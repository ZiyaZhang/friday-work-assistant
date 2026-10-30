import type { FeishuClient } from '../feishu/client.js'
import { messageSourceLink } from '../feishu/message-links.js'
import type { InboundMessage } from '../feishu/mention.js'
import type { InboundMaterialReference } from './inbound-materials.js'
import type { SourceContext } from './source-context.js'
import type { TodoMessageMetadata, TodoProvenance } from './todo-provenance.js'

/** A host-bound creation receipt. The worker supplies neither identity nor source URLs. */
export async function captureTodoProvenance(input: {
  runId: string
  workKey: string
  taskId: number | null
  request: InboundMessage | null
  selectedInputs: readonly InboundMaterialReference[]
  assertCurrent(): void
  snapshot(): SourceContext
}, deps: { feishu: Pick<FeishuClient, 'getMessageItems'>; domain: 'feishu' | 'lark' }): Promise<TodoProvenance> {
  input.assertCurrent()
  const captureMessage = async (message: InboundMessage): Promise<TodoMessageMetadata> => {
    input.assertCurrent()
    // Link lookup is optional metadata, before any Todo write. A provider outage
    // cannot erase the trusted inbound receipt or leave a content-only Todo.
    const items = await deps.feishu.getMessageItems(message.messageId).catch(() => [])
    input.assertCurrent()
    const exact = items.find(item => item.messageId === message.messageId && item.chatId === message.chatId &&
      (!item.senderOpenId || item.senderOpenId === message.senderOpenId))
    const url = exact && messageSourceLink(exact, deps.domain)
    return { messageId: message.messageId, chatId: message.chatId, chatType: message.chatType,
      senderOpenId: message.senderOpenId!, msgType: message.msgType, createTimeMs: message.createTimeMs,
      ...(message.threadId ? { threadId: message.threadId } : {}),
      ...(message.rootId ? { rootId: message.rootId } : {}),
      ...(message.parentId ? { parentId: message.parentId } : {}),
      ...(message.fileName ? { fileName: message.fileName } : {}),
      link: url ? { status: 'available', url } : { status: 'unavailable' } }
  }
  const [request, selectedInputs] = await Promise.all([
    input.request ? captureMessage(input.request) : Promise.resolve(null),
    Promise.all(input.selectedInputs.map(async reference => ({ ref: reference.ref, taskId: reference.taskId,
      message: await captureMessage(reference.message) }))),
  ])
  input.assertCurrent()
  return { version: 1, originRunId: input.runId, taskId: input.taskId, workKey: input.workKey,
    request, selectedInputs, contextSnapshot: structuredClone(input.snapshot()) }
}
