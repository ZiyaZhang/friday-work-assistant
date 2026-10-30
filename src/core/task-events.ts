import { workRequestMessage } from '../feishu/work-request.js'
import type { Registry, TaskRow } from './registry.js'
import type { InboundMessage } from '../feishu/mention.js'
import { WorkControlError } from './work-contexts.js'
import type { DatabaseSync } from 'node:sqlite'

export type TaskEventKind = 'meeting_draft' | 'issue_assessment' | 'github_ci' | 'github_issue_reply'
const EVENT_KINDS: readonly TaskEventKind[] = ['meeting_draft', 'issue_assessment', 'github_ci', 'github_issue_reply']

export interface TaskEventSource {
  key: string; kind: TaskEventKind; sourceTaskId: number; sourceWorkKey: string
  targetSessionKey: string; domainId: string; taskId: number
}

/** Origin metadata for tasks admitted by the host. This is not another queue:
 * existing Tasks, Work controls and dispatches own scheduling and execution. */
export class TaskEvents {
  constructor(private readonly registry: Registry) {
    const schema = `CREATE TABLE IF NOT EXISTS task_event_sources (
      task_id INTEGER PRIMARY KEY REFERENCES tasks(id), event_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK(kind IN ('meeting_draft','issue_assessment','github_ci','github_issue_reply')), source_task_id INTEGER NOT NULL REFERENCES tasks(id),
      source_work_key TEXT NOT NULL REFERENCES work_contexts(work_key), target_session_key TEXT NOT NULL,
      domain_id TEXT NOT NULL
    )`
    const old = registry.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='task_event_sources'").get()
    if (old && EVENT_KINDS.some(kind => !String(old.sql).includes(`'${kind}'`))) {
      registry.db.exec('SAVEPOINT extend_task_event_kinds')
      try {
        registry.db.exec('ALTER TABLE task_event_sources RENAME TO task_event_sources_previous')
        registry.db.exec(schema)
        registry.db.exec('INSERT INTO task_event_sources SELECT * FROM task_event_sources_previous; DROP TABLE task_event_sources_previous')
        registry.db.exec('RELEASE SAVEPOINT extend_task_event_kinds')
      } catch (error) {
        registry.db.exec('ROLLBACK TO SAVEPOINT extend_task_event_kinds; RELEASE SAVEPOINT extend_task_event_kinds')
        throw error
      }
    } else registry.db.exec(schema)
  }

  get(taskId: number): TaskEventSource | undefined {
    const row = this.registry.db.prepare(`SELECT task_id AS taskId,event_key AS key,kind,source_task_id AS sourceTaskId,
      source_work_key AS sourceWorkKey,target_session_key AS targetSessionKey,domain_id AS domainId FROM task_event_sources WHERE task_id=?`).get(taskId)
    return row as unknown as TaskEventSource | undefined
  }

  admit(input: { key: string; kind: TaskEventKind; sourceTaskId: number; targetSessionKey: string; domainId: string; prompt: string }): { task: TaskRow; created: boolean } {
    if (!input.key || !EVENT_KINDS.includes(input.kind) || !input.domainId || !input.prompt.trim()) throw new Error('宿主事件缺少来源')
    const { registry } = this, source = registry.getTask(input.sourceTaskId), sourceDispatch = source && registry.dispatches.get(source.id)
    const target = registry.getSession(input.targetSessionKey), work = source && registry.taskWork.get(source.id)
    if (!source || !work || !source.requesterOpenId || !sourceDispatch || sourceDispatch.inbound.senderType !== 'user' ||
      sourceDispatch.inbound.messageId !== source.messageId || sourceDispatch.inbound.senderOpenId !== source.requesterOpenId ||
      !registry.db.prepare('SELECT 1 FROM task_receipts WHERE task_id=? AND dedup_key=?').get(source.id, source.messageId) ||
      !target || target.status === 'archived' || target.sessionKey !== source.sessionKey &&
        (target.chatType !== 'p2p' || target.requesterOpenId !== source.requesterOpenId)) throw new Error('宿主事件未绑定真实原委托及本人受众')
    registry.db.exec('SAVEPOINT admit_task_event')
    try {
      const existing = registry.db.prepare('SELECT task_id FROM task_event_sources WHERE event_key=?').get(input.key)
      if (existing) {
        const event = this.get(Number(existing.task_id))!, task = registry.getTask(event.taskId)!
        if (event.kind !== input.kind || event.sourceTaskId !== input.sourceTaskId || event.sourceWorkKey !== work.key ||
          event.targetSessionKey !== target.sessionKey || event.domainId !== input.domainId || task.prompt !== input.prompt) throw new Error('事件已绑定其他委托或内容')
        registry.db.exec('RELEASE SAVEPOINT admit_task_event')
        return { task, created: false }
      }
      this.assertParent(work.key, source.id)
      const messageId = `host-event:${input.key}`
      // The sender is explicitly a host event; this can never authorize a new
      // human command, public URL, confirmation, or reaction to a Feishu message.
      const inbound = workRequestMessage({ requestId: input.key, actorId: source.requesterOpenId, actorKind: 'bot', text: input.prompt, createdAt: Date.now(),
        destination: { kind: 'feishu', messageId, chatId: target.chatId, chatType: target.chatType } })
      const accepted = registry.createTaskOnce({ sessionKey: target.sessionKey, messageId, requesterOpenId: source.requesterOpenId,
        prompt: input.prompt, inputKind: 'evidence', inbound, steer: false,
        ...(source.sessionKey === target.sessionKey ? { workFromTaskId: source.id } : {}) })
      if (!accepted.created) throw new Error('事件身份与任务收据不一致')
      registry.db.prepare(`INSERT INTO task_event_sources(task_id,event_key,kind,source_task_id,source_work_key,target_session_key,domain_id)
        VALUES(?,?,?,?,?,?,?)`).run(accepted.task.id, input.key, input.kind, source.id, work.key, target.sessionKey, input.domainId)
      registry.db.exec('RELEASE SAVEPOINT admit_task_event')
      return accepted
    } catch (error) { registry.db.exec('ROLLBACK TO SAVEPOINT admit_task_event; RELEASE SAVEPOINT admit_task_event'); throw error }
  }

