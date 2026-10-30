import type { FeishuClient } from '../feishu/client.js'
import { ORG_SCOPE, type ChannelMemory } from './memory.js'
import { circleScope, type Circles } from './circles.js'
import { DeliveryService, type DeliveryContext } from './delivery.js'
import type { PolicyService } from './policy.js'
import type { Registry } from './registry.js'
import type { Spaces } from './space.js'

type ReceiptDeps = { registry: Registry; memory: ChannelMemory; spaces: Spaces; circles?: Circles; policy: PolicyService; feishu: FeishuClient; now: () => number }
type ReceiptInput = { noteId: number; runId: string; changedScope: string; spaceId: string; chatId: string; chatType: 'group' | 'p2p';
  actorOpenId: string; messageId: string; threadId?: string }

/** A committed control result may outlive the worker that consumed the changed note. */
export async function deliverForgottenMemory(deps: ReceiptDeps, input: ReceiptInput) {
  const forgotten = deps.memory.getTombstone(input.noteId)
  if (!forgotten || forgotten.scope !== input.changedScope || input.changedScope !== `space:${input.spaceId}`) throw new Error('没有对应的记忆删除记录')
  return deliverFact(deps, input, `memory:forget:${input.noteId}:v${forgotten.revision}`, '已删除这条记忆。')
}

export async function deliverCorrectedMemory(deps: ReceiptDeps, input: ReceiptInput) {
  const note = deps.memory.get(input.noteId)
  if (!note || note.scope !== input.changedScope || note.status !== 'candidate' || !readableScope(deps, input)) throw new Error('没有对应的候选更正记录')
  return deliverFact(deps, input, `memory:correct:${note.id}:v${note.revision}`, '更正已记下，你确认后生效；原来那条在此之前照常有效。')
}

async function deliverFact(deps: ReceiptDeps, input: ReceiptInput, key: string, text: string) {
  const resolve = (): DeliveryContext | undefined => {
    const space = deps.spaces.get(input.spaceId)
    if (!space || space.status !== 'active' || space.chatId !== input.chatId || space.kind !== input.chatType || !readableScope(deps, input)) return undefined
    return { actorOpenId: input.actorOpenId, expiresAt: deps.now() + 60_000, provenanceComplete: true,
      audience: input.chatType === 'p2p' ? { kind: 'dm', spaceId: space.id, openId: input.actorOpenId }
        : { kind: 'group', spaceId: space.id, chatId: input.chatId, replyToMessageId: input.messageId, threadId: input.threadId },
      sources: [{ ref: `space:${space.id}`, spaceId: space.id, chatId: input.chatId }] }
  }
  const delivery = new DeliveryService(deps.registry.db, { ...deps, resolveContext: async () => {
    if (input.chatType === 'group' && !(await deps.feishu.chatMemberOpenIds(input.chatId, { fresh: true })).has(input.actorOpenId)) return undefined
    return resolve()
  },
    send: async () => {
      const remoteId = input.chatType === 'p2p' ? await deps.feishu.sendToChat(input.chatId, { text })
        : (await deps.feishu.replyText(input.messageId, text, !input.threadId)).messageId
      return { remoteId }
    },
  })
  return delivery.deliver({ key, contextRef: `memory-control:${input.runId}`, payload: { text } })
}

/** The committed note layer is not the destination. A fact receipt stays in the original audience. */
function readableScope(deps: ReceiptDeps, input: ReceiptInput): boolean {
  if (input.changedScope === `space:${input.spaceId}` || input.changedScope === ORG_SCOPE) return true
  const circle = input.chatType === 'group' ? deps.circles?.circleOf(input.chatId) : undefined
  return Boolean(circle && input.changedScope === circleScope(circle))
}
