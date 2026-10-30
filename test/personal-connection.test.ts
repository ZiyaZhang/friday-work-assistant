import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChannelMemory } from '../src/core/memory.js'
import { MemoryRuntime } from '../src/core/memory-runtime.js'
import { PersonalConnectionApplication } from '../src/core/personal-connection.js'
import { Registry } from '../src/core/registry.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { UserTokenStore, type TokenExchange } from '../src/feishu/oauth.js'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })

async function fixture() {
  const registry = new Registry(':memory:'), db = registry.db, memory = new ChannelMemory(db), attempts = new RunAttempts(db)
  cleanup.push(() => registry.close())
  const provider = { exchangeCode: vi.fn(async (): Promise<TokenExchange> => ({
    accessToken: 'SYNTHETIC_ACCESS_1', refreshToken: 'SYNTHETIC_REFRESH_1', expiresIn: 7200, scope: 'im:message:readonly',
  })), refresh: vi.fn(async (): Promise<TokenExchange> => ({ accessToken: 'SYNTHETIC_REFRESHED', expiresIn: 7200 })) }
  const tokens = new UserTokenStore(db, provider, () => 1_000)
  const connect = () => tokens.complete({ openId: 'alice', code: 'synthetic', redirectUri: 'https://callback.invalid' })
  const originalToken = await connect()
  const note = memory.add({ scope: 'space:sp_dm_alice', kind: 'fact', title: 'synthetic', body: 'synthetic',
    provenance: { state: 'verified', originRunId: 'synthetic-origin', sources: [{ ref: 'synthetic-source', appId: 'synthetic-app',
      tenantId: 'synthetic-tenant', spaceId: 'synthetic-group-space', chatId: 'synthetic-group', messageId: 'synthetic-message',
      readIdentity: { kind: 'user', openId: 'alice' }, readAt: 1, coverage: 'complete' }] } })
  const copy = memory.promote(note.id, note.scope, 'org')!
  registry.createSession({ sessionKey: 's', chatId: 'dm', chatType: 'p2p', requesterOpenId: 'alice', cwd: '/synthetic' })
  const task = registry.createTask({ sessionKey: 's', messageId: 'synthetic-task', requesterOpenId: 'alice', prompt: 'synthetic' })
  const run = attempts.begin({ sessionKey: 's', workKey: `task:${task.id}`, triggerKey: `task:${task.id}`, stage: 'task',
    taskId: task.id, actorOpenId: 'alice', now: 10 }, () => registry.startTask(task.id, 10, 's'))!
  const abort = vi.fn()
  const runtime = new MemoryRuntime({ registry, memory, attempts, now: () => 100,
    activeRun: id => id === run.id ? { runId: id, abort } : undefined })
  attempts.bindRuntime(run.id, 'acp'); runtime.contexts.bind(run.id, 's', 'acp')
  // A synthetic pre-existing managed consumer. This test verifies invalidation/commit,
  // not authorization or the not-yet-enabled managed read path.
  db.prepare('UPDATE runtime_contexts SET notes_json=? WHERE acp_id=?').run(JSON.stringify([{ id: copy.id, revision: copy.revision }]), 'acp')
  const app = new PersonalConnectionApplication({ registry, userTokens: tokens, memory: runtime })
  const snapshot = () => ['user_tokens', 'memory_notes', 'memory_provenance', 'memory_changes', 'memory_tombstones',
    'runtime_contexts', 'run_contexts', 'run_attempts', 'tasks', 'sqlite_sequence']
    .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all())
  return { registry, db, memory, attempts, tokens, originalToken, provider, connect, note, copy, task, run, abort, runtime, app, snapshot }
}

