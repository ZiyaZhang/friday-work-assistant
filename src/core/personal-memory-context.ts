import type { ChannelMemory, MemoryAddInput, ScopeSpec } from './memory.js'
import type { MemoryRuntime } from './memory-runtime.js'
import type { PersonalMemoryAccess } from './personal-memory-access.js'
import type { PersonalMemoryReader, PersonalMemoryReadActor, PersonalMemoryAuthorization } from './personal-memory-reader.js'
import type { SourceContext } from './source-context.js'
import { MemoryRevisionConflict } from './memory-provenance.js'
import { describeMemoryAvailability } from './receipt.js'

/** Coordinates source authorization with actual memory consumption. No chat routing or sending here. */
export class PersonalMemoryContext {
  constructor(private readonly deps: { memory: ChannelMemory; runtime: MemoryRuntime; reader: PersonalMemoryReader; access: PersonalMemoryAccess }) {}

  async resume(actor: PersonalMemoryReadActor, acpId: string, assertRun: () => void): Promise<boolean> {
    const context = this.deps.runtime.contexts.get(acpId)
    if (!context || context.state !== 'valid') return false
    const managed = context.notes.filter(ref => this.deps.memory.getProvenance(ref.id)?.state === 'verified')
    if (!managed.length) return true
    let result: PersonalMemoryAuthorization
    try { result = await this.deps.reader.authorizeRefs(actor, managed, assertRun) }
    catch (error) { if (error instanceof MemoryRevisionConflict) return false; throw error }
    this.applyAuthorization(actor, result)
    return result.denied.length === 0 && result.unavailable.length === 0
  }

  async search(actor: PersonalMemoryReadActor, scopes: string[], query: string, limit: number, assertRun: () => void) {
    const result = await this.deps.reader.search(actor, { query, limit, purpose: 'history' }, assertRun)
    this.applyAuthorization(actor, result)
    const legacy = this.deps.memory.search(scopes, query, limit)
    const notes = [...result.notes, ...legacy].slice(0, limit)
    this.deps.runtime.recordRead(actor.runId, notes)
    return { notes, unavailable: result.unavailable.length, sourceDenied: result.denied.length, availability: result.availability }
  }

  async prepare(actor: PersonalMemoryReadActor, scopes: ScopeSpec[], query: string, assertRun: () => void) {
    const result = await this.deps.reader.search(actor, { query, limit: 6, purpose: 'prompt' }, assertRun)
    this.applyAuthorization(actor, result)
    const prepared = this.deps.runtime.prepare(actor.runId, scopes, query)
    prepared.used.availability = result.availability
    const availability = describeMemoryAvailability(result.availability)
    if (availability) prepared.text += `\n\n[记忆可用性｜给你自己判断用，不是要转告的话]\n${availability}\n回答里不提这些条数；只有本人问「你怎么知道的」或问记忆全不全时才说。`
    if (result.notes.length) {
      this.deps.runtime.recordRead(actor.runId, result.notes)
      prepared.text += `\n\n[本人获授权群资料的相关记忆；仍以当前材料为准]\n${result.notes.map(note =>
        `- ${note.title}${note.status === 'candidate' ? '（待确认）' : ''}：${note.body.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n')}`
      prepared.used.notes.push(...result.notes.map(note => ({ id: note.id, revision: note.revision, title: note.title,
        scope: note.scope, label: '个人', status: note.status })))
      const layer = prepared.used.layers.find(layer => layer.scope === `space:${actor.spaceId}`)
      if (layer) { layer.hits += result.notes.length; layer.total += result.total }
    }
    return { prepared, unavailable: result.unavailable.length }
  }

  async add(actor: PersonalMemoryReadActor, input: MemoryAddInput, context: SourceContext, assertRun: () => void, assertMaterials: () => void = assertRun) {
    if (context.meetingSources?.length) throw new Error('会议材料尚未接入长期记忆来源核验')
    if (context.pollSources?.length) throw new Error('投票材料尚未接入长期记忆来源核验')
    // The person's own notes may draw on what was read as them or is openly public; another identity's material may not.
    const foreign = context.external.some(source => !(source.access === 'public' && !source.personalOpenId) && source.personalOpenId !== actor.openId)
    if (input.scope !== `space:${actor.spaceId}` || context.spaceId !== actor.spaceId ||
      context.personalMemoryComplete !== true || foreign) throw new Error('本次材料尚不能保存到个人记忆')
    const sources = [...(context.messageSources ?? [])]
    if (input.replaces) sources.push(...(this.deps.memory.getProvenance(input.replaces)?.sources ?? []))
    const consumed = this.deps.runtime.contexts.contextForRun(actor.runId)?.notes ?? []
    for (const ref of consumed) sources.push(...(this.deps.memory.getProvenance(ref.id)?.sources ?? []))
    if (context.chats.some(chat => !sources.some(source => source.chatId === chat.chatId))) throw new Error('群材料缺少本次读取来源')
    const distinct = [...new Map(sources.map(source => [JSON.stringify(source), source])).values()]
    if (!distinct.length) throw new Error('个人记忆缺少获授权的来源')
    const access = await this.deps.access.check(actor, distinct, assertRun)
    access.assertCurrent()
    if (access.status !== 'allowed') throw new Error(access.status === 'denied' ? '这些群资料的授权已失效' : '这次未能核验群资料授权，请稍后再试')
    assertMaterials()
    const note = this.deps.runtime.addDerived(actor.runId, { ...input, provenance: {
      state: 'verified', originRunId: actor.runId, sources: distinct,
    } })
    // A correction can invalidate this ACP. The host sends its fixed receipt without resuming it.
    if (this.deps.runtime.contexts.contextForRun(actor.runId)?.state === 'valid') {
      this.deps.runtime.contexts.admit(actor.runId, { runId: actor.runId, refs: [note], assertCurrent: access.assertCurrent })
      this.deps.runtime.recordRead(actor.runId, [note])
    }
    return note
  }

  private applyAuthorization(actor: PersonalMemoryReadActor, result: PersonalMemoryAuthorization): void {
    result.proof.assertCurrent()
    this.deps.runtime.contexts.withdraw(actor.runId, result.unavailable)
    if (result.denied.length) this.deps.runtime.invalidateSources({ kind: 'notes', refs: result.denied })
    this.deps.runtime.contexts.admit(actor.runId, result.proof)
  }
}
