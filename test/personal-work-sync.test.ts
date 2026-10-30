import { afterEach, describe, expect, it, vi } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { Todos } from '../src/core/todos.js'
import { TodoApplication } from '../src/core/todo-application.js'
import { PersonalCollectionStore } from '../src/core/personal-collection.js'
import { PersonalWorkSync, personalGitHubSource } from '../src/core/personal-work-sync.js'
import { readPersonalGitHubWork, type PersonalGitHubState } from '../src/github/personal-work.js'

const URL = 'https://github.com/team/repo/pull/41', SHA = 'a'.repeat(40), NOW = Date.parse('2026-09-30T08:00:00Z')
const registries: Registry[] = []
afterEach(() => registries.splice(0).forEach(registry => registry.close()))
const pr = (patch: Record<string, unknown> = {}) => ({ state: 'open', updated_at: new Date(NOW).toISOString(), head: { sha: SHA },
  merged: false, draft: false, requested_reviewers: [], ...patch })
function github(replies: unknown[]) {
  return { repoAllowed: vi.fn(() => true), api: vi.fn(async () => replies.shift()) } as any
}

describe('GitHub facts for personal work', () => {
  it('removes a native assignment when GitHub explicitly assigns it away, without closing a Feishu commitment', async () => {
    const item = { state: 'open', assignees: [{ login: 'someone-else' }], updated_at: new Date(NOW).toISOString() }
    const source = { url: 'https://github.com/team/repo/issues/42', completion: 'issue_closed' as const }
    expect(await readPersonalGitHubWork(github([item]), { ...source, relationship: 'assigned' }, { login: 'owner', assertCurrent() {} }))
      .toMatchObject({ completion: 'cancelled', note: 'Issue #42 已不再分配给你' })
    expect((await readPersonalGitHubWork(github([item]), source, { login: 'owner', assertCurrent() {} })).completion).toBeUndefined()
    expect((await readPersonalGitHubWork(github([{ ...item, assignees: [{ login: 'owner' }] }]), { ...source, relationship: 'assigned' },
      { login: 'owner', assertCurrent() {} })).completion).toBeUndefined()
  })

  it('distinguishes merged work from a closed unmerged request', async () => {
    for (const merged of [true, false]) {
      const g = github([pr({ state: 'closed', merged }), pr({ state: 'closed', merged })])
      const result = await readPersonalGitHubWork(g, { url: URL, completion: 'merged' }, { assertCurrent() {} })
      expect(result.completion).toBe(merged ? 'done' : 'cancelled')
      expect(g.api.mock.calls.every((args: any[]) => args[0] === 'GET')).toBe(true)
    }
  })
  it.each(['completed', 'not_planned', null])('does not equate all closed issues with completion: %s', async reason => {
    const result = await readPersonalGitHubWork(github([{ state: 'closed', state_reason: reason, updated_at: new Date(NOW).toISOString() }]),
      { url: 'https://github.com/team/repo/issues/42', completion: 'issue_closed' }, { assertCurrent() {} })
    expect(result.completion).toBe(reason === 'completed' ? 'done' : reason === 'not_planned' ? 'cancelled' : undefined)
  })
  it.each(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'PENDING', 'DISMISSED'])('requires a submitted current-head review by the known owner: %s', async state => {
    const g = github([pr(), [{ id: 1, user: { login: 'Owner' }, state, commit_id: SHA, submitted_at: new Date(NOW).toISOString() }], pr()])
    const result = await readPersonalGitHubWork(g, { url: URL, completion: 'reviewed' }, { login: 'owner', assertCurrent() {} })
    expect(result.reviewed).toBe(['APPROVED', 'CHANGES_REQUESTED'].includes(state))
  })
  it('does not reuse an old review after a new request or infer a personal login from the shared credential', async () => {
    for (const login of [undefined, 'owner']) {
      const body = pr({ requested_reviewers: [{ login: 'owner' }] }), g = github([body, body])
      const result = await readPersonalGitHubWork(g, { url: URL, completion: 'reviewed' }, { login, assertCurrent() {} })
      expect(result.reviewed).toBe(false); expect(result.completion).toBeUndefined()
      expect(g.api).toHaveBeenCalledTimes(2)
    }
  })
  it('rejects mixed heads, incomplete review pagination and revoked access', async () => {
    await expect(readPersonalGitHubWork(github([pr(), [], pr({ head: { sha: 'b'.repeat(40) } })]),
      { url: URL, completion: 'reviewed' }, { login: 'owner', assertCurrent() {} })).rejects.toThrow('变化')
    const page = Array.from({ length: 100 }, (_, id) => ({ id, state: 'COMMENTED' }))
    await expect(readPersonalGitHubWork(github([pr(), page, page]), { url: URL, completion: 'reviewed' },
      { login: 'owner', assertCurrent() {} })).rejects.toThrow('分页')
    const g = github([pr()]); g.api.mockImplementationOnce(async () => { g.repoAllowed.mockReturnValue(false); return pr() })
    await expect(readPersonalGitHubWork(g, { url: URL, completion: 'merged' }, { assertCurrent() {} })).rejects.toThrow('范围')
  })
})