describe('personal connection removal and derived source invalidation', () => {
  it('commits the token, original/copy revisions and exact run/task stop before aborting', async () => {
    const t = await fixture()
    t.abort.mockImplementation(() => {
      // Starting a new transaction here proves the operation released its outer transaction.
      t.db.exec('BEGIN'); t.db.exec('ROLLBACK')
      expect(t.tokens.get('alice')).toBeUndefined()
      expect(t.memory.getProvenance(t.note.id)?.state).toBe('unavailable')
      expect(t.memory.getProvenance(t.copy.id)?.state).toBe('unavailable')
      expect(t.attempts.get(t.run.id)?.stopReason).toBe('memory_context_invalidated')
      expect(t.registry.getTask(t.task.id)?.stopReason).toBe('memory_context_invalidated')
    })
    expect(t.app.disconnect('alice', t.originalToken)).toBe(true)
    expect(t.abort).toHaveBeenCalledOnce()
    expect(t.runtime.contexts.contextForRun(t.run.id)?.state).toBe('invalidated')
    const before = t.snapshot()
    expect(t.app.disconnect('alice')).toBe(false)
    expect(t.snapshot()).toEqual(before)
    expect(t.abort).toHaveBeenCalledOnce()
  })

  it('rolls the removed token and all memory effects back when a late task write fails', async () => {
    const t = await fixture(), before = t.snapshot()
    t.db.exec("CREATE TRIGGER fail_disconnect_stop BEFORE UPDATE OF stop_reason ON tasks BEGIN SELECT RAISE(ABORT,'synthetic persistence failure'); END")
    expect(() => t.app.disconnect('alice')).toThrow('synthetic persistence failure')
    expect(t.snapshot()).toEqual(before)
    expect(t.abort).not.toHaveBeenCalled()
  })

  it('does not invalidate any source if token removal itself fails', async () => {
    const t = await fixture(), before = t.snapshot()
    t.db.exec("CREATE TRIGGER fail_disconnect_token BEFORE DELETE ON user_tokens BEGIN SELECT RAISE(ABORT,'synthetic token failure'); END")
    expect(() => t.app.disconnect('alice')).toThrow('synthetic token failure')
    expect(t.snapshot()).toEqual(before)
    expect(t.abort).not.toHaveBeenCalled()
  })

  it('rejects nesting rather than aborting an execution before its caller rolls back', async () => {
    const t = await fixture(), before = t.snapshot()
    t.db.exec('BEGIN')
    try {
      expect(() => t.app.disconnect('alice')).toThrow()
      expect(t.snapshot()).toEqual(before)
      expect(t.abort).not.toHaveBeenCalled()
    } finally { t.db.exec('ROLLBACK') }
    expect(t.snapshot()).toEqual(before)
  })

  it('a late wrong-account result for an old token cannot remove a replacement grant or invalidate its sources', async () => {
    const t = await fixture()
    t.provider.exchangeCode.mockResolvedValue({ accessToken: 'SYNTHETIC_ACCESS_2', refreshToken: 'SYNTHETIC_REFRESH_2',
      expiresIn: 7200, scope: 'im:message:readonly' })
    const replacement = await t.connect(), before = t.snapshot()
    expect(t.app.disconnect('alice', t.originalToken)).toBe(false)
    expect(t.tokens.get('alice')).toEqual(replacement)
    expect(t.snapshot()).toEqual(before)
    expect(t.abort).not.toHaveBeenCalled()
  })

  it('recognizes a replacement authority even when token bytes and timestamps match but scope changed', async () => {
    const t = await fixture()
    t.provider.exchangeCode.mockResolvedValue({ accessToken: t.originalToken.accessToken, refreshToken: t.originalToken.refreshToken!,
      expiresIn: 7200, scope: 'im:chat:readonly' })
    await t.connect(); const before = t.snapshot()
    expect(t.app.disconnect('alice', t.originalToken)).toBe(false)
    expect(t.snapshot()).toEqual(before)
    expect(t.abort).not.toHaveBeenCalled()
  })

  it('explicit disconnect still withdraws remembered source use if the token row was already absent', async () => {
    const t = await fixture()
    t.tokens.disconnect('alice')
    expect(t.app.disconnect('alice', t.originalToken)).toBe(false) // stale validation has no current grant to remove
    expect(t.memory.getProvenance(t.note.id)?.state).toBe('verified')
    expect(t.abort).not.toHaveBeenCalled()
    expect(t.app.disconnect('alice')).toBe(false) // explicit human action also stops outstanding remembered use
    expect(t.memory.getProvenance(t.note.id)?.state).toBe('unavailable')
    expect(t.abort).toHaveBeenCalledOnce()
  })

  it('preserves an existing explicit stop and does not stop unrelated source owners', async () => {
    const t = await fixture()
    const before = t.snapshot()
    expect(t.app.disconnect('bob')).toBe(false)
    expect(t.snapshot()).toEqual(before)
    t.attempts.requestStop(t.run.id, 'user_requested'); t.registry.requestStop(t.task.id, 'user_requested')
    expect(t.app.disconnect('alice')).toBe(true)
    expect(t.attempts.get(t.run.id)?.stopReason).toBe('user_requested')
    expect(t.registry.getTask(t.task.id)?.stopReason).toBe('user_requested')
    expect(t.abort).not.toHaveBeenCalled()
  })
})
