import type { FeishuClient } from '../feishu/client.js'
import type { UserTokenStore } from '../feishu/oauth.js'
import { UserMessageReadAccess, UserMessageReadChanged } from './user-message-read-lease.js'
import type { MemorySourceReference } from './memory-provenance.js'
import type { PolicyService } from './policy.js'
import { dmSpaceId, type Space, type Spaces } from './space.js'

export { UserMessageReadChanged as PersonalMemoryAccessChanged } from './user-message-read-lease.js'

export interface PersonalMemoryActor { spaceId: string; openId: string }
type DeniedReason = 'target_forbidden' | 'source_actor_mismatch' | 'source_app_mismatch' | 'source_binding_changed'
  | 'not_connected' | 'invalid_grant' | 'identity_mismatch' | 'scope_missing' | 'chat_not_accessible'
type UnavailableReason = 'source_incomplete' | 'unsupported_identity' | 'token_unavailable' | 'authorization_changed'
  | 'scope_unknown' | 'identity_unavailable' | 'chat_list_unavailable' | 'chat_list_incomplete'
export type PersonalMemoryAccessResult =
  | { status: 'allowed'; assertCurrent(): void }
  | { status: 'denied'; reason: DeniedReason; assertCurrent(): void }
  | { status: 'unavailable'; reason: UnavailableReason; assertCurrent(): void }

export interface PersonalMemoryAccessEntry { key: string; sources: readonly MemorySourceReference[] }
export type PersonalMemoryAccessDecision =
  | { key: string; status: 'allowed' }
  | { key: string; status: 'denied'; reason: DeniedReason }
  | { key: string; status: 'unavailable'; reason: UnavailableReason }
export interface PersonalMemoryBatchResult {
  results: readonly PersonalMemoryAccessDecision[]
  assertCurrent(): void
}

interface PersonalMemoryAccessDeps {
  /** Must be the appId of the supplied FeishuClient and UserTokenStore provider. */
  appId: string
  spaces: Spaces
  policy: PolicyService
  userTokens: Pick<UserTokenStore, 'get' | 'accessTokenResult'>
  feishu: Pick<FeishuClient, 'whoAmI' | 'listChatsResult'>
}

/** Read authorization for host-recorded user/group-message sources into the user's own DM.
 * Does not ensure Spaces, write memory, grant publishing rights, or fall back to app identity.
 */
export class PersonalMemoryAccess {
  private readonly reads: UserMessageReadAccess
  constructor(private readonly deps: PersonalMemoryAccessDeps) { this.reads = new UserMessageReadAccess(deps) }

  async check(actor: PersonalMemoryActor, sources: readonly MemorySourceReference[], assertRun: () => void): Promise<PersonalMemoryAccessResult> {
    const result = await this.checkMany(actor, [{ key: 'source', sources }], assertRun)
    const { key: _, ...decision } = result.results[0]!
    return { ...decision, assertCurrent: result.assertCurrent }
  }

  /** Reading existing execution material does not grant, or require, permission to save memory. */
  async checkRead(actor: PersonalMemoryActor, sources: readonly MemorySourceReference[], assertRun: () => void): Promise<PersonalMemoryAccessResult> {
    const result = await this.checkManyFor(actor, [{ key: 'source', sources }], assertRun, false)
    const { key: _, ...decision } = result.results[0]!
    return { ...decision, assertCurrent: result.assertCurrent }
  }

  /** Each note keeps its own decision; all eligible notes share one fresh identity/group lease. */
  async checkMany(inputActor: PersonalMemoryActor, inputEntries: readonly PersonalMemoryAccessEntry[], assertRun: () => void): Promise<PersonalMemoryBatchResult> {
    return this.checkManyFor(inputActor, inputEntries, assertRun, true)
  }

