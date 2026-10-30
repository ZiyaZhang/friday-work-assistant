import { MaterialApplicationError, type MaterialRun } from './execution-material-application.js'
import type { MaterialProvenance } from './execution-materials.js'
import type { ExecutionSourceAccess, ExecutionSourceActor } from './execution-source-access.js'
import type { RuntimeContexts } from './runtime-contexts.js'
import type { SourceContexts } from './source-context.js'

export interface MaterialExecutionBinding extends ExecutionSourceActor {
  sessionKey: string
  mode: 'workspace' | 'managed'
  deliver: MaterialRun['deliver']
}

/** Connects registered file versions to the current host Run and its authorized inputs. */
export class ExecutionMaterialRuntime {
  constructor(private readonly deps: {
    sources: SourceContexts
    contexts: RuntimeContexts
    access: Pick<ExecutionSourceAccess, 'check'>
    binding(runId: string): MaterialExecutionBinding
  }) {}

  resolve(runId: string): MaterialRun {
    const binding = this.deps.binding(runId)
    const check = () => {
      binding.assertCurrent()
      const current = this.deps.binding(runId)
      if (current.mode !== 'managed' || current.runId !== runId || current.sessionKey !== binding.sessionKey ||
        current.acpSessionId !== binding.acpSessionId || current.spaceId !== binding.spaceId ||
        !this.deps.contexts.isEligible(runId, true)) throw new MaterialApplicationError('denied')
    }
    const snapshot = (): MaterialProvenance => {
      check()
      const sources = this.deps.sources.get(binding.sessionKey), context = this.deps.contexts.contextForRun(runId)
      if (!sources || sources.acpSessionId !== binding.acpSessionId || sources.spaceId !== binding.spaceId ||
        sources.chatId !== binding.chatId || !context) throw new MaterialApplicationError('denied')
      return structuredClone({ sources, memoryRefs: context.notes })
    }
    const checkRefs = (provenance: MaterialProvenance) => {
      const current = snapshot()
      if (provenance.sources.acpSessionId !== binding.acpSessionId || provenance.sources.spaceId !== binding.spaceId ||
        provenance.sources.chatId !== binding.chatId || !provenance.memoryRefs.every(ref => current.memoryRefs.some(item =>
          item.id === ref.id && item.revision === ref.revision))) throw new MaterialApplicationError('denied')
    }
    check()
    return {
      context: { sessionKey: binding.sessionKey, spaceId: binding.spaceId, generation: binding.acpSessionId, runId, assertCurrent: check },
      snapshot,
      authorize: async provenance => {
        checkRefs(provenance)
        const access = await this.deps.access.check({ ...binding, assertCurrent: () => checkRefs(provenance) }, provenance.sources)
        const assertCurrent = () => { checkRefs(provenance); access.assertCurrent() }
        assertCurrent()
        if (access.status !== 'allowed') throw new MaterialApplicationError('denied')
        return { assertCurrent }
      },
      consume: provenance => {
        checkRefs(provenance)
        this.deps.sources.recordRetained(binding, provenance.sources)
        this.deps.contexts.recordRead(runId, provenance.memoryRefs)
        check()
      },
      deliver: (file, assertCurrent) => {
        check(); assertCurrent()
        return binding.deliver(file, () => { check(); assertCurrent() })
      },
    }
  }
}
