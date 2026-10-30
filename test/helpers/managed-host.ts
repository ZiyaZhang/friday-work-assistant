import { join } from 'node:path'
import { AcpRuntimePool } from '../../src/acp/runtime-pool.js'
import { ExecutionMaterials } from '../../src/core/execution-materials.js'
import type { ManagedExecution } from '../../src/core/execution-sessions.js'
import type { Registry } from '../../src/core/registry.js'
import { RuntimeBindings } from '../../src/core/runtime-bindings.js'
import type { Logger } from '../../src/log.js'
import { createFakeAgent } from './fake-agent.js'

/** Real mode routing, persistent bindings and material store; only ACP peers are synthetic.
 * This fixture does not claim to validate DSH profile loading (the separate profile probe does).
 */
export function managedHostRuntime(registry: Registry, home: string, log: Logger, options: { maxConcurrent?: number } = {}) {
  // Distinct peer namespaces model independent runtimes without accidental fake ID collisions.
  const peer = createFakeAgent({ script: [] }), workspacePeer = createFakeAgent({ script: [], counter: 1_000_000 })
  const opts = (p: typeof peer) => ({ transport: { kind: 'inproc' as const, agent: p.app }, log,
    onPermission: async () => ({ outcome: { outcome: 'cancelled' as const } }) })
  const bindings = new RuntimeBindings(registry)
  const runtime = new AcpRuntimePool({ workspace: opts(workspacePeer), managed: opts(peer), bindings, ...options })
  const files = new ExecutionMaterials(registry.db, join(home, 'material-store'))
  const managed: ManagedExecution = { runtime, files, root: join(home, 'managed-executions'), profileDigest: 'synthetic-pinned-profile' }
  return { runtime, managed, peer, workspacePeer, bindings }
}
