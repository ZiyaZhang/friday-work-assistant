/**
 * Space（空间）：Friday 的一等对象。一个群 / 一个私聊 = 一个空间，
 * 配置、记忆、职责、成员、执行记录都挂在它下面。
 *
 * - 群空间 id 是随机的 `sp_<8hex>`，和 chat 解耦；群迁移需要应用层协调资料、授权和职责。
 *   单独修改 chat_id 不是完整迁移，用户换绑入口在迁移流程完成前保持关闭。
 * - 私聊空间 id 是 `sp_dm_<open_id>`：人即空间，永不换绑。
 * - 角色：owner（负责人，改配置/换绑/晋升）、member（在这里和 Friday 说过话的人）。
 *   建群空间那一刻把创建者写成 owner；群主/管理员由调用方补充（一次性授权，之后不自动同步）。
 * - 配置只存"和默认值不同的部分"，读取时和 .env 的默认值合并。
 */
import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export type SpaceKind = 'group' | 'p2p'
export type SpaceRole = 'owner' | 'member'

/** 空间的行为偏好；字段都可选，缺省用部署级默认值 */
export interface SpaceConfig {
  /** 回答长度偏好：short 更简短，detailed 允许展开 */
  brevity?: 'short' | 'normal' | 'detailed'
  /** 仅兼容旧配置；过程卡已停用，此值（包括 0）不控制发送。 */
  progressCardDelayMs?: number
  /** 轮末记忆整理开关 */
  reflect?: boolean
  /**
   * 夜间整理的频率：每天 / 每周 / 关。
   *
   * 频率高更及时，但更费模型额度——这个取舍该由**用谁的额度的人**来定，
   * 而不是写死在部署里。所以它是空间配置，不是环境变量。
   */
  consolidate?: 'daily' | 'weekly' | 'off'
  /** 群级主动模式 */
  proactive?: {
    enabled?: boolean
    quietMs?: number
    minMessages?: number
    maxPerHour?: number
    dormantAfter?: number
    /** 自定义"什么消息该主动回"的依据；为空则模型自己判断 */
    criteria?: string
    /**
     * 只在这个时段内主动说话，本地时间 [起, 止)，如 { from: 9, to: 21 }。
     * 半夜在群里冒出来一句话，比白天多嘴十句还讨人厌。
     */
    hours?: { from: number; to: number }
  }
  /** 主动巡检时给明确有用的消息点赞；缺省为开，只在主动模式开着时生效 */
  kudos?: 'on' | 'off'
  /** 需求投票；缺省为关。空间负责人（或全局管理员）用 /space set polls on 开启，部署开关 FRIDAY_POLLS 也要开着。 */
  polls?: 'on' | 'off'
  /** 会议旁听；缺省为关。私聊由本人、群里由群负责人（或全局管理员）用 /space set meetings on 开启，部署开关 FRIDAY_MEETINGS 也要开着。 */
  meetings?: 'on' | 'off'
  /** 这个空间的工作区要不要挂共享代码检出（repos/）。默认关；只有管理员能开 */
  repos?: boolean
  /** 部署管理员明确批准向本空间展示的 GitHub 项目；不是 GitHub 凭证能读的所有仓库。 */
  projectRepos?: string[]
  /** 自由的行为偏好（"这个群攒一批再处理""只有讨论排期时找我"），原样注入 prompt */
  notes?: string[]
  /**
   * 普通任务的状态反馈（确认卡和最终结果卡另行发送）：
   *   'react' 默认用表情表示状态，完成后发送结果
   *   'none'  不贴状态表情
   *   'card'  仅兼容旧配置，行为同 'react'，不会创建过程卡
   */
  ack?: 'card' | 'react' | 'none'
  /** 夜间记忆整理的间隔（毫秒）。不设 = 按部署默认 */
  digestEveryMs?: number
  /** 经部署目录验证的主模型；null/缺省使用部署默认，只影响下一次执行。 */
  modelSelection?: { value: string } | null
  /** 旧版本只保存过的模型偏好，保留历史，不自动激活。 */
  models?: { main?: string; heavy?: string; probe?: string }
}

/** 可跨空间沿用的个人展示偏好；新增空间字段不会自动获得继承语义。 */
type PersonalPreferences = Pick<SpaceConfig, 'brevity' | 'ack'>