function fixture() {
  const registry = new Registry(':memory:'); registries.push(registry)
  const todos = new Todos(registry.db), clock = { now: NOW, readable: true, allowed: true }, now = () => clock.now
  const store = new PersonalCollectionStore(registry.db, todos, now), application = new TodoApplication({ db: registry.db, todos })
  const audience = { openId: 'owner', chatType: 'p2p' as const, chatId: 'oc_friday', scope: 'space:sp_dm_owner' }
  store.configure('owner', true)
  const text = `请评审 ${URL}`
  store.commit({ profile: store.profile('owner')!, cursor: store.next('owner')!, audience, candidates: [], assertCurrent() {},
    messages: [{ text, senderName: 'requester', mentions: ['owner'], metadata: { chatId: 'oc_source', chatType: 'group', messageId: 'om_source',
      senderOpenId: 'requester', msgType: 'text', createTimeMs: NOW, link: { status: 'unavailable' } } }],
    decisions: [{ messageId: 'om_source', quote: text, title: '评审 PR #41', kind: 'todo', relationship: 'requested', operation: 'record',
      existingId: null, dueMs: null, github: { url: URL, completion: 'reviewed' } }] })
  const read = vi.fn(async (): Promise<PersonalGitHubState> => ({ url: URL, head: SHA, state: 'closed', merged: true, updatedAt: new Date(NOW).toISOString(),
    note: 'PR #41 已合并', completion: 'done' })), readSource = vi.fn(async () => {}), onChange = vi.fn(async () => {})
  const deps = { registry, todos, now, enabled: () => true, audience: () => audience, readable: () => clock.readable,
    canRead: () => clock.allowed, read, readSource, onChange }
  return { registry, todos, clock, store, application, audience, read, readSource, onChange, deps, sync: new PersonalWorkSync(deps) }
}

describe('background personal work reconciliation', () => {
  it('automatically closes the linked task, records the fact, survives restart and reopens on a genuine source change', async () => {
    const t = fixture(); await t.sync.tick()
    expect(t.todos.get(1)).toMatchObject({ status: 'done', statusBy: 'personal-github', statusNote: 'PR #41 已合并' })
    const next = new PersonalWorkSync(t.deps); await next.tick()
    expect(t.read).toHaveBeenCalledTimes(1)
    t.clock.now += 300_001
    t.read.mockResolvedValue({ url: URL, head: SHA, state: 'open', updatedAt: new Date(t.clock.now).toISOString(), note: 'PR 仍开放' })
    await next.tick(); expect(t.todos.get(1)?.status).toBe('open')
    expect(t.onChange).toHaveBeenCalledTimes(2)
  })
  it('does not re-close a manually corrected item or quietly replace manual edits', async () => {
    const t = fixture(); await t.sync.tick()
    t.application.update(1, t.audience, { current: true, patch: { status: 'open' } }, 'owner')
    for (let i = 0; i < 2; i++) { t.clock.now += 300_001; await t.sync.tick(); expect(t.todos.get(1)?.status).toBe('open') }
  })
  it.each(['scope', 'edit', 'pause'])('guards late network results after %s changes', async change => {
    const t = fixture()
    t.read.mockImplementationOnce(async () => {
      if (change === 'scope') t.clock.readable = false
      if (change === 'pause') t.store.configure('owner', false)
      if (change === 'edit') t.application.update(1, t.audience, { current: true, patch: { title: '先不要处理' } }, 'owner')
      return { url: URL, state: 'closed', updatedAt: new Date(NOW).toISOString(), note: 'merged', completion: 'done' }
    })
    await t.sync.tick(); expect(t.todos.get(1)?.status).toBe('open')
    expect(t.sync.current('owner', t.todos.get(1)!)).toBeUndefined()
  })
  it('expires failed reads and will not offer stale or no-longer-authorized repository context', async () => {
    const t = fixture(); await t.sync.tick()
    expect(t.sync.current('owner', t.todos.get(1)!)).toBeDefined()
    t.clock.allowed = false; expect(t.sync.current('owner', t.todos.get(1)!)).toBeUndefined()
    t.clock.allowed = true; t.clock.now += 300_001; t.read.mockRejectedValue(new Error('unavailable'))
    await t.sync.tick(); expect(t.sync.current('owner', t.todos.get(1)!)).toBeUndefined()
    expect(t.todos.get(1)?.status).toBe('done')
  })
  it('does not turn a dependency PR into completion of deployment or a multi-object task', () => {
    const t = fixture(), source = t.todos.getProvenance(1)!, todo = t.todos.get(1)!
    expect(personalGitHubSource({ ...todo, title: '评审并发布客户端' }, source)).toBeUndefined()
    expect(personalGitHubSource(todo, { ...source, collection: { ...source.collection!, quote: `${source.collection!.quote} 和 https://github.com/team/repo/pull/42` } })).toBeUndefined()
  })
})
