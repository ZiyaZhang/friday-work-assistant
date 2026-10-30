import type { Registry } from './registry.js'
import type { RunAttempts } from './run-attempts.js'
import type { ChannelMemory } from './memory.js'
import type { PersonalMemoryAccess } from './personal-memory-access.js'
import type { ExecutionSourceAccess, ExecutionSourceAccessResult } from './execution-source-access.js'
import type { MaterialProvenance } from './execution-materials.js'
import type { Spaces } from './space.js'

export interface RetainedSourceOrigin {
  runId: string; taskId: number; workKey: string; sessionKey: string; ownerOpenId: string
  spaceId: string; chatId: string; chatType: 'group' | 'p2p'
}

/** Revalidates a persisted input snapshot for a later host event without pretending
 * its original Run is still alive. Permissions and exact memory versions stay live. */
export async function authorizeRetainedSources(deps: {
  registry: Registry; attempts: RunAttempts; spaces: Spaces; memory: ChannelMemory
  access: Pick<ExecutionSourceAccess, 'check'>; personalMemory?: Pick<PersonalMemoryAccess, 'checkRead'>
  readScopes(origin: RetainedSourceOrigin): readonly string[]
}, provenance: MaterialProvenance, origin: RetainedSourceOrigin, assertCaller: () => void,
  options: { readOnlyResult?: boolean } = {}): Promise<ExecutionSourceAccessResult> {
  const snapshot = structuredClone(provenance), work = deps.registry.workContexts.get(origin.workKey), epoch = work?.controlEpoch
  const current = () => {
    assertCaller()
    const task = deps.registry.getTask(origin.taskId), session = deps.registry.getSession(origin.sessionKey)
    const attempt = deps.attempts.get(origin.runId), sourceWork = deps.registry.workContexts.get(origin.workKey), space = deps.spaces.get(origin.spaceId)
    if (!task || task.sessionKey !== origin.sessionKey || task.requesterOpenId !== origin.ownerOpenId ||
      deps.registry.taskWork.get(task.id)?.key !== origin.workKey || !session || session.status === 'archived' ||
      session.chatId !== origin.chatId || session.chatType !== origin.chatType || !attempt || attempt.taskId !== task.id ||
      attempt.sessionKey !== origin.sessionKey || attempt.actorOpenId !== origin.ownerOpenId || attempt.workKey !== origin.workKey ||
      attempt.acpSessionId !== snapshot.sources.acpSessionId || !sourceWork || (!options.readOnlyResult && (sourceWork.lifecycle !== 'open' || sourceWork.pauseReasons.length > 0)) ||
      sourceWork.controlEpoch !== epoch || sourceWork.authorityOpenId !== origin.ownerOpenId ||
      !space || space.status !== 'active' || space.chatId !== origin.chatId || space.kind !== origin.chatType) throw new Error('原委托或来源绑定已变化')
    const scopes = new Set(deps.readScopes(origin))
    for (const ref of snapshot.memoryRefs) {
      // Metadata only: ChannelMemory.get deliberately hides managed bodies.
      const note = deps.registry.db.prepare('SELECT revision,status,scope FROM memory_notes WHERE id=?').get(ref.id)
      if (!note || note.revision !== ref.revision || !['candidate', 'confirmed'].includes(String(note.status)) || !scopes.has(String(note.scope))) throw new Error('原记忆版本已不可用')
    }
  }
  current()
  const source = await deps.access.check({ runId: origin.runId, openId: origin.ownerOpenId, spaceId: origin.spaceId,
    chatId: origin.chatId, chatType: origin.chatType, acpSessionId: snapshot.sources.acpSessionId,
    assertCurrent: current, readScopes: () => deps.readScopes(origin) }, snapshot.sources)
  current(); source.assertCurrent()
  if (source.status !== 'allowed') return source
  const records = snapshot.memoryRefs.map(ref => deps.memory.getProvenance(ref.id)).filter(value => value !== undefined)
  if (records.some(record => record.state === 'unavailable')) return { status: 'unavailable', reason: 'memory_source_unverified', assertCurrent: current }
  const sources = records.filter(record => record.state === 'verified').flatMap(record => record.sources)
  if (!sources.length) return { status: 'allowed', assertCurrent: () => { current(); source.assertCurrent() } }
  if (!deps.personalMemory || origin.chatType !== 'p2p') return { status: 'unavailable', reason: 'memory_source_unverified', assertCurrent: current }
  const memory = await deps.personalMemory.checkRead({ spaceId: origin.spaceId, openId: origin.ownerOpenId }, sources,
    () => { current(); source.assertCurrent() })
  const check = () => { current(); source.assertCurrent(); memory.assertCurrent() }
  check()
  return memory.status === 'allowed' ? { status: 'allowed', assertCurrent: check } : { status: memory.status, reason: memory.reason, assertCurrent: check }
}
