import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Registry } from '../src/core/registry.js'
import type { InboundMessage } from '../src/feishu/mention.js'

const cleanups: (() => void)[] = []
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close() })
const input = { sessionKey: 'session-a', messageId: 'message-a', requesterOpenId: 'alice', prompt: '保留原来的问题，不另建单' }

function setup(legacy?: (db: DatabaseSync) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'friday-task-work-')), path = join(dir, 'registry.db')
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  if (legacy) {
    const db = new DatabaseSync(path)
    try { legacy(db) } finally { db.close() }
  }
  let registry = new Registry(path)
  cleanups.push(() => registry.close())
  return { path, get registry() { return registry }, reopen() { registry.close(); registry = new Registry(path) } }
}

function oldSchema(db: DatabaseSync) {
  db.exec(`CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_key TEXT NOT NULL, message_id TEXT NOT NULL,
    requester_open_id TEXT, prompt TEXT NOT NULL, status TEXT NOT NULL, stop_reason TEXT, error TEXT,
    card_message_id TEXT, started_at INTEGER, finished_at INTEGER, created_at INTEGER NOT NULL);
    CREATE TABLE task_amendments(task_id INTEGER PRIMARY KEY, prior_task_id INTEGER NOT NULL);`)
}

function oldTask(db: DatabaseSync, id: number, overrides: { messageId?: string; actor?: string; session?: string } = {}) {
  db.prepare(`INSERT INTO tasks(id, session_key, message_id, requester_open_id, prompt, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'done', ?)`).run(id, overrides.session ?? input.sessionKey,
    overrides.messageId ?? `old-${id}`, overrides.actor ?? input.requesterOpenId, `${input.prompt} ${id}`, id * 100)
}

const rows = (db: DatabaseSync) => db.prepare('SELECT * FROM tasks ORDER BY id').all()
const work = (registry: Registry, id: number) => registry.taskWork.get(id)
const expectedWork = (id: number) => ({ key: `task:${id}`, rootTaskId: id })

