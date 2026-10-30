import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Bugs } from '../src/core/bugs.js'
import { BugQuestions } from '../src/core/bug-questions.js'
import { DeliveryService, type DeliveryDependencies } from '../src/core/delivery.js'
import { Registry } from '../src/core/registry.js'
import { ChangeManager } from '../src/github/changes.js'
import { GitHubIdentity } from '../src/github/identity.js'
import { IssueLinks } from '../src/github/issues.js'
import { createLogger } from '../src/log.js'
import { spaceDeps } from './helpers/space.js'

const NOW = 1_800_000_000_000
const ORIGINAL = '  SYNTHETIC_ORIGINAL\n完成后提供手动隐藏按钮；不要自动隐藏。🙂\n'
const AMENDMENT = 'SYNTHETIC_AMENDMENT\n补充：默认仍可见。'
const REPLY = '  SYNTHETIC_REPLY\n现在不导出日志，也没有同意继续追问。\r\n'
const USER_NOTE = `  SYNTHETIC_USER_NOTE\n${'文字还在，不是消息已发送。🙂\n'.repeat(200)}保留末尾空白。  `
const ISSUE = 'https://github.com/test-org/test-repo/issues/7'
const PR = 'https://github.com/test-org/test-repo/pull/8'
const CONTEXT_TABLES = ['console_operations', 'console_sessions', 'run_contexts', 'runtime_contexts',
  'execution_material_files', 'execution_material_generations', 'execution_material_versions']
const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fileDigest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
function tableRows(db: DatabaseSync, table: string) {
  return db.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}"`).all()
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
}
function snapshot(db: DatabaseSync) {
  return new Map(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
    .map(row => [String(row.name), digest(tableRows(db, String(row.name)))]))
}

