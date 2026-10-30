import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { BugQuestions, type BugQuestion, type BugQuestionInput } from '../src/core/bug-questions.js'
import { Bugs } from '../src/core/bugs.js'
import { DeliveryService } from '../src/core/delivery.js'
import { Registry } from '../src/core/registry.js'
import { FakeFeishu } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const cleanups: (() => void)[] = []
afterEach(() => { for (const clean of cleanups.splice(0).reverse()) clean() })

function errorOf(action: () => unknown): unknown {
  try { action() } catch (error) { return error }
  return undefined
}

/** Same real stores as bug-questions.test.ts: SQLite, inbound Task receipts and the Delivery ledger; no model. */
function setup(path = ':memory:') {
  const registry = new Registry(path)
  cleanups.push(() => registry.close())
  const bugs = new Bugs(registry.db)
  const questions = new BugQuestions(registry.db, bugs)
  const sp = spaceDeps(registry.db)
  const space = sp.spaces.ensure({ kind: 'group', chatId: 'chat_a', openId: 'alice' })
  const bucket = bugs.record({ spaceId: space.id, chatId: 'chat_a', title: '合成按钮无响应', text: '按钮点了没反应；日志我导不出来', messageId: 'origin' }).bucket
  registry.createSession({ sessionKey: 'session-a', chatId: 'chat_a', chatType: 'group', cwd: '/synthetic', requesterOpenId: 'alice', rootMessageId: 'origin', threadId: 'thread_a' })
  const feishu = new FakeFeishu()
  const input = (messageId = 'origin', patch: Partial<BugQuestionInput> = {}): BugQuestionInput => {
    const task = registry.createTaskOnce({ sessionKey: 'session-a', messageId, requesterOpenId: 'alice', prompt: `真实合成请求 ${messageId}` }).task
    return {
      bucketId: bucket.id, spaceId: space.id, sessionKey: 'session-a', originTaskId: task.id, targetOpenId: 'alice',
      anchor: { tenantId: 'tenant_a', appId: 'app_a', chatId: 'chat_a', messageId, threadId: 'thread_a', rootId: 'origin' },
      kind: 'info', question: '出问题前最后一步点了什么？', missingInfo: ['触发操作'], ...patch,
    }
  }
  const send = async (q: BugQuestion) => {
    const service = new DeliveryService(registry.db, {
      ...sp, resolveContext: async () => ({
        actorOpenId: 'alice', audience: { kind: 'group', spaceId: space.id, chatId: 'chat_a', replyToMessageId: 'origin', threadId: 'thread_a' },
        sources: [{ ref: 'synthetic-question-source', spaceId: space.id, chatId: 'chat_a' }], provenanceComplete: true, expiresAt: Date.now() + 60_000,
      }),
      send: async () => ({ remoteId: (await feishu.replyMarkdown('origin', q.question, false)).messageId }),
    })
    return service.deliver({ key: q.deliveryKey, contextRef: `question-run:${q.id}`, payload: { markdown: q.question } })
  }
  const reply = (q: BugQuestion, messageId = 'reply-1', text = '这个不方便给') => {
    const task = registry.createTaskOnce({ sessionKey: q.sessionKey, messageId, requesterOpenId: q.targetOpenId, prompt: text }).task
    const record = questions.acceptReply(q.id, { messageId, senderOpenId: q.targetOpenId, taskId: task.id })
    registry.updateTask(task.id, { status: 'running' })
    return { task, record }
  }
  return { registry, bugs, questions, space, bucket, feishu, input, send, reply }
}

