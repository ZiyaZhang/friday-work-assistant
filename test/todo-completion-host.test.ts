/**
 * 包 B §9 宿主接线：待办按证据标完成。判断规则由 TodoCompletionEvidence 的测试覆盖；这里验证宿主怎么取待办、
 * 怎么取话题消息、谁能读、在一个事务里标完成并记下证据，以及写入条件不满足时只列出来不写。
 * 用户已定：只认平台状态或本人在原话题明确说完成，且只有一条未完成候选；“好，今天搞定”是承诺；“Bob 的文档写完了”算本人明确完成。
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Registry } from '../src/core/registry.js'
import { Todos } from '../src/core/todos.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { ChannelMemory } from '../src/core/memory.js'
import { ChatReadScope } from '../src/core/chat-read-scope.js'
import { TodoApplication, todoTag } from '../src/core/todo-application.js'
import { TodoCompletionHost, EVIDENCE_COMPLETION_ACTOR } from '../src/core/todo-completion-host.js'
import type { GitHubItemState, GitHubRef } from '../src/core/todo-completion-evidence.js'
import type { TodoMessageMetadata, TodoProvenance } from '../src/core/todo-provenance.js'
import { spaceScope, type Space } from '../src/core/space.js'
import { createInternalApi } from '../src/internal/api.js'
import { ALL_SCOPES, GROUP_SCOPES, PROACTIVE_SCOPES, TokenIssuer, type Capability } from '../src/internal/tokens.js'
import { buildServer } from '../src/mcp/server.js'
import { createLogger } from '../src/log.js'
import { FakeFeishu, asFeishuClient, historyMsg } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

function fixture() {
  const registry = new Registry(':memory:')
  cleanups.push(() => registry.close())
  const todos = new Todos(registry.db), cache = new MessageCache(registry.db), readScope = new ChatReadScope(registry.db)
  const { spaces, policy } = spaceDeps(registry.db)
  const dm = spaces.ensure({ kind: 'p2p', chatId: 'oc_dm_alice', openId: 'ou_alice' })
  const group = spaces.ensure({ kind: 'group', chatId: 'oc_team', openId: 'ou_alice' })
  spaces.addMember(group.id, 'ou_bob', 'member')
  const memberLookups: string[] = []
  const host = new TodoCompletionHost({ db: registry.db, todos, todoApplication: new TodoApplication({ db: registry.db, todos }),
    messages: cache, spaces, policy, readScope, members: async chatId => { memberLookups.push(chatId); return new Set(['ou_alice', 'ou_bob']) } })
  const audience = (space: Space) => ({ scope: spaceScope(space.id), chatId: space.chatId!, chatType: space.kind, openId: 'ou_alice' })
  let seq = 0
  /** 在某个会话里由本人发一条消息记下待办；rootId 给了就是话题里的回复。 */
  const record = (space: Space, title: string, opts: { rootId?: string; threadId?: string; ownerOpenId?: string; detail?: string } = {}) => {
    const messageId = `om_src_${++seq}`
    const request: TodoMessageMetadata = { messageId, chatId: space.chatId!, chatType: space.kind, senderOpenId: 'ou_alice', msgType: 'text',
      createTimeMs: Date.now() - 60_000, ...(opts.rootId ? { rootId: opts.rootId } : {}), ...(opts.threadId ? { threadId: opts.threadId } : {}), link: { status: 'unavailable' } }
    const provenance: TodoProvenance = { version: 1, originRunId: `run-${seq}`, taskId: seq, workKey: `work-${seq}`, request, selectedInputs: [],
      contextSnapshot: { version: 1, acpSessionId: 'acp-1', spaceId: space.id, chatId: space.chatId!, memoryScopes: [], chats: [], external: [], repositories: [] } }
    const todo = todos.add({ scope: spaceScope(space.id), title, ...(opts.detail ? { detail: opts.detail } : {}),
      ...(space.kind === 'group' ? { ownerOpenId: opts.ownerOpenId ?? 'ou_alice' } : {}), createdBy: 'ou_alice', provenance })
    return { todo, root: opts.rootId ?? messageId }
  }
  /** 话题里后来的一条消息（缓存里有的才算） */
  const say = (space: Space, root: string, text: string, opts: { sender?: string; senderType?: string; at?: number; id?: string; threadId?: string } = {}) => {
    const id = opts.id ?? `om_say_${++seq}`
    cache.upsert(space.chatId!, [historyMsg({ messageId: id, chatId: space.chatId!, rootId: root, ...(opts.threadId ? { threadId: opts.threadId } : {}),
      senderOpenId: opts.sender ?? 'ou_alice', senderType: opts.senderType ?? 'user', createTimeMs: opts.at ?? Date.now() + 1000, text })])
    return id
  }
  const evidenceRows = () => registry.db.prepare('SELECT todo_id, evidence_key FROM todo_completion_evidence ORDER BY todo_id, evidence_key').all()
  return { registry, todos, cache, readScope, spaces, policy, dm, group, host, audience, record, say, evidenceRows, memberLookups }
}

