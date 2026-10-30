import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { FeishuClient } from '../feishu/client.js'
import { assertRequestCurrent } from './request-lease.js'

/** References to concrete domain receipts, never a second copy of their state. */
export interface RunOperationReference { kind: 'github_change_preparation' | 'github_execution'; id: string }

export interface RunApiCall {
  id: string
  runId: string
  route: string
  scopes: string[]
  state: 'started' | 'returned' | 'failed'
  operations?: RunOperationReference[]
}

/** Host dispatch evidence. Request bodies, provider errors and credentials never enter this ledger. */
export class RunApiCalls {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS run_api_calls (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      route TEXT NOT NULL,
      scopes_json TEXT NOT NULL,
      operations_json TEXT NOT NULL DEFAULT '[]',
      state TEXT NOT NULL CHECK(state IN ('started','returned','failed')),
      started_at INTEGER NOT NULL,
      finished_at INTEGER
    ); CREATE INDEX IF NOT EXISTS idx_run_api_calls_run ON run_api_calls(run_id)`)
    if (!db.prepare('PRAGMA table_info(run_api_calls)').all().some(row => row.name === 'operations_json')) {
      db.exec("ALTER TABLE run_api_calls ADD COLUMN operations_json TEXT NOT NULL DEFAULT '[]'")
    }
  }

  begin(runId: string, route: string, now = Date.now()): string {
    const id = randomUUID()
    this.db.prepare("INSERT INTO run_api_calls(id,run_id,route,scopes_json,state,started_at) VALUES (?,?,?,'[]','started',?)")
      .run(id, runId, route, now)
    return id
  }

  /** Invoked by the common capability gate before it permits an operation. */
  need(id: string, scope: string): void {
    const row = this.db.prepare("SELECT scopes_json FROM run_api_calls WHERE id=? AND state='started'").get(id)
    if (!row) throw new Error('本次工具调用已结束')
    const recorded = JSON.parse(String(row.scopes_json)) as string[]
    // Current authority is checked by the caller on every invocation. This
    // ledger records consumption once, without rewriting an identical receipt
    // during every file/page guard. Always read the live call state first.
    if (recorded.includes(scope)) return
    const scopes = [...new Set([...recorded, scope])].sort()
    this.db.prepare('UPDATE run_api_calls SET scopes_json=? WHERE id=?').run(JSON.stringify(scopes), id)
  }

  finish(id: string, state: 'returned' | 'failed', now = Date.now()): void {
    this.db.prepare("UPDATE run_api_calls SET state=?,finished_at=? WHERE id=? AND state='started'").run(state, now, id)
  }

  /** Called immediately after the domain reserves its operation, before asynchronous effects. */
  reference(id: string, operation: RunOperationReference): void {
    if (!['github_change_preparation', 'github_execution'].includes(operation.kind) || !operation.id.trim()) throw new Error('业务操作引用无效')
    const row = this.db.prepare("SELECT operations_json FROM run_api_calls WHERE id=? AND state='started'").get(id)
    if (!row) throw new Error('本次工具调用已结束，不能追加新操作')
    const operations = JSON.parse(String(row.operations_json)) as RunOperationReference[]
    if (!operations.some(item => item.kind === operation.kind && item.id === operation.id)) {
      operations.push({ ...operation })
      this.db.prepare('UPDATE run_api_calls SET operations_json=? WHERE id=?').run(JSON.stringify(operations), id)
    }
  }

  /** A retry shares its original receipt. A failed HTTP response alone says nothing about that receipt's result. */
  unresolvedOperations(runId: string, resolved: (operation: RunOperationReference) => boolean): RunOperationReference[] {
    const unique = new Map<string, RunOperationReference>()
    for (const call of this.forRun(runId)) for (const operation of call.operations ?? []) {
      unique.set(`${operation.kind}:${operation.id}`, operation)
    }
    return [...unique.values()].filter(operation => !resolved(operation))
  }

  /** An admitted continuation still owes the original Task's operations even if
   * this Run only reads their status. Other Tasks, actors and stages cannot leak
   * obligations into it; the domain receipt remains the source of current state. */
  unresolvedTaskOperations(runId: string, resolved: (operation: RunOperationReference) => boolean): RunOperationReference[] {
    const runs = this.db.prepare(`SELECT prior.id FROM run_attempts current JOIN run_attempts prior
      ON prior.task_id=current.task_id AND prior.stage='task' AND current.stage='task'
        AND prior.work_key=current.work_key AND prior.session_key=current.session_key
        AND prior.actor_open_id=current.actor_open_id AND prior.rowid<=current.rowid
      WHERE current.id=? ORDER BY prior.rowid`).all(runId)
    if (!runs.length) return this.unresolvedOperations(runId, resolved)
    const unique = new Map<string, RunOperationReference>()
    for (const run of runs) for (const operation of this.unresolvedOperations(String(run.id), () => false)) {
      unique.set(`${operation.kind}:${operation.id}`, operation)
    }
    return [...unique.values()].filter(operation => !resolved(operation))
  }

  /** A host-side business effect uses the same before-call evidence as API handlers.
   * `failed` means the outcome is unresolved, never that no remote effect occurred. */
  async capture<T>(runId: string, route: string, scopes: readonly string[], fn: () => T | Promise<T>): Promise<T> {
    assertRequestCurrent()
    if (!runId.trim() || !route.trim() || !scopes.length || scopes.some(scope => !scope.trim())) {
      throw new Error('宿主调用缺少执行或能力边界')
    }
    const id = this.begin(runId, route)
    for (const scope of scopes) this.need(id, scope)
    try {
      const result = await fn()
      this.finish(id, 'returned')
      return result
    } catch (error) {
      this.finish(id, 'failed')
      throw error
    }
  }

  /** All coordinator document writes share this provider boundary, even when a caller catches errors. */
  documents(runId: string, provider: Pick<FeishuClient, 'createDocument' | 'rewriteDocument' | 'prependToDocument' | 'grantDocAccess'>) {
    return {
      createDocument: (...args: Parameters<FeishuClient['createDocument']>) =>
        this.capture(runId, 'HOST /documents/create', ['doc:write'], () => provider.createDocument(...args)),
      rewriteDocument: (...args: Parameters<FeishuClient['rewriteDocument']>) =>
        this.capture(runId, 'HOST /documents/rewrite', ['doc:write'], () => provider.rewriteDocument(...args)),
      prependToDocument: (...args: Parameters<FeishuClient['prependToDocument']>) =>
        this.capture(runId, 'HOST /documents/prepend', ['doc:write'], () => provider.prependToDocument(...args)),
      grantDocAccess: (...args: Parameters<FeishuClient['grantDocAccess']>) =>
        this.capture(runId, 'HOST /documents/grant', ['doc:write'], () => provider.grantDocAccess(...args)),
    }
  }

  forRun(runId: string): RunApiCall[] {
    return (this.db.prepare('SELECT * FROM run_api_calls WHERE run_id=? ORDER BY started_at,rowid').all(runId) as
      { id: string; run_id: string; route: string; scopes_json: string; operations_json: string; state: RunApiCall['state'] }[])
      .map(row => ({ id: row.id, runId: row.run_id, route: row.route, scopes: JSON.parse(row.scopes_json), state: row.state,
        ...(row.operations_json !== '[]' ? { operations: JSON.parse(row.operations_json) as RunOperationReference[] } : {}) }))
  }
}

/** Capability names define the contract; absent/new mutation gates cannot silently qualify as reads. */
export function readOnlyApiCall(call: Pick<RunApiCall, 'scopes'>): boolean {
  return call.scopes.length > 0 && call.scopes.every(scope => scope.endsWith(':read') || scope.endsWith(':list') || scope === 'chat:read-others')
}