describe('case record of materials the user will not provide', () => {
  it('records kinds stated in the original words append-only, keeping the first source of each kind', () => {
    const t = setup()
    expect(t.bucket.declinedInfo).toEqual([])
    const first = t.bugs.addDeclinedInfo({ bucketId: t.bucket.id, spaceId: t.space.id, kinds: ['session_log', 'session_log'], source: 'statement', messageId: 'origin', now: 10 })
    expect(first.declinedInfo).toEqual([{ kind: 'session_log', source: 'statement', messageId: 'origin', at: 10 }])
    const second = t.bugs.addDeclinedInfo({ bucketId: t.bucket.id, spaceId: t.space.id, kinds: ['screenshot', 'session_log'], source: 'statement', now: 20 })
    expect(second.declinedInfo).toEqual([
      { kind: 'session_log', source: 'statement', messageId: 'origin', at: 10 },
      { kind: 'screenshot', source: 'statement', at: 20 },
    ])
    expect(new Bugs(t.registry.db).get(t.bucket.id)?.declinedInfo).toEqual(second.declinedInfo)
    // The host does not interpret free text or accept a catch-all kind as a refusal.
    for (const kinds of [['other'], ['日志'], [''], ['session_log', 'logs']]) {
      expect(() => t.bugs.addDeclinedInfo({ bucketId: t.bucket.id, spaceId: t.space.id, kinds, source: 'statement' })).toThrow('材料类型')
    }
    expect(() => t.bugs.addDeclinedInfo({ bucketId: t.bucket.id, spaceId: 'other-space', kinds: ['version'], source: 'statement' })).toThrow('不属于当前空间')
    t.bugs.stopFollowing(t.bucket.id, t.space.id)
    expect(() => t.bugs.addDeclinedInfo({ bucketId: t.bucket.id, spaceId: t.space.id, kinds: ['version'], source: 'statement' })).toThrow('已停止跟进')
    expect(t.bugs.get(t.bucket.id)?.declinedInfo).toEqual(second.declinedInfo)
  })

  it('refuses a question for a declined kind with declined_before, reserving no budget, anchor or delivery', () => {
    const t = setup()
    t.bugs.addDeclinedInfo({ bucketId: t.bucket.id, spaceId: t.space.id, kinds: ['session_log'], source: 'statement', messageId: 'origin' })
    const refused = errorOf(() => t.questions.prepare(t.input('ask-log', { infoKind: 'session_log', question: '能导出会话日志吗？' })))
    expect(refused).toBeInstanceOf(Error)
    expect(refused).toMatchObject({ code: 'declined_before', declined: [expect.objectContaining({ kind: 'session_log', source: 'statement' })] })
    expect(t.questions.list(t.bucket.id, t.space.id)).toEqual([])
    expect(t.bugs.anchors(t.bucket.id, t.space.id)).toEqual([])
    expect(t.questions.budget(t.bucket.id)).toEqual({ occupied: 0, max: 3 })
    // A different kind, including the explicit catch-all, is still asked.
    const steps = t.questions.prepare(t.input('ask-steps', { infoKind: 'repro_steps' }))
    expect(steps).toMatchObject({ infoKind: 'repro_steps', resolution: 'open' })
    expect(t.questions.prepare(t.input('ask-steps', { infoKind: 'repro_steps' }))).toEqual(steps)
    t.questions.cancel(steps.id)
    expect(t.questions.prepare(t.input('ask-other', { infoKind: 'other', question: '当时用的是哪个浏览器？' }))).toMatchObject({ infoKind: 'other', resolution: 'open' })
  })

  it('checks the open question and the budget before the declined kind', () => {
    const t = setup()
    t.bugs.addDeclinedInfo({ bucketId: t.bucket.id, spaceId: t.space.id, kinds: ['session_log'], source: 'statement' })
    const open = t.questions.prepare(t.input('open', { infoKind: 'version' }))
    expect(errorOf(() => t.questions.prepare(t.input('while-open', { infoKind: 'session_log' })))).toMatchObject({ message: expect.stringContaining('已有未处理') })
    t.questions.cancel(open.id)
    for (let i = 0; i < 3; i++) t.bugs.tryAsk(t.bucket.id)
    const exhausted = errorOf(() => t.questions.prepare(t.input('exhausted', { infoKind: 'session_log' })))
    expect(exhausted).toMatchObject({ message: expect.stringContaining('额度已用完') })
    expect(exhausted).not.toHaveProperty('code')
  })

  it('requires an explicit info_kind once the case has a declined record; unclassified asks remain for other cases', () => {
    const t = setup()
    const legacy = t.questions.prepare(t.input('legacy'))
    expect(legacy.infoKind).toBeNull()
    t.questions.cancel(legacy.id)
    t.bugs.addDeclinedInfo({ bucketId: t.bucket.id, spaceId: t.space.id, kinds: ['screenshot'], source: 'statement' })
    expect(errorOf(() => t.questions.prepare(t.input('unclassified')))).toMatchObject({ code: 'info_kind_required', declined: [expect.objectContaining({ kind: 'screenshot' })] })
    expect(errorOf(() => t.questions.prepare(t.input('bad-kind', { infoKind: 'logs' as never })))).toMatchObject({ message: expect.stringContaining('info_kind') })
    expect(t.questions.budget(t.bucket.id).occupied).toBe(0)
    const other = t.bugs.record({ spaceId: t.space.id, chatId: 'chat_a', title: '另一合成案件', text: '无材料限制' }).bucket
    expect(t.questions.prepare(t.input('other-case', { bucketId: other.id })).infoKind).toBeNull()
  })

  it.each([
    ['declined', 'session_log', true],
    ['unavailable', 'version', true],
    ['answered', 'screenshot', false],
    ['declined', 'other', false],
    ['declined', undefined, false],
  ] as const)('a %s reply to a %s question updates the case record only for a concrete kind', async (outcome, infoKind, recorded) => {
    const t = setup()
    const q = t.questions.prepare(t.input('origin', infoKind === undefined ? {} : { infoKind }))
    await t.send(q)
    const { task, record } = t.reply(q)
    const resolved = t.questions.resolveReply(q.id, record.id, task.id, outcome)
    expect(resolved.outcome).toBe(outcome)
    const expected = recorded ? [{ kind: infoKind, source: 'reply', questionId: q.id, outcome, messageId: 'reply-1', at: expect.any(Number) }] : []
    expect(t.bugs.get(t.bucket.id)?.declinedInfo).toEqual(expected)
    expect(t.questions.resolveReply(q.id, record.id, task.id, outcome)).toEqual(resolved)
    expect(t.bugs.get(t.bucket.id)?.declinedInfo).toEqual(expected)
    if (recorded) {
      expect(errorOf(() => t.questions.prepare(t.input('later-same-kind', { infoKind })))).toMatchObject({ code: 'declined_before' })
      // Later material the user volunteers is still accepted as a reply and as case evidence.
      const later = t.reply(q, 'later-material', '找到了，发你')
      expect(later.record.outcome).toBe('pending')
      expect(t.bugs.addEvidence({ bucketId: t.bucket.id, spaceId: t.space.id, kind: 'user_export', sourceRef: 'feishu:tenant_a:app_a:chat_a:later-material', coverage: { state: 'unknown' } }))
        .toMatchObject({ kind: 'user_export' })
    }
  })

  it('rolls the reply resolution back when the case record cannot be written', async () => {
    const t = setup()
    const q = t.questions.prepare(t.input('origin', { infoKind: 'session_log' }))
    await t.send(q)
    const { task, record } = t.reply(q)
    t.registry.db.exec("CREATE TRIGGER fail_declined BEFORE UPDATE OF declined_info ON bug_buckets BEGIN SELECT RAISE(ABORT, 'synthetic declined failure'); END")
    expect(() => t.questions.resolveReply(q.id, record.id, task.id, 'declined')).toThrow('synthetic declined failure')
    expect(t.questions.replies(q.id)).toEqual([record])
    expect(t.questions.get(q.id)?.resolution).toBe('open')
    expect(t.bugs.get(t.bucket.id)?.declinedInfo).toEqual([])
  })
})

