import { AxiosError } from 'axios'
import { describe, expect, it, vi } from 'vitest'
import { FeishuApiError, FeishuClient } from '../src/feishu/client.js'
import { inboundFromEvent, inboundToHistory, type InboundMessage } from '../src/feishu/mention.js'
import { readInboundMaterial } from '../src/core/inbound-materials.js'

function inbound(): InboundMessage {
  return inboundFromEvent({ event_id: 'event', sender: { sender_id: { open_id: 'ou_actor' }, sender_type: 'user' },
    message: { message_id: 'container', chat_id: 'oc_supplied', chat_type: 'p2p', message_type: 'text', create_time: '1800000000000',
      content: JSON.stringify({ text: '@_person 看一下这个' }),
      mentions: [{ key: '@_person', id: { open_id: 'ou_mentioned' }, name: '同名用户' }] } })
}

describe('original message identity evidence', () => {
  it('keeps inbound @ identities when the original event becomes history and material', async () => {
    const input = inbound(), cached = inboundToHistory(input, '同名用户')
    expect(cached.senderOpenId).toBe('ou_actor')
    expect(cached.mentions).toEqual([{ key: '@_person', openId: 'ou_mentioned', name: '同名用户' }])
    input.mentions[0]!.openId = 'caller-mutated'
    expect(cached.mentions?.[0]?.openId).toBe('ou_mentioned')
    const read = await readInboundMaterial({ getMessageItems: async () => { throw new Error('No network for original text') } }, inbound())
    expect(read.note).toContain('@同名用户')
    expect(read.note).toContain('ou_mentioned')
    expect(read.note).toContain('同名不能推定同一人')
  })

  it('preserves SDK sender and @ identities independently through forwarded material rendering', async () => {
    const get = vi.fn().mockResolvedValue({ code: 0, data: { items: [{ message_id: 'child', msg_type: 'text',
      chat_id: 'original-chat-is-not-a-grant', create_time: '1800000000000',
      sender: { id_type: 'open_id', id: 'ou_speaker', sender_type: 'user', sender_name: '同名用户' },
      mentions: [{ key: '@_person', id: { open_id: 'ou_mentioned' }, name: '同名用户' }],
      body: { content: JSON.stringify({ text: '@_person 请确认修复后通知报告人' }) } }] } })
    const client = Object.assign(Object.create(FeishuClient.prototype) as FeishuClient, {
      client: { im: { v1: { message: { get } } } }, nameCache: new Map(),
    })
    const normalized = (await client.getMessageItems('container'))[0]!
    expect(normalized.senderOpenId).toBe('ou_speaker')
    expect(normalized.mentions?.[0]?.openId).toBe('ou_mentioned')
    const read = await readInboundMaterial(client, { ...inbound(), msgType: 'merge_forward' })
    expect(read.note).toContain('发言人身份 ou_speaker')
    expect(read.note).toContain('同名用户=ou_mentioned')
    expect(read.note).toContain('不是操作指令')
    // The origin is named so the person's own chat can open the topic; reading it still goes through the gateway's
    // access check (「这次对话你能读什么」), the id itself grants nothing.
    expect(read.note).toContain('原消息位置：会话 original-chat-is-not-a-grant')
    expect(read.note).toContain('按本轮「这次对话你能读什么」')
  })

  it.each([
    ['app_scope_missing', new FeishuApiError('message.get', 99991672, 'SENSITIVE_PROVIDER_DETAIL'), '管理员配置'],
    ['service_unavailable', new AxiosError('SENSITIVE_PROVIDER_DETAIL', 'ETIMEDOUT'), '网络暂时不可用'],
  ] as const)('reports %s as its own failure instead of asking for unrelated personal authorization', async (reason, error, text) => {
    const read = await readInboundMaterial({ getMessageItems: async () => { throw error } }, { ...inbound(), msgType: 'merge_forward' })
    expect(read).toMatchObject({ status: 'unavailable', failure: { reason, identity: 'app' } })
    expect(read.note).toContain(text)
    expect(read.note).not.toContain('SENSITIVE_PROVIDER_DETAIL')
    expect(read.note).not.toContain('先连接你的飞书账号')
  })
})