describe('MessageCache.thread', () => {
  it('returns later messages of the same thread by root message or known thread id, never another chat', () => {
    const t = fixture()
    t.cache.upsert('oc_team', [
      historyMsg({ messageId: 'om_root', chatId: 'oc_team', createTimeMs: 1000, text: '记一下：整理风险' }),
      historyMsg({ messageId: 'om_reply', chatId: 'oc_team', rootId: 'om_root', createTimeMs: 2000, text: '回复' }),
      historyMsg({ messageId: 'om_thread_only', chatId: 'oc_team', threadId: 'omt_1', createTimeMs: 3000, text: '话题里' }),
      historyMsg({ messageId: 'om_before', chatId: 'oc_team', rootId: 'om_root', createTimeMs: 500, text: '更早' }),
      historyMsg({ messageId: 'om_other_root', chatId: 'oc_team', rootId: 'om_other', createTimeMs: 2500, text: '别的话题' }),
    ])
    t.cache.upsert('oc_elsewhere', [historyMsg({ messageId: 'om_elsewhere', chatId: 'oc_elsewhere', rootId: 'om_root', createTimeMs: 2000, text: '别的群' })])
    expect(t.cache.thread({ chatId: 'oc_team', rootMessageId: 'om_root' }, 1000).map(m => m.messageId)).toEqual(['om_reply'])
    expect(t.cache.thread({ chatId: 'oc_team', rootMessageId: 'om_root', threadId: 'omt_1' }, 1000).map(m => m.messageId)).toEqual(['om_reply', 'om_thread_only'])
  })
})

