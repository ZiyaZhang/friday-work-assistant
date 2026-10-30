/**
 * 控制面注册表：飞书线程 ↔ ACP 会话、任务、别名。node:sqlite，单文件，无原生依赖。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { InboundMessage } from '../feishu/mention.js'
import { TaskDispatches } from './task-dispatch.js'
import { TaskWork } from './task-work.js'
import { WorkContexts, type WorkInputKind } from './work-contexts.js'

export type SessionStatus = 'idle' | 'running' | 'archived'
export type TaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export interface SessionRow {
  sessionKey: string
  acpSessionId: string | null
  chatId: string
  chatType: 'group' | 'p2p'
  cwd: string
  requesterOpenId: string | null
  threadId: string | null
  rootMessageId: string | null
  status: SessionStatus
  title: string | null
  turns: number
  createdAt: number
  updatedAt: number
}

export interface TaskRow {
  id: number
  sessionKey: string
  messageId: string
  requesterOpenId: string | null
  prompt: string
  status: TaskStatus
  stopReason: string | null
  error: string | null
  cardMessageId: string | null
  startedAt: number | null
  finishedAt: number | null
  createdAt: number
}

export interface TaskInput { sessionKey: string; messageId: string; requesterOpenId?: string; prompt: string }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  session_key TEXT PRIMARY KEY,
  acp_session_id TEXT,
  chat_id TEXT NOT NULL,
  chat_type TEXT NOT NULL,
  cwd TEXT NOT NULL,
  requester_open_id TEXT,
  thread_id TEXT,
  root_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  title TEXT,
  turns INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_acp ON sessions(acp_session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_chat ON sessions(chat_id, updated_at);
CREATE TABLE IF NOT EXISTS aliases (
  alias TEXT PRIMARY KEY,
  session_key TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_key TEXT NOT NULL,
  message_id TEXT NOT NULL,
  requester_open_id TEXT,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL,
  stop_reason TEXT,
  error TEXT,
  card_message_id TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_key, created_at);
CREATE TABLE IF NOT EXISTS task_receipts (
  dedup_key TEXT PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS task_amendments (
  task_id INTEGER PRIMARY KEY REFERENCES tasks(id),
  prior_task_id INTEGER NOT NULL REFERENCES tasks(id),
  CHECK (prior_task_id < task_id)
);
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
`

export class Registry {
  readonly db: DatabaseSync
  readonly dispatches: TaskDispatches
  readonly taskWork: TaskWork
  /** Thin delegation lifecycle per work root; written only inside Task creation and host control transactions. */
  readonly workContexts: WorkContexts

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
    this.dispatches = new TaskDispatches(this.db)
    this.taskWork = new TaskWork(this.db)
    this.workContexts = new WorkContexts(this.db)
    // 老库可能有重复 message_id：保留所有历史，仅把首次任务作为入站重投的收据。
    // followup 曾复用根消息 ID；它仍走 createTask，不受入站收据限制。
    this.db.exec(`INSERT OR IGNORE INTO task_receipts (dedup_key, task_id, created_at)
      SELECT message_id, MIN(id), MIN(created_at) FROM tasks WHERE message_id != '' GROUP BY message_id`)
  }

  close(): void {
    this.db.close()
  }

  // ---- sessions ----

  /** 按别名候选顺序查找活跃会话（archived 的不算）。 */
  resolveSession(candidates: string[]): SessionRow | undefined {
    for (const c of candidates) {
      const alias = this.db.prepare('SELECT session_key FROM aliases WHERE alias = ?').get(c) as { session_key: string } | undefined
      if (alias) {
        const row = this.getSession(alias.session_key)
        if (row && row.status !== 'archived') return row
      }
      const direct = this.getSession(c)
      if (direct && direct.status !== 'archived') return direct
    }
    return undefined
  }

  getSession(sessionKey: string): SessionRow | undefined {
    const r = this.db.prepare('SELECT * FROM sessions WHERE session_key = ?').get(sessionKey) as Record<string, unknown> | undefined
    return r ? toSession(r) : undefined
  }

  getSessionByAcpId(acpSessionId: string): SessionRow | undefined {
    const r = this.db.prepare('SELECT * FROM sessions WHERE acp_session_id = ? ORDER BY updated_at DESC LIMIT 1').get(acpSessionId) as
      | Record<string, unknown>
      | undefined
    return r ? toSession(r) : undefined
  }

  createSession(input: {
    sessionKey: string
    chatId: string
    chatType: 'group' | 'p2p'
    cwd: string
    requesterOpenId?: string
    rootMessageId?: string
    threadId?: string
    title?: string
  }): SessionRow {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO sessions (session_key, acp_session_id, chat_id, chat_type, cwd, requester_open_id, thread_id, root_message_id, status, title, turns, created_at, updated_at)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'idle', ?, 0, ?, ?)`,
      )
      .run(
        input.sessionKey,
        input.chatId,
        input.chatType,
        input.cwd,
        input.requesterOpenId ?? null,
        input.threadId ?? null,
        input.rootMessageId ?? null,
        input.title ?? null,
        now,
        now,
      )
    this.addAlias(input.sessionKey, input.sessionKey)
    if (input.threadId) this.addAlias(`thread:${input.threadId}`, input.sessionKey)
    return this.getSession(input.sessionKey) as SessionRow
  }

  updateSession(sessionKey: string, patch: Partial<Pick<SessionRow, 'acpSessionId' | 'status' | 'title' | 'threadId' | 'requesterOpenId'>> & { bumpTurns?: boolean }): void {
    const sets: string[] = ['updated_at = ?']
    const args: unknown[] = [Date.now()]
    if (patch.acpSessionId !== undefined) {
      sets.push('acp_session_id = ?')
      args.push(patch.acpSessionId)
    }
    if (patch.status !== undefined) {
      // 失效会话不能被异步任务的 finally 或迟到的完成回执重新激活。
      sets.push("status = CASE WHEN status = 'archived' THEN status ELSE ? END")
      args.push(patch.status)
    }
    if (patch.title !== undefined) {
      sets.push('title = ?')
      args.push(patch.title)
    }
    if (patch.threadId !== undefined) {
      sets.push('thread_id = ?')
      args.push(patch.threadId)
      // A late response may discover the thread after a newer work session bound it.
      if (patch.threadId && !this.resolveSession([`thread:${patch.threadId}`])) this.addAlias(`thread:${patch.threadId}`, sessionKey)
    }
    if (patch.requesterOpenId !== undefined) {
      sets.push('requester_open_id = ?')
      args.push(patch.requesterOpenId)
    }
    if (patch.bumpTurns) sets.push('turns = turns + 1')
    args.push(sessionKey)
    this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE session_key = ?`).run(...(args as never[]))
  }

  addAlias(alias: string, sessionKey: string): void {
    if (this.getSession(sessionKey)?.status === 'archived') return
    this.db.prepare('INSERT OR REPLACE INTO aliases (alias, session_key) VALUES (?, ?)').run(alias, sessionKey)
  }

  /**
   * 私聊会话键固定为 dm:<open_id>：重开时把旧行改名成 dm:<open_id>#<created_at> 并归档，让出键位。
   * 返回改名后的键；tasks 里的引用一并改，别名保留（新会话建好后会重新指向自己）。
   */
  retireSession(sessionKey: string): string | undefined {
    const s = this.getSession(sessionKey)
    if (!s) return undefined
    const retired = `${sessionKey}#${s.createdAt}`
    this.db.prepare(`UPDATE sessions SET session_key = ?, status = 'archived', updated_at = ? WHERE session_key = ?`).run(retired, Date.now(), sessionKey)
    this.db.prepare('UPDATE tasks SET session_key = ? WHERE session_key = ?').run(retired, sessionKey)
    this.db.prepare('DELETE FROM aliases WHERE alias = ? OR session_key = ?').run(sessionKey, sessionKey)
    return retired
  }

  /** 归档旧会话，并把它的所有别名指向新会话（!restart 用）。 */
  archiveAndRepoint(oldKey: string, newKey: string): void {
    this.db.prepare(`UPDATE sessions SET status = 'archived', updated_at = ? WHERE session_key = ?`).run(Date.now(), oldKey)
    this.db.prepare('UPDATE aliases SET session_key = ? WHERE session_key = ?').run(newKey, oldKey)
    this.addAlias(newKey, newKey)
  }

  listRecentSessions(chatId: string, limit = 20): SessionRow[] {
    const rows = this.db.prepare('SELECT * FROM sessions WHERE chat_id = ? ORDER BY updated_at DESC LIMIT ?').all(chatId, limit) as Record<string, unknown>[]
    return rows.map(toSession)
  }

  /** 生命周期操作不受最近 20 条的展示上限影响。调用方在同库事务中使用。 */
  invalidateChat(chatId: string, reason: string): SessionRow[] {
    const sessions = (this.db.prepare("SELECT * FROM sessions WHERE chat_id = ? AND status != 'archived'").all(chatId) as Record<string, unknown>[]).map(toSession)
    const now = Date.now()
    this.db.prepare(`UPDATE tasks SET status = 'cancelled', stop_reason = ?, finished_at = ?
      WHERE status IN ('queued', 'running') AND session_key IN (SELECT session_key FROM sessions WHERE chat_id = ?)`)
      .run(reason, now, chatId)
    this.db.prepare("DELETE FROM aliases WHERE session_key IN (SELECT session_key FROM sessions WHERE chat_id = ?)").run(chatId)
    this.db.prepare("UPDATE sessions SET status = 'archived', updated_at = ? WHERE chat_id = ?").run(now, chatId)
    return sessions
  }

  // ---- tasks ----

  createTask(input: TaskInput): TaskRow {
    return this.createTaskInWork(input)
  }

  private createTaskInWork(input: TaskInput, workFromTaskId?: number, kind?: WorkInputKind): TaskRow {
    this.db.exec('SAVEPOINT create_task')
    try {
      const now = Date.now()
      const res = this.db
        .prepare(`INSERT INTO tasks (session_key, message_id, requester_open_id, prompt, status, created_at) VALUES (?, ?, ?, ?, 'queued', ?)`)
        .run(input.sessionKey, input.messageId, input.requesterOpenId ?? null, input.prompt, now)
      const id = Number(res.lastInsertRowid)
      const work = this.taskWork.initialize(id, workFromTaskId)
      this.workContexts.registerTask({ taskId: id, workKey: work.key, rootTaskId: work.rootTaskId, sessionKey: input.sessionKey,
        authorityOpenId: input.requesterOpenId ?? null, kind, now })
      const task = this.getTask(id) as TaskRow
      this.db.exec('RELEASE SAVEPOINT create_task')
      return task
    } catch (error) {
      this.db.exec('ROLLBACK TO SAVEPOINT create_task')
      this.db.exec('RELEASE SAVEPOINT create_task')
      throw error
    }
  }

  /**
   * 真实入站用 message_id 持久去重；created=false 时调用者不能再次 ACK、插话或执行。
   * 单部署单 app。系统触发使用稳定执行键；followup 绑定 occurrence 或手动消息。
   * 不比较 prompt/session：解析结果或会话别名变化不能让同一入站消息再次执行。
   */
  createTaskOnce(input: TaskInput & { amendsTaskId?: number; workFromTaskId?: number; replaceQueued?: boolean; inbound?: InboundMessage; steer?: boolean; inputKind?: WorkInputKind }, dedupKey = input.messageId): { task: TaskRow; created: boolean } {
    if (!dedupKey.trim()) throw new Error('任务去重键不能为空')
    // SAVEPOINT 同时支持独立调用和已有网关事务；没有 await 的临界区只交付一个新任务。
    this.db.exec('SAVEPOINT create_task_once')
    try {
      const seen = this.db.prepare('SELECT task_id FROM task_receipts WHERE dedup_key = ?').get(dedupKey) as { task_id: number } | undefined
      let result: { task: TaskRow; created: boolean }
      if (seen) {
        const task = this.getTask(Number(seen.task_id))
        if (!task) throw new Error('任务收据对应的历史任务不存在，不能重新执行')
        if (task.messageId !== input.messageId) throw new Error('任务去重键已绑定其他消息')
        result = { task, created: false }
      } else {
        if (input.replaceQueued && input.amendsTaskId === undefined) throw new Error('替换排队任务需要原任务')
        const sourceIds = [input.amendsTaskId, input.workFromTaskId].filter((id): id is number => id !== undefined)
        let workRoot: number | undefined
        for (const sourceId of sourceIds) {
          const prior = this.getTask(sourceId)
          const receipt = prior && this.db.prepare('SELECT 1 FROM task_receipts WHERE task_id = ? AND dedup_key = ?').get(prior.id, prior.messageId)
          if (!prior || !receipt || prior.sessionKey !== input.sessionKey || !input.requesterOpenId || prior.requesterOpenId !== input.requesterOpenId) {
            throw new Error('补充只能关联同一会话中本人发起的真实请求')
          }
          const work = this.taskWork.get(prior.id)
          if (!work) throw new Error('来源任务的工作关系不完整，不能继承')
          if (workRoot !== undefined && workRoot !== work.rootTaskId) throw new Error('补充与回复来源属于不同工作')
          workRoot = work.rootTaskId
        }
        const task = this.createTaskInWork(input, input.amendsTaskId ?? input.workFromTaskId, input.inputKind)
        if (input.inbound) {
          if (input.inbound.messageId !== input.messageId || input.inbound.senderOpenId !== input.requesterOpenId) throw new Error('执行交接与真实入站身份不符')
          this.dispatches.save(task.id, input.inbound, input.steer)
        }
        this.db.prepare('INSERT INTO task_receipts (dedup_key, task_id, created_at) VALUES (?, ?, ?)').run(dedupKey, task.id, task.createdAt)
        if (input.amendsTaskId !== undefined) {
          this.db.prepare('INSERT INTO task_amendments (task_id, prior_task_id) VALUES (?, ?)').run(task.id, input.amendsTaskId)
          if (input.replaceQueued && !this.cancelQueuedTask(input.amendsTaskId, task.createdAt, 'steered')) throw new Error('原任务已不在排队，请重新确认补充对象')
        }
        result = { task, created: true }
      }
      this.db.exec('RELEASE SAVEPOINT create_task_once')
      return result
    } catch (err) {
      this.db.exec('ROLLBACK TO SAVEPOINT create_task_once')
      this.db.exec('RELEASE SAVEPOINT create_task_once')
      throw err
    }
  }

  getTask(id: number): TaskRow | undefined {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return r ? toTask(r) : undefined
  }

  taskForMessage(messageId: string): TaskRow | undefined {
    const receipt = this.db.prepare('SELECT task_id FROM task_receipts WHERE dedup_key = ?').get(messageId) as { task_id: number } | undefined
    if (receipt) return this.getTask(receipt.task_id)
    const row = this.db.prepare('SELECT * FROM tasks WHERE card_message_id = ? ORDER BY id DESC LIMIT 1').get(messageId) as Record<string, unknown> | undefined
    return row ? toTask(row) : undefined
  }

  /** Exact human input received by Friday, including thread followups without an @ mention. */
  isAssistantInput(message: { messageId: string; chatId: string; senderOpenId: string }): boolean {
    const task = this.taskForMessage(message.messageId)
    const input = task && this.dispatches.get(task.id)?.inbound
    return Boolean(task && task.messageId === message.messageId && task.requesterOpenId === message.senderOpenId &&
      input?.senderType === 'user' && input.messageId === message.messageId && input.chatId === message.chatId &&
      input.senderOpenId === message.senderOpenId)
  }

  listTasks(sessionKey: string, limit = 60): TaskRow[] {
    return (this.db.prepare('SELECT * FROM tasks WHERE session_key = ? ORDER BY id DESC LIMIT ?').all(sessionKey, limit) as Record<string, unknown>[]).map(toTask).reverse()
  }

  /** Host-bound amendment chain; original inbound text remains on each Task. */
  listAmendedTasks(taskId: number): TaskRow[] {
    return (this.db.prepare(`WITH RECURSIVE ancestors(id) AS (
      SELECT prior_task_id FROM task_amendments WHERE task_id = ?
      UNION ALL SELECT a.prior_task_id FROM task_amendments a JOIN ancestors p ON a.task_id = p.id
    ) SELECT t.* FROM tasks t JOIN ancestors a ON a.id = t.id ORDER BY t.id`)
      .all(taskId) as Record<string, unknown>[]).map(toTask)
  }

  listUnfinishedTasks(chatId: string, chatType: 'group' | 'p2p'): TaskRow[] {
    return (this.db.prepare(`SELECT t.* FROM tasks t JOIN sessions s ON s.session_key = t.session_key
      WHERE s.chat_id = ? AND s.chat_type = ? AND s.status != 'archived'
        AND t.status IN ('queued', 'running') ORDER BY t.id`).all(chatId, chatType) as Record<string, unknown>[]).map(toTask)
  }

  /** Recent human delegations, newest first and one latest input per work root.
   * A user-stopped attempt remains addressable only while its Work is open with
   * run_stop pauses; listing never resumes it. Cancelled/completed delegations
   * do not become resumable just because their old prompts remain in a Session. */
  listRecentInboundWorkTargets(input: { chatId: string; chatType: 'group' | 'p2p'; actorOpenId: string;
    sessionKey: string; threadId?: string; rootMessageId?: string; limit?: number }): TaskRow[] {
    const limit = input.limit ?? 6
    if (!input.actorOpenId || !Number.isSafeInteger(limit) || limit < 1 || limit > 12) throw new Error('无效的工作候选范围')
    return (this.db.prepare(`WITH candidates AS (
      SELECT t.*,row_number() OVER (PARTITION BY t.work_root_task_id ORDER BY t.id DESC) AS work_rank
      FROM tasks t JOIN sessions s ON s.session_key=t.session_key
      JOIN work_contexts w ON w.root_task_id=t.work_root_task_id AND w.session_key=t.session_key
      JOIN work_inputs i ON i.work_key=w.work_key AND i.task_id=t.id
      JOIN task_receipts r ON r.task_id=t.id AND r.dedup_key=t.message_id
      JOIN task_dispatches d ON d.task_id=t.id
      WHERE s.chat_id=? AND s.chat_type=? AND s.status!='archived' AND w.lifecycle='open'
        AND t.requester_open_id=? AND w.authority_open_id=t.requester_open_id
        AND (s.chat_type!='p2p' OR s.requester_open_id=t.requester_open_id)
        AND (s.chat_type='p2p' OR s.session_key=? OR (? IS NOT NULL AND s.thread_id=?)
          OR (? IS NOT NULL AND s.root_message_id=?))
        AND CASE WHEN json_valid(d.inbound) THEN
          json_extract(d.inbound,'$.senderType')='user'
          AND json_extract(d.inbound,'$.messageId')=t.message_id
          AND json_extract(d.inbound,'$.senderOpenId')=t.requester_open_id
          AND json_extract(d.inbound,'$.chatId')=s.chat_id
          AND json_extract(d.inbound,'$.chatType')=s.chat_type ELSE 0 END
    ) SELECT * FROM candidates WHERE work_rank=1
      AND ((status IN ('done','failed') AND coalesce(stop_reason,'')!='user_requested')
        OR (status='cancelled' AND stop_reason='memory_context_invalidated')
        OR (status='cancelled' AND stop_reason='user_requested'
          AND EXISTS (SELECT 1 FROM work_pause_reasons p WHERE p.work_key='task:' || candidates.work_root_task_id AND p.reason='run_stop')
          AND NOT EXISTS (SELECT 1 FROM work_pause_reasons p WHERE p.work_key='task:' || candidates.work_root_task_id AND p.reason!='run_stop')))
      ORDER BY id DESC LIMIT ?`)
      .all(input.chatId, input.chatType, input.actorOpenId, input.sessionKey,
        input.threadId ?? null, input.threadId ?? null, input.rootMessageId ?? null, input.rootMessageId ?? null, limit) as Record<string, unknown>[]).map(toTask)
  }

  cancelQueuedTask(id: number, now: number, reason: 'user_requested' | 'steered' = 'user_requested'): boolean {
    return Boolean(this.db.prepare(`UPDATE tasks SET status = 'cancelled', stop_reason = ?, finished_at = ?
      WHERE id = ? AND status = 'queued'`).run(reason, now, id).changes)
  }

  taskReceiptKeys(taskId: number): string[] {
    return (this.db.prepare('SELECT dedup_key FROM task_receipts WHERE task_id = ?').all(taskId) as { dedup_key: string }[])
      .map(row => row.dedup_key)
  }

  listInboundTasksBefore(sessionKey: string, beforeTaskId: number, limit: number): TaskRow[] {
    return (this.db.prepare(`SELECT t.* FROM tasks t JOIN task_receipts r
      ON r.task_id = t.id AND r.dedup_key = t.message_id
      WHERE t.session_key = ? AND t.id < ? ORDER BY t.id DESC LIMIT ?`)
      .all(sessionKey, beforeTaskId, limit) as Record<string, unknown>[]).map(toTask).reverse()
  }

  /** Implicit execution history follows the current Task's persisted Work, not
   * every request that happened in its conversation. Explicit material and
   * navigation references use their own host-recorded relations. */
  listInboundWorkTasksBefore(taskId: number, limit: number): TaskRow[] {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('无效的工作历史范围')
    const task = this.getTask(taskId), work = task && this.taskWork.get(taskId)
    if (!task?.requesterOpenId || !work) return []
    return (this.db.prepare(`SELECT t.* FROM tasks t
      JOIN task_receipts r ON r.task_id = t.id AND r.dedup_key = t.message_id
      JOIN sessions s ON s.session_key = t.session_key
      LEFT JOIN task_dispatches d ON d.task_id = t.id
      WHERE t.session_key = ? AND t.requester_open_id = ? AND t.work_root_task_id = ? AND t.id < ?
        AND (d.task_id IS NULL OR CASE WHEN json_valid(d.inbound) THEN
          json_extract(d.inbound, '$.senderType') = 'user'
          AND json_extract(d.inbound, '$.messageId') = t.message_id
          AND json_extract(d.inbound, '$.senderOpenId') = t.requester_open_id
          AND json_extract(d.inbound, '$.chatId') = s.chat_id
          AND json_extract(d.inbound, '$.chatType') = s.chat_type ELSE 0 END)
      ORDER BY t.id DESC LIMIT ?`)
      .all(task.sessionKey, task.requesterOpenId, work.rootTaskId, taskId, limit) as Record<string, unknown>[]).map(toTask).reverse()
  }

  /** Record the request before signalling ACP. A running task is not terminal yet. */
  requestStop(id: number, reason = 'user_requested'): boolean {
    return Boolean(this.db.prepare("UPDATE tasks SET stop_reason = ? WHERE id = ? AND status = 'running'").run(reason, id).changes)
  }

  /** Claim execution only after current authorization, in the same transaction as its handoff. */
  startTask(id: number, now: number, sessionKey?: string): boolean {
    this.db.exec('SAVEPOINT start_task')
    try {
      const started = Boolean(this.db.prepare(`UPDATE tasks SET status = 'running', started_at = ?, error = NULL WHERE id = ? AND status = 'queued'
        ${sessionKey === undefined ? '' : 'AND session_key = ?'}`).run(now, id, ...(sessionKey === undefined ? [] : [sessionKey])).changes)
      if (started) this.dispatches.started(id, now)
      this.db.exec('RELEASE SAVEPOINT start_task')
      return started
    } catch (error) {
      this.db.exec('ROLLBACK TO SAVEPOINT start_task')
      this.db.exec('RELEASE SAVEPOINT start_task')
      throw error
    }
  }

  updateTask(id: number, patch: Partial<Pick<TaskRow, 'status' | 'stopReason' | 'error' | 'cardMessageId' | 'startedAt' | 'finishedAt'>>): void {
    const sets: string[] = []
    const args: unknown[] = []
    const map: Record<string, string> = {
      status: 'status',
      stopReason: 'stop_reason',
      error: 'error',
      cardMessageId: 'card_message_id',
      startedAt: 'started_at',
      finishedAt: 'finished_at',
    }
    for (const [k, col] of Object.entries(map)) {
      const v = (patch as Record<string, unknown>)[k]
      if (v !== undefined) {
        sets.push(`${col} = ?`)
        args.push(v)
      }
    }
    if (!sets.length) return
    args.push(id)
    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ? AND NOT (status = 'cancelled' AND stop_reason IS 'space_disabled')`).run(...(args as never[]))
  }

  runningTask(sessionKey: string): TaskRow | undefined {
    const r = this.db.prepare(`SELECT * FROM tasks WHERE session_key = ? AND status IN ('queued','running') ORDER BY created_at ASC LIMIT 1`).get(sessionKey) as
      | Record<string, unknown>
      | undefined
    return r ? toTask(r) : undefined
  }

  /** 某人发起的、还在排队/运行的任务（机器人菜单"我的任务"用），带所在会话的群信息。 */
  listActiveTasks(requesterOpenId: string, limit = 20): (TaskRow & { chatId: string; chatType: 'group' | 'p2p'; chatName?: string })[] {
    const rows = this.db
      .prepare(
        `SELECT t.*, s.chat_id AS s_chat_id, s.chat_type AS s_chat_type, s.title AS s_title FROM tasks t JOIN sessions s ON s.session_key = t.session_key
         WHERE t.requester_open_id = ? AND t.status IN ('queued','running') ORDER BY t.created_at ASC LIMIT ?`,
      )
      .all(requesterOpenId, limit) as Record<string, unknown>[]
    return rows.map((r) => ({ ...toTask(r), chatId: String(r.s_chat_id), chatType: r.s_chat_type === 'p2p' ? 'p2p' : 'group' }))
  }

  /** 已开始的执行不能重放；有完整入站交接且从未开始的排队任务保留。 */
  failStaleTasks(reason: string): number {
    const res = this.db.prepare(`UPDATE tasks SET status = 'failed', error = ?, finished_at = ? WHERE status IN ('queued','running')
      AND NOT (status = 'queued' AND EXISTS (SELECT 1 FROM task_dispatches d WHERE d.task_id = tasks.id AND d.started_at IS NULL))`).run(reason, Date.now())
    this.db.prepare(`UPDATE sessions SET status = 'idle' WHERE status = 'running'`).run()
    return Number(res.changes)
  }

  // ---- kv ----

  getKv(k: string): string | undefined {
    const r = this.db.prepare('SELECT v FROM kv WHERE k = ?').get(k) as { v: string } | undefined
    return r?.v
  }

  setKv(k: string, v: string): void {
    this.db.prepare('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)').run(k, v)
  }
}

function toSession(r: Record<string, unknown>): SessionRow {
  return {
    sessionKey: String(r.session_key),
    acpSessionId: (r.acp_session_id as string | null) ?? null,
    chatId: String(r.chat_id),
    chatType: r.chat_type === 'p2p' ? 'p2p' : 'group',
    cwd: String(r.cwd),
    requesterOpenId: (r.requester_open_id as string | null) ?? null,
    threadId: (r.thread_id as string | null) ?? null,
    rootMessageId: (r.root_message_id as string | null) ?? null,
    status: (r.status as SessionStatus) ?? 'idle',
    title: (r.title as string | null) ?? null,
    turns: Number(r.turns ?? 0),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  }
}

function toTask(r: Record<string, unknown>): TaskRow {
  return {
    id: Number(r.id),
    sessionKey: String(r.session_key),
    messageId: String(r.message_id),
    requesterOpenId: (r.requester_open_id as string | null) ?? null,
    prompt: String(r.prompt),
    status: r.status as TaskStatus,
    stopReason: (r.stop_reason as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    cardMessageId: (r.card_message_id as string | null) ?? null,
    startedAt: (r.started_at as number | null) ?? null,
    finishedAt: (r.finished_at as number | null) ?? null,
    createdAt: Number(r.created_at),
  }
}
