import { describe, expect, it, vi } from 'vitest'
import { captureTodoProvenance } from '../src/core/todo-provenance-capture.js'
import { todoOrigin } from '../src/core/todo-provenance.js'
import type { SourceContext } from '../src/core/source-context.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import type { HistoryMessage } from '../src/feishu/client.js'

const inbound = (messageId: string, msgType = 'text'): InboundMessage => ({ eventId: messageId,
  messageId, chatId: 'dm-input', chatType: 'p2p', senderOpenId: 'owner', senderType: 'user',
  msgType, text: 'Synthetic private content', mentions: [], createTimeMs: 1000 })
const returned = (message: InboundMessage, position: string): HistoryMessage => ({ ...message,
  senderName: 'Synthetic user', messagePosition: position })

function fixture() {
  const request = inbound('request'), material = inbound('forward', 'merge_forward')
  const sources: SourceContext = { version: 1, acpSessionId: 'acp', spaceId: 'space', chatId: request.chatId,
    memoryScopes: [], chats: [], external: [], repositories: [], inboundMaterials: [
      { messageId: 'unrelated-history', chatId: request.chatId, actorOpenId: 'owner', digest: 'old', complete: true }] }
  let active = true
  const input = { runId: 'run', workKey: 'work', taskId: 2, request,
    selectedInputs: [{ ref: 'selected', taskId: 1, message: material }],
    assertCurrent() { if (!active) throw new Error('run no longer current') }, snapshot: () => sources }
  const getMessageItems = vi.fn(async (id: string) => id === request.messageId
    ? [returned(request, '32')] : [returned(material, '20'), returned(inbound('foreign-child'), '5')])
  return { input, request, material, sources, deps: { feishu: { getMessageItems }, domain: 'feishu' as const },
    stop() { active = false } }
}

describe('Host captures Todo creation evidence before writing', () => {
  it('links exact supplied containers while keeping unrelated ACP history in the audit snapshot only', async () => {
    const t = fixture(), proof = await captureTodoProvenance(t.input, t.deps)
    expect(proof.request?.link).toEqual({ status: 'available', url: 'https://applink.feishu.cn/client/chat/open?openChatId=dm-input&position=32' })
    expect(proof.selectedInputs).toHaveLength(1)
    expect(proof.selectedInputs[0]?.message).toMatchObject({ messageId: 'forward', link: { status: 'available',
      url: 'https://applink.feishu.cn/client/chat/open?openChatId=dm-input&position=20' } })
    expect(proof.contextSnapshot).toEqual(t.sources)
    expect(JSON.stringify(todoOrigin(proof))).not.toMatch(/Synthetic|foreign-child|unrelated-history|messageId|"ref"|"selected"/)
    t.sources.repositories.push('later/repository')
    expect(proof.contextSnapshot.repositories).toEqual([])
  })

  it.each(['missing-container', 'wrong-chat', 'wrong-sender'] as const)('never substitutes a %s API item for the received message', async mismatch => {
    const t = fixture()
    t.deps.feishu.getMessageItems.mockImplementation(async id => {
      const actual = returned(id === 'request' ? t.request : t.material, '30')
      if (mismatch === 'missing-container') actual.messageId = 'foreign-child'
      if (mismatch === 'wrong-chat') actual.chatId = 'other-chat'
      if (mismatch === 'wrong-sender') actual.senderOpenId = 'other-user'
      return [actual]
    })
    const proof = await captureTodoProvenance(t.input, t.deps)
    expect(proof.request?.link).toEqual({ status: 'unavailable' })
    expect(proof.selectedInputs[0]?.message.link).toEqual({ status: 'unavailable' })
    expect(proof.selectedInputs[0]?.message.messageId).toBe('forward')
  })

  it('keeps the original source when link metadata is unavailable, without inventing a URL', async () => {
    const t = fixture()
    t.deps.feishu.getMessageItems.mockRejectedValue(new Error('synthetic provider outage'))
    const proof = await captureTodoProvenance(t.input, t.deps)
    expect(proof.request).toMatchObject({ messageId: 'request', link: { status: 'unavailable' } })
    expect(proof.selectedInputs[0]?.message).toMatchObject({ messageId: 'forward', link: { status: 'unavailable' } })
  })

  it.each([false, true])('rejects a stopped Run after an awaited metadata read (provider failed=%s)', async providerFails => {
    const t = fixture()
    t.deps.feishu.getMessageItems.mockImplementation(async () => {
      t.stop()
      if (providerFails) throw new Error('synthetic provider outage')
      return []
    })
    await expect(captureTodoProvenance(t.input, t.deps)).rejects.toThrow('run no longer current')
  })

  it('records a real background trigger without inventing a human request', async () => {
    const t = fixture()
    const proof = await captureTodoProvenance({ ...t.input, taskId: null, request: null, selectedInputs: [] }, t.deps)
    expect(proof).toMatchObject({ originRunId: 'run', taskId: null, request: null, selectedInputs: [] })
    expect(t.deps.feishu.getMessageItems).not.toHaveBeenCalled()
  })
})