describe('schema-only upgrade from the r77 feedback tables', () => {
  function schemaChanges(db: DatabaseSync, construct: (db: DatabaseSync) => void): string[] {
    const statements: string[] = []
    const spy = new Proxy(db, { get(target, key) {
      if (key === 'exec') return (sql: string) => { statements.push(sql); return target.exec(sql) }
      const value = Reflect.get(target, key) as unknown
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    } }) as DatabaseSync
    const before = JSON.stringify(db.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all())
    construct(spy)
    const after = JSON.stringify(db.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all())
    return before === after ? [] : statements.filter(sql => !sql.trimStart().startsWith('CREATE'))
  }

  it('adds two columns, keeps every old value, gives old cases [] and old questions NULL, and is idempotent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'friday-declined-upgrade-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const path = join(dir, 'state.sqlite')
    const t = setup(path)
    const legacyInput = t.input()
    const q = t.questions.prepare(legacyInput)
    await t.send(q)
    const { task, record } = t.reply(q)
    t.questions.resolveReply(q.id, record.id, task.id, 'declined')
    // Emulate r77: neither column existed, so old replies left no case record.
    t.registry.db.exec('ALTER TABLE bug_questions DROP COLUMN info_kind; ALTER TABLE bug_buckets DROP COLUMN declined_info')
    const oldBucket = t.registry.db.prepare('SELECT * FROM bug_buckets WHERE id = ?').get(t.bucket.id)
    const oldQuestion = t.registry.db.prepare('SELECT * FROM bug_questions WHERE id = ?').get(q.id)
    t.registry.close(); cleanups.pop()

    const reopened = new Registry(path)
    cleanups.push(() => reopened.close())
    let bugs!: Bugs
    expect(schemaChanges(reopened.db, db => { bugs = new Bugs(db); new BugQuestions(db, bugs) })).toEqual([
      "ALTER TABLE bug_buckets ADD COLUMN declined_info TEXT NOT NULL DEFAULT '[]'",
      'ALTER TABLE bug_questions ADD COLUMN info_kind TEXT',
    ])
    expect(schemaChanges(reopened.db, db => { new BugQuestions(db, new Bugs(db)) })).toEqual([])
    const columns = (table: string) => reopened.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }[]
    expect(columns('bug_buckets').at(-1)).toMatchObject({ name: 'declined_info', type: 'TEXT', notnull: 1, dflt_value: "'[]'", pk: 0 })
    expect(columns('bug_questions').at(-1)).toMatchObject({ name: 'info_kind', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 })
    expect(reopened.db.prepare('SELECT * FROM bug_buckets WHERE id = ?').get(t.bucket.id)).toEqual({ ...oldBucket, declined_info: '[]' })
    expect(reopened.db.prepare('SELECT * FROM bug_questions WHERE id = ?').get(q.id)).toEqual({ ...oldQuestion, info_kind: null })
    // No backfill from old declined replies: those questions carry no material kind.
    expect(bugs.get(t.bucket.id)?.declinedInfo).toEqual([])
    const questions = new BugQuestions(reopened.db, bugs)
    expect(questions.get(q.id)).toMatchObject({ id: q.id, infoKind: null, resolution: 'declined' })
    // The unchanged legacy input still resolves to the same persisted question (its signature is unchanged).
    expect(questions.prepare(legacyInput)).toMatchObject({ id: q.id, infoKind: null })
  })
})
