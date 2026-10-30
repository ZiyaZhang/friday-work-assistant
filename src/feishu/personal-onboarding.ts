import { PersonalApplication, type PersonalListView, type PersonalSettingsCommand } from '../core/personal-application.js'
import { createHash, randomUUID } from 'node:crypto'
import type { Registry } from '../core/registry.js'
import type { Spaces } from '../core/space.js'
import type { PolicyService } from '../core/policy.js'
import type { ChatReadScope } from '../core/chat-read-scope.js'
import { type PersonalCollectionStore } from '../core/personal-collection.js'
import { TodoApplication } from '../core/todo-application.js'
import type { Todo, Todos } from '../core/todos.js'
import { presentTodoOrigin } from '../core/todo-origin-presentation.js'
import type { RoutineStore } from '../core/routines.js'
import type { RoutineApplication } from '../core/routine-application.js'
import { buildAuthorizeUrl, type UserTokenStore } from './oauth.js'
import type { FeishuClient } from './client.js'
import type { CardAction } from './ws.js'
import { measureTodoCard } from './todo-card-pagination.js'
import type { PersonalAssistance } from '../core/personal-assistance.js'
import type { PersonalWorkSync } from '../core/personal-work-sync.js'
import { linkedGithubTitle as linkedTitle } from '../core/github-links.js'
import type { GitHubUserConnections } from '../github/user-connection.js'
import type { GitHubPersonalDiscovery } from '../core/github-personal-discovery.js'
import type { GmailConnections } from '../gmail/connection.js'
import type { GmailMailbox } from '../gmail/mailbox.js'
import type { PersonalDevices } from '../personal/devices.js'

type Card = Record<string, unknown>
type View = PersonalListView
type Binding = { openId: string; chatId: string; kind: 'setup' | 'tasks' | 'connections'; page: number; view: View;
  ids: number[]; snoozeId?: number; lastId?: number; offerId?: string }
export interface PersonalOnboardingDeps {
  registry: Registry; spaces: Spaces; policy: PolicyService; collection: PersonalCollectionStore
  todos: Todos; application: TodoApplication; readScope?: ChatReadScope
  userTokens: UserTokenStore; routines?: RoutineStore; controls: RoutineApplication
  feishu: Pick<FeishuClient, 'sendToUserOnce' | 'getMessage' | 'patchCard'>
  oauth: { appId: string; redirectUri: string; domain: 'feishu' | 'lark' }
  now(): number; assertActive(): void
  assistance?: PersonalAssistance; dispatchAssistance?(taskId: number): void
  workSync?: PersonalWorkSync
  personalGithub?: GitHubUserConnections
  githubDiscovery?: GitHubPersonalDiscovery
  gmail?: GmailConnections
  mailbox?: GmailMailbox
  devices?: PersonalDevices
}

const md = (content: string): Card => ({ tag: 'markdown', content })
const escaped = (text: string) => text.replace(/</g, '＜').replace(/>/g, '＞').replace(/[\\\x60*_\[\]()]/g, '\\$&')
const hash = (data: unknown) => createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 20)
const button = (label: string, value: Card, primary = false): Card => ({ tag: 'button', text: { tag: 'plain_text', content: label },
  type: primary ? 'primary' : 'default', behaviors: [{ type: 'callback', value }] })
const row = (...elements: Card[]): Card => ({ tag: 'column_set', flex_mode: 'none', columns: elements.map(element => ({ tag: 'column', width: 'auto', elements: [element] })) })
const card = (title: string, elements: Card[]): Card => ({ schema: '2.0', config: { update_multi: true, wide_screen_mode: true },
  header: { title: { tag: 'plain_text', content: title }, template: 'blue' }, body: { elements } })
const stamp = (ms: number) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(ms)

/** Feishu presentation and authenticated card callbacks for the personal application. */
export class PersonalOnboarding {
  private readonly publishing = new Set<string>()
  readonly application: PersonalApplication
  constructor(private readonly d: PersonalOnboardingDeps) {
    this.application = new PersonalApplication({ ...d, authorizeUrl: input => buildAuthorizeUrl({ ...d.oauth, ...input }) })
  }
  private read<T>(key: string): T | undefined {
    const value = this.d.registry.getKv(key)
    return value ? JSON.parse(value) as T : undefined
  }
  private write(key: string, value: unknown) { this.d.registry.setKv(key, JSON.stringify(value)) }
  settings(openId: string) { return this.application.settings(openId) }
  private audience(openId: string) { return this.application.audience(openId) }
  authorizationPresented(openId: string) { return this.application.authorizationPresented(openId) }
  isReadOnlyRoutine(id: number) { return this.application.isReadOnlyRoutine(id) }
  snoozedUntil(openId: string, id: number) { return this.application.snoozedUntil(openId, id) }

