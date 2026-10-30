import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpRuntime } from '../src/acp/runtime.js'
import type { IngressClassificationInput, IngressDecision } from '../src/acp/ingress-classifier.js'
import { loadConfig } from '../src/config.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { SourceContexts } from '../src/core/source-context.js'
import { Todos } from '../src/core/todos.js'
import { InboundMaterials, readForwardMaterial } from '../src/core/inbound-materials.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import { createInternalApi } from '../src/internal/api.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { createFakeAgent } from './helpers/fake-agent.js'
import { asFeishuClient, FakeFeishu, historyMsg } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const closes: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks() })
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

/** Real coordinator, ACP, SQLite and signed todo HTTP; only platform and model decisions are synthetic. */
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'friday-inbound-material-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic', FEISHU_APP_SECRET: 'synthetic', FRIDAY_HOME: home,
    FRIDAY_REFLECT: 'off', FRIDAY_PROMPT_TIMEOUT_MS: '5000' })
  mkdirSync(cfg.workspace.root, { recursive: true })
  const registry = new Registry(join(home, 'test.sqlite')), memory = new ChannelMemory(registry.db), todos = new Todos(registry.db)
  const sp = spaceDeps(registry.db), dm = sp.spaces.ensure({ kind: 'p2p', chatId: 'oc_dm', openId: 'ou_alice' })
  const fake = new FakeFeishu(), feishu = asFeishuClient(fake), log = createLogger('inbound-material-test', 'error')
  const cache = new MessageCache(registry.db), messages = new MessageService(feishu, cache, log), tokens = new TokenIssuer('synthetic')
  const { app, state } = createFakeAgent({ script: [{ kind: 'text', text: '已查看材料。' }] })
  const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: app }, maxConcurrent: 3,
    onPermission: async () => ({ outcome: { outcome: 'cancelled' } }), log })
  const classify = vi.fn<(input: IngressClassificationInput) => Promise<IngressDecision>>(async input => {
    // Idle own-DM input now also uses the typed classifier for explicit memory
    // intents. These fixture source messages request ordinary work, not memory.
    if (!input.candidates.length && !input.materials?.length && !input.memoryTargets?.length) return { kind: 'work_request' }
    return input.materials?.length === 1
      ? { kind: 'new_work', contextRefs: [input.materials[0]!.ref] } : { kind: 'clarify' }
  })
  const deps = { cfg, registry, memory, todos, ...sp, messages, tokens, feishu, runtime,
    ingressClassifier: { classify }, apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', botOpenId: 'ou_bot', log }
  let host = new Orchestrator(deps)
  const api = createInternalApi({ registry, memory, todos, ...sp, feishu, messages, messageCache: cache, tokens, log, maxHistoryPerCall: 20,
    resolveActorForSession: key => host.resolveActorForSession(key), allowedRoutesForSession: key => host.allowedRoutesForSession(key),
    canPersistDerivedState: (key, purpose) => host.canPersistDerivedState(key, purpose), abilities: host.abilities })
  await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
  closes.push(async () => { api.server.closeAllConnections(); await new Promise<void>(resolve => api.server.close(() => resolve()));
    await runtime.stop(); registry.close(); rmSync(home, { recursive: true, force: true }) })
  const postTodo = async (title: string) => {
    const server = state.allPrompts.at(-1)!.mcpServers[0] as { env: { name: string; value: string }[] }
    const token = server.env.find(item => item.name === 'FRIDAY_CAP_TOKEN')!.value
    const response = await fetch(`http://127.0.0.1:${(api.server.address() as AddressInfo).port}/v1/todo/add`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ title }) })
    return { status: response.status, body: await response.json() }
  }
  let serial = 0
  const msg = (text: string, over: Partial<InboundMessage> = {}): InboundMessage => {
    const id = `material-message-${++serial}`
    return { eventId: id, messageId: id, chatId: 'oc_dm', chatType: 'p2p', senderOpenId: 'ou_alice', senderType: 'user',
      msgType: 'text', text, mentions: [], createTimeMs: Date.now(), ...over }
  }
  const forward = (text = '修复输出截断后通知报告人', over: Partial<InboundMessage> = {}) => {
    const message = msg('[合并转发消息]', { msgType: 'merge_forward', ...over })
    fake.messages.set(message.messageId, historyMsg({ ...message, senderName: '合成用户' }))
    fake.forwarded.set(message.messageId, [historyMsg({ messageId: `${message.messageId}-child`, chatId: 'oc_original_unreadable', text })])
    return message
  }
  const dispatch = (message: InboundMessage) => host.handleMessage(message)
  const task = (message: InboundMessage) => registry.taskForMessage(message.messageId)!
  const rebuild = async (message: InboundMessage) => {
    const session = registry.getSession(task(message).sessionKey)!
    await runtime.closeSession(session.acpSessionId!)
    registry.updateSession(session.sessionKey, { acpSessionId: null })
    host = new Orchestrator(deps)
  }
  return { registry, todos, dm, ...sp, fake, feishu, runtime, state, classify, dispatch, msg, forward, task, postTodo, rebuild,
    sources: new SourceContexts(registry), get host() { return host } }
}

