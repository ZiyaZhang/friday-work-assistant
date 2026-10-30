import type { FeishuClient } from '../feishu/client.js'
import type { ConsoleActor } from './console-sessions.js'
import type { PolicyService } from './policy.js'
import { dmSpaceId, type Space, type SpaceRole, type Spaces } from './space.js'

/** An authenticated browser identity, supplied and revalidated by the login service. */
export type HumanSpaceActor = ConsoleActor

export type HumanSpaceOperation = 'read' | 'configure' | 'resume'
export interface HumanSpaceAuthorization {
  operation: HumanSpaceOperation
  allowArchived?: boolean
}

export interface AuthorizedSpace {
  space: Space
  role: SpaceRole
  /** Recheck after any caller await and immediately before a local response/commit. */
  assertCurrent(): Space
  canConfigure(): boolean
}

export type HumanSpaceAccessErrorCode = 'space_not_found' | 'space_archived' | 'space_changed'
  | 'not_group_member' | 'membership_unavailable' | 'operation_forbidden'

export class HumanSpaceAccessError extends Error {
  constructor(readonly status: 403 | 404 | 409 | 503, readonly code: HumanSpaceAccessErrorCode, message: string) {
    super(message)
    this.name = 'HumanSpaceAccessError'
  }
}

interface HumanSpaceAccessDeps {
  spaces: Spaces
  policy: PolicyService
  feishu: Pick<FeishuClient, 'chatMemberOpenIds'>
  assertActor(actor: HumanSpaceActor): void
}

/** Human resource authorization only: no Space creation, membership grants or worker capabilities. */
export class HumanSpaceAccess {
  constructor(private readonly deps: HumanSpaceAccessDeps) {}

  async authorize(inputActor: HumanSpaceActor, spaceId: string, options: HumanSpaceAuthorization): Promise<AuthorizedSpace> {
    const actor = { ...inputActor }, operation = options.operation
    const allowArchived = options.allowArchived === true || operation === 'resume'
    const initial = this.localAccess(actor, spaceId, operation, allowArchived)
    // Binding/role/state are authority. Config and title may change without invalidating it.
    const binding = { kind: initial.space.kind, chatId: initial.space.chatId, status: initial.space.status, role: initial.role }
    const assertCurrent = (): Space => {
      const current = this.localAccess(actor, spaceId, operation, allowArchived)
      if (current.space.kind !== binding.kind || current.space.chatId !== binding.chatId ||
        current.space.status !== binding.status || current.role !== binding.role) {
        throw new HumanSpaceAccessError(409, 'space_changed', '空间状态或权限已变化，请刷新后重试')
      }
      return current.space
    }
    if (initial.space.kind === 'group') {
      let members: Set<string>
      try {
        members = await this.deps.feishu.chatMemberOpenIds(initial.space.chatId!, { fresh: true })
      } catch {
        assertCurrent()
        throw new HumanSpaceAccessError(503, 'membership_unavailable', '暂时无法核验群成员，请稍后重试')
      }
      assertCurrent()
      if (!members.has(actor.openId)) throw new HumanSpaceAccessError(403, 'not_group_member', '你已不在这个群里')
    }
    return { space: assertCurrent(), role: initial.role, assertCurrent, canConfigure: () => {
      assertCurrent()
      try { this.localAccess(actor, spaceId, 'configure', allowArchived); return true }
      catch (error) {
        if (error instanceof HumanSpaceAccessError && error.code === 'operation_forbidden') return false
        throw error
      }
    } }
  }

  /** Includes existing archived memberships; checks are sequential to bound platform concurrency. */
  async list(actor: HumanSpaceActor): Promise<AuthorizedSpace[]> {
    this.deps.assertActor(actor)
    const candidates = this.deps.spaces.listAll(true).filter(space =>
      this.deps.spaces.roleOf(space.id, actor.openId) && (space.kind !== 'p2p' || space.id === dmSpaceId(actor.openId)))
    const authorized: AuthorizedSpace[] = []
    for (const space of candidates) {
      try {
        authorized.push(await this.authorize(actor, space.id, { operation: 'read', allowArchived: true }))
      } catch (error) {
        this.deps.assertActor(actor)
        if (error instanceof HumanSpaceAccessError &&
          ['space_not_found', 'not_group_member', 'operation_forbidden'].includes(error.code)) continue
        // In particular, failed membership lookup is not an empty list or a partial disclosure.
        throw error
      }
    }
    this.deps.assertActor(actor)
    return authorized.map(access => ({ ...access, space: access.assertCurrent() }))
  }

  private localAccess(actor: HumanSpaceActor, spaceId: string, operation: HumanSpaceOperation, allowArchived: boolean): { space: Space; role: SpaceRole } {
    this.deps.assertActor(actor)
    const { spaces, policy } = this.deps
    const space = spaces.get(spaceId), role = spaces.roleOf(spaceId, actor.openId)
    if (!space || !role || (space.kind === 'p2p' && space.id !== dmSpaceId(actor.openId)) ||
      (space.kind === 'group' && !space.chatId)) {
      throw new HumanSpaceAccessError(404, 'space_not_found', '找不到可访问的空间')
    }
    if (space.status === 'archived' && !allowArchived) throw new HumanSpaceAccessError(409, 'space_archived', '空间已停用')
    if (operation !== 'read' && role !== 'owner' && !policy.isAdmin(actor.openId)) {
      throw new HumanSpaceAccessError(403, 'operation_forbidden', '只有空间负责人或有权管理员可以执行此操作')
    }
    const gate = policy.decide({ spaceId, openId: actor.openId, action: operation === 'read' ? 'read' : 'configure' })
    if (gate.decision !== 'allow') throw new HumanSpaceAccessError(403, 'operation_forbidden', '当前策略不允许此操作')
    return { space, role }
  }
}
