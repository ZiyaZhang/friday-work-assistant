import type { Registry } from '../core/registry.js'
import type { PersonalLocalWork } from '../personal/local-work.js'
import type { FeishuClient } from './client.js'
import type { CardAction } from './ws.js'

type Card = Record<string, unknown>
const escaped = (v: string) => v.replace(/</g, '＜').replace(/>/g, '＞').replace(/[\\`*_\[\]()]/g, '\\$&')
const md = (content: string): Card => ({ tag: 'markdown', content })
const card = (elements: Card[]): Card => ({ schema: '2.0', config: { update_multi: true, wide_screen_mode: true },
  header: { title: { tag: 'plain_text', content: 'Friday · 本机工作' }, template: 'blue' }, body: { elements } })

export class LocalWorkCards {
  constructor(private readonly d: { work: PersonalLocalWork; registry: Registry; feishu: Pick<FeishuClient, 'sendToUserOnce' | 'patchCard'>;
    audience(owner: string): { chatId: string }; assertActive(): void; background(work: () => Promise<void>): void }) {}
  async show(owner: string, id: string) {
    this.d.assertActive(); const audience = this.d.audience(owner)
    const guard = () => { this.d.assertActive(); if (this.d.audience(owner).chatId !== audience.chatId) throw new Error('个人空间已变化。') }
    const read = await this.d.work.authorize(owner, id, guard); const view = this.d.work.view(read(), true)
    const button = (text: string, op: string): Card => ({ tag: 'button', text: { tag: 'plain_text', content: text }, type: 'default',
      behaviors: [{ type: 'callback', value: { action: 'local_work', op, id, revision: view.revision } }] })
    const actions = [button('刷新进展', 'refresh'), ...(view.canStop ? [button('停止', 'stop')] : [])]
    const elements = [md(`**${escaped(view.title)}**`), md(`<font color="grey">${escaped(view.deviceName)} · ${view.label}</font>`)]
    if (view.state === 'queued') elements.push(md('在 DSH 的 Friday → 本机工作中，选择仓库并开始。'))
    if (view.directory) elements.push(md(`<font color="grey">${escaped(view.directory)} · ${escaped(view.model ?? '')}</font>`))
    if (view.result) elements.push(md(view.result.slice(0, 4500).replace(/</g, '＜').replace(/>/g, '＞')), ...(view.result.length > 4500 ? [md('完整结果可在 DSH 的同一项工作里查看。')] : []))
    elements.push({ tag: 'column_set', flex_mode: 'none', columns: actions.map(element => ({ tag: 'column', width: 'auto', elements: [element] })) })
    const rendered = card(elements), key = `personal-local-work-message:${id}`, previous = this.d.registry.getKv(key)
    guard(); read()
    if (previous) { await this.d.feishu.patchCard(previous, rendered); return }
    const messageId = await this.d.feishu.sendToUserOnce(owner, { card: rendered }, `personal-local-work:${id}`)
    guard()
    if (!messageId) throw new Error('未取得本机工作卡的送达回执。')
    this.d.registry.setKv(`personal-local-card:${messageId}`, JSON.stringify({ owner, chatId: audience.chatId, id }))
    this.d.registry.setKv(key, messageId)
  }
  handle(action: CardAction): Card {
    try {
      this.d.assertActive()
      const raw = action.messageId && this.d.registry.getKv(`personal-local-card:${action.messageId}`)
      const binding = raw ? JSON.parse(raw) as { owner: string; chatId: string; id: string } : undefined
      if (!binding || action.operatorOpenId !== binding.owner || action.chatId !== binding.chatId || action.value.id !== binding.id ||
        this.d.audience(binding.owner).chatId !== binding.chatId) throw new Error('请在本人私聊中操作这项工作。')
      if (action.value.op === 'stop') this.d.work.stop(binding.owner, binding.id, Number(action.value.revision))
      else if (action.value.op !== 'refresh') throw new Error('这个操作已失效。')
      this.d.background(() => this.show(binding.owner, binding.id))
      return {}
    } catch (error) { return { toast: { type: 'error', content: error instanceof Error ? error.message : '请刷新工作状态。' } } }
  }
}
