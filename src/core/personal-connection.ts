import type { Registry } from './registry.js'
import type { MemoryRuntime } from './memory-runtime.js'
import type { UserToken, UserTokenStore } from '../feishu/oauth.js'

/** Connection removal and the memories derived from it commit together. */
export class PersonalConnectionApplication {
  constructor(private readonly deps: { registry: Registry; userTokens: UserTokenStore; memory: MemoryRuntime }) {}

  /** OAuth validation uses expected to avoid disconnecting a newer, concurrent connection. */
  disconnect(openId: string, expected?: UserToken): boolean {
    const { registry, userTokens, memory } = this.deps
    let removed: boolean
    let invalidated: ReturnType<MemoryRuntime['application']['invalidateSources']>
    // This entry point owns the outer commit; nested callers must not abort runtime work before their own commit.
    registry.db.exec('BEGIN IMMEDIATE')
    try {
      if (expected && JSON.stringify(userTokens.get(openId)) !== JSON.stringify(expected)) {
        registry.db.exec('COMMIT')
        return false
      }
      removed = userTokens.disconnect(openId)
      invalidated = memory.application.invalidateSources({ kind: 'user', openId })
      registry.db.exec('COMMIT')
    } catch (error) {
      registry.db.exec('ROLLBACK')
      throw error
    }
    memory.complete(invalidated)
    return removed
  }
}