  /** Captured at Run admission; a parent stop/pause cannot be bypassed by a new DM Work. */
  lease(taskId: number): (() => void) | undefined {
    const source = this.get(taskId)
    if (!source) return undefined
    const parent = this.assertParent(source.sourceWorkKey, source.sourceTaskId), epoch = parent.controlEpoch
    return () => {
      const current = this.assertParent(source.sourceWorkKey, source.sourceTaskId)
      if (current.controlEpoch !== epoch || this.get(taskId)?.key !== source.key) throw new WorkControlError('stale_revision', '原委托在事件执行期间发生变化')
    }
  }

  private assertParent(workKey: string, sourceTaskId: number) {
    const work = this.registry.workContexts.get(workKey), source = this.registry.getTask(sourceTaskId)
    const session = source && this.registry.getSession(source.sessionKey)
    if (!work || !source || this.registry.taskWork.get(sourceTaskId)?.key !== workKey || work.authorityOpenId !== source.requesterOpenId ||
      !session || session.status === 'archived') throw new WorkControlError('unknown_work', '原委托已不可用')
    if (work.lifecycle !== 'open') throw new WorkControlError(work.lifecycle, '原委托已结束，事件不会重新启动它')
    if (work.pauseReasons.length) throw new WorkControlError('paused', '原委托已暂停，事件等待其恢复')
    return work
  }
}

/** Read-only validation for startup/resume. Never invents a human receipt for an event. */
export function validTaskEventDispatch(db: DatabaseSync, taskId: number, inbound: InboundMessage): boolean {
  if (inbound.senderType !== 'bot' || !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_event_sources'").get()) return false
  const source = db.prepare(`SELECT e.event_key,e.kind,e.domain_id,t.session_key,t.message_id,t.requester_open_id,
    s.chat_id,s.chat_type,s.status,w.lifecycle,w.authority_open_id,d.inbound AS original,
    p.message_id AS original_message_id,ps.chat_id AS original_chat_id,ps.chat_type AS original_chat_type,ps.status AS original_status
    FROM task_event_sources e JOIN tasks t ON t.id=e.task_id JOIN sessions s ON s.session_key=t.session_key
    JOIN tasks p ON p.id=e.source_task_id JOIN sessions ps ON ps.session_key=p.session_key JOIN task_dispatches d ON d.task_id=p.id
    JOIN task_receipts r ON r.task_id=p.id AND r.dedup_key=p.message_id
    JOIN work_contexts w ON w.work_key=e.source_work_key
    WHERE e.task_id=? AND e.target_session_key=t.session_key AND p.requester_open_id=t.requester_open_id
      AND p.session_key=w.session_key AND p.work_root_task_id=w.root_task_id
      AND NOT EXISTS(SELECT 1 FROM work_pause_reasons pause WHERE pause.work_key=w.work_key)`)
    .get(taskId)
  if (!source || !EVENT_KINDS.includes(String(source.kind) as TaskEventKind) || !source.domain_id || source.status === 'archived' || source.original_status === 'archived' ||
    source.lifecycle !== 'open' || source.authority_open_id !== source.requester_open_id ||
    inbound.eventId !== source.event_key || inbound.messageId !== source.message_id || inbound.messageId !== `host-event:${source.event_key}` ||
    inbound.senderOpenId !== source.requester_open_id || inbound.chatId !== source.chat_id || inbound.chatType !== source.chat_type) return false
  try {
    const original = JSON.parse(String(source.original)) as InboundMessage
    return original.senderType === 'user' && original.senderOpenId === source.requester_open_id && original.messageId === source.original_message_id &&
      original.chatId === source.original_chat_id && original.chatType === source.original_chat_type
  } catch { return false }
}