describe('TodoCompletionHost', () => {
  it('marks a todo done in one transaction when the owner said it is finished in its own thread, and never reuses that statement', async () => {
    const t = fixture()
    const { todo, root } = t.record(t.group, '整理项目风险清单')
    const said = t.say(t.group, root, '风险清单做完了')
    const review = await t.host.review({ owner: 'ou_alice', audience: t.audience(t.group), assertWritable: () => {} })
    expect(review.suggested).toEqual([])
    expect(review.applied).toMatchObject([{ id: todo.id, title: '整理项目风险清单', receipt: '依据：你在这条待办的原话题里说已经完成',
      evidence: [{ kind: 'message', messageId: said, byOwner: true }] }])
    expect(t.todos.get(todo.id)).toMatchObject({ status: 'done', statusBy: EVIDENCE_COMPLETION_ACTOR, statusNote: '依据：你在这条待办的原话题里说已经完成' })
    expect(t.evidenceRows()).toEqual([{ todo_id: todo.id, evidence_key: `message:${said}` }])
    // 本人改回未完成走现有操作；同一句话不再用
    const current = t.todos.get(todo.id)!
    new TodoApplication({ db: t.registry.db, todos: t.todos }).update(todo.id, t.audience(t.group), { expectedTag: todoTag(current), patch: { status: 'open' } }, 'ou_alice')
    expect(await t.host.review({ owner: 'ou_alice', audience: t.audience(t.group), assertWritable: () => {} })).toEqual({ applied: [], suggested: [] })
    expect(t.todos.get(todo.id)?.status).toBe('open')
    // 新的证据照常判断
    t.say(t.group, root, '这次真的搞定了')
    expect((await t.host.review({ owner: 'ou_alice', audience: t.audience(t.group), assertWritable: () => {} })).applied.map(n => n.id)).toEqual([todo.id])
  })

  it('treats “好，今天搞定” as a commitment, and keeps “Bob 的文档写完了” said by the owner as a plain completion', async () => {
    const t = fixture()
    const promise = t.record(t.group, '周报')
    t.say(t.group, promise.root, '好，今天搞定')
    const bob = t.record(t.group, '催 Bob 写接口文档')
    t.say(t.group, bob.root, 'Bob 的文档写完了')
    const review = await t.host.review({ owner: 'ou_alice', audience: t.audience(t.group), assertWritable: () => {} })
    expect(review.applied.map(n => n.id)).toEqual([bob.todo.id])
    expect(review.suggested).toEqual([])
    expect(t.todos.get(promise.todo.id)?.status).toBe('open')
  })

  it('only lists what someone else said, and what is ambiguous between two todos of one thread', async () => {
    const t = fixture()
    const other = t.record(t.group, '发布说明')
    t.say(t.group, other.root, '发布说明写好了', { sender: 'ou_bob' })
    const first = t.record(t.group, '改登录页')
    const second = t.record(t.group, '改设置页', { rootId: first.root })
    t.say(t.group, first.root, '改好了')
    const review = await t.host.review({ owner: 'ou_alice', audience: t.audience(t.group), assertWritable: () => {} })
    expect(review.applied).toEqual([])
    expect(review.suggested.map(n => n.id).sort()).toEqual([other.todo.id, first.todo.id, second.todo.id].sort())
    for (const id of [other.todo.id, first.todo.id, second.todo.id]) expect(t.todos.get(id)?.status).toBe('open')
    expect(t.evidenceRows()).toEqual([])
  })

  it('does not write when the caller cannot write personal state now, and says why', async () => {
    const t = fixture()
    const { todo, root } = t.record(t.group, '整理项目风险清单')
    t.say(t.group, root, '做完了')
    const review = await t.host.review({ owner: 'ou_alice', audience: t.audience(t.group), assertWritable: () => { throw new Error('本轮包含外部资料') } })
    expect(review.applied).toEqual([])
    expect(review.suggested).toMatchObject([{ id: todo.id, receipt: '依据：你在这条待办的原话题里说已经完成', notApplied: '本轮不能写入个人状态（本轮包含外部资料）' }])
    expect(t.todos.get(todo.id)).toMatchObject({ status: 'open', statusBy: null })
    expect(t.evidenceRows()).toEqual([])
  })

  it('uses GitHub state only as read by the host, and does not apply when the todo changed while it was being read', async () => {
    const t = fixture()
    const merged = t.record(t.dm, '合并登录修复 https://github.com/org/repo/pull/12')
    const dropped = t.record(t.dm, '跟进 https://github.com/org/repo/issues/13')
    const changing = t.record(t.dm, '看一下 https://github.com/org/repo/issues/14')
    const reads: string[] = []
    const readGitHub = async (ref: GitHubRef): Promise<GitHubItemState> => {
      reads.push(`${ref.owner}/${ref.repo}#${ref.number}`)
      if (ref.number === 12) return { status: 'read', kind: 'pull', state: 'closed', merged: true, stateReason: null }
      if (ref.number === 13) return { status: 'read', kind: 'issue', state: 'closed', merged: false, stateReason: 'not_planned' }
      t.todos.update(changing.todo.id, spaceScope(t.dm.id), { title: '看一下 https://github.com/org/repo/issues/14（本人刚改过）' })
      return { status: 'read', kind: 'issue', state: 'closed', merged: false, stateReason: 'completed' }
    }
    const review = await t.host.review({ owner: 'ou_alice', audience: t.audience(t.dm), readGitHub, assertWritable: () => {} })
    expect(reads.sort()).toEqual(['org/repo#12', 'org/repo#13', 'org/repo#14'])
    expect(review.applied).toMatchObject([{ id: merged.todo.id, receipt: '依据：org/repo#12 已合并',
      evidence: [{ kind: 'github', ref: 'org/repo#12', url: 'https://github.com/org/repo/pull/12', state: '已合并' }] }])
    expect(review.suggested).toMatchObject([{ id: changing.todo.id, notApplied: '这条待办在判断期间被改过' }])
    expect(t.todos.get(merged.todo.id)).toMatchObject({ status: 'done', statusBy: EVIDENCE_COMPLETION_ACTOR })
    expect(t.todos.get(dropped.todo.id)?.status).toBe('open')
    expect(t.todos.get(changing.todo.id)).toMatchObject({ status: 'open', title: '看一下 https://github.com/org/repo/issues/14（本人刚改过）' })
  })

  it('reads each distinct link once, at most a bounded number of links and a few at a time', async () => {
    const t = fixture()
    for (let n = 1; n <= 30; n++) t.record(t.dm, `跟进 https://github.com/org/repo/issues/${n} 和 https://github.com/Org/Repo/issues/${n}`)
    let active = 0, peak = 0
    const reads: number[] = []
    const readGitHub = async (ref: GitHubRef): Promise<GitHubItemState> => {
      reads.push(ref.number); active++; peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 2))
      active--
      return { status: 'read', kind: 'issue', state: 'open', merged: false, stateReason: null }
    }
    expect(await t.host.review({ owner: 'ou_alice', audience: t.audience(t.dm), readGitHub, assertWritable: () => {} })).toEqual({ applied: [], suggested: [] })
    expect(reads).toHaveLength(24)
    expect(new Set(reads).size).toBe(24)
    expect(peak).toBeLessThanOrEqual(6)
    expect(peak).toBeGreaterThan(1)
  })

  it('ignores words in a chat the owner stopped Friday from reading, words from Friday itself, and other people’s todos', async () => {
    const t = fixture()
    const excluded = t.record(t.group, '整理项目风险清单')
    t.say(t.group, excluded.root, '做完了')
    t.readScope.exclude('ou_alice', 'oc_team')
    expect(await t.host.review({ owner: 'ou_alice', audience: t.audience(t.group), assertWritable: () => {} })).toEqual({ applied: [], suggested: [] })
    t.readScope.restore('ou_alice', 'oc_team')
    t.registry.db.prepare('UPDATE todos SET status = ? WHERE id = ?').run('done', excluded.todo.id)

    const bot = t.record(t.group, '周会纪要')
    t.say(t.group, bot.root, '已完成', { sender: 'ou_bot', senderType: 'app' })
    const bobs = t.record(t.group, 'Bob 自己的事', { ownerOpenId: 'ou_bob' })
    t.say(t.group, bobs.root, '做完了')
    expect(await t.host.review({ owner: 'ou_alice', audience: t.audience(t.group), assertWritable: () => {} })).toEqual({ applied: [], suggested: [] })
    expect(t.todos.get(bobs.todo.id)?.status).toBe('open')
    // 本人正在这个群里说话：不为当前会话再去查成员
    expect(t.memberLookups).toEqual([])
  })

  it('only looks at the current conversation’s todos of that owner', async () => {
    const t = fixture()
    const inGroup = t.record(t.group, '群里的事')
    t.say(t.group, inGroup.root, '做完了')
    const inDm = t.record(t.dm, '私聊里的事')
    t.say(t.dm, inDm.root, '做完了')
    const dmReview = await t.host.review({ owner: 'ou_alice', audience: t.audience(t.dm), assertWritable: () => {} })
    expect(dmReview.applied.map(n => n.id)).toEqual([inDm.todo.id])
    expect(t.todos.get(inGroup.todo.id)?.status).toBe('open')
    // 身份不一致时什么都不做
    expect(await t.host.review({ owner: 'ou_bob', audience: t.audience(t.group), assertWritable: () => {} })).toEqual({ applied: [], suggested: [] })
    expect(t.todos.get(inGroup.todo.id)?.status).toBe('open')
  })
})