describe('Task work roots', () => {
  it('migrates a populated amendment chain without merging unrelated history or rewriting any original field', () => {
    let before: ReturnType<typeof rows> = []
    const t = setup(db => {
      oldSchema(db)
      for (const id of [2, 9, 12, 15, 16]) oldTask(db, id, id === 16 ? { messageId: 'old-2' } : {})
      db.exec('INSERT INTO task_amendments VALUES(9,2),(12,9)')
      before = rows(db)
    })
    expect(work(t.registry, 2)).toEqual(expectedWork(2))
    expect(work(t.registry, 9)).toEqual(expectedWork(2))
    expect(work(t.registry, 12)).toEqual(expectedWork(2))
    expect(work(t.registry, 15)).toEqual(expectedWork(15))
    expect(work(t.registry, 16)).toEqual(expectedWork(16)) // duplicate message is not a work relationship
    expect(rows(t.registry.db).map(({ work_root_task_id: _, ...old }) => old)).toEqual(before)
    const first = rows(t.registry.db)
    t.reopen()
    expect(rows(t.registry.db)).toEqual(first)
    expect(t.registry.db.prepare('PRAGMA quick_check').get()?.quick_check).toBe('ok')
  })

  it('leaves explicit broken or cross-origin old relations unresolved, including their descendants', () => {
    const t = setup(db => {
      oldSchema(db)
      oldTask(db, 2); oldTask(db, 10); oldTask(db, 11)
      oldTask(db, 12, { actor: 'bob' }); oldTask(db, 13, { session: 'session-b' })
      db.exec('INSERT INTO task_amendments VALUES(10,1),(11,10),(12,2),(13,2)')
    })
    for (const id of [10, 11, 12, 13]) expect(work(t.registry, id)).toBeUndefined()
    expect(() => t.registry.createTaskOnce({ ...input, messageId: 'cannot-inherit', workFromTaskId: 10 })).toThrow('工作关系不完整')
    t.reopen()
    expect(t.registry.db.prepare('SELECT work_root_task_id FROM tasks WHERE id >= 10').all()).toEqual(
      Array.from({ length: 4 }, () => ({ work_root_task_id: null })))
    expect(t.registry.taskForMessage('cannot-inherit')).toBeUndefined()
  })

  it('makes ordinary requests independent and inherits only actual amendments', () => {
    const t = setup()
    const first = t.registry.createTaskOnce(input).task
    const other = t.registry.createTaskOnce({ ...input, messageId: 'other' }).task
    const second = t.registry.createTaskOnce({ ...input, messageId: 'second', amendsTaskId: first.id, replaceQueued: true }).task
    const third = t.registry.createTaskOnce({ ...input, messageId: 'third', amendsTaskId: second.id }).task
    expect(work(t.registry, other.id)).toEqual(expectedWork(other.id))
    for (const task of [first, second, third]) expect(work(t.registry, task.id)).toEqual(expectedWork(first.id))
    expect(t.registry.getTask(first.id)?.stopReason).toBe('steered')
    expect(work(t.registry, 999)).toBeUndefined()
  })

  it('binds a host-verified Question reply without inventing an amendment and keeps that binding after reopen', () => {
    const t = setup()
    const origin = t.registry.createTaskOnce(input).task
    const amended = t.registry.createTaskOnce({ ...input, messageId: 'amended', amendsTaskId: origin.id }).task
    const reply = t.registry.createTaskOnce({ ...input, messageId: 'reply', prompt: '暂时不提供日志', workFromTaskId: amended.id }).task
    expect(t.registry.listAmendedTasks(reply.id)).toEqual([])
    expect(work(t.registry, reply.id)).toEqual(expectedWork(origin.id))
    t.reopen()
    expect(work(t.registry, reply.id)).toEqual(expectedWork(origin.id))
    const later = t.registry.createTaskOnce({ ...input, messageId: 'later', amendsTaskId: reply.id }).task
    expect(work(t.registry, later.id)).toEqual(expectedWork(origin.id))
    // Dedupe preserves the accepted binding even if an alias now routes elsewhere.
    const other = t.registry.createTaskOnce({ ...input, messageId: 'other' }).task
    expect(t.registry.createTaskOnce({ ...input, messageId: reply.messageId, sessionKey: 'new-session', workFromTaskId: other.id }))
      .toMatchObject({ created: false, task: { id: reply.id, sessionKey: input.sessionKey, prompt: reply.prompt } })
    expect(work(t.registry, reply.id)).toEqual(expectedWork(origin.id))
  })

  it('accepts two explicit sources only when they name the same work', () => {
    const t = setup(), original = t.registry.createTaskOnce(input).task
    const amended = t.registry.createTaskOnce({ ...input, messageId: 'amended', amendsTaskId: original.id }).task
    const same = t.registry.createTaskOnce({ ...input, messageId: 'same', amendsTaskId: amended.id, workFromTaskId: original.id }).task
    expect(work(t.registry, same.id)).toEqual(expectedWork(original.id))
    const other = t.registry.createTaskOnce({ ...input, messageId: 'other' }).task
    expect(() => t.registry.createTaskOnce({ ...input, messageId: 'conflict', amendsTaskId: amended.id, workFromTaskId: other.id })).toThrow('不同工作')
    expect(t.registry.taskForMessage('conflict')).toBeUndefined()
  })

  it.each(['missing', 'actor', 'session', 'system', 'no-receipt'] as const)('rejects a %s Question work source without creating work', boundary => {
    const t = setup(), original = t.registry.createTaskOnce(input).task
    const source = boundary === 'system' ? t.registry.createTaskOnce(input, 'routine:1:occurrence:2').task
      : boundary === 'no-receipt' ? t.registry.createTask({ ...input, messageId: 'no-receipt' }) : original
    const before = rows(t.registry.db)
    expect(() => t.registry.createTaskOnce({ ...input, messageId: 'reply', workFromTaskId: boundary === 'missing' ? 999 : source.id,
      ...(boundary === 'actor' ? { requesterOpenId: 'bob' } : {}), ...(boundary === 'session' ? { sessionKey: 'session-b' } : {}) }))
      .toThrow('本人发起的真实请求')
    expect(rows(t.registry.db)).toEqual(before)
    expect(t.registry.taskForMessage('reply')).toBeUndefined()
  })

  it.each(['root', 'receipt', 'dispatch'] as const)('rolls back task, root and all handoff records when %s persistence fails', boundary => {
    const t = setup(), original = t.registry.createTaskOnce(input).task
    const trigger = boundary === 'root' ? 'BEFORE UPDATE OF work_root_task_id ON tasks'
      : boundary === 'receipt' ? 'BEFORE INSERT ON task_receipts' : 'BEFORE INSERT ON task_dispatches'
    t.registry.db.exec(`CREATE TRIGGER fail_creation ${trigger} BEGIN SELECT RAISE(ABORT, 'disk fault'); END`)
    const inbound: InboundMessage = { eventId: 'event-reply', messageId: 'reply', chatId: 'chat-a', chatType: 'group',
      senderOpenId: 'alice', senderType: 'user', text: '补充', msgType: 'text', mentions: [], createTimeMs: 1 }
    expect(() => t.registry.createTaskOnce({ ...input, messageId: inbound.messageId, inbound,
      workFromTaskId: original.id, amendsTaskId: original.id, replaceQueued: true })).toThrow('disk fault')
    expect(rows(t.registry.db)).toHaveLength(1)
    expect(t.registry.getTask(original.id)?.status).toBe('queued')
    expect(t.registry.dispatches.pending()).toEqual([])
    expect(t.registry.db.prepare('SELECT * FROM task_amendments').all()).toEqual([])
    expect(t.registry.taskForMessage('reply')).toBeUndefined()
    t.registry.db.exec('DROP TRIGGER fail_creation')
    const accepted = t.registry.createTaskOnce({ ...input, messageId: 'reply', workFromTaskId: original.id }).task
    expect(work(t.registry, accepted.id)).toEqual(expectedWork(original.id))
  })

  it('keeps both binding and Task inside the outer Question transaction', () => {
    const t = setup(), original = t.registry.createTaskOnce(input).task
    t.registry.db.exec('BEGIN')
    const reply = t.registry.createTaskOnce({ ...input, messageId: 'reply', workFromTaskId: original.id }).task
    expect(work(t.registry, reply.id)).toEqual(expectedWork(original.id))
    t.registry.db.exec('ROLLBACK')
    expect(t.registry.getTask(reply.id)).toBeUndefined()
    expect(t.registry.taskForMessage('reply')).toBeUndefined()
    expect(work(t.registry, original.id)).toEqual(expectedWork(original.id))
  })

  it('passes the migration guard twice on a nonempty pre-work-root database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'friday-task-work-guard-')), source = join(dir, 'old.db'), protection = join(dir, 'protected')
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const old = new DatabaseSync(source)
    try {
      oldSchema(old)
      for (const id of [2, 9, 12, 15]) oldTask(old, id)
      old.exec('INSERT INTO task_amendments VALUES(9,2),(12,9)')
    } finally { old.close() }
    const guard = (...args: string[]) => {
      const run = spawnSync('python3', [resolve('scripts/database-migration-guard.py'), ...args], { encoding: 'utf8', timeout: 15000 })
      expect(run.status, run.stdout + run.stderr).toBe(0)
      return JSON.parse(run.stdout)
    }
    guard('backup', '--source', source, '--out-dir', protection)
    const result = guard('verify', '--protection-dir', protection, '--', process.execPath, resolve('scripts/upgrade-schema-copy.mjs'))
    expect(result).toMatchObject({ passed: true, protected_backup_unchanged: true,
      old_business_rows: { equal: true }, second_upgrade_idempotent: { equal: true } })
    const migrated = new DatabaseSync(join(result.run_dir, 'candidate.db'), { readOnly: true })
    try {
      expect(migrated.prepare('SELECT id,work_root_task_id FROM tasks ORDER BY id').all()).toEqual([
        { id: 2, work_root_task_id: 2 }, { id: 9, work_root_task_id: 2 },
        { id: 12, work_root_task_id: 2 }, { id: 15, work_root_task_id: 15 },
      ])
    } finally { migrated.close() }
  })
})