  private async checkManyFor(inputActor: PersonalMemoryActor, inputEntries: readonly PersonalMemoryAccessEntry[], assertRun: () => void,
    requireRemember: boolean): Promise<PersonalMemoryBatchResult> {
    const actor = { ...inputActor }
    const entries = inputEntries.map(entry => ({ key: entry.key,
      sources: entry.sources.map(source => ({ ...source, readIdentity: { ...source.readIdentity } })) }))
    if (entries.some(entry => !entry.key) || new Set(entries.map(entry => entry.key)).size !== entries.length) throw new Error('来源核验需要唯一条目编号')
    assertRun()
    const allSources = entries.flatMap(entry => entry.sources)
    const snapshot = this.localSnapshot(actor, allSources, requireRemember), signature = JSON.stringify(snapshot)
    const assertLocal = () => {
      assertRun()
      if (JSON.stringify(this.localSnapshot(actor, allSources, requireRemember)) !== signature) throw new UserMessageReadChanged()
    }
    const results = new Map<string, PersonalMemoryAccessDecision>()
    const finish = (assertCurrent: () => void): PersonalMemoryBatchResult => {
      assertCurrent()
      return { results: entries.map(entry => results.get(entry.key)!), assertCurrent }
    }
    if (!actor.openId || actor.spaceId !== dmSpaceId(actor.openId) || snapshot.target?.kind !== 'p2p' ||
      snapshot.target.status !== 'active' || snapshot.role !== 'owner' || snapshot.read !== 'allow' || requireRemember && snapshot.remember !== 'allow') {
      for (const { key } of entries) results.set(key, { key, status: 'denied', reason: 'target_forbidden' })
      return finish(assertLocal)
    }
    for (const { key, sources } of entries) {
      if (!sources.length || sources.some(source => !source.ref || !source.chatId || !source.tenantId || !source.appId)) {
        results.set(key, { key, status: 'unavailable', reason: 'source_incomplete' }); continue
      }
      if (sources.some(source => source.readIdentity.kind !== 'user')) {
        results.set(key, { key, status: 'unavailable', reason: 'unsupported_identity' }); continue
      }
      if (sources.some(source => source.readIdentity.kind === 'user' && source.readIdentity.openId !== actor.openId)) {
        results.set(key, { key, status: 'denied', reason: 'source_actor_mismatch' }); continue
      }
      if (!this.deps.appId || sources.some(source => source.appId !== this.deps.appId)) {
        results.set(key, { key, status: 'denied', reason: 'source_app_mismatch' }); continue
      }
      const local = this.localSnapshot(actor, sources, requireRemember)
      if (local.sources.some((binding, index) => {
        const source = sources[index]!
        if (source.spaceId && (!binding.original || binding.original.id !== source.spaceId)) return true
        const space = binding.original ?? binding.byChat
        return Boolean(space && (space.kind !== 'group' || space.status !== 'active' || space.chatId !== source.chatId)) ||
          Boolean(binding.original && binding.byChat && binding.original.id !== binding.byChat.id)
      })) {
        results.set(key, { key, status: 'denied', reason: 'source_binding_changed' }); continue
      }
      if (new Set(sources.map(source => source.tenantId)).size !== 1) {
        results.set(key, { key, status: 'denied', reason: 'identity_mismatch' })
      }
    }
    const eligible = entries.filter(entry => !results.has(entry.key))
    if (!eligible.length) return finish(assertLocal)
    const tenants = new Set(eligible.flatMap(entry => entry.sources.map(source => source.tenantId)))
    // A single expected tenant can fail before listing chats. Mixed entries are compared
    // independently to the same returned identity; one bad note does not deny the others.
    const access = await this.reads.open(actor.openId, assertLocal, tenants.size === 1 ? [...tenants][0] : undefined)
    if (access.status !== 'available') {
      const { assertCurrent, ...decision } = access
      for (const { key } of eligible) results.set(key, { key, ...decision })
      return finish(access.assertCurrent)
    }
    const lease = access.lease
    lease.assertCurrent()
    const readable = lease.capture.status === 'ready' ? new Set(lease.capture.groups.map(chat => chat.chatId)) : null
    for (const { key, sources } of eligible) {
      if (sources.some(source => source.tenantId !== lease.authority.tenantId)) {
        results.set(key, { key, status: 'denied', reason: 'identity_mismatch' })
      } else if (lease.capture.status !== 'ready') {
        results.set(key, { key, ...lease.capture })
      } else if (sources.some(source => !readable!.has(source.chatId!))) {
        results.set(key, lease.capture.groupsComplete
          ? { key, status: 'denied', reason: 'chat_not_accessible' }
          : { key, status: 'unavailable', reason: 'chat_list_incomplete' })
      } else results.set(key, { key, status: 'allowed' })
    }
    return finish(lease.assertCurrent)
  }

  private localSnapshot(actor: PersonalMemoryActor, sources: readonly MemorySourceReference[], requireRemember: boolean) {
    const { spaces, policy } = this.deps
    return {
      target: binding(spaces.get(actor.spaceId)), role: spaces.roleOf(actor.spaceId, actor.openId),
      read: policy.decide({ spaceId: actor.spaceId, openId: actor.openId, action: 'read' }).decision,
      remember: requireRemember ? policy.decide({ spaceId: actor.spaceId, openId: actor.openId, action: 'remember' }).decision : undefined,
      sources: sources.map(source => ({ original: source.spaceId ? binding(spaces.get(source.spaceId)) : null,
        byChat: source.chatId ? binding(spaces.byChat(source.chatId, true)) : null })),
    }
  }
}

function binding(space: Space | undefined) {
  return space ? { id: space.id, kind: space.kind, chatId: space.chatId, status: space.status } : null
}