  setupCard(openId: string): Card {
    const { settings: s, available, brief } = this.application.setup(openId)
    const elements: Card[] = [md('先找出需要你处理的事，再看看有哪些我能帮你推进。')]
    for (const [feature, label, description] of [
      ['collection', '自动收集待办', '群聊与私聊里的交办、承诺和待回复事项'],
      ['brief', '工作日早报', '09:00 · 北京时间 · 今日待办和日程'],
    ] as const) {
      if (feature === 'brief' && !this.d.routines) continue
      elements.push({ tag: 'checker', name: feature, checked: s[feature], overall_checkable: true, text: { tag: 'plain_text', content: label },
        behaviors: [{ type: 'callback', value: { action: 'personal_setup', op: 'select', feature, revision: s.revision } }] },
      md(`<font color="grey">${description}</font>`))
    }
    elements.push(md('读取已授权的群聊和私聊，可排除会话；结果只发给你。'))
    if (!available) {
      elements.push({ tag: 'button', type: 'primary', text: { tag: 'plain_text', content: s.started ? '重新连接' : '连接飞书并开启' },
        behaviors: [{ type: 'open_url', default_url: s.awaiting!.url }] })
      if (s.started) elements.push(md('<font color="grey">等待所需授权，连接后自动继续。</font>'))
    } else if (!s.started) elements.push(button('开启', { action: 'personal_setup', op: 'start', revision: s.revision }, true))
    else {
      elements.push(md(this.statusText(openId)))
      if (s.brief) elements.push(md(`<font color="grey">早报：${brief?.enabled && brief.status === 'active' ? '工作日 09:00' : '已暂停，可重试恢复'}</font>`))
    }
    elements.push(row(button('查看清单', { action: 'personal_tasks', op: 'view', view: 'active' }),
      button('读取范围', { action: 'personal_setup', op: 'scope' }),
      button('刷新', { action: 'personal_setup', op: 'refresh' })))
    const settingsActions: Card[] = []
    if (this.d.personalGithub) settingsActions.push(button('账号连接', { action: 'personal_connections', op: 'view' }))
    if (s.started && (s.collection || s.brief)) settingsActions.push(button('重试', { action: 'personal_setup', op: 'retry', revision: s.revision }))
    if (settingsActions.length) elements.push(row(...settingsActions))
    return card('Friday · 个人助手', elements)
  }

  statusText(openId: string): string {
    const progress = this.d.collection.progress(openId)
    const text = { off: '自动收集尚未开启', paused: '自动收集已暂停', today: '正在整理今天的消息', history: '今天已整理，正在补查近 7 天',
      current: '持续收集中', needs_connection: '收集暂停，等待重新连接', retrying: '部分消息暂未读到，稍后自动重试',
      partial: `已继续整理可读消息，仍有 ${progress.gapCount} 条读取缺口` }[progress.state]
    const coverage = progress.lanes.some(lane => ['partial', 'retrying', 'needs_connection'].includes(lane.state))
      ? progress.lanes.map(lane => `\n${lane.lane === 'group' ? '群聊' : '私聊'}：${lane.state === 'needs_connection' ? '等待重新连接' : lane.state === 'retrying' ? '读取重试中' : lane.state === 'partial' ? `${lane.gapCount} 条读取缺口` : '持续收集中'}${lane.scannedThrough ? `，已扫描至 ${stamp(lane.scannedThrough)}` : ''}${lane.through ? `，完整覆盖至 ${stamp(lane.through)}` : ''}`).join('')
      : progress.through ? `\n消息已整理至 ${stamp(progress.through)}` : ''
    return `<font color="grey">${text}${['today', 'history'].includes(progress.state) ? ` · 已读取 ${progress.messages} 条` : ''}${coverage}</font>`
  }

  /** Authenticated callback metadata and stored delivery identity, never openId supplied in a button. */
  authorize(action: CardAction): Binding {
    this.d.assertActive()
    const binding = action.messageId && this.read<Binding>(`personal-card:${action.messageId}`)
    if (!binding || binding.openId !== action.operatorOpenId || binding.chatId !== action.chatId ||
      this.audience(binding.openId).chatId !== binding.chatId) throw new Error('这张卡只在本人的 Friday 私聊中生效，请重新打开。')
    return binding
  }

