import type { DatabaseSync } from 'node:sqlite'
import type { ChannelMemory } from './memory.js'
import type { RuntimeContexts } from './runtime-contexts.js'
import type { RunAttempts } from './run-attempts.js'

export interface MemoryOperationResult<T> { value: T; invalidatedRunIds: string[] }
export interface MemoryApplicationOptions {
  /** Synchronous persistence only, on the same DB/transaction. Abort captured handles after outer COMMIT. */
  persistInvalidatedRuns?: (runIds: readonly string[]) => void
}

/** Authorized host writes: memory, context invalidation and durable stop commit or roll back together. */
export class MemoryApplication {
  constructor(private readonly db: DatabaseSync, private readonly memory: ChannelMemory,
    private readonly contexts: RuntimeContexts, private readonly attempts: RunAttempts,
    private readonly options: MemoryApplicationOptions = {}) {}

  add(...args: Parameters<ChannelMemory['add']>): MemoryOperationResult<ReturnType<ChannelMemory['add']>> {
    return this.write(() => this.memory.add(...args))
  }

  confirm(...args: Parameters<ChannelMemory['confirm']>): MemoryOperationResult<ReturnType<ChannelMemory['confirm']>> {
    return this.write(() => this.memory.confirm(...args))
  }

  remove(...args: Parameters<ChannelMemory['remove']>): MemoryOperationResult<ReturnType<ChannelMemory['remove']>> {
    return this.write(() => this.memory.remove(...args))
  }

  promote(...args: Parameters<ChannelMemory['promote']>): MemoryOperationResult<ReturnType<ChannelMemory['promote']>> {
    return this.write(() => this.memory.promote(...args))
  }

  invalidateSources(...args: Parameters<ChannelMemory['invalidateSources']>): MemoryOperationResult<number[]> {
    return this.write(() => this.memory.invalidateSources(...args))
  }

  private write<T>(action: () => T): MemoryOperationResult<T> {
    this.db.exec('SAVEPOINT memory_application_write')
    try {
      const before = this.db.prepare('SELECT COALESCE(MAX(sequence),0) n FROM memory_changes').get() as { n: number }
      const value = action()
      const invalidatedRunIds = this.contexts.invalidate(this.memory.changes(Number(before.n)))
      for (const id of invalidatedRunIds) this.attempts.requestStop(id, 'memory_context_invalidated')
      if (invalidatedRunIds.length) this.options.persistInvalidatedRuns?.(invalidatedRunIds)
      this.db.exec('RELEASE memory_application_write')
      // This may still be inside the caller's transaction. No side effects run here.
      return { value, invalidatedRunIds }
    } catch (error) {
      this.db.exec('ROLLBACK TO memory_application_write; RELEASE memory_application_write')
      throw error
    }
  }
}
