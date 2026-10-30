import type { DatabaseSync } from 'node:sqlite'

export interface RunModelBinding {
  acpSessionId: string
  runtimeGeneration: number
  selector: string
}

export interface PrepareRunModel extends RunModelBinding {
  runId: string
  providerId: string
  modelId: string
  /** Deployment-owned, non-secret account reference. Never a credential or endpoint. */
  accountRef: string
  preparedAt: number
}

export interface RunModel extends PrepareRunModel {
  admittedAt: number | null
  contextUsed: number | null
  contextSize: number | null
  contextObservedAt: number | null
  /** ACP context occupancy is not provider-reported billing usage. */
  usageStatus: 'unavailable'
}

export class RunModelError extends Error {
  constructor(readonly code: 'invalid_model_fact' | 'run_not_current' | 'model_pin_conflict') {
    super(code === 'invalid_model_fact' ? '执行模型事实无效' : code === 'run_not_current' ? '执行或 ACP 绑定已失效' : '本次执行已固定其他模型或运行时')
    this.name = 'RunModelError'
  }
}

/** Facts for one admitted Run. This store neither selects a model nor starts/replays an execution. */
export class RunModels {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS run_models (
      run_id TEXT PRIMARY KEY REFERENCES run_attempts(id),
      acp_session_id TEXT NOT NULL,
      runtime_generation INTEGER NOT NULL CHECK(runtime_generation >= 1),
      selector TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      account_ref TEXT NOT NULL,
      prepared_at INTEGER NOT NULL,
      admitted_at INTEGER,
      context_used INTEGER,
      context_size INTEGER,
      context_observed_at INTEGER
    )`)
  }

  get(runId: string): RunModel | undefined {
    const row = this.db.prepare(`SELECT run_id AS runId, acp_session_id AS acpSessionId,
      runtime_generation AS runtimeGeneration, selector, provider_id AS providerId, model_id AS modelId,
      account_ref AS accountRef, prepared_at AS preparedAt, admitted_at AS admittedAt,
      context_used AS contextUsed, context_size AS contextSize, context_observed_at AS contextObservedAt
      FROM run_models WHERE run_id = ?`).get(runId)
    return row ? { ...row, usageStatus: 'unavailable' } as unknown as RunModel : undefined
  }

  /** The first verified choice pins this Run. Repeating it never changes its original timestamps. */
  prepare(input: PrepareRunModel): RunModel {
    if (![input.runId, input.acpSessionId, input.selector, input.providerId, input.modelId, input.accountRef].every(nonempty)
      || !integer(input.runtimeGeneration, 1) || !integer(input.preparedAt)) throw new RunModelError('invalid_model_fact')
    this.db.exec('SAVEPOINT prepare_run_model')
    try {
      const run = this.db.prepare('SELECT state, acp_session_id FROM run_attempts WHERE id = ?').get(input.runId)
      if (run?.state !== 'running' || run.acp_session_id !== input.acpSessionId) throw new RunModelError('run_not_current')
      const existing = this.get(input.runId)
      if (existing) {
        if (existing.acpSessionId !== input.acpSessionId || existing.runtimeGeneration !== input.runtimeGeneration
          || existing.selector !== input.selector || existing.providerId !== input.providerId
          || existing.modelId !== input.modelId || existing.accountRef !== input.accountRef) throw new RunModelError('model_pin_conflict')
      } else {
        this.db.prepare(`INSERT INTO run_models
          (run_id,acp_session_id,runtime_generation,selector,provider_id,model_id,account_ref,prepared_at)
          VALUES (?,?,?,?,?,?,?,?)`).run(input.runId, input.acpSessionId, input.runtimeGeneration, input.selector,
          input.providerId, input.modelId, input.accountRef, input.preparedAt)
      }
      const result = existing ?? this.get(input.runId)!
      this.db.exec('RELEASE SAVEPOINT prepare_run_model')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK TO SAVEPOINT prepare_run_model; RELEASE SAVEPOINT prepare_run_model')
      throw error
    }
  }

  /** Called at the actual prompt admission boundary, including a same-pin wrap-up prompt. */
  admit(runId: string, binding: RunModelBinding, now: number): boolean {
    if (!validBinding(binding) || !integer(now)) return false
    return Boolean(this.db.prepare(`UPDATE run_models SET admitted_at = COALESCE(admitted_at, ?)
      WHERE run_id = ? AND acp_session_id = ? AND runtime_generation = ? AND selector = ? AND prepared_at <= ?
      AND EXISTS (SELECT 1 FROM run_attempts r WHERE r.id = run_models.run_id
        AND r.state = 'running' AND r.acp_session_id = run_models.acp_session_id)`)
      .run(now, runId, binding.acpSessionId, binding.runtimeGeneration, binding.selector, now).changes)
  }

  /** Store the newest occupancy sample, never a sum or an estimate of billable tokens. */
  observeContext(runId: string, binding: RunModelBinding, sample: { used: number; size: number; observedAt: number }): boolean {
    if (!validBinding(binding) || !integer(sample.used) || !integer(sample.size) || !integer(sample.observedAt)) return false
    return Boolean(this.db.prepare(`UPDATE run_models SET context_used = ?, context_size = ?, context_observed_at = ?
      WHERE run_id = ? AND acp_session_id = ? AND runtime_generation = ? AND selector = ?
      AND admitted_at IS NOT NULL AND admitted_at <= ?
      AND (context_observed_at IS NULL OR context_observed_at <= ?)
      AND EXISTS (SELECT 1 FROM run_attempts r WHERE r.id = run_models.run_id
        AND r.state = 'running' AND r.acp_session_id = run_models.acp_session_id)`)
      .run(sample.used, sample.size, sample.observedAt, runId, binding.acpSessionId, binding.runtimeGeneration,
        binding.selector, sample.observedAt, sample.observedAt).changes)
  }
}

function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 }
function integer(value: unknown, min = 0): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= min }
function validBinding(input: RunModelBinding): boolean {
  return nonempty(input.acpSessionId) && integer(input.runtimeGeneration, 1) && nonempty(input.selector)
}
