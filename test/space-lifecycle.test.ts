import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Registry, type SessionRow } from '../src/core/registry.js'
import { RoutineStore } from '../src/core/routines.js'
import { Spaces } from '../src/core/space.js'
import { SpaceLifecycle } from '../src/core/space-lifecycle.js'

const T0 = Date.UTC(2026, 8, 19)
const registries = new Set<Registry>()
const directories: string[] = []
afterEach(() => {
  for (const registry of registries) registry.close()
  registries.clear()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function setup(path = ':memory:') {
  const registry = new Registry(path)
  registries.add(registry)
  const spaces = new Spaces(registry.db)
  const routines = new RoutineStore(registry.db)
  const a = spaces.ensure({ kind: 'group', chatId: 'oc_a', openId: 'ou_owner', title: 'A' })
  const b = spaces.ensure({ kind: 'group', chatId: 'oc_b', openId: 'ou_other', title: 'B' })
  const stopRuntime = vi.fn(async (_sessions: SessionRow[]) => {})
  const lifecycle = new SpaceLifecycle({ registry, spaces, routines, stopRuntime })
  return { registry, spaces, routines, a, b, stopRuntime, lifecycle }
}

function addSession(registry: Registry, chatId: string, suffix: string) {
  const key = `${chatId}:${suffix}`
  registry.createSession({ sessionKey: key, chatId, chatType: 'group', cwd: `/synthetic/${key}`, requesterOpenId: 'ou_owner' })
  registry.updateSession(key, { acpSessionId: `acp:${key}`, status: 'running' })
  registry.addAlias(`thread:${key}`, key)
  registry.addAlias(`message:${key}`, key)
  const queued = registry.createTask({ sessionKey: key, messageId: `queued:${key}`, prompt: 'queued' })
  const running = registry.createTask({ sessionKey: key, messageId: `running:${key}`, prompt: 'running' })
  registry.updateTask(running.id, { status: 'running', startedAt: T0 })
  const done = registry.createTask({ sessionKey: key, messageId: `done:${key}`, prompt: 'finished' })
  registry.updateTask(done.id, { status: 'done', stopReason: 'end_turn', finishedAt: T0 })
  return { key, queued: queued.id, running: running.id, done: done.id }
}

function addRoutine(t: ReturnType<typeof setup>, name: string, options: { once?: boolean; other?: boolean; legacy?: boolean } = {}) {
  const space = options.other ? t.b : t.a
  const routine = t.routines.add({
    kind: 'watch', name, prompt: `Read ${name}`, ownerOpenId: 'ou_owner',
    spaceId: options.legacy ? undefined : space.id, chatId: space.chatId!, chatType: 'group',
    schedule: options.once ? { type: 'once', atMs: T0 + 600_000 } : { type: 'interval', everyMinutes: 10 },
    watchChatIds: ['oc_source'], deliverTo: 'dm', now: T0,
  })
  t.routines.recordRun(routine.id, 'ok', T0 - 1000)
  return t.routines.get(routine.id)!
}

function snapshot(t: ReturnType<typeof setup>) {
  return Object.fromEntries(['space_rooms', 'space_members', 'sessions', 'aliases', 'tasks', 'routines', 'routine_occurrences'].map((table) => [
    table, t.registry.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  ]))
}

describe('SpaceLifecycle durable stop boundary', () => {
  it('archives every session beyond the recent-20 limit, removes aliases and cancels only unfinished tasks in that chat', async () => {
    const t = setup()
    const all = Array.from({ length: 27 }, (_, i) => addSession(t.registry, 'oc_a', String(i)))
    // Old archived sessions may still have stale aliases or unfinished tasks after an interrupted cleanup.
    const archived = addSession(t.registry, 'oc_a', 'already-archived')
    t.registry.updateSession(archived.key, { status: 'archived' })
    const other = addSession(t.registry, 'oc_b', 'unrelated')
    const otherBefore = {
      session: t.registry.getSession(other.key),
      tasks: t.registry.db.prepare('SELECT * FROM tasks WHERE session_key = ? ORDER BY id').all(other.key),
      aliases: t.registry.db.prepare('SELECT * FROM aliases WHERE session_key = ? ORDER BY alias').all(other.key),
    }
    t.stopRuntime.mockImplementation(async (sessions) => {
      expect(sessions.map((s) => s.sessionKey).sort()).toEqual(all.map((s) => s.key).sort())
      expect(sessions.every((s) => s.acpSessionId === `acp:${s.sessionKey}`)).toBe(true)
      expect(t.spaces.get(t.a.id)?.status).toBe('archived')
      expect(t.registry.db.prepare("SELECT COUNT(*) n FROM tasks WHERE status IN ('queued', 'running') AND session_key IN (SELECT session_key FROM sessions WHERE chat_id = 'oc_a')").get()).toMatchObject({ n: 0 })
    })

    expect(await t.lifecycle.stop(t.a.id)).toEqual({ stoppedRoutines: 0 })
    for (const session of [...all, archived]) {
      expect(t.registry.getSession(session.key)?.status).toBe('archived')
      expect(t.registry.resolveSession([`thread:${session.key}`, `message:${session.key}`])).toBeUndefined()
      for (const id of [session.queued, session.running]) {
        expect(t.registry.getTask(id)).toMatchObject({ status: 'cancelled', stopReason: 'space_disabled', finishedAt: expect.any(Number) })
      }
      expect(t.registry.getTask(session.done)).toMatchObject({ status: 'done', stopReason: 'end_turn', finishedAt: T0 })
    }
    expect(t.registry.db.prepare("SELECT COUNT(*) n FROM aliases WHERE session_key LIKE 'oc_a:%'").get()).toMatchObject({ n: 0 })
    expect({
      session: t.registry.getSession(other.key),
      tasks: t.registry.db.prepare('SELECT * FROM tasks WHERE session_key = ? ORDER BY id').all(other.key),
      aliases: t.registry.db.prepare('SELECT * FROM aliases WHERE session_key = ? ORDER BY alias').all(other.key),
    }).toEqual(otherBefore)
    expect(t.spaces.get(t.b.id)).toEqual(t.b)
    expect(t.stopRuntime).toHaveBeenCalledTimes(1)
  })

  it('pauses active and once-pending routines, cancels their occurrences and preserves cursors plus manual pause reasons', async () => {
    const t = setup()
    const pending = addRoutine(t, 'interval-pending')
    const running = addRoutine(t, 'interval-running')
    const oncePending = addRoutine(t, 'once-pending', { once: true })
    const onceRunning = addRoutine(t, 'once-running', { once: true })
    const legacy = addRoutine(t, 'legacy-same-chat', { legacy: true })
    const manual = addRoutine(t, 'manual')
    t.routines.setEnabled(manual.id, false, T0)
    const manualBefore = t.routines.get(manual.id)
    const manualVersion = t.routines.configVersion(manual.id)
    const other = addRoutine(t, 'other', { other: true })
    const otherOccurrence = t.routines.claimDueOccurrence(other.id, other.nextRunAt, other.nextRunAt)!
    const otherBefore = t.routines.get(other.id)
    const affected = [pending, running, oncePending, onceRunning, legacy]
    const occurrences = affected.map((r) => t.routines.claimDueOccurrence(r.id, r.nextRunAt, r.nextRunAt)!)
    for (const index of [1, 3]) t.routines.startOccurrence(occurrences[index]!.id, affected[index]!.nextRunAt)
    const before = affected.map((r) => ({ routine: t.routines.get(r.id)!, version: t.routines.configVersion(r.id)! }))

    expect(await t.lifecycle.stop(t.a.id)).toEqual({ stoppedRoutines: 5 })
    for (const { routine, version } of before) {
      expect(t.routines.get(routine.id)).toMatchObject({
        enabled: false, disabledReason: '空间已停用', lastRunAt: routine.lastRunAt,
        nextRunAt: routine.nextRunAt, runs: routine.runs, lastStatus: routine.lastStatus,
        prompt: routine.prompt, watchChatIds: routine.watchChatIds, deliverTo: routine.deliverTo,
      })
      expect(t.routines.configVersion(routine.id)).toBe(version + 1)
    }
    for (const occurrence of occurrences) {
      expect(t.routines.getOccurrence(occurrence.id)).toMatchObject({ status: 'cancelled', error: '空间已停用', finishedAt: expect.any(Number) })
      expect(t.routines.startOccurrence(occurrence.id, T0 + 700_000)).toBeUndefined()
      expect(t.routines.finishOccurrence(occurrence.id, 'ok', T0 + 700_000)).toBeUndefined()
    }
    expect(t.routines.get(manual.id)).toEqual(manualBefore)
    expect(t.routines.configVersion(manual.id)).toBe(manualVersion)
    expect(t.routines.get(other.id)).toEqual(otherBefore)
    expect(t.routines.getOccurrence(otherOccurrence.id)).toEqual(otherOccurrence)
    expect(await t.lifecycle.stop(t.a.id)).toEqual({ stoppedRoutines: 0 })
    for (const { routine, version } of before) expect(t.routines.configVersion(routine.id)).toBe(version + 1)
  })

  it('rolls back the space, routines, occurrences, tasks and aliases together if the final database update fails', async () => {
    const t = setup()
    addSession(t.registry, 'oc_a', 'rollback')
    const routine = addRoutine(t, 'rollback-routine')
    const occurrence = t.routines.claimDueOccurrence(routine.id, routine.nextRunAt, routine.nextRunAt)!
    t.routines.startOccurrence(occurrence.id, routine.nextRunAt)
    const before = snapshot(t)
    t.registry.db.exec("CREATE TRIGGER reject_session_archive BEFORE UPDATE OF status ON sessions WHEN NEW.status = 'archived' BEGIN SELECT RAISE(ABORT, 'synthetic lifecycle storage failure'); END")

    await expect(t.lifecycle.stop(t.a.id)).rejects.toThrow('synthetic lifecycle storage failure')
    expect(snapshot(t)).toEqual(before)
    expect(t.stopRuntime).not.toHaveBeenCalled()
    t.registry.db.exec('DROP TRIGGER reject_session_archive')
    expect(await t.lifecycle.stop(t.a.id)).toEqual({ stoppedRoutines: 1 })
    expect(t.spaces.get(t.a.id)?.status).toBe('archived')
  })

  it('keeps the committed stop across a real database reopen when runtime cancellation fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'friday-space-stop-'))
    directories.push(dir)
    const path = join(dir, 'registry.sqlite')
    const t = setup(path)
    const session = addSession(t.registry, 'oc_a', 'runtime-failure')
    const routine = addRoutine(t, 'runtime-failure-routine')
    t.stopRuntime.mockRejectedValue(new Error('synthetic ACP close failure'))
    await expect(t.lifecycle.stop(t.a.id)).rejects.toThrow('synthetic ACP close failure')
    t.registry.close()
    registries.delete(t.registry)

    const registry = new Registry(path)
    registries.add(registry)
    const spaces = new Spaces(registry.db)
    const routines = new RoutineStore(registry.db)
    expect(spaces.ensure({ kind: 'group', chatId: 'oc_a', openId: 'ou_new_owner' })).toMatchObject({ id: t.a.id, chatId: 'oc_a', status: 'archived' })
    expect(registry.getSession(session.key)?.status).toBe('archived')
    expect(registry.resolveSession([`thread:${session.key}`])).toBeUndefined()
    expect(registry.getTask(session.running)?.status).toBe('cancelled')
    expect(routines.get(routine.id)).toMatchObject({ enabled: false, disabledReason: '空间已停用', lastRunAt: routine.lastRunAt })
    expect(spaces.roleOf(t.a.id, 'ou_new_owner')).toBeUndefined()
  })

  it('does not replace or revive a stopped space when stores are rebuilt on the same database', async () => {
    const t = setup()
    t.spaces.patchConfig(t.a.id, { notes: ['SYNTHETIC_SPACE_KNOWLEDGE'], brevity: 'short' })
    await t.lifecycle.stop(t.a.id)
    const before = t.spaces.get(t.a.id)
    const rebuilt = new Spaces(t.registry.db)
    expect(rebuilt.byChat('oc_a')).toBeUndefined()
    expect(rebuilt.ensure({ kind: 'group', chatId: 'oc_a', openId: 'ou_new', owners: ['ou_new'], title: 'replacement' })).toEqual(before)
    expect(rebuilt.listAll(true)).toHaveLength(2)
    expect(rebuilt.owners(t.a.id)).toEqual(['ou_owner'])
  })

  it('rejects an unknown or unbound space without changing storage or contacting the runtime', async () => {
    const t = setup()
    const dm = t.spaces.dm('ou_dm')
    const before = snapshot(t)
    for (const id of ['sp_missing', dm.id]) await expect(t.lifecycle.stop(id)).rejects.toThrow('找不到当前群绑定')
    expect(snapshot(t)).toEqual(before)
    expect(t.stopRuntime).not.toHaveBeenCalled()
  })
})