/** Synthetic pre-context schema: these business constructors/schema were unchanged
 * from r31 d1dadfd to C2a bd364405 (Delivery only added a synchronous lease check).
 * No RuntimeContexts/Console constructors are used to manufacture the old DB.
 * GitHub publication metadata is explicitly seeded, not claimed as a real PR.
 */
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'friday-c2-business-migration-'))
  const source = join(home, 'active.db'), protection = join(home, 'protected')
  const registry = new Registry(source), db = registry.db
  cleanup.push(() => { registry.close(); rmSync(home, { recursive: true, force: true }) })
  db.exec('PRAGMA wal_autocheckpoint=0')
  const bugs = new Bugs(db), questions = new BugQuestions(db, bugs), links = new IssueLinks(db, () => NOW)
  const sp = spaceDeps(db), space = sp.spaces.ensure({ kind: 'group', chatId: 'synthetic-chat', openId: 'synthetic-alice' })
  const log = createLogger('synthetic-migration', 'error')
  const github = new GitHubIdentity({ apiUrl: 'https://github.invalid', mode: 'pat', token: 'synthetic-unused', allowedRepos: ['test-org/test-repo'] }, log,
    { request: async () => { throw new Error('Synthetic migration must never contact GitHub') } })
  new ChangeManager({ db, github, log, cacheDir: join(home, 'unused-git') })
  registry.createSession({ sessionKey: 'synthetic-session', chatId: 'synthetic-chat', chatType: 'group', requesterOpenId: 'synthetic-alice',
    cwd: '/synthetic/work', threadId: 'synthetic-thread', rootMessageId: 'synthetic-original' })
  registry.updateSession('synthetic-session', { acpSessionId: 'synthetic-legacy-acp' })
  const task = (messageId: string, prompt: string) => registry.createTaskOnce({ sessionKey: 'synthetic-session', messageId,
    requesterOpenId: 'synthetic-alice', prompt }).task
  const original = task('synthetic-original', ORIGINAL)
  const amendment = registry.createTaskOnce({ sessionKey: original.sessionKey, messageId: 'synthetic-amendment', requesterOpenId: 'synthetic-alice',
    prompt: AMENDMENT, amendsTaskId: original.id, replaceQueued: true }).task
  registry.startTask(amendment.id, NOW)
  registry.updateTask(amendment.id, { status: 'done', finishedAt: NOW + 1 })
  const makeQuestion = (originTaskId: number, messageId: string, title: string) => {
    const bucket = bugs.record({ spaceId: space.id, chatId: 'synthetic-chat', title, text: ORIGINAL, messageId,
      reporterOpenId: 'synthetic-alice', now: NOW }).bucket
    const question = questions.prepare({ bucketId: bucket.id, spaceId: space.id, sessionKey: original.sessionKey, originTaskId,
      targetOpenId: 'synthetic-alice', kind: 'info', question: `${title}：可否补充触发前的操作？`, missingInfo: ['触发操作'],
      anchor: { tenantId: 'synthetic-tenant', appId: 'synthetic-app', chatId: 'synthetic-chat', messageId,
        threadId: 'synthetic-thread', rootId: 'synthetic-original' } })
    return { bucket, question }
  }
  const sent = makeQuestion(amendment.id, amendment.messageId, 'Synthetic acknowledged question')
  const unknownTask = task('synthetic-unknown-origin', 'Synthetic unknown question origin')
  const unknown = makeQuestion(unknownTask.id, unknownTask.messageId, 'Synthetic unknown question')
  const pendingTask = task('synthetic-planned-origin', 'Synthetic planned question origin')
  const planned = makeQuestion(pendingTask.id, pendingTask.messageId, 'Synthetic planned question')
  const intents = [sent, unknown, planned].map(({ question }) => ({ key: question.deliveryKey,
    contextRef: `synthetic-question:${question.id}`, payload: { markdown: question.question } }))
  const deliveryDeps = (connection: DatabaseSync, send: DeliveryDependencies['send']): DeliveryDependencies => ({
    ...spaceDeps(connection), now: () => NOW, resolveContext: async () => ({ actorOpenId: 'synthetic-alice',
      audience: { kind: 'group', spaceId: space.id, chatId: 'synthetic-chat', replyToMessageId: 'synthetic-original', threadId: 'synthetic-thread' },
      sources: [{ ref: 'synthetic-source', spaceId: space.id, chatId: 'synthetic-chat' }], provenanceComplete: true, expiresAt: NOW + 60_000 }), send,
  })
  let plannedEntered!: () => void
  const entered = new Promise<void>(resolve => { plannedEntered = resolve })
  const service = new DeliveryService(db, deliveryDeps(db, async ({ key }) => {
    if (key === planned.question.deliveryKey) {
      plannedEntered()
      // Simulates a process lost after the real ledger admission, without an ACK.
      // This pending transport has no timer/network and is never released later.
      return new Promise<{ remoteId: string }>(() => {})
    }
    if (key === unknown.question.deliveryKey) throw new Error('Synthetic lost ACK after POST')
    return { remoteId: 'synthetic-question-remote' }
  }))
  await service.deliver(intents[0]!)
  await expect(service.deliver(intents[1]!)).rejects.toMatchObject({ code: 'unknown' })
  const pendingSend = service.deliver(intents[2]!)
  await Promise.race([entered, pendingSend.then(() => { throw new Error('Expected pending transport') })])
  const replyTask = task('synthetic-reply', REPLY)
  const reply = questions.acceptReply(sent.question.id, { messageId: replyTask.messageId, senderOpenId: 'synthetic-alice', taskId: replyTask.id })
  registry.startTask(replyTask.id, NOW + 2)
  questions.resolveReply(sent.question.id, reply.id, replyTask.id, 'declined')
  registry.updateTask(replyTask.id, { status: 'done', finishedAt: NOW + 3 })
  bugs.linkIssue(sent.bucket.id, ISSUE)
  bugs.stopFollowing(sent.bucket.id, space.id, NOW + 4)
  const noteTask = task('synthetic-user-note', USER_NOTE)
  bugs.captureUserNote({ bucketId: sent.bucket.id, spaceId: space.id, chatId: 'synthetic-chat', messageId: noteTask.messageId,
    reporterOpenId: 'synthetic-alice', text: noteTask.prompt, now: NOW + 5 })
  links.remember({ fingerprint: 'synthetic-fingerprint', repo: 'test-org/test-repo', number: 7, url: ISSUE,
    spaceId: space.id, source: ORIGINAL, createdBy: 'synthetic-alice' })
  db.prepare(`INSERT INTO github_changes
    (id,session_key,requester_open_id,cwd,dir,repo,base,base_commit,branch,remote_url,git_dir,state,snapshot,publish_intent,commit_id,pr_number,pr_url,result,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('synthetic-change', original.sessionKey, 'synthetic-alice', '/synthetic/work',
    '/synthetic/work/change', 'test-org/test-repo', 'main', 'synthetic-base', 'friday/synthetic', 'https://github.com/test-org/test-repo.git',
    '/synthetic/private-git', 'confirmed', 'synthetic-tree', JSON.stringify({ title: 'Synthetic PR', body: ORIGINAL }), 'synthetic-head', 8, PR,
    JSON.stringify({ url: PR, number: 8, phase: 'confirmed', head: 'synthetic-head' }), NOW, NOW)
  for (const name of CONTEXT_TABLES) expect(db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name)).toBeUndefined()
  const old = snapshot(db)
  const call = (...args: string[]) => {
    const result = spawnSync('python3', [resolve('scripts/database-migration-guard.py'), ...args], { encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, FRIDAY_MIGRATION_NODE: process.execPath } })
    expect(result.status, result.stdout + result.stderr).toBe(0)
    return { ...JSON.parse(result.stdout.trim()), output: result.stdout + result.stderr }
  }
  const backup = call('backup', '--source', source, '--out-dir', protection)
  const protectedHash = fileDigest(join(protection, 'baseline.db'))
  const migration = call('verify', '--protection-dir', protection, '--', process.execPath, resolve('scripts/upgrade-schema-copy.mjs'))
  expect(migration).toMatchObject({ passed: true, protected_backup_unchanged: true, old_business_rows: { equal: true }, second_upgrade_idempotent: { equal: true } })
  expect(migration.passes.map((pass: { exit_code: number }) => pass.exit_code)).toEqual([0, 0])
  const candidatePath = join(migration.run_dir, 'candidate.db')
  return { registry, db, space, old, original, amendment, sent, unknown, planned, reply, replyTask, noteTask, intents,
    deliveryDeps, backup, migration, candidatePath, protection, protectedHash }
}

describe('C2a synthetic nonempty legacy business migration', () => {
  it('preserves exact IDs, full user notes, Question/reply and amendment chains, Issue/PR facts and delivery states in both real upgrades', async () => {
    const t = await fixture(), candidate = new Registry(t.candidatePath)
    try {
      for (const [name, hash] of t.old) expect(digest(tableRows(candidate.db, name)), name).toBe(hash)
      const bugs = new Bugs(candidate.db), questions = new BugQuestions(candidate.db, bugs)
      const context = questions.readContext(t.sent.bucket.id, t.space.id)
      expect(context.bucket).toMatchObject({ id: t.sent.bucket.id, issueUrl: ISSUE, intakePhase: 'cancelled', status: 'triaging' })
      const note = context.reports.find(report => report.recordKind === 'user_note')!
      expect(digest(note.text)).toBe(digest(USER_NOTE))
      expect(note.messageId).toBe(t.noteTask.messageId)
      expect(note.text.length).toBeGreaterThan(2000)
      expect(context.questions[0]).toMatchObject({ id: t.sent.question.id, anchorId: t.sent.question.anchorId, resolution: 'declined',
        origin: { taskId: t.amendment.id, messageId: t.amendment.messageId },
        replies: [{ id: t.reply.id, taskId: t.replyTask.id, messageId: t.replyTask.messageId, outcome: 'declined' }] })
      expect(digest(context.questions[0]!.origin.text)).toBe(digest(AMENDMENT))
      expect(digest(context.questions[0]!.replies[0]!.text)).toBe(digest(REPLY))
      expect(candidate.listAmendedTasks(t.amendment.id).map(task => task.id)).toEqual([t.original.id])
      expect(digest(candidate.getTask(t.original.id)?.prompt)).toBe(digest(ORIGINAL))
      expect(new IssueLinks(candidate.db).get('synthetic-fingerprint')).toMatchObject({ number: 7, url: ISSUE, spaceId: t.space.id })
      expect(candidate.db.prepare('SELECT id,pr_number,pr_url,commit_id,state FROM github_changes').get()).toEqual({
        id: 'synthetic-change', pr_number: 8, pr_url: PR, commit_id: 'synthetic-head', state: 'confirmed' })
      expect(candidate.db.prepare('SELECT status,remote_id FROM deliveries ORDER BY delivery_key').all()).toEqual([
        { status: 'sent', remote_id: 'synthetic-question-remote' }, { status: 'unknown', remote_id: null }, { status: 'planned', remote_id: null },
      ])
      for (const name of CONTEXT_TABLES) expect(candidate.db.prepare(`SELECT count(*) n FROM ${name}`).get()?.n).toBe(0)
      const visibleEvidence = t.backup.output + t.migration.output + readFileSync(join(t.protection, 'baseline-summary.json'), 'utf8') +
        readFileSync(join(t.migration.run_dir, 'verification.json'), 'utf8')
      expect(visibleEvidence).not.toMatch(/SYNTHETIC_(?:ORIGINAL|USER_NOTE|REPLY|AMENDMENT)/)
    } finally { candidate.close() }
    for (const [name, hash] of t.old) expect(digest(tableRows(t.db, name)), `unmodified source ${name}`).toBe(hash)
    expect(fileDigest(join(t.protection, 'baseline.db'))).toBe(t.protectedHash)
  })

  it('reopens the upgraded copy, recovers planned to unknown once, and never POSTs either unknown intent or an acknowledged question again', async () => {
    const t = await fixture()
    let sends = 0
    for (let restart = 0; restart < 2; restart++) {
      const candidate = new Registry(t.candidatePath)
      try {
        const service = new DeliveryService(candidate.db, t.deliveryDeps(candidate.db, async () => { sends++; return { remoteId: 'unexpected' } }))
        const unknownBefore = service.get(t.unknown.question.deliveryKey), sentBefore = service.get(t.sent.question.deliveryKey)
        const plannedBefore = service.get(t.planned.question.deliveryKey)!
        expect(service.recoverInterrupted()).toBe(restart === 0 ? 1 : 0)
        expect(service.get(t.planned.question.deliveryKey)).toEqual({ ...plannedBefore, status: 'unknown', error: 'interrupted_before_receipt', updatedAt: NOW })
        expect(service.get(t.unknown.question.deliveryKey)).toEqual(unknownBefore)
        expect(service.get(t.sent.question.deliveryKey)).toEqual(sentBefore)
        for (const intent of t.intents.slice(1)) await expect(service.deliver(intent)).rejects.toMatchObject({ code: 'unknown' })
        await expect(service.deliver(t.intents[0]!)).resolves.toMatchObject({ status: 'sent', replayed: true, remoteId: 'synthetic-question-remote' })
        const questions = new BugQuestions(candidate.db, new Bugs(candidate.db))
        expect(questions.recoverUnsent()).toBe(0) // Existing sent/unknown ledger rows remain occupied; no guessed resends/cancellations.
        expect(questions.get(t.planned.question.id)?.resolution).toBe('open')
        expect(questions.get(t.unknown.question.id)?.resolution).toBe('open')
        expect(questions.findForReply({ spaceId: t.space.id, tenantId: 'synthetic-tenant', appId: 'synthetic-app', chatId: 'synthetic-chat',
          parentId: 'synthetic-question-remote', targetOpenId: 'synthetic-alice' })?.id).toBe(t.sent.question.id)
        for (const [name, hash] of t.old) if (name !== 'deliveries') expect(digest(tableRows(candidate.db, name)), name).toBe(hash)
      } finally { candidate.close() }
    }
    expect(sends).toBe(0)
    expect(fileDigest(join(t.protection, 'baseline.db'))).toBe(t.protectedHash)
    for (const [name, hash] of t.old) expect(digest(tableRows(t.db, name)), `unmodified source ${name}`).toBe(hash)
  })
})
