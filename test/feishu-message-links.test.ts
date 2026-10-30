import { describe, expect, it, vi } from 'vitest'
import { FeishuClient } from '../src/feishu/client.js'
import { messageSourceLink, messagePosition } from '../src/feishu/message-links.js'

describe('platform-backed message links', () => {
  it.each(['feishu', 'lark'] as const)('prefers the returned %s message link over positional fields', domain => {
    const host = domain === 'feishu' ? 'applink.feishu.cn' : 'applink.larksuite.com'
    const link = `https://${host}/client/message/link/open?token=synthetic%2Bproof%3D`
    expect(messageSourceLink({ messageAppLink: link, chatId: 'oc_original', messagePosition: '7' }, domain)).toBe(link)
  })

  it('builds a chat position link from actual fields, including position zero', () => {
    const link = new URL(messageSourceLink({ chatId: 'oc_original', messagePosition: '0' })!)
    expect(link.origin + link.pathname).toBe('https://applink.feishu.cn/client/chat/open')
    expect([...link.searchParams]).toEqual([['openChatId', 'oc_original'], ['position', '0']])
  })

  it('prioritizes a real thread position and sends both official desktop/mobile spellings', () => {
    const link = new URL(messageSourceLink({ chatId: 'oc_original', threadId: 'omt_original',
      messagePosition: '100', threadMessagePosition: '-1' }, 'lark')!)
    expect(link.origin + link.pathname).toBe('https://applink.larksuite.com/client/thread/open')
    expect(Object.fromEntries(link.searchParams)).toEqual({ openthreadid: 'omt_original', open_thread_id: 'omt_original',
      openchatid: 'oc_original', open_chat_id: 'oc_original', thread_position: '-1' })
  })

  it.each([
    'https://applink.feishu.cn.attacker.invalid/client/chat/open?openChatId=oc_other',
    'http://applink.feishu.cn/client/chat/open?openChatId=oc_other',
    'https://attacker@applink.feishu.cn/client/chat/open?openChatId=oc_other',
    'https://applink.feishu.cn:8443/client/chat/open?openChatId=oc_other',
    'https://applink.larksuite.com/client/chat/open?openChatId=oc_other',
    'https://applink.feishu.cn/client/mini_program/open?appId=other',
    'https://applink.feishu.cn/client/chat/open?openChatId=oc_other',
    'https://applink.feishu.cn/client/message/link/open',
    'https://applink.feishu.cn/client/thread/open?open_chat_id=oc_chat&open_thread_id=omt_thread',
    'javascript:alert(1)', 'not a URL',
  ])('does not publish an untrusted or unrelated provider link %s', messageAppLink => {
    expect(messageSourceLink({ messageAppLink })).toBeUndefined()
    const fallback = messageSourceLink({ messageAppLink, chatId: 'oc_original', messagePosition: '9' })!
    expect(new URL(fallback).searchParams.get('openChatId')).toBe('oc_original')
    expect(new URL(fallback).searchParams.get('position')).toBe('9')
  })

  it('uses chat position if the thread position is unavailable, and never derives a position from message ID or time', () => {
    expect(messageSourceLink({ chatId: 'oc_original', threadId: 'omt_original', threadMessagePosition: 'unknown',
      messagePosition: '20' })).toContain('position=20')
    expect(messageSourceLink({ chatId: 'oc_original', threadId: 'omt_original' })).toBeUndefined()
    expect(messageSourceLink({ messagePosition: '20' })).toBeUndefined()
    expect(messageSourceLink({ messageId: 'om_actual', createTimeMs: 1800000000000 } as never)).toBeUndefined()
  })

  it('does not let a conflicting plain link replace the exact returned item location', () => {
    const link = messageSourceLink({ chatId: 'oc_original', messagePosition: '8',
      messageAppLink: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_other&position=9' })!
    expect(new URL(link).searchParams.get('openChatId')).toBe('oc_original')
    expect(new URL(link).searchParams.get('position')).toBe('8')
  })

  it('retains exact integer coordinates without rounding unrepresentable or malformed values', () => {
    expect(messagePosition('9007199254740993')).toBe('9007199254740993')
    expect(messagePosition(12)).toBe('12')
    for (const value of [undefined, null, {}, true, 12.5, Infinity, NaN, 9007199254740992, '', '1e3', '12.5', 'nan']) {
      expect(messagePosition(value)).toBeUndefined()
    }
  })
})

describe('SDK get and list preserve exact message-link evidence', () => {
  const raw = (id: string, position: string | number) => ({ message_id: id, chat_id: 'oc_original', msg_type: 'text',
    create_time: '1800000000000', sender: { sender_type: 'user', id_type: 'open_id', id: 'ou_author' },
    body: { content: '{"text":"synthetic source"}' }, message_app_link: `https://applink.feishu.cn/client/chat/open?openChatId=oc_original&position=${position}`,
    message_position: position, thread_id: 'omt_original', thread_message_position: '-1' })
  function fixture(items: unknown[]) {
    const get = vi.fn(async () => ({ code: 0, data: { items } }))
    const list = vi.fn(async () => ({ code: 0, data: { items, has_more: false } }))
    const client = Object.assign(Object.create(FeishuClient.prototype) as FeishuClient,
      { client: { im: { v1: { message: { get, list } } } }, nameCache: new Map() })
    return { client, get, list }
  }

  it('keeps each multi-item get link tied to its own item and selects the exact requested container', async () => {
    const t = fixture([raw('om_child', 99), raw('om_container', '10')])
    const messages = await t.client.getMessageItems('om_container')
    expect(messages.map(message => [message.messageId, message.messagePosition, message.threadMessagePosition]))
      .toEqual([['om_child', '99', '-1'], ['om_container', '10', '-1']])
    const container = await t.client.getMessage('om_container')
    expect(container?.messageAppLink).toContain('position=10')
    expect(messageSourceLink(container!)).toContain('position=10')
    expect(await t.client.getMessage('om_not_returned')).toBeUndefined()
    expect(t.get.mock.calls[0]![0]).toMatchObject({ path: { message_id: 'om_container' } })
  })

  it.each(['thread', 'chat'] as const)('retains the same proof through %s history normalization', async kind => {
    const t = fixture([raw('om_original', '42')])
    const messages = kind === 'thread' ? await t.client.listThread('omt_original')
      : (await t.client.listChatHistory('oc_original', 1800000000, 1800000001)).items
    expect(messages[0]).toMatchObject({ messageId: 'om_original', chatId: 'oc_original', messagePosition: '42',
      threadMessagePosition: '-1', messageAppLink: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_original&position=42' })
    expect(t.list).toHaveBeenCalledTimes(1)
  })

  it('does not invent unavailable fields in legacy API replies', async () => {
    const t = fixture([{ message_id: 'om_original', msg_type: 'text', body: { content: '{"text":"source"}' } }])
    const result = await t.client.getMessage('om_original')
    expect(result?.messageAppLink).toBeUndefined()
    expect(result?.messagePosition).toBeUndefined()
    expect(result?.threadMessagePosition).toBeUndefined()
    expect(messageSourceLink(result!)).toBeUndefined()
  })
})
