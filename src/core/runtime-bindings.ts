import type { AcpRuntimeBindings, AcpRuntimeMode } from '../acp/runtime-pool.js'
import type { Registry } from './registry.js'

/** Uses the existing host KV; no existing Session or ACP ID is rewritten. */
export class RuntimeBindings implements AcpRuntimeBindings {
  constructor(private readonly registry: Registry) {}
  get(id: string): AcpRuntimeMode | undefined {
    const value = this.registry.getKv(`acp-runtime:${id}`)
    if (value === undefined) return undefined
    if (value !== 'managed' && value !== 'workspace') throw new Error('执行模式记录无效')
    return value
  }
  bindOnce(id: string, mode: AcpRuntimeMode): void {
    const previous = this.get(id)
    if (previous !== undefined && previous !== mode) throw new Error('不能更改既有执行会话的运行模式')
    if (previous === undefined) this.registry.setKv(`acp-runtime:${id}`, mode)
  }
  /** Genuine old Registry sessions only. Existing managed bindings are never overwritten. */
  importLegacyWorkspace(): void {
    for (const row of this.registry.db.prepare('SELECT DISTINCT acp_session_id FROM sessions WHERE acp_session_id IS NOT NULL').all()) {
      const id = String(row.acp_session_id)
      if (this.get(id) === undefined) this.bindOnce(id, 'workspace')
    }
  }
}
