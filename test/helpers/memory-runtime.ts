import type { ChannelMemory } from '../../src/core/memory.js'
import { MemoryApplication } from '../../src/core/memory-application.js'
import type { Registry } from '../../src/core/registry.js'
import { RunAttempts, type RunStage } from '../../src/core/run-attempts.js'
import { RuntimeContexts } from '../../src/core/runtime-contexts.js'
import type { InternalApiDeps } from '../../src/internal/api.js'

/** Real stores behind protocol fixtures; no ACP process, platform transport or authorization is simulated here. */
export function memoryRuntimeFixture(registry: Registry, memory: ChannelMemory) {
  const attempts = new RunAttempts(registry.db), contexts = new RuntimeContexts(registry.db)
  const application = new MemoryApplication(registry.db, memory, contexts, attempts)
  function pin(input: { runId: string; sessionKey: string; stage?: RunStage; actorOpenId?: string; taskId?: number }) {
    const attempt = attempts.begin({ workKey: input.taskId ? `task:${input.taskId}` : `fixture:${input.runId}`,
      sessionKey: input.sessionKey, triggerKey: `fixture:${input.runId}`, stage: input.stage ?? 'task',
      actorOpenId: input.actorOpenId, taskId: input.taskId, now: Date.now() })!
    // Existing protocol fixtures use named signed Run IDs. Rename before adding FK-bound facts.
    registry.db.prepare('UPDATE run_attempts SET id = ? WHERE id = ?').run(input.runId, attempt.id)
    const acpId = `acp:${input.runId}`
    if (!attempts.bindRuntime(input.runId, acpId)) throw new Error('fixture Run admission failed')
    contexts.bind(input.runId, input.sessionKey, acpId)
    return acpId
  }
  const runtime: NonNullable<InternalApiDeps['memoryRuntime']> = {
    recordRead: (runId, refs) => contexts.recordRead(runId, refs),
    add: (runId, input) => { contexts.recordRead(runId, []); return application.add(input).value },
    forget: async (runId, id, scope) => { contexts.recordRead(runId, []); return application.remove(id, scope).value },
  }
  return { attempts, contexts, application, pin, runtime }
}
