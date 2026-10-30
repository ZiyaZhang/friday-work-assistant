/**
 * 飞书长连接事件订阅：不需要公网回调地址，开发机能出网即可。
 */
import * as Lark from '@larksuiteoapi/node-sdk'
import { inboundFromEvent, type InboundMessage } from './mention.js'
import { sdkLogger } from './client.js'
import { createProxiedHttp, describeProxy } from './proxy.js'
import type { Logger } from '../log.js'

export interface CardAction {
  operatorOpenId?: string
  messageId?: string
  chatId?: string
  /** Platform interaction metadata, independent of static behaviors.value. */
  tag?: string
  checked?: boolean
  formValue?: Record<string, unknown>
  value: Record<string, unknown>
  raw: unknown
}

/** 机器人菜单（私聊底部的菜单栏）点击事件 application.bot.menu_v6 */
export interface MenuEvent {
  operatorOpenId?: string
  operatorName?: string
  eventKey: string
  raw: unknown
}

/**
 * 会话生命周期。被拉进群那一刻就要建空间、冻结负责人、发欢迎卡——
 * 等第一条消息再建就晚了：那时"拉它进来的人"已经不可知，只能拿"第一个说话的人"顶替。
 */
export interface ChatLifecycleEvent {
  kind: 'bot_added' | 'bot_removed' | 'disbanded'
  chatId: string
  /** 谁拉的 / 谁踢的 / 谁解散的。这是授权的来源，不是执行者 */
  operatorOpenId?: string
  chatName?: string
  raw: unknown
}

/** 消息被撤回：撤回是有明确语义的动作，不订阅等于当没发生过，缓存里还会把它引回来。 */
export interface RecallEvent {
  messageId: string
  chatId?: string
  raw: unknown
}

/** 有人给消息贴了表情——天然的"这条我接了"，拿来收信号比猜"有别人说话了"准得多。 */
export interface ReactionEvent {
  messageId: string
  emoji: string
  operatorOpenId?: string
  raw: unknown
}

export interface FeishuWsOptions {
  appId: string
  appSecret: string
  domain: 'feishu' | 'lark'
  /** 出网代理；长连接（WebSocket）和拉取 endpoint 的 HTTP 请求都走它 */
  proxyUrl?: string
  log: Logger
  onMessage: (msg: InboundMessage) => Promise<void> | void
  onCardAction: (action: CardAction) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void
  onMenu?: (ev: MenuEvent) => Promise<void> | void
  onChatLifecycle?: (ev: ChatLifecycleEvent) => Promise<void> | void
  onRecall?: (ev: RecallEvent) => Promise<void> | void
  onReaction?: (ev: ReactionEvent) => Promise<void> | void
}

function openIdOf(v: unknown): string | undefined {
  const o = (v ?? {}) as Record<string, unknown>
  return typeof o.open_id === 'string' ? o.open_id : undefined
}

export function normalizeChatLifecycle(kind: ChatLifecycleEvent['kind'], data: Record<string, unknown>): ChatLifecycleEvent {
  return {
    kind,
    chatId: typeof data.chat_id === 'string' ? data.chat_id : '',
    operatorOpenId: openIdOf(data.operator_id),
    chatName: typeof data.name === 'string' ? data.name : undefined,
    raw: data,
  }
}

export function normalizeRecall(data: Record<string, unknown>): RecallEvent {
  return {
    messageId: typeof data.message_id === 'string' ? data.message_id : '',
    chatId: typeof data.chat_id === 'string' ? data.chat_id : undefined,
    raw: data,
  }
}

export function normalizeReaction(data: Record<string, unknown>): ReactionEvent {
  const rt = (data.reaction_type ?? {}) as Record<string, unknown>
  return {
    messageId: typeof data.message_id === 'string' ? data.message_id : '',
    emoji: typeof rt.emoji_type === 'string' ? rt.emoji_type : '',
    operatorOpenId: openIdOf(data.user_id) ?? openIdOf(data.operator_id),
    raw: data,
  }
}

export function normalizeMenuEvent(data: Record<string, unknown>): MenuEvent {
  const operator = (data.operator ?? {}) as Record<string, unknown>
  const id = (operator.operator_id ?? {}) as Record<string, unknown>
  return {
    operatorOpenId: typeof id.open_id === 'string' ? id.open_id : undefined,
    operatorName: typeof operator.operator_name === 'string' ? operator.operator_name : undefined,
    eventKey: typeof data.event_key === 'string' ? data.event_key : '',
    raw: data,
  }
}

export interface FeishuWsHandle {
  stop(): void
}