  handle(action: CardAction): Card {
    let binding: Binding | undefined
    try {
      binding = this.authorize(action)
      if (action.value.action === 'personal_connections') {
        if (action.value.op === 'setup') {
          binding.kind = 'setup'; this.write(`personal-card:${action.messageId}`, binding)
          this.d.registry.setKv(`personal-setup-message:${binding.openId}`, action.messageId!)
          return { card: { type: 'raw', data: this.setupCard(binding.openId) } }
        }
        if (typeof action.value.op === 'string' && action.value.op.startsWith('gmail_')) {
          const gmail = this.d.gmail
          if (!gmail) throw new Error('Gmail 暂不可用。')
          this.d.registry.setKv(`gmail-connection-error:${binding.openId}`, '')
          if (action.value.op === 'gmail_connect' || action.value.op === 'gmail_send') gmail.begin(binding.openId, action.value.op === 'gmail_send')
          else if (action.value.op === 'gmail_cancel') gmail.cancelPending(binding.openId)
          else if (action.value.op === 'gmail_disconnect') { gmail.disconnect(binding.openId, Number(action.value.revision)); this.d.mailbox?.forget(binding.openId) }
          else throw new Error('请刷新后重试。')
          binding.kind = 'connections'; this.write(`personal-card:${action.messageId}`, binding)
          this.d.registry.setKv(`personal-connections-message:${binding.openId}`, action.messageId!)
          return { card: { type: 'raw', data: this.connectionsCard(binding.openId) } }
        }
        if (typeof action.value.op === 'string' && action.value.op.startsWith('desktop_')) {
          const devices = this.d.devices
          if (!devices) throw new Error('DSH 连接暂不可用。')
          if (action.value.op === 'desktop_begin') devices.begin(binding.openId)
          else if (action.value.op === 'desktop_approve' && typeof action.value.state === 'string' && typeof action.value.requestHash === 'string')
            devices.approve(binding.openId, action.value.state, action.value.requestHash)
          else if (action.value.op === 'desktop_reject' && typeof action.value.state === 'string') devices.reject(binding.openId, action.value.state)
          else if (action.value.op === 'desktop_revoke' && typeof action.value.id === 'string') devices.revoke(binding.openId, action.value.id, Number(action.value.revision))
          else throw new Error('请刷新后重试。')
          binding.kind = 'connections'; this.write(`personal-card:${action.messageId}`, binding)
          this.d.registry.setKv(`personal-connections-message:${binding.openId}`, action.messageId!)
          return { card: { type: 'raw', data: this.connectionsCard(binding.openId) } }
        }
        if (!this.d.personalGithub) throw new Error('账号连接暂不可用。')
        let url: string | undefined
        if (action.value.op === 'connect') url = this.d.personalGithub.begin(binding.openId).url
        else if (action.value.op === 'token') url = this.d.personalGithub.beginToken(binding.openId).url
        else if (action.value.op === 'disconnect') this.d.personalGithub.disconnect(binding.openId, Number(action.value.revision))
        else if (action.value.op === 'cancel') this.d.personalGithub.cancelPending(binding.openId)
        else if (action.value.op === 'stop_temporary') this.d.personalGithub.disableTemporaryRead(binding.openId, Number(action.value.revision))
        else if (action.value.op !== 'view') throw new Error('请刷新后重试。')
        else if (this.d.personalGithub.pendingTokenUrl(binding.openId)) url = this.d.personalGithub.pendingTokenUrl(binding.openId)
        else if (this.d.personalGithub.available && this.d.personalGithub.view(binding.openId).status !== 'connected') url = this.d.personalGithub.begin(binding.openId).url
        binding.kind = 'connections'; this.write(`personal-card:${action.messageId}`, binding)
        this.d.registry.setKv(`personal-connections-message:${binding.openId}`, action.messageId!)
        return { card: { type: 'raw', data: this.connectionsCard(binding.openId, url) } }
      }
      if (action.value.action === 'personal_tasks') return this.taskAction(action, binding)
      if (binding.kind !== 'setup') throw new Error('这张卡已更新，请重新打开设置。')
      const op = action.value.op
      let command: PersonalSettingsCommand
      if (op === 'select') {
        const feature = action.value.feature
        if ((feature !== 'collection' && feature !== 'brief') || action.tag !== 'checker' || typeof action.checked !== 'boolean') throw new Error('没有收到有效的选项。')
        command = { operation: op, revision: action.value.revision as number, feature, checked: action.checked }
      } else if (op === 'start' || op === 'retry') command = { operation: op, revision: action.value.revision as number }
      else if (op === 'refresh') command = { operation: op }
      else throw new Error('这个操作已失效，请刷新卡片。')
      this.application.changeSettings(binding.openId, command)
      return { card: { type: 'raw', data: this.setupCard(binding.openId) } }
    } catch (error) {
      let refreshed: Card | undefined
      try { if (binding) refreshed = binding.kind === 'setup' ? this.setupCard(binding.openId) : binding.kind === 'connections' ? this.connectionsCard(binding.openId) : this.tasksCard(binding) } catch { /* no substitute success */ }
      return { toast: { type: 'error', content: error instanceof Error ? error.message : '设置未保存，请稍后再试。' },
        ...(refreshed ? { card: { type: 'raw', data: refreshed } } : {}) }
    }
  }

  async authorizationCompleted(openId: string): Promise<boolean> {
    if (!this.application.authorizationCompleted(openId)) return false
    if (await this.refreshSetup(openId)) this.d.registry.setKv(`personal-presented-grant:${openId}`, this.d.userTokens.grantId(openId) ?? '')
    return true
  }

  /** Send with a stable idempotency key; remember only a real delivery receipt. */
  async show(openId: string, kind: 'setup' | 'tasks' | 'connections'): Promise<string> {
    this.d.assertActive()
    const space = this.d.spaces.dm(openId)
    if (space.status !== 'active') throw new Error('个人空间已暂停。')
    const binding: Binding = { openId, chatId: space.chatId ?? '', kind, view: 'active', page: 0, ids: [] }
    // A first-ever menu event has no chat_id. A source-free setup card establishes the real DM first.
    if (!binding.chatId) binding.kind = 'setup'
    const githubUrl = binding.kind === 'connections' ? this.d.personalGithub?.pendingTokenUrl(openId) ??
      (this.d.personalGithub?.available && this.d.personalGithub.view(openId).status !== 'connected' ? this.d.personalGithub.begin(openId).url : undefined) : undefined
    const body = binding.kind === 'setup' ? this.setupCard(openId) : binding.kind === 'connections' ? this.connectionsCard(openId, githubUrl) : this.tasksCard(binding)
    const messageId = await this.d.feishu.sendToUserOnce(openId, { card: body }, randomUUID())
    this.d.assertActive()
    if (!messageId) throw new Error('没有取得卡片的送达回执。')
    if (!binding.chatId) {
      const message = await this.d.feishu.getMessage(messageId)
      this.d.assertActive()
      if (!message?.chatId || message.messageId !== messageId) throw new Error('卡片已发送，但私聊位置暂未核实；请发一条消息后重试。')
      const current = this.d.spaces.dm(openId)
      if (current.status !== 'active' || current.chatId && current.chatId !== message.chatId) throw new Error('私聊位置已变化。')
      binding.chatId = this.d.spaces.ensure({ kind: 'p2p', openId, chatId: message.chatId }).chatId!
    }
    this.audience(openId)
    this.write(`personal-card:${messageId}`, binding)
    this.d.registry.setKv(`personal-card-body:${messageId}`, hash(body))
    if (binding.kind === 'setup') this.d.registry.setKv(`personal-setup-message:${openId}`, messageId)
    else if (binding.kind === 'connections') this.d.registry.setKv(`personal-connections-message:${openId}`, messageId)
    else this.d.registry.setKv(`personal-tasks-message:${openId}`, messageId)
    return messageId
  }