function personalPreferences(value: unknown): PersonalPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const input = value as Record<string, unknown>
  const preferences: PersonalPreferences = {}
  if (input.brevity === 'short' || input.brevity === 'normal' || input.brevity === 'detailed') preferences.brevity = input.brevity
  if (input.ack === 'react' || input.ack === 'none' || input.ack === 'card') preferences.ack = input.ack
  return preferences
}

export interface Space {
  id: string
  kind: SpaceKind
  /** 当前绑定的会话；换绑改这里 */
  chatId: string | null
  title: string | null
  config: SpaceConfig
  status: 'active' | 'archived'
  createdBy: string | null
  createdAt: number
  updatedAt: number
}

export interface SpaceMemberRow {
  spaceId: string
  openId: string
  role: SpaceRole
  addedBy: string | null
  addedAt: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS user_defaults (
  open_id TEXT PRIMARY KEY,
  config TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS space_rooms (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  chat_id TEXT,
  title TEXT,
  config TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active',
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_space_rooms_chat ON space_rooms(chat_id, status);
CREATE TABLE IF NOT EXISTS space_members (
  space_id TEXT NOT NULL,
  open_id TEXT NOT NULL,
  role TEXT NOT NULL,
  added_by TEXT,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (space_id, open_id)
);
CREATE INDEX IF NOT EXISTS idx_space_members_open ON space_members(open_id);
`

export function dmSpaceId(openId: string): string {
  return `sp_dm_${openId}`
}

export class Spaces {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = () => Date.now(),
  ) {
    db.exec(SCHEMA)
  }

  /** 这个会话对应的空间；没有就返回 undefined（不自动建，建由 ensure 负责）。 */
  byChat(chatId: string, includeArchived = false): Space | undefined {
    const r = this.db.prepare(`SELECT * FROM space_rooms WHERE chat_id = ? ${includeArchived ? '' : "AND status = 'active'"} ORDER BY created_at DESC LIMIT 1`).get(chatId) as Record<string, unknown> | undefined
    return r ? toSpace(r) : undefined
  }

  get(id: string): Space | undefined {
    const r = this.db.prepare('SELECT * FROM space_rooms WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return r ? toSpace(r) : undefined
  }

  /**
   * 拿到这个会话的空间，没有就建一个。
   * 私聊空间 id 由 open_id 决定；群空间随机 id，创建者成为 owner。
   */
  ensure(input: { kind: SpaceKind; chatId: string; openId?: string; title?: string; owners?: string[] }): Space {
    if (input.kind === 'p2p' && input.openId && !input.chatId) return this.dm(input.openId)
    const existing = input.kind === 'p2p' && input.openId ? this.get(dmSpaceId(input.openId)) : this.byChat(input.chatId, true)
    if (existing) {
      if (existing.status === 'archived') return existing
      if (existing.chatId !== input.chatId) this.db.prepare('UPDATE space_rooms SET chat_id = ?, updated_at = ? WHERE id = ?').run(input.chatId, this.now(), existing.id)
      if (input.title && !existing.title) this.db.prepare('UPDATE space_rooms SET title = ?, updated_at = ? WHERE id = ?').run(input.title, this.now(), existing.id)
      return this.get(existing.id) as Space
    }
    const id = input.kind === 'p2p' && input.openId ? dmSpaceId(input.openId) : `sp_${randomBytes(4).toString('hex')}`
    const now = this.now()
    // 沿用这个人上次的配置：新同事第一次用，不该被从零问一遍
    const inherited = input.openId ? this.defaultsFor(input.openId) : {}
    this.db
      .prepare(`INSERT INTO space_rooms (id, kind, chat_id, title, config, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`)
      .run(id, input.kind, input.chatId, input.title ?? null, JSON.stringify(inherited), input.openId ?? null, now, now)
    // 建空间这一刻冻结 owner：创建者 + 调用方给的群主/管理员（之后换管理员不自动同步）
    const owners = new Set([...(input.owners ?? []), ...(input.openId ? [input.openId] : [])])
    for (const o of owners) this.addMember(id, o, 'owner', input.openId)
    return this.get(id) as Space
  }

  /**
   * 这个人上次设过的偏好。新同事第一次和我说话时套用——
   * 私聊沿用最近的有效配置，避免重复询问已配置的选项。
   * 只继承回答长度和状态反馈。模型、主动规则、记忆整理、注记和权限
   * 都属于原空间，不能借这个人的下次入群传播；旧保存记录也须过滤。
   */
  defaultsFor(openId: string): PersonalPreferences {
    const r = this.db.prepare('SELECT config FROM user_defaults WHERE open_id = ?').get(openId) as { config?: string } | undefined
    if (!r?.config) return {}
    try {
      return personalPreferences(JSON.parse(r.config))
    } catch {
      return {}
    }
  }

  /** 只记本次明确设置的个人偏好，保留他此前的其他个人偏好。 */
  rememberDefaults(openId: string, config: SpaceConfig): void {
    const safe = { ...this.defaultsFor(openId), ...personalPreferences(config) }
    this.db
      .prepare('INSERT INTO user_defaults (open_id, config, updated_at) VALUES (?, ?, ?) ON CONFLICT(open_id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at')
      .run(openId, JSON.stringify(safe), this.now())
  }

  /**
   * 拿到某人的私聊空间，不需要知道 p2p 的 chat_id（菜单、迁移、"我的任务"一类没有会话上下文的入口用）。
   * 真正收到私聊消息时 ensure() 会把 chat_id 补上。
   */
  dm(openId: string): Space {
    const id = dmSpaceId(openId)
    const existing = this.get(id)
    if (existing) return existing
    const now = this.now()
    this.db.prepare(`INSERT INTO space_rooms (id, kind, chat_id, title, config, status, created_by, created_at, updated_at) VALUES (?, 'p2p', NULL, NULL, '{}', 'active', ?, ?, ?)`).run(id, openId, now, now)
    this.addMember(id, openId, 'owner', openId)
    return this.get(id) as Space
  }

  /** 换绑：把空间绑到另一个会话（记忆/职责/配置全部带走）。 */
  rebind(id: string, chatId: string): Space | undefined {
    const space = this.get(id)
    if (!space || space.kind !== 'group') return undefined
    const occupied = this.byChat(chatId)
    if (occupied && occupied.id !== id) throw new Error(`那个群已经绑了空间 ${occupied.id}，先在那边把它删掉或换绑走`)
    // 仓库的发布受众改变，旧群的明确授权不能跟着偏好一起继承。
    const config = space.chatId === chatId || space.config.projectRepos === undefined ? space.config : { ...space.config, projectRepos: [] }
    this.db.prepare('UPDATE space_rooms SET chat_id = ?, config = ?, updated_at = ? WHERE id = ?').run(chatId, JSON.stringify(config), this.now(), id)
    return this.get(id)
  }

  /**
   * 停用保留 chat_id，普通消息不会创建替代空间。恢复必须经过应用层的显式操作。
   */
  suspend(id: string): boolean {
    return Number(this.db.prepare(`UPDATE space_rooms SET status = 'archived', updated_at = ? WHERE id = ? AND status = 'active'`).run(this.now(), id).changes) > 0
  }

  /** 应用层完成当前身份校验后，显式恢复同一个空间；不恢复旧执行或职责。 */
  resume(chatId: string): Space | undefined {
    const r = this.db.prepare(`SELECT id FROM space_rooms WHERE chat_id = ? AND status = 'archived' ORDER BY updated_at DESC LIMIT 1`).get(chatId) as { id?: string } | undefined
    if (!r?.id) return undefined
    this.db.prepare(`UPDATE space_rooms SET status = 'active', updated_at = ? WHERE id = ?`).run(this.now(), r.id)
    return this.get(String(r.id))
  }

  archive(id: string): boolean {
    return this.suspend(id)
  }

  listAll(includeArchived = false): Space[] {
    const rows = this.db.prepare(`SELECT * FROM space_rooms ${includeArchived ? '' : `WHERE status = 'active'`} ORDER BY created_at`).all() as Record<string, unknown>[]
    return rows.map(toSpace)
  }

  // ---- 配置 ----

  /** 局部更新配置（深合并一层：proactive 子对象也是合并而不是覆盖）。 */
  /**
   * 改空间偏好。`by` 给了，只把本次明确修改的可继承偏好记成个人默认。
   */
  patchConfig(id: string, patch: SpaceConfig, by?: string): Space | undefined {
    const space = this.get(id)
    if (!space) return undefined
    const next: SpaceConfig = { ...space.config, ...patch }
    if (patch.proactive) next.proactive = { ...space.config.proactive, ...patch.proactive }
    if (patch.notes) next.notes = patch.notes
    // 改群规则不能把整个群的偏好抄成操作者的个人默认。
    if (by) this.rememberDefaults(by, patch)
    this.db.prepare('UPDATE space_rooms SET config = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(next), this.now(), id)
    return this.get(id)
  }

  addNote(id: string, note: string, max = 12): Space | undefined {
    const space = this.get(id)
    if (!space) return undefined
    const notes = [...(space.config.notes ?? []).filter((n) => n !== note), note].slice(-max)
    return this.patchConfig(id, { notes })
  }

  removeNote(id: string, index: number): Space | undefined {
    const space = this.get(id)
    if (!space) return undefined
    const notes = [...(space.config.notes ?? [])]
    if (index < 1 || index > notes.length) return undefined
    notes.splice(index - 1, 1)
    return this.patchConfig(id, { notes })
  }

  // ---- 成员与角色 ----

  addMember(spaceId: string, openId: string, role: SpaceRole, addedBy?: string): void {
    this.db
      .prepare(`INSERT INTO space_members (space_id, open_id, role, added_by, added_at) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(space_id, open_id) DO UPDATE SET role = CASE WHEN space_members.role = 'owner' THEN 'owner' ELSE excluded.role END`)
      .run(spaceId, openId, role, addedBy ?? null, this.now())
  }

  /** 在这里说过话的人自动成为 member（已经是 owner 的不降级）。 */
  touchMember(spaceId: string, openId: string): void {
    this.addMember(spaceId, openId, 'member')
  }

  removeMember(spaceId: string, openId: string): boolean {
    return Number(this.db.prepare('DELETE FROM space_members WHERE space_id = ? AND open_id = ?').run(spaceId, openId).changes) > 0
  }

  roleOf(spaceId: string, openId: string | undefined): SpaceRole | undefined {
    if (!openId) return undefined
    const r = this.db.prepare('SELECT role FROM space_members WHERE space_id = ? AND open_id = ?').get(spaceId, openId) as { role?: string } | undefined
    return r?.role === 'owner' ? 'owner' : r?.role === 'member' ? 'member' : undefined
  }

  members(spaceId: string): SpaceMemberRow[] {
    const rows = this.db.prepare(`SELECT * FROM space_members WHERE space_id = ? ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, added_at`).all(spaceId) as Record<string, unknown>[]
    return rows.map((r) => ({ spaceId: String(r.space_id), openId: String(r.open_id), role: r.role === 'owner' ? 'owner' : 'member', addedBy: (r.added_by as string | null) ?? null, addedAt: Number(r.added_at) }))
  }

  owners(spaceId: string): string[] {
    return this.members(spaceId).filter((m) => m.role === 'owner').map((m) => m.openId)
  }

  /** 这个人所属的空间（私聊 + 他说过话的群），用于"我的任务"一类的跨空间视图。 */
  spacesOf(openId: string): Space[] {
    const rows = this.db
      .prepare(`SELECT r.* FROM space_rooms r JOIN space_members m ON m.space_id = r.id WHERE m.open_id = ? AND r.status = 'active' ORDER BY r.created_at`)
      .all(openId) as Record<string, unknown>[]
    return rows.map(toSpace)
  }
}

/** 记忆/待办的作用域串 */
export function spaceScope(spaceId: string): string {
  return `space:${spaceId}`
}

function toSpace(r: Record<string, unknown>): Space {
  let config: SpaceConfig = {}
  try {
    const parsed = JSON.parse(String(r.config ?? '{}')) as unknown
    if (parsed && typeof parsed === 'object') config = parsed as SpaceConfig
  } catch {
    /* ignore */
  }
  return {
    id: String(r.id),
    kind: r.kind === 'p2p' ? 'p2p' : 'group',
    chatId: (r.chat_id as string | null) ?? null,
    title: (r.title as string | null) ?? null,
    config,
    status: r.status === 'archived' ? 'archived' : 'active',
    createdBy: (r.created_by as string | null) ?? null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  }
}