/** 最近 N 个事件 id 去重（飞书会重投递）。 */
export class RecentSet {
  private readonly set = new Set<string>()
  private readonly order: string[] = []
  constructor(private readonly max = 5000) {}
  seen(id: string): boolean {
    if (!id) return false
    if (this.set.has(id)) return true
    this.set.add(id)
    this.order.push(id)
    if (this.order.length > this.max) {
      const old = this.order.shift()
      if (old) this.set.delete(old)
    }
    return false
  }
}

export function normalizeCardAction(data: Record<string, unknown>): CardAction {
  const context = (data.context ?? {}) as Record<string, unknown>
  const operator = (data.operator ?? {}) as Record<string, unknown>
  const action = (data.action ?? {}) as Record<string, unknown>
  const value = (action.value && typeof action.value === 'object' ? action.value : {}) as Record<string, unknown>
  return {
    operatorOpenId: typeof operator.open_id === 'string' ? operator.open_id : undefined,
    messageId: (context.open_message_id ?? data.open_message_id) as string | undefined,
    chatId: (context.open_chat_id ?? data.open_chat_id) as string | undefined,
    tag: typeof action.tag === 'string' ? action.tag : undefined,
    checked: typeof action.checked === 'boolean' ? action.checked : undefined,
    formValue: action.form_value && typeof action.form_value === 'object' && !Array.isArray(action.form_value) ? action.form_value as Record<string, unknown> : undefined,
    value,
    raw: data,
  }
}

export async function startFeishuWs(opts: FeishuWsOptions): Promise<FeishuWsHandle> {
  const { log } = opts
  const recent = new RecentSet()
  const dispatcher = new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data: Record<string, unknown>) => {
      try {
        const msg = inboundFromEvent(data)
        if (recent.seen(msg.eventId || msg.messageId)) {
          log.debug('duplicate event dropped', { messageId: msg.messageId })
          return
        }
        await opts.onMessage(msg)
      } catch (err) {
        log.error('onMessage failed', { err })
      }
    },
    'card.action.trigger': async (data: Record<string, unknown>) => {
      try {
        const res = await opts.onCardAction(normalizeCardAction(data))
        return res ?? {}
      } catch (err) {
        log.error('onCardAction failed', { err })
        return {}
      }
    },
    // 会话生命周期。三个 handler 都是幂等的（ensure / archive / 欢迎卡有 KV 标记），
    // 所以不做事件去重——飞书重投递顶多多算一次。
    'im.chat.member.bot.added_v1': async (data: Record<string, unknown>) => {
      try {
        await opts.onChatLifecycle?.(normalizeChatLifecycle('bot_added', data))
      } catch (err) {
        log.error('onChatLifecycle(bot_added) failed', { err })
      }
    },
    'im.chat.member.bot.deleted_v1': async (data: Record<string, unknown>) => {
      try {
        await opts.onChatLifecycle?.(normalizeChatLifecycle('bot_removed', data))
      } catch (err) {
        log.error('onChatLifecycle(bot_removed) failed', { err })
      }
    },
    'im.chat.disbanded_v1': async (data: Record<string, unknown>) => {
      try {
        await opts.onChatLifecycle?.(normalizeChatLifecycle('disbanded', data))
      } catch (err) {
        log.error('onChatLifecycle(disbanded) failed', { err })
      }
    },
    'im.message.recalled_v1': async (data: Record<string, unknown>) => {
      try {
        await opts.onRecall?.(normalizeRecall(data))
      } catch (err) {
        log.error('onRecall failed', { err })
      }
    },
    'im.message.reaction.created_v1': async (data: Record<string, unknown>) => {
      try {
        await opts.onReaction?.(normalizeReaction(data))
      } catch (err) {
        log.error('onReaction failed', { err })
      }
    },
    'application.bot.menu_v6': async (data: Record<string, unknown>) => {
      try {
        const ev = normalizeMenuEvent(data)
        const key = `menu:${ev.operatorOpenId ?? ''}:${ev.eventKey}:${String((data as { timestamp?: unknown }).timestamp ?? '')}`
        if (recent.seen(key)) return
        await opts.onMenu?.(ev)
      } catch (err) {
        log.error('onMenu failed', { err })
      }
    },
  } as never)

  const proxied = opts.proxyUrl ? createProxiedHttp(opts.proxyUrl) : undefined
  if (proxied) log.info('feishu websocket via proxy', { proxy: describeProxy(proxied.proxyUrl) })
  const ws = new Lark.WSClient({
    appId: opts.appId,
    appSecret: opts.appSecret,
    domain: opts.domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu,
    loggerLevel: Lark.LoggerLevel.warn,
    logger: sdkLogger(log),
    ...(proxied ? { agent: proxied.agent, httpInstance: proxied.httpInstance } : {}),
  })
  await ws.start({ eventDispatcher: dispatcher })
  log.info('feishu websocket started')
  return {
    stop: () => ws.close({ force: true }),
  }
}
