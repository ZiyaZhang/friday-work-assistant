import type { Registry } from './registry.js'
import { MemoryApplication, type MemoryOperationResult } from './memory-application.js'
import type { ChannelMemory, ScopeSpec } from './memory.js'
import { RuntimeContextError, RuntimeContexts, type RuntimeMemoryRef } from './runtime-contexts.js'
import type { RunAttempts } from './run-attempts.js'
import type { RoutineStore } from './routines.js'

export interface ActiveMemoryRun { runId: string; occurrenceId?: number; abort: () => void }

/** Connects memory commits to exact executions. Business work and user questions remain intact. */
export class MemoryRuntime {
  readonly contexts: RuntimeContexts
  readonly application: MemoryApplication
  constructor(private readonly deps: { registry: Registry; memory: ChannelMemory; attempts: RunAttempts; routines?: RoutineStore;
    activeRun: (runId: string) => ActiveMemoryRun | undefined; now: () => number }) {
    this.contexts = new RuntimeContexts(deps.registry.db, deps.now)
    this.application = new MemoryApplication(deps.registry.db, deps.memory, this.contexts, deps.attempts, {
      persistInvalidatedRuns: ids => {
        for (const id of ids) {
          const attempt = deps.attempts.get(id)!
          if (attempt.stopReason !== 'memory_context_invalidated') continue
          if (attempt.taskId) deps.registry.requestStop(attempt.taskId, 'memory_context_invalidated')
          const active = deps.activeRun(id)
          if (active?.occurrenceId) deps.routines?.cancelOccurrence(active.occurrenceId, deps.now(), '本次执行使用的记忆已更新')
        }
      },
    })
  }

  /** Called only after a top-level memory operation has committed. */
  complete<T>(result: MemoryOperationResult<T>): T {
    for (const id of result.invalidatedRunIds) {
      const attempt = this.deps.attempts.get(id)
      if (attempt?.state === 'stop_requested' && attempt.stopReason === 'memory_context_invalidated') this.deps.activeRun(id)?.abort()
    }
    return result.value
  }
  add(...args: Parameters<ChannelMemory['add']>) { return this.complete(this.application.add(...args)) }
  /** Generated answers and extractions inherit the actual ACP inputs, including earlier turns. */
  addDerived(runId: string, input: Parameters<ChannelMemory['add']>[0]) {
    if (!this.deps.attempts.isCurrent(runId) || !this.contexts.isEligible(runId, true)) throw new RuntimeContextError('run_ineligible')
    return this.add({ ...input, derivedFrom: this.contexts.contextForRun(runId)!.notes })
  }
  confirm(...args: Parameters<ChannelMemory['confirm']>) { return this.complete(this.application.confirm(...args)) }
  remove(...args: Parameters<ChannelMemory['remove']>) { return this.complete(this.application.remove(...args)) }
  promote(...args: Parameters<ChannelMemory['promote']>) { return this.complete(this.application.promote(...args)) }
  invalidateSources(...args: Parameters<ChannelMemory['invalidateSources']>) { return this.complete(this.application.invalidateSources(...args)) }

  prepare(runId: string, scopes: ScopeSpec[] | string, query: string, limit = 6) {
    const prepared = this.deps.memory.composeForPrompt(scopes, query, limit)
    this.recordRead(runId, prepared.used.notes)
    return prepared
  }
  recordRead(runId: string, notes: readonly RuntimeMemoryRef[]) { this.contexts.recordRead(runId, notes) }
}