describe('human material references across independent work', () => {
  it.each(['text', 'post', 'file', 'image'])('keeps a selected %s input and real todo after a cold ACP rebuild', async msgType => {
    const t = await fixture(), source = t.msg('周五前给报告人确认输出截断的修复进度', { msgType,
      ...(msgType === 'file' ? { fileKey: 'provided-file', fileName: '报告.txt' } : {}),
      ...(msgType === 'image' ? { imageKey: 'provided-image' } : {}),
      mentions: [{ key: '@person', name: '报告人', openId: 'ou_reporter' }] })
    await t.dispatch(source)
    const summary = t.msg('先整理这件事')
    await t.dispatch(summary)
    expect(new InboundMaterials(t.registry).forTask(t.task(summary).id).map(ref => ref.message.messageId)).toEqual([source.messageId])
    await t.rebuild(summary)
    t.classify.mockImplementationOnce(async input => ({ kind: 'amend', targetRef: input.message.replyToRef! }))
    t.state.script = [{ kind: 'hook', run: async () => {
      const prompt = t.state.allPrompts.at(-1)!.text
      expect(prompt).toContain('周五前给报告人确认输出截断的修复进度')
      expect(prompt).toContain('ou_reporter')
      expect(await t.postTodo('确认输出截断的修复进度')).toMatchObject({ status: 200 })
    } }, { kind: 'text', text: '已记下待办。' }]
    const followup = t.msg('现在记为待办', { parentId: summary.messageId })
    await t.dispatch(followup)
    expect(t.task(followup).status).toBe('done')
    expect(t.todos.list(`space:${t.dm.id}`)).toMatchObject([{ title: '确认输出截断的修复进度' }])
    expect(t.sources.get(t.task(followup).sessionKey)?.inboundMaterials).toContainEqual(expect.objectContaining({
      messageId: source.messageId, chatId: source.chatId, actorOpenId: source.senderOpenId }))
  })

  it('offers actual plain text as a candidate but does not attach it when the classifier chooses unrelated work', async () => {
    const t = await fixture(), source = t.msg('SOURCE_ONLY_FOLLOWUP_MATERIAL')
    await t.dispatch(source)
    t.classify.mockImplementationOnce(async input => {
      expect(input.materials?.[0]?.preview).toContain(source.text)
      return { kind: 'new_work', contextRefs: [] }
    })
    const unrelated = t.msg('另外计算一个独立问题')
    await t.dispatch(unrelated)
    expect(t.state.allPrompts.at(-1)!.text).not.toContain('本次请求引用的用户材料')
    expect(new InboundMaterials(t.registry).forTask(t.task(unrelated).id)).toEqual([])
  })

  it('creates a real todo once from a forwarded container; a follow-up sent while the original work runs waits in the same conversation', async () => {
    const t = await fixture(), source = t.forward(), entered = deferred(), release = deferred()
    t.state.script = [{ kind: 'hook', run: async () => { entered.resolve(); await release.promise } }, { kind: 'text', text: '原事项完成。' }]
    const first = t.dispatch(source)
    let followupRun: Promise<unknown> | undefined
    try {
      await entered.promise
      t.classify.mockImplementationOnce(async input => {
        expect(input.materials?.[0]?.preview).toContain('修复输出截断后通知报告人')
        return { kind: 'new_work', contextRefs: [input.materials![0]!.ref] }
      })
      t.state.script = [{ kind: 'hook', run: async () => {
        expect(t.state.allPrompts.at(-1)!.text).toContain('修复输出截断后通知报告人')
        expect(await t.postTodo('修复输出截断后通知报告人')).toMatchObject({ status: 200 })
      } }, { kind: 'text', text: '已记下待办。' }]
      const followup = t.msg('记下todo')
      followupRun = Promise.all([t.dispatch(followup), t.dispatch(followup)])
      await vi.waitFor(() => expect(t.task(followup)).toBeDefined())
      // One private conversation: the follow-up is queued behind the running work, not run beside it in a second session.
      expect(t.task(followup).sessionKey).toBe(t.task(source).sessionKey)
      expect(t.task(followup).status).toBe('queued')
      expect(t.task(source).status).toBe('running')
      expect(t.todos.list(`space:${t.dm.id}`)).toEqual([])
      release.resolve(); await first; await followupRun
      expect(t.task(followup).status).toBe('done')
      expect(t.todos.list(`space:${t.dm.id}`)).toMatchObject([{ title: '修复输出截断后通知报告人', sessionKey: t.task(followup).sessionKey }])
      expect(t.sources.get(t.task(followup).sessionKey)?.inboundMaterials).toContainEqual(
        expect.objectContaining({ messageId: source.messageId, chatId: 'oc_dm', actorOpenId: 'ou_alice', complete: true }))
    } finally { release.resolve(); await first; await followupRun }
  })

  it('restarts the private conversation when read material can never be delivered, so the next request starts clean', async () => {
    const t = await fixture(), source = t.forward()
    t.state.script = [{ kind: 'hook', run: () => t.host.noteExternalSource(t.task(source).sessionKey,
      { kind: 'document', ref: 'PRIVATE_OLD_TOOL_SOURCE', access: 'app' }) }, { kind: 'text', text: '原工具结果。' }]
    await t.dispatch(source)
    expect(t.task(source).status).toBe('failed')
    // The person is told, once, that the conversation started over.
    expect(JSON.stringify(t.fake.sent)).toContain('我把会话重开了')
    t.state.script = [{ kind: 'hook', run: async () => {
      expect(t.state.allPrompts.at(-1)!.text).not.toContain('PRIVATE_OLD_TOOL_SOURCE')
      expect(await t.postTodo('跟进转发的截断问题')).toMatchObject({ status: 200 })
    } }, { kind: 'text', text: '已记录。' }]
    const followup = t.msg('把这里的事变成我的待办')
    await t.dispatch(followup)
    expect(t.task(followup).status).toBe('done')
    expect(t.task(followup).sessionKey).not.toBe(t.task(source).sessionKey)
    expect(t.todos.list(`space:${t.dm.id}`)).toHaveLength(1)
    expect(t.sources.get(t.task(source).sessionKey)?.external).toHaveLength(1)
    expect(t.sources.get(t.task(followup).sessionKey)?.external).toEqual([])
  })

  it('in the person\'s own chat, what the conversation already read for them may become their own todo; another identity\'s material may not', async () => {
    const t = await fixture(), first = t.msg('看看产品群今天说了什么')
    t.fake.chats = [{ chatId: 'oc_product_group', name: '产品群' }]
    t.fake.members.set('oc_product_group', new Set(['ou_alice', 'ou_bob']))
    t.state.script = [{ kind: 'hook', run: async () => {
      // The conversation has read another group the person is in.
      t.sources.addChat(t.task(first).sessionKey, { chatId: 'oc_product_group' })
      expect(await t.postTodo('明天跟进产品群提的问题')).toMatchObject({ status: 200 })
    } }, { kind: 'text', text: '已记下。' }]
    await t.dispatch(first)
    expect(t.task(first).status).toBe('done')
    expect(t.todos.list(`space:${t.dm.id}`)).toMatchObject([{ title: '明天跟进产品群提的问题' }])
    // Material read under someone else's identity closes the door again.
    t.state.script = [{ kind: 'hook', run: async () => {
      t.host.noteExternalSource(t.task(first).sessionKey, { kind: 'document', ref: 'doc:bobs', personalOpenId: 'ou_bob', access: 'user' })
      expect(await t.postTodo('抄一份 Bob 的文档')).toMatchObject({ status: 403 })
    } }, { kind: 'text', text: '这条记不了。' }]
    const second = t.msg('再记一条')
    await t.dispatch(second)
    expect(t.task(second).sessionKey).toBe(t.task(first).sessionKey)
    expect(t.todos.list(`space:${t.dm.id}`)).toHaveLength(1)
  })

  it('rebuilds persisted selected material after ACP loss, including a changed action', async () => {
    const t = await fixture(), source = t.forward()
    await t.dispatch(source)
    const summarize = t.msg('整理为一条跟进记录')
    await t.dispatch(summarize)
    const refs = new InboundMaterials(t.registry).forTask(t.task(summarize).id)
    expect(refs.map(ref => ref.message.messageId)).toEqual([source.messageId])
    await t.rebuild(summarize)
    t.classify.mockImplementationOnce(async input => ({ kind: 'amend', targetRef: input.message.replyToRef! }))
    t.state.script = [{ kind: 'hook', run: async () => {
      expect(t.state.allPrompts.at(-1)!.text).toContain('修复输出截断后通知报告人')
      expect(await t.postTodo('重建后保存的跟进事项')).toMatchObject({ status: 200 })
    } }, { kind: 'text', text: '已保存。' }]
    const followup = t.msg('改成待办', { parentId: summarize.messageId })
    await t.dispatch(followup)
    expect(t.task(followup).status).toBe('done')
    expect(t.todos.list(`space:${t.dm.id}`)).toHaveLength(1)
  })

  it('continues the conversation for an unclear reference to two materials without binding either, while explicit independence has no material', async () => {
    const t = await fixture(), first = t.forward('第一份转发：修复截断'), second = t.forward('第二份转发：更新安装说明')
    await t.dispatch(first)
    t.classify.mockResolvedValueOnce({ kind: 'new_work' })
    await t.dispatch(second)
    const uncertain = t.msg('记一下')
    await t.dispatch(uncertain)
    expect(t.classify.mock.calls.at(-1)![0].materials).toHaveLength(2)
    // In the person's own chat the line is not asked back: it continues the conversation, which already holds both
    // forwards; neither is bound to it as material, and nothing is written.
    expect(t.task(uncertain)?.sessionKey).toBe(t.task(second).sessionKey)
    expect(new InboundMaterials(t.registry).forTask(t.task(uncertain).id)).toEqual([])
    expect(t.todos.list(`space:${t.dm.id}`)).toEqual([])
    t.classify.mockResolvedValueOnce({ kind: 'new_work', contextRefs: [] })
    const independent = t.msg('另一件事：解释一下素数')
    await t.dispatch(independent)
    expect(t.state.allPrompts.at(-1)!.text).not.toContain('修复截断')
    expect(t.state.allPrompts.at(-1)!.text).not.toContain('更新安装说明')
  })

  it('rejects cross-user and cross-space references even when a classifier returns a guessed ref', async () => {
    const t = await fixture(), source = t.forward()
    await t.dispatch(source)
    const store = new InboundMaterials(t.registry), alice = t.msg('引用'), refs = store.candidates(alice)
    expect(refs).toHaveLength(1)
    expect(store.candidates(t.msg('引用', { senderOpenId: 'ou_bob', parentId: source.messageId }))).toEqual([])
    expect(store.candidates(t.msg('引用', { chatId: 'oc_other', parentId: source.messageId }))).toEqual([])
    expect(() => store.bind(t.task(source), t.msg('引用', { senderOpenId: 'ou_bob' }), refs)).toThrow()
    t.classify.mockResolvedValueOnce({ kind: 'new_work', contextRefs: ['forged'] })
    await t.dispatch(alice)
    expect(t.task(alice)).toBeUndefined()
    expect(t.todos.list(`space:${t.dm.id}`)).toEqual([])
  })

  it('does not prompt or create a todo from material that returns after the current run was stopped', async () => {
    const t = await fixture(), source = t.forward()
    await t.dispatch(source)
    const original = t.feishu.getMessageItems.bind(t.feishu), entered = deferred(), release = deferred()
    let calls = 0
    vi.spyOn(t.feishu, 'getMessageItems').mockImplementation(async id => {
      if (++calls === 2) { entered.resolve(); await release.promise }
      return original(id)
    })
    t.state.script = [{ kind: 'hook', run: async () => { await t.postTodo('LATE_MATERIAL_MUST_NOT_PERSIST') } }]
    const followup = t.msg('将刚才的内容记为待办'), pending = t.dispatch(followup)
    try {
      await entered.promise
      // The public stop command follows the current DM alias to the new task.
      await t.dispatch(t.msg('/stop'))
    } finally { release.resolve(); await pending }
    expect(t.todos.list(`space:${t.dm.id}`)).toEqual([])
    expect(t.state.allPrompts).toHaveLength(1)
    expect(t.task(followup).status).toBe('cancelled')
  })

  it('rechecks space access after the referenced material read before prompting or writing', async () => {
    const t = await fixture(), source = t.forward()
    await t.dispatch(source)
    const recorded = t.sources.get(t.task(source).sessionKey)?.inboundMaterials?.length ?? 0
    const original = t.feishu.getMessageItems.bind(t.feishu)
    let calls = 0
    vi.spyOn(t.feishu, 'getMessageItems').mockImplementation(async id => {
      const result = await original(id)
      if (++calls === 2) t.spaces.archive(t.dm.id)
      return result
    })
    const followup = t.msg('记成我的待办')
    await t.dispatch(followup)
    expect(t.state.allPrompts).toHaveLength(1)
    expect(t.todos.list(`space:${t.dm.id}`)).toEqual([])
    // The shared conversation keeps the earlier task's own material on record; the refused follow-up adds nothing.
    expect(t.sources.get(t.task(followup).sessionKey)?.inboundMaterials?.length ?? 0).toBe(recorded)
  })

  it('can explicitly cite an older supplied container without treating unrelated old materials as recent', async () => {
    const t = await fixture(), source = t.forward()
    await t.dispatch(source)
    const later = t.msg('继续处理', { createTimeMs: Date.now() + 31 * 60_000 })
    const store = new InboundMaterials(t.registry)
    expect(store.candidates(later)).toEqual([])
    expect(store.candidates({ ...later, parentId: source.messageId }).map(ref => ref.taskId)).toEqual([t.task(source).id])
  })
})

describe('forward read boundaries', () => {
  it('keeps failed reads and truncation explicit and never reflects raw platform errors', async () => {
    const t = await fixture(), source = t.forward('x'.repeat(5000))
    expect(await readForwardMaterial(t.feishu, source)).toMatchObject({ status: 'partial', note: expect.stringContaining('已截断') })
    vi.spyOn(t.feishu, 'getMessageItems').mockRejectedValueOnce(new Error('SECRET_IN_PROVIDER_ERROR'))
    const result = await readForwardMaterial(t.feishu, source)
    expect(result).toMatchObject({ status: 'unavailable', note: expect.stringContaining('用户没有提供') })
    expect(JSON.stringify(result)).not.toContain('SECRET_IN_PROVIDER_ERROR')
    t.fake.messages.set(source.messageId, historyMsg({ ...source, chatId: 'oc_wrong' }))
    await expect(readForwardMaterial(t.feishu, source)).rejects.toThrow('不属于当前会话')
  })
})
