/**
 * 发起人的 GitHub 用户名：查 / 记（POST /v1/github/login）。
 *
 * 这条路径存在的唯一理由是让「我的 issue」用人话就能走通：模型问一句、他答一句、这里记下来。
 * 在这之前唯一的入口是 `/github <登录名>`——等于要求他先知道有这么个命令，
 * 而用户真实反馈就是"大部分用户不会用 switch command"。
 *
 * 两条不能松的：
 * - 只记**发起人自己**的名字（身份从 capability 来，body 里的 open_id 一律不看）；
 * - 格式不对就拒绝，不替他猜——猜错会把别人的 issue 当成他的。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { Registry } from '../src/core/registry.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Todos } from '../src/core/todos.js'
import { createInternalApi } from '../src/internal/api.js'
import { ALL_SCOPES, TokenIssuer, type Capability } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { memoryRuntimeFixture } from './helpers/memory-runtime.js'
import { spaceDeps } from './helpers/space.js'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function setup() {
  const registry = new Registry(':memory:')
  const cwd = mkdtempSync(join(tmpdir(), 'friday-gh-login-'))
  cleanups.push(() => { registry.close(); rmSync(cwd, { recursive: true, force: true }) })
  const sp = spaceDeps(registry.db)
  const space = sp.spaces.ensure({ kind: 'p2p', chatId: 'chat-a', openId: 'alice' })
  const feishu = new FakeFeishu()
  const memory = new ChannelMemory(registry.db)
  const log = createLogger('gh-login', 'error')
  registry.createSession({ sessionKey: 'session-a', chatId: 'chat-a', chatType: 'p2p', cwd, requesterOpenId: 'alice' })
  const task = registry.createTaskOnce({ sessionKey: 'session-a', messageId: 'om_current', requesterOpenId: 'alice', prompt: '我的 issue 有哪些' }).task
  registry.updateTask(task.id, { status: 'running' })
  const memoryHost = memoryRuntimeFixture(registry, memory)
  memoryHost.pin({ runId: 'current-run', sessionKey: 'session-a', actorOpenId: 'alice', taskId: task.id })
  const tokens = new TokenIssuer('synthetic')
  const created = createInternalApi({
    registry, ...sp, feishu: asFeishuClient(feishu), messageCache: new MessageCache(registry.db),
    memory, memoryRuntime: memoryHost.runtime, todos: new Todos(registry.db),
    messages: new MessageService(asFeishuClient(feishu), new MessageCache(registry.db), log),
    tokens, log, maxHistoryPerCall: 50,
    resolveActorForSession: () => ({ requesterOpenId: 'alice', runId: 'current-run', stage: 'task', taskId: task.id }),
    canPersistDerivedState: () => true,
  })
  await new Promise<void>(resolve => created.server.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => { created.server.closeAllConnections(); await new Promise<void>(resolve => created.server.close(() => resolve())) })
  const url = `http://127.0.0.1:${(created.server.address() as AddressInfo).port}/v1/github/login`
  const cap: Omit<Capability, 'exp'> = {
    runId: 'current-run', sessionKey: 'session-a', chatId: 'chat-a', chatType: 'p2p', spaceId: space.id,
    requesterOpenId: 'alice', cwd, scopes: [...ALL_SCOPES],
  }
  const call = async (body: Record<string, unknown> = {}, actor = cap): Promise<{ login: string | null; saved?: boolean }> => {
    const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${tokens.issue(actor)}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const result = await response.json()
    if (!response.ok) throw Object.assign(new Error(String(result.error)), { status: response.status })
    return result
  }
  return { call, cap, registry }
}

describe('发起人的 GitHub 用户名', () => {
  it('没记过时如实说不知道，不编一个', async () => {
    const t = await setup()
    expect(await t.call()).toEqual({ login: null })
  })

  it('他说了就记下来，下次直接读得到', async () => {
    const t = await setup()
    expect(await t.call({ login: 'ZhixingLu' })).toEqual({ login: 'ZhixingLu', saved: true })
    expect(await t.call()).toEqual({ login: 'ZhixingLu' })
  })

  it('@ 前缀和空格是人话里常见的，去掉就好', async () => {
    const t = await setup()
    expect(await t.call({ login: '  @ZhixingLu ' })).toEqual({ login: 'ZhixingLu', saved: true })
  })

  it('格式不对就拒绝，不替他猜', async () => {
    const t = await setup()
    for (const bad of ['陆知行', 'a'.repeat(40), 'has space', '-leading', 'we/ird']) {
      await expect(t.call({ login: bad }), bad).rejects.toMatchObject({ status: 400 })
    }
    expect(await t.call()).toEqual({ login: null })
  })

  it('只记发起人自己的：body 里塞别人的 open_id 不起作用', async () => {
    const t = await setup()
    await t.call({ login: 'ZhixingLu', open_id: 'ou_someone_else', requester_open_id: 'ou_someone_else' })
    expect(t.registry.getKv('github_login:alice')).toBe('ZhixingLu')
    expect(t.registry.getKv('github_login:ou_someone_else')).toBeUndefined()
  })

  it('换一个名字就是覆盖，不会两个并存', async () => {
    const t = await setup()
    await t.call({ login: 'ZhixingLu' })
    await t.call({ login: 'someone-new' })
    expect(await t.call()).toEqual({ login: 'someone-new' })
  })
})
