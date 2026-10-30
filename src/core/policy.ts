/**
 * Policy：六类动作的唯一判定入口。任何"能不能做"的问题都在这里回答，
 * 编排器和动作网关不再各自判断（照企业双边 Agent 方案的"五种权限分别判断"，加一类 configure）。
 *
 *   read      能看这个来源吗
 *   act       能让它跑命令 / 改文件 / 开 PR 吗
 *   publish   结果能发给这个受众吗（跨空间内容尤其要问）
 *   remember  能写进这一层的记忆吗
 *   promote   能把记忆/技能升到联盟 / 企业层吗
 *   configure 能改空间配置 / 换绑 / 删空间 / 接 MCP 吗
 *
 * 判定只看三件事：谁（角色）、在哪个空间、做什么。结果三态：allow / ask（发确认卡）/ deny。
 */
import type { SpaceRole, Spaces } from './space.js'

export type ActionClass = 'read' | 'act' | 'publish' | 'remember' | 'promote' | 'configure'
export type Decision = 'allow' | 'ask' | 'deny'
export type Actor = 'admin' | 'owner' | 'member' | 'outsider'

export interface PolicyInput {
  spaceId: string
  openId?: string
  action: ActionClass
  /** promote 的目标层；publish 的受众是否跨空间 */
  target?: 'circle' | 'org' | 'cross-space' | 'here' | 'repository-proposal'
}

export interface PolicyResult {
  decision: Decision
  actor: Actor
  /** 为什么——直接可以贴给用户看 */
  reason: string
}

export interface PolicyOptions {
  /** 全局管理员（open_id）：跑命令自动放行、可晋升到企业层 */
  admins: string[]
  /** 部署级总开关：deny = 全拒，auto = 全放（只在受控环境用） */
  mode?: 'safe' | 'auto' | 'deny'
}

export class PolicyService {
  constructor(
    private readonly spaces: Spaces,
    private readonly opts: PolicyOptions,
  ) {}

  isAdmin(openId: string | undefined): boolean {
    return Boolean(openId && this.opts.admins.includes(openId))
  }

  /** 部署管理员，按配置顺序（FRIDAY_ADMINS，未配时为 FRIDAY_TRUSTED_USERS）。只读。 */
  adminOpenIds(): readonly string[] {
    return this.opts.admins
  }

  actorOf(spaceId: string, openId: string | undefined): Actor {
    if (this.isAdmin(openId)) return 'admin'
    const role: SpaceRole | undefined = this.spaces.roleOf(spaceId, openId)
    if (role === 'owner') return 'owner'
    if (role === 'member') return 'member'
    return 'outsider'
  }

  decide(input: PolicyInput): PolicyResult {
    const actor = this.actorOf(input.spaceId, input.openId)
    const mode = this.opts.mode ?? 'safe'
    if (mode === 'deny') return { decision: 'deny', actor, reason: '这个部署把所有写操作关掉了（FRIDAY_PERMISSION_POLICY=deny）' }
    const allow = (reason: string): PolicyResult => ({ decision: 'allow', actor, reason })
    const ask = (reason: string): PolicyResult => ({ decision: 'ask', actor, reason })
    const deny = (reason: string): PolicyResult => ({ decision: 'deny', actor, reason })
    if (mode === 'auto' && input.action !== 'promote') return allow('部署策略 auto：不确认直接放行')

    switch (input.action) {
      case 'read':
        return actor === 'outsider' ? deny('你不在这个空间里') : allow('空间成员可读本空间')

      case 'remember':
        return actor === 'outsider' ? deny('你不在这个空间里') : allow('空间成员可以写本空间的记忆')

      case 'act':
        // A gateway-bound proposed diff is not native shell access or a merge.
        // Repository, original Work, and source checks remain mandatory at its host.
        if (input.target === 'repository-proposal') return actor === 'outsider' ? deny('你不在这个空间里') : allow('空间成员可提出获准仓库的修改提议')
        if (actor === 'admin' || actor === 'owner') return allow(actor === 'admin' ? '全局管理员' : '空间负责人')
        if (actor === 'member') return ask('成员发起的执行类操作要发起人确认')
        return deny('你不在这个空间里')

      case 'publish':
        if (input.target === 'here') return actor === 'outsider' ? deny('你不在这个空间里') : allow('本空间自产内容发回本空间')
        if (actor === 'admin' || actor === 'owner') return allow('负责人可以决定跨空间内容的披露')
        if (actor === 'member') return ask('要把别处的内容发到这里，需要确认受众')
        return deny('你不在这个空间里')

      case 'promote':
        if (input.target === 'org') return actor === 'admin' ? allow('全局管理员可以晋升到企业层') : deny('晋升到企业层需要全局管理员（FRIDAY_ADMINS）')
        if (input.target === 'circle') return actor === 'admin' || actor === 'owner' ? allow('负责人可以晋升到联盟层') : deny('晋升到联盟层需要空间负责人')
        return deny('没说清楚要晋升到哪一层')

      case 'configure':
        return actor === 'admin' || actor === 'owner' ? allow(actor === 'admin' ? '全局管理员' : '空间负责人') : deny('改空间配置 / 换绑 / 删空间只有空间负责人能做（问我一句就知道谁是负责人）')

      default:
        return deny('未知动作')
    }
  }

  /** 给人看的一行说明 */
  describeActor(spaceId: string, openId: string | undefined): string {
    const actor = this.actorOf(spaceId, openId)
    switch (actor) {
      case 'admin':
        return '全局管理员（可跑命令、可晋升企业层记忆）'
      case 'owner':
        return '本空间负责人（可改配置、换绑、跑命令）'
      case 'member':
        return '本空间成员（执行类操作要点确认）'
      default:
        return '还不是本空间成员（在这里说句话就是了）'
    }
  }
}
