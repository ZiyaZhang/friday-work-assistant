import type { MemoryAvailability, MemoryNote } from './memory.js'
import type { MemoryAncestor } from './memory-provenance.js'
import { ManagedMemoryStorage, type ManagedMemoryMetadata, type ManagedMemoryQuery } from './managed-memory-storage.js'
import type { PersonalMemoryAccess, PersonalMemoryActor } from './personal-memory-access.js'
import { dmSpaceId } from './space.js'

export interface ManagedMemoryProof {
  readonly runId: string
  readonly refs: readonly Readonly<MemoryAncestor>[]
  /** Host-only closure: current identity/Space/Run lease plus exact admitted note versions. */
  assertCurrent(): void
}
export interface PersonalMemoryAuthorization {
  denied: { id: number; revision: number; reason: string }[]
  unavailable: { id: number; revision: number; reason: string }[]
  proof: ManagedMemoryProof
}
export interface PersonalMemoryReadResult extends PersonalMemoryAuthorization {
  notes: MemoryNote[]
  total: number
  availability: MemoryAvailability
}
export type PersonalMemoryReadActor = PersonalMemoryActor & { runId: string }

/** One metadata batch and one authorization request; no mutation or runtime-stop side effects. */
export class PersonalMemoryReader {
  constructor(private readonly storage: ManagedMemoryStorage, private readonly access: Pick<PersonalMemoryAccess, 'checkMany'>) {}

  /** Reauthorize the exact managed versions already present in a warm ACP context, without bodies. */
  async authorizeRefs(actor: PersonalMemoryReadActor, refs: readonly MemoryAncestor[], assertRun: () => void): Promise<PersonalMemoryAuthorization> {
    assertRun()
    const capturedActor = { ...actor }, capturedRefs = refs.map(({ id, revision }) => ({ id, revision }))
    const scope = `space:${capturedActor.spaceId}`
    return (await this.authorize(capturedActor, this.storage.metadataForRefs(scope, capturedRefs), assertRun)).authorization
  }

  async search(actor: PersonalMemoryReadActor, input: ManagedMemoryQuery, assertRun: () => void): Promise<PersonalMemoryReadResult> {
    assertRun()
    const capturedActor = { ...actor }, query = { ...input }, scope = `space:${capturedActor.spaceId}`
    // Even an empty metadata batch must not disclose another person's inactive count.
    if (!capturedActor.openId || capturedActor.spaceId !== dmSpaceId(capturedActor.openId)) throw new Error('只能查询本人的个人记忆')
    const { authorization, proofFor } = await this.authorize(capturedActor, this.storage.metadata(scope), assertRun)
    authorization.proof.assertCurrent()
    const read = this.storage.search(scope, authorization.proof.refs, query)
    authorization.proof.assertCurrent()
    // The query snapshot covers the full authorized set; a consumed context only depends
    // on the returned bodies, while retaining the same fixed identity/Space/Run lease.
    // Denied refs are still verified here. The host applies their invalidation after this
    // read, so adding them to the already-unavailable count cannot count a note twice.
    const availability = { inactiveNotes: this.storage.countUnavailable(scope) + authorization.denied.length,
      temporarilyUnavailableNotes: authorization.unavailable.length }
    return { ...read, ...authorization, availability, proof: proofFor(read.notes) }
  }

  private async authorize(actor: PersonalMemoryReadActor, metadata: readonly ManagedMemoryMetadata[], assertRun: () => void): Promise<{
    authorization: PersonalMemoryAuthorization
    proofFor: (refs: readonly MemoryAncestor[]) => ManagedMemoryProof
  }> {
    if (!actor.runId) throw new Error('记忆核验需要当前执行编号')
    const scope = `space:${actor.spaceId}`, key = ({ id, revision }: MemoryAncestor) => `${id}:${revision}`
    const refs = metadata.map(({ id, revision }) => ({ id, revision }))
    const access = await this.access.checkMany(actor, metadata.map(note => ({ key: key(note), sources: note.provenance.sources })), assertRun)
    assertRun(); access.assertCurrent(); this.storage.assertCurrent(scope, refs)
    const decisions = new Map(access.results.map(result => [result.key, result]))
    // Missing/duplicate/foreign decisions are an adapter failure, not evidence of lost access.
    if (decisions.size !== access.results.length || decisions.size !== metadata.length || metadata.some(note => !decisions.has(key(note)))) {
      throw new Error('记忆来源核验结果不完整，请稍后重试')
    }
    const allowed: MemoryAncestor[] = [], denied: PersonalMemoryAuthorization['denied'] = [], unavailable: PersonalMemoryAuthorization['unavailable'] = []
    for (const note of metadata) {
      const result = decisions.get(key(note))!
      const ref = { id: note.id, revision: note.revision }
      if (result.status === 'allowed') allowed.push(ref)
      else (result.status === 'denied' ? denied : unavailable).push({ ...ref, reason: result.reason })
    }
    const proofFor = (selected: readonly MemoryAncestor[]): ManagedMemoryProof => {
      const refs = Object.freeze(selected.map(({ id, revision }) => Object.freeze({ id, revision })))
      return Object.freeze({ runId: actor.runId, refs,
        assertCurrent: () => { assertRun(); access.assertCurrent(); this.storage.assertCurrent(scope, refs) },
      })
    }
    const proof = proofFor(allowed)
    proof.assertCurrent()
    return { authorization: { denied, unavailable, proof }, proofFor }
  }
}