describe('todo list API and MCP with completion evidence', () => {
  async function apiFixture() {
    const t = fixture()
    const feishu = new FakeFeishu(), log = createLogger('todo-completion-host-test', 'error'), tokens = new TokenIssuer('synthetic')
    const state = { actor: { requesterOpenId: 'ou_alice' as string | undefined, runId: 'run-a', stage: 'task' }, safe: true }
    const api = createInternalApi({ registry: t.registry, memory: new ChannelMemory(t.registry.db), spaces: t.spaces, policy: t.policy, todos: t.todos,
      feishu: asFeishuClient(feishu), messageCache: t.cache, messages: new MessageService(asFeishuClient(feishu), t.cache, log), tokens, log, maxHistoryPerCall: 50,
      todoCompletion: t.host,
      resolveActorForSession: () => state.actor,
      canPersistDerivedState: () => state.safe })
    await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
    cleanups.push(async () => { api.server.closeAllConnections(); await new Promise<void>(resolve => api.server.close(() => resolve())) })
    const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
    const caps = {
      dm: { sessionKey: 'dm:ou_alice', runId: 'run-a', chatId: t.dm.chatId!, chatType: 'p2p' as const, spaceId: t.dm.id, requesterOpenId: 'ou_alice', scopes: [...ALL_SCOPES] },
      group: { sessionKey: 'msg:1', runId: 'run-a', chatId: t.group.chatId!, chatType: 'group' as const, spaceId: t.group.id, requesterOpenId: 'ou_alice', scopes: [...GROUP_SCOPES] },
    }
    const post = async (cap: Omit<Capability, 'exp'>, body: Record<string, unknown> = {}) => {
      const res = await fetch(`${base}/v1/todo/list`, { method: 'POST', headers: { authorization: `Bearer ${tokens.issue(cap)}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return { status: res.status, body: await res.json() as Record<string, any> }
    }
    const tool = async (cap: Omit<Capability, 'exp'>) => {
      const server = buildServer({ apiUrl: base, token: tokens.issue(cap) })
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await server.connect(serverTransport)
      const client = new Client({ name: 'test-client', version: '0.0.0' })
      await client.connect(clientTransport)
      cleanups.push(() => client.close())
      const res = await client.callTool({ name: 'friday_todo_list', arguments: {} }) as { content: { text: string }[] }
      return res.content.map(item => item.text).join('\n')
    }
    return { ...t, state, caps, post, tool }
  }

  it('applies definite evidence before listing and tells the model what was marked and what only needs confirmation', async () => {
    const t = await apiFixture()
    const done = t.record(t.dm, '整理项目风险清单')
    t.say(t.dm, done.root, '做完了')
    const pending = t.record(t.dm, '发布说明')
    t.say(t.dm, pending.root, '应该写完了吧')
    const listed = await t.post(t.caps.dm)
    expect(listed.status).toBe(200)
    expect(listed.body.todos.map((todo: { id: number }) => todo.id)).toEqual([pending.todo.id])
    expect(listed.body.completion).toMatchObject({ applied: [{ id: done.todo.id }], suggested: [{ id: pending.todo.id }] })
    expect(t.todos.get(done.todo.id)).toMatchObject({ status: 'done', statusBy: EVIDENCE_COMPLETION_ACTOR })
    const again = await t.tool(t.caps.dm)
    expect(again).not.toContain('我按依据标了完成')
    expect(again).toContain('看起来做完了，但没有改状态')
    expect(again).toContain(`[todo:${pending.todo.id}]`)
  })

  it('renders the applied list through MCP with the undo sentence', async () => {
    const t = await apiFixture()
    const done = t.record(t.group, '整理项目风险清单')
    t.say(t.group, done.root, '做完了')
    const text = await t.tool(t.caps.group)
    expect(text).toContain('这几条我按依据标了完成')
    expect(text).toContain('不对的话说一声，我改回来')
    expect(text).toContain(`[todo:${done.todo.id}] 整理项目风险清单：依据：你在这条待办的原话题里说已经完成`)
    expect(t.todos.get(done.todo.id)?.status).toBe('done')
  })

  it('only lists definite items when this run may not write personal state', async () => {
    const t = await apiFixture()
    const done = t.record(t.dm, '整理项目风险清单')
    t.say(t.dm, done.root, '做完了')
    t.state.safe = false
    const listed = await t.post(t.caps.dm)
    expect(listed.status).toBe(200)
    expect(listed.body.completion.applied).toEqual([])
    expect(listed.body.completion.suggested).toMatchObject([{ id: done.todo.id, notApplied: expect.stringContaining('本轮不能写入个人状态') }])
    expect(t.todos.get(done.todo.id)?.status).toBe('open')
    expect(t.evidenceRows()).toEqual([])
  })

  it.each(['routine', 'reflect'] as const)('does not judge or write during a %s run', async stage => {
    const t = await apiFixture()
    const done = t.record(t.dm, '整理项目风险清单')
    t.say(t.dm, done.root, '做完了')
    t.state.actor.stage = stage
    const listed = await t.post(t.caps.dm)
    expect(listed.status).toBe(200)
    expect(listed.body.completion).toBeUndefined()
    expect(t.todos.get(done.todo.id)?.status).toBe('open')
  })

  it('does not judge for a proactive group run without a person', async () => {
    const t = await apiFixture()
    const done = t.record(t.group, '整理项目风险清单')
    t.say(t.group, done.root, '做完了')
    t.state.actor = { requesterOpenId: undefined, runId: 'run-a', stage: 'routine' }
    const { requesterOpenId: _requester, ...cap } = t.caps.group
    const listed = await t.post({ ...cap, sessionKey: 'proactive:oc_team', scopes: [...PROACTIVE_SCOPES] })
    expect(listed.status).toBe(200)
    expect(listed.body.completion).toBeUndefined()
    expect(t.todos.get(done.todo.id)?.status).toBe('open')
  })

  it('lists but does not write when the capability cannot write todos', async () => {
    const t = await apiFixture()
    const done = t.record(t.dm, '整理项目风险清单')
    t.say(t.dm, done.root, '做完了')
    const listed = await t.post({ ...t.caps.dm, scopes: ['todo:read'] })
    expect(listed.status).toBe(200)
    expect(listed.body.completion.suggested).toMatchObject([{ id: done.todo.id, notApplied: '本轮不能写入个人状态（该会话没有 todo:write 权限）' }])
    expect(t.todos.get(done.todo.id)?.status).toBe('open')
  })
})