  connectionsCard(openId: string, url?: string): Card {
    const github = this.d.personalGithub, connection = github?.view(openId)
    const progress = this.d.githubDiscovery?.view(openId), temporary = github?.temporaryAccess(openId)
    const elements = [md(`**飞书** · ${this.d.userTokens.isConnected(openId) ? '已连接' : '未连接'}`),
      md('群聊、私聊里的工作背景与交办，整理到你的个人清单。'),
      button('飞书与收集设置', { action: 'personal_connections', op: 'setup' }), { tag: 'hr' },
      md(`**GitHub** · ${connection?.status === 'connected' ? `[${connection.login}](https://github.com/${connection.login})` : connection?.status === 'needs_connection' ? '需要重新连接' : '未连接'}`),
      md('查找等你评审的 PR 和分配给你的 Issue；结合飞书讨论，准备评审要点与回复草稿。'),
      md(connection?.method === 'personal_token' ? '<font color="grey">通过个人令牌连接，按该令牌获准访问的仓库读取。</font>' : '<font color="grey">通过 GitHub 登录连接时，仓库需要同时允许你和 Friday App 访问。也可以使用本人的个人令牌连接。</font>')]
    const connected = connection?.status === 'connected', needsInstallation = progress?.state === 'needs_installation'
    const connectionActions: Card[] = []
    if (url) {
      elements.push(md('<font color="grey">连接完成后自动更新这里。链接 10 分钟内有效。</font>'))
      connectionActions.push({ tag: 'button', type: 'primary', text: { tag: 'plain_text', content: url.includes('/github/token?') ? '配置个人令牌' : '连接 GitHub' },
        behaviors: [{ type: 'open_url', default_url: url }] })
    } else if (!connected && github?.available) connectionActions.push(button('连接 GitHub', { action: 'personal_connections', op: 'connect' }, true))
    else if (!github?.available && !github?.tokenAvailable) elements.push(md('<font color="grey">GitHub 个人连接尚未开放；飞书收集可以继续使用。</font>'))
    if (connection?.status === 'connected') elements.push(md(!this.settings(openId).collection ? '自动收集已暂停，可在收集设置中开启。' : progress?.state === 'needs_installation'
      ? '账号已连接，尚未找到 Friday App 可访问的安装。请让仓库管理员安装 Friday App 并选择仓库。'
      : `<font color="grey">${progress?.state === 'current' ? `已读取最近的 GitHub 事项 · ${stamp(progress.checkedAt)}${progress.partial ? ' · 部分结果未读取' : ''}` : progress?.state === 'retrying' ? 'GitHub 暂未读完，稍后自动重试。' : '正在查找 GitHub 事项。'}</font>`))
    if (connected && connection.method !== 'personal_token' && github?.installationUrl) connectionActions.push({ tag: 'button', type: needsInstallation ? 'primary' : 'default',
      text: { tag: 'plain_text', content: '仓库权限' }, behaviors: [{ type: 'open_url', default_url: github.installationUrl }] })
    if (connected && github?.available && !url) connectionActions.push(button('更换账号', { action: 'personal_connections', op: 'connect' }))
    if (connected || connection?.status === 'needs_connection' || url) connectionActions.push(button(url ? '取消连接' : '断开连接',
      { action: 'personal_connections', op: url ? 'cancel' : 'disconnect', revision: connection?.revision ?? 0 }))
    if (connectionActions.length) elements.push(row(...connectionActions))
    if (github?.tokenAvailable && !url?.includes('/github/token?')) elements.push(row(button(connection?.method === 'personal_token' ? '更换个人令牌' : '使用个人令牌', { action: 'personal_connections', op: 'token' })))
    if (temporary) elements.push(md(`**临时读取** · ${temporary.repositories.map(repo => `[${repo}](https://github.com/${repo})`).join('、')}\n使用 ${connection?.login} 本人凭据，只读，有效至 ${stamp(temporary.expiresAt)}。`),
      button('停止临时读取', { action: 'personal_connections', op: 'stop_temporary', revision: connection?.revision ?? 0 }))
    const gmail = this.d.gmail, mail = gmail?.view(openId), gmailUrl = gmail?.pendingUrl(openId)
    if (gmail?.available || mail?.status === 'connected' || mail?.status === 'needs_connection') {
      elements.push({ tag: 'hr' }, md(`**Gmail** · ${mail?.status === 'connected' ? escaped(mail.email ?? '') : mail?.status === 'needs_connection' ? '需要重新连接' : '未连接'}`),
        md('整理需要回复的邮件，结合工作背景起草；已发邮件继续跟进对方回复。'))
      const connectionError = this.d.registry.getKv(`gmail-connection-error:${openId}`)
      if (connectionError) elements.push(md(`<font color="grey">${escaped(connectionError)}</font>`))
      const actions: Card[] = []
      if (gmailUrl) actions.push({ tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '继续连接 Gmail' }, behaviors: [{ type: 'open_url', default_url: gmailUrl }] },
        button('取消', { action: 'personal_connections', op: 'gmail_cancel' }))
      else if (mail?.status !== 'connected') actions.push(button('连接 Gmail', { action: 'personal_connections', op: 'gmail_connect' }, true))
      else {
        elements.push(md(`<font color="grey">${mail.canSend ? '可读取与起草；发送前由你确认当前草稿。' : '已允许读取；草稿保存在 Friday，尚未允许发送。'}</font>`))
        const scan = this.d.mailbox?.scanStatus(openId)
        elements.push(md(`<font color="grey">${!this.settings(openId).collection ? '自动收集已暂停，可在个人设置恢复。' : scan?.state === 'current'
          ? `最近整理于 ${stamp(scan.checkedAt ?? 0)}` : scan?.state === 'retrying' || scan?.state === 'partial' ? '部分邮件暂未整理完成，会继续重试。' : '正在整理最近的邮件…'}</font>`))
        if (!mail.canSend) actions.push(button('允许发送邮件', { action: 'personal_connections', op: 'gmail_send' }))
        actions.push(button('更换邮箱', { action: 'personal_connections', op: 'gmail_connect' }),
          button('断开 Gmail', { action: 'personal_connections', op: 'gmail_disconnect', revision: mail.revision }))
      }
      if (actions.length) elements.push(row(...actions))
    }
    if (this.d.devices) {
      const devices = this.d.devices, pending = devices.pendingFor(openId)
      elements.push({ tag: 'hr' }, md('**DSH**'), md('在自己的电脑上查看同一份清单，接着处理工作。'))
      for (const device of devices.list(openId).filter(d => d.revokedAt === null && d.expiresAt > this.d.now())) {
        elements.push(md(`**${escaped(device.label)}** · 已连接${device.lastSeenAt ? `\n<font color="grey">最近使用 ${stamp(device.lastSeenAt)}</font>` : ''}`),
          row(button('断开设备', { action: 'personal_connections', op: 'desktop_revoke', id: device.id, revision: device.revision })))
      }
      if (pending?.status === 'waiting' || pending?.status === 'requested') {
        if (pending.status === 'waiting') elements.push(md('把配对链接粘贴到 DSH 的 Friday 面板，随后在这里确认设备。'),
          row({ tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '打开配对链接' }, behaviors: [{ type: 'open_url', default_url: devices.pairUrl(pending) }] },
            button('取消', { action: 'personal_connections', op: 'desktop_reject', state: pending.state })))
        else elements.push(md(`**确认连接「${escaped(pending.label!)}」**\n验证码：**${pending.fingerprint}**\n与 DSH 中显示的一致后，允许这台设备读取本人的清单和工作背景、修改事项、启动工作。`),
          row(button('连接这台设备', { action: 'personal_connections', op: 'desktop_approve', state: pending.state, requestHash: pending.requestHash }, true),
            button('取消', { action: 'personal_connections', op: 'desktop_reject', state: pending.state })))
      } else elements.push(row(button('连接 DSH', { action: 'personal_connections', op: 'desktop_begin' })))
    }
    elements.push(row(button('查看清单', { action: 'personal_tasks', op: 'view', view: 'active' }, connected && !needsInstallation && !url),
      button('刷新', { action: 'personal_connections', op: 'view' })))
    return card('Friday · 账号连接', elements)
  }

  async githubConnectionChanged(openId: string): Promise<void> {
    const messageId = this.d.registry.getKv(`personal-connections-message:${openId}`)
    const binding = messageId && this.read<Binding>(`personal-card:${messageId}`)
    if (binding && binding.kind === 'connections' && binding.openId === openId && this.audience(openId).chatId === binding.chatId) {
      await this.d.feishu.patchCard(messageId!, this.connectionsCard(openId))
    }
  }

  private async refreshSetup(openId: string): Promise<boolean> {
    const messageId = this.d.registry.getKv(`personal-setup-message:${openId}`)
    const binding = messageId && this.read<Binding>(`personal-card:${messageId}`)
    if (!binding || binding.kind !== 'setup' || this.audience(openId).chatId !== binding.chatId) return false
    await this.d.feishu.patchCard(messageId!, this.setupCard(openId))
    return true
  }

  async refreshTasks(messageId: string): Promise<void> {
    const key = `personal-card:${messageId}`
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = this.d.registry.getKv(key), binding = this.read<Binding>(key)
      if (!binding || binding.kind !== 'tasks') return
      const body = this.tasksCard(binding)
      if (this.d.registry.getKv(`personal-card-body:${messageId}`) === hash(body)) return
      await this.d.feishu.patchCard(messageId, body)
      if (this.d.registry.getKv(key) === before) { this.write(key, binding); this.d.registry.setKv(`personal-card-body:${messageId}`, hash(body)); return }
      // A button was used during the network request. Keep its newer state and repair the visible card.
    }
  }

  async workProgress(openId: string): Promise<void> {
    const receipt = this.read<{ messageId?: string }>(`personal-first-result:${openId}`)
    const ids = new Set([receipt?.messageId, this.d.registry.getKv(`personal-tasks-message:${openId}`)])
    for (const id of ids) if (id) await this.refreshTasks(id)
  }

  async githubProgress(openId: string): Promise<void> {
    await this.githubConnectionChanged(openId)
    await this.workProgress(openId)
    const grant = this.d.personalGithub?.view(openId), progress = this.d.githubDiscovery?.view(openId)
    if (grant?.status !== 'connected' || !progress || progress.state === 'needs_installation' || !this.settings(openId).collection) return
    const guard = () => {
      this.d.assertActive(); this.audience(openId)
      this.d.personalGithub!.assertCurrent(openId, grant.revision)
      if (!this.settings(openId).collection) throw new Error('自动收集已暂停。')
    }
    await this.publishFirstResult(openId, progress.state === 'current', guard)
  }

  /** Initial results use one persisted delivery UUID across retries/restarts. Later changes patch that card. */
  async collectionProgress(openId: string): Promise<void> {
    const s = this.settings(openId)
    if (!s.started || !s.collection) return
    const audience = this.audience(openId), progress = this.d.collection.progress(openId)
    await this.refreshSetup(openId)
    const guard = () => {
      this.d.assertActive(); this.audience(openId)
      if (!this.settings(openId).collection || !this.d.collection.profile(openId)?.enabled) throw new Error('自动收集已暂停。')
    }
    // A pause while the setup card was being patched is not a new delivery request.
    if (!this.settings(openId).collection || !this.d.collection.profile(openId)?.enabled) return
    const hasItems = this.d.todos.listForAudience(audience, { status: 'active', limit: 1 }).items.length > 0
    if (!hasItems && !progress.through) return
    await this.publishFirstResult(openId, progress.state === 'current', guard)
  }

  private async publishFirstResult(openId: string, complete: boolean, guard: () => void): Promise<void> {
    if (this.publishing.has(openId)) return
    this.publishing.add(openId)
    try {
      guard()
      const audience = this.audience(openId)
      if (!complete && !this.application.query(openId, 'active').items.length) return
      const key = `personal-first-result:${openId}`
      let receipt = this.read<{ uuid: string; attemptedAt: number; messageId?: string; complete?: boolean }>(key)
      if (!receipt) { receipt = { uuid: randomUUID(), attemptedAt: this.d.now() }; this.write(key, receipt) }
      if (receipt.messageId) {
        const binding = this.read<Binding>(`personal-card:${receipt.messageId}`)
        if (binding && binding.kind === 'tasks') {
          await this.refreshTasks(receipt.messageId)
          if (complete) this.write(key, { ...receipt, complete: true })
        }
        return
      }
      // Feishu guarantees UUID deduplication for one hour only. Never replay an unknown send after that window.
      if (this.d.now() - receipt.attemptedAt > 55 * 60_000) return
      const binding: Binding = { openId, chatId: audience.chatId!, kind: 'tasks', view: 'active', page: 0, ids: [] }
      const body = this.tasksCard(binding)
      guard()
      const messageId = await this.d.feishu.sendToUserOnce(openId, { card: body }, receipt.uuid)
      if (!messageId) throw new Error('首批清单没有送达回执')
      this.write(key, { ...receipt, messageId, complete })
      this.write(`personal-card:${messageId}`, binding)
      this.d.registry.setKv(`personal-card-body:${messageId}`, hash(body))
      this.d.registry.setKv(`personal-tasks-message:${openId}`, messageId)
    } finally { this.publishing.delete(openId) }
  }

  tasksCard(binding: Binding): Card {
    const { openId } = binding
    const list = this.application.query(openId, binding.view), { audience, items } = list
    const collection = (todo: Todo) => this.d.todos.getProvenance(todo.id)?.collection
    binding.page = Math.max(0, Math.min(Math.ceil(items.length / 5) - 1, binding.page))
    const shown = items.slice(binding.page * 5, binding.page * 5 + 5)
    binding.ids = shown.map(todo => todo.id)
    const elements: Card[] = [md(this.statusText(openId))]
    delete binding.offerId
    const offer = binding.view === 'active' && binding.page === 0 ? this.d.assistance?.suggest(openId, items) : undefined
    if (offer) {
      binding.offerId = offer.id
      elements.push(md(`**可以先帮你推进这件事**\n${linkedTitle(offer.title, offer.source.collection?.quote ?? offer.source.github?.url)}\n${offer.description}`))
      if (offer.taskId) {
        const task = this.d.registry.getTask(offer.taskId)
        const state = this.d.assistance?.completed(offer.taskId) ? '准备工作已完成，结果见本次私聊。原待办仍保留。' : task?.status === 'running' ? '正在整理，结果会发在这里。'
          : task?.status === 'queued' ? '已排队，结果会发在这里。' : '这次准备工作未完成，可以在私聊里继续处理。'
        elements.push(md(`<font color="grey">${state}</font>`))
      } else elements.push(row(button(offer.label, { action: 'personal_tasks', op: 'assist', offer: offer.id, version: offer.version }, true),
        button('先不用', { action: 'personal_tasks', op: 'assist_dismiss', offer: offer.id, version: offer.version })))
      elements.push({ tag: 'hr' })
    }
    const last = binding.lastId && this.d.todos.getForAudience(binding.lastId, audience)
    if (last && this.application.visible(openId, last) && !shown.some(todo => todo.id === last.id)) {
      binding.ids.push(last.id)
      elements.push(row(md(last.status === 'done' ? '已完成' : last.status === 'cancelled' ? '已忽略' : '已放入稍后处理'),
        button('撤销', { action: 'personal_tasks', op: 'undo', id: last.id, version: this.application.itemVersion(openId, last) })))
    }
    const uncertain: Card[] = []
    for (const todo of shown) {
      const githubSource = this.d.todos.getProvenance(todo.id)?.github
      const info = collection(todo), terminal = ['done', 'cancelled'].includes(todo.status), version = this.application.itemVersion(openId, todo)
      const details = [githubSource?.relationship === 'assigned' ? '分配给你，尚未承诺交期' : info?.relationship === 'committed' ? '你已承诺' : '',
        todo.dueMs !== null ? `${stamp(todo.dueMs)} 截止` : '', binding.view === 'later' ? `${stamp(this.snoozedUntil(openId, todo.id))} 再看` : ''].filter(Boolean)
      const action = (label: string, op: string) => button(label, { action: 'personal_tasks', op, id: todo.id, version })
      const parts: Card[] = [{ tag: 'checker', name: `todo_${todo.id}`, checked: terminal, overall_checkable: false,
        text: { tag: 'lark_md', content: linkedTitle(todo.title, info?.quote ?? githubSource?.url) }, checked_style: { show_strikethrough: true, opacity: 0.6 },
        behaviors: [{ type: 'callback', value: { action: 'personal_tasks', op: terminal ? 'undo' : 'done', id: todo.id, version } }] }]
      // Completion is an optional correction. The main list never asks the owner to triage every item.
      if (info) {
        const source = info.message, label = [source.senderOpenId === openId ? '你' : source.senderName,
          source.chatName || (source.chatType === 'p2p' ? '私聊' : '群聊'), stamp(source.createTimeMs)].filter(Boolean).join(' · ')
        const excerpt = info.quote.replace(/\s+/g, ' ').trim()
        parts.push(md(`<font color="grey">${escaped(label)}</font>${source.link.status === 'available' ? ` · [原消息](${source.link.url.replace(/\(/g, '%28').replace(/\)/g, '%29')})` : ' · 原消息链接暂不可用'}\n${escaped(excerpt.length > 140 ? `${excerpt.slice(0, 139)}…` : excerpt)}`))
      }
      if (details.length) parts.push(md(`<font color="grey">${details.join(' · ')}</font>`))
      const secondary: Card[] = []
      const reply = this.d.collection.replyResolution(todo.id)
      if (reply && (!this.d.readScope || this.d.readScope.isReadable(openId, reply.message.chatId))) {
        parts.push(md(`${reply.message.link.status === 'available' ? `[已回复](${reply.message.link.url.replace(/\(/g, '%28').replace(/\)/g, '%29')})` : '已回复'} · ${stamp(reply.message.createTimeMs)}\n${escaped(reply.quote.length > 140 ? `${reply.quote.slice(0, 139)}…` : reply.quote)}`))
      }
      const work = this.d.workSync?.current(openId, todo)
      if (work) secondary.push(md(`[${escaped(work.note)}](${work.url})`))
      const origin = presentTodoOrigin(todo.origin)
      if (!info && origin?.items.length) parts.push(md(origin.items.map(source => source.url
        ? `[${escaped(source.label)}](${source.url.replace(/\(/g, '%28').replace(/\)/g, '%29')})` : escaped(source.label)).join('\n')))
      if (todo.statusNote && !reply) secondary.push(md(escaped(todo.statusNote)))
      secondary.push(terminal ? row(action('恢复', 'undo')) : row(action('稍后处理', 'snooze_menu'), action('不需要我处理', 'ignore')))
      if (binding.snoozeId === todo.id && !terminal) secondary.push(row(action('1 小时后', 'hour'), action('明天 09:00', 'tomorrow'), action('取消', 'snooze_close')))
      parts.push({ tag: 'collapsible_panel', expanded: binding.snoozeId === todo.id,
        header: { title: { tag: 'plain_text', content: '调整' } }, elements: secondary })
      if (info?.relationship === 'uncertain') uncertain.push(...parts)
      else elements.push(...parts)
    }
    if (uncertain.length) elements.push({ tag: 'collapsible_panel', expanded: false, header: { title: { tag: 'plain_text', content: '可能与你有关' } }, elements: uncertain })
    const github = this.d.githubDiscovery?.view(openId)
    if (binding.view === 'active' && binding.page === 0 && github) {
      if (github.waiting.length) elements.push({ tag: 'collapsible_panel', expanded: false,
        header: { title: { tag: 'plain_text', content: `你提交的 PR · ${github.waiting.length}` } },
        elements: [md(github.waiting.slice(0, 10).map(item => `${linkedTitle(item.title, item.url)}${item.draft ? ' · 草稿' : ''}`).join('\n')),
          ...(github.waiting.length > 10 ? [md(`<font color="grey">展示最近更新的 10 项。</font>`)] : [])] })
      elements.push(md(`<font color="grey">GitHub${github.checkedAt ? ` · ${stamp(github.checkedAt)}` : ''}${github.state === 'retrying' ? ' · 更新暂未完成，稍后重试' : github.partial ? ' · 仅展示本次读取的部分结果' : ''}</font>`))
    }
    const mailItems = binding.view === 'active' && binding.page === 0 ? this.d.mailbox?.items(openId) ?? [] : []
    if (mailItems.length) {
      const replies = mailItems.filter(item => item.state === 'needs_reply'), waiting = mailItems.filter(item => item.state === 'waiting')
      if (replies.length) elements.push(md('**邮件里等你回复**'), ...replies.slice(0, 3).map(item => md(
        `[${escaped(item.title || item.thread.subject)}](${item.thread.url})\n<font color="grey">${escaped(item.thread.messages.at(-1)!.from)} · ${stamp(item.thread.messages.at(-1)!.at)}</font>\n${escaped(item.reason)}\n${escaped(item.quote.slice(0, 160))}`)))
      if (waiting.length) elements.push({ tag: 'collapsible_panel', expanded: false, header: { title: { tag: 'plain_text', content: `已发邮件 · 等待反馈 ${waiting.length}` } },
        elements: [md(waiting.slice(0, 5).map(item => `[${escaped(item.title || item.thread.subject)}](${item.thread.url}) · ${escaped(item.reason)}`).join('\n'))] })
      if (replies.length > 3) elements.push(md('<font color="grey">还有其他邮件待回复，可以直接问“我的邮件有哪些事”。</font>'))
    }
    if (!shown.length && !mailItems.length) elements.push(md(binding.view === 'later' ? '没有稍后处理的事项。' : binding.view === 'closed' ? '还没有已结束的事项。'
      : ['off', 'paused'].includes(this.d.collection.progress(openId).state) ? '个人清单为空。' : '目前尚未发现需要你处理的事项。'))
    if (list.total > list.loaded) elements.push(md(`<font color="grey">当前展示前 ${list.loaded} 条，另有 ${list.total - list.loaded} 条未载入。</font>`))
    if (items.length > 5) elements.push(row(
      ...(binding.page ? [button('上一页', { action: 'personal_tasks', op: 'page', page: binding.page - 1 })] : []),
      md(`${binding.page + 1}/${Math.ceil(items.length / 5)} 页`),
      ...(binding.page * 5 + 5 < items.length ? [button('下一页', { action: 'personal_tasks', op: 'page', page: binding.page + 1 })] : [])))
    elements.push(row(...([['待处理', 'active'], ['稍后处理', 'later'], ['已结束', 'closed']] as const).map(([label, view]) =>
      button(label, { action: 'personal_tasks', op: 'view', view })), button('设置', { action: 'personal_tasks', op: 'setup' })))
    const result = card('Friday · 个人清单', elements)
    if (!measureTodoCard(result, { kind: 'create', receiveId: audience.chatId! }).fits) throw new Error('事项的来源较长，这张清单暂时无法完整显示。')
    return result
  }

  private taskAction(action: CardAction, binding: Binding): Card {
    const op = action.value.op
    this.audience(binding.openId)
    if (op === 'assist' || op === 'assist_dismiss') {
      if (!this.d.assistance || binding.kind !== 'tasks' || !binding.offerId || action.value.offer !== binding.offerId || typeof action.value.version !== 'string') throw new Error('这个建议已更新，请刷新清单。')
      const offer = this.d.assistance.get(binding.offerId)
      if (!offer || this.snoozedUntil(binding.openId, offer.todoId) > this.d.now()) throw new Error('事项已放入稍后处理，请先回到清单。')
      const task = this.d.assistance.decide({ id: binding.offerId, version: action.value.version, actorId: binding.openId,
        requestId: `card:${action.messageId}:${binding.offerId}:${op}`, source: { surface: 'feishu', conversationId: binding.chatId, reference: action.messageId! }, decision: op === 'assist' ? 'start' : 'dismiss' })
      if (task && op === 'assist') this.d.dispatchAssistance?.(task.id)
    } else if (op === 'setup') binding.kind = 'setup'
    else if (op === 'view') {
      if (!['active', 'later', 'closed'].includes(String(action.value.view))) throw new Error('清单分类无效。')
      binding.kind = 'tasks'; binding.view = action.value.view as View; binding.page = 0; delete binding.snoozeId; delete binding.lastId
    } else if (op === 'page') {
      if (binding.kind !== 'tasks' || !Number.isSafeInteger(action.value.page) || Number(action.value.page) < 0) throw new Error('页码无效。')
      binding.page = Number(action.value.page); delete binding.snoozeId; delete binding.lastId
    } else {
      if (binding.kind !== 'tasks' || !binding.ids.includes(Number(action.value.id))) throw new Error('这条事项已不在当前卡片中。')
      if (typeof action.value.version !== 'string') throw new Error('事项已更新，请核对当前版本后操作。')
      const todo = this.application.item(binding.openId, Number(action.value.id), action.value.version)
      if (op === 'snooze_menu') binding.snoozeId = todo.id
      else if (op === 'snooze_close') delete binding.snoozeId
      else if (op === 'hour' || op === 'tomorrow') {
        this.application.updateItem(binding.openId, { id: todo.id, version: action.value.version as string, operation: op })
        delete binding.snoozeId; binding.lastId = todo.id
      } else if (op === 'done' || op === 'ignore' || op === 'undo') {
        if (action.tag === 'checker' && action.checked !== (op === 'done')) throw new Error('勾选状态已变化，请刷新清单。')
        this.application.updateItem(binding.openId, { id: todo.id, version: action.value.version as string, operation: op })
        delete binding.snoozeId; binding.lastId = op === 'undo' ? undefined : todo.id
      } else throw new Error('操作无效，请重新打开清单。')
    }
    const result = binding.kind === 'setup' ? this.setupCard(binding.openId) : this.tasksCard(binding)
    this.write(`personal-card:${action.messageId}`, binding)
    this.d.registry.setKv(`personal-card-body:${action.messageId}`, hash(result))
    if (binding.kind === 'setup') this.d.registry.setKv(`personal-setup-message:${binding.openId}`, action.messageId!)
    else this.d.registry.setKv(`personal-tasks-message:${binding.openId}`, action.messageId!)
    return { card: { type: 'raw', data: result } }
  }
}
