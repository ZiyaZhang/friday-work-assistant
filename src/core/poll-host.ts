import { z } from 'zod'
import type { Registry } from './registry.js'
import type { RunAttempts } from './run-attempts.js'
import type { RuntimeContexts } from './runtime-contexts.js'
import type { SourceContexts, SourceContextBinding } from './source-context.js'
import type { CardAction } from '../feishu/ws.js'
import { assertRequestCurrent } from './request-lease.js'
import { PollError, pollDigest } from './polls.js'
import { PollRuntime, type PollRuntimeDeps, type PollRunRef, type PollRuntimeBinding, type PollCallback } from './poll-runtime.js'
import type { PollSourceReceipt } from './poll-source.js'

/** Live host identity only; neither an MCP argument nor a card value may create it. */
export interface PollHostBinding extends PollRunRef, SourceContextBinding {
  taskId: number; workKey: string; openId: string; chatType: 'group' | 'p2p'
  assertCurrent(): void
}

export interface PollHostDeps extends Omit<PollRuntimeDeps, 'db' | 'binding' | 'recordSource'> {
  registry: Registry
  attempts: RunAttempts
  contexts: RuntimeContexts
  sources: Pick<SourceContexts, 'get'>
  binding(ref: PollRunRef): PollHostBinding
  /** Uses the shared source store; the application supplies the actual bound identity. */
  recordSource(binding: SourceContextBinding, source: PollSourceReceipt): void
  /** Includes current deployment allow-list and bot/group lifecycle admission. */
  assertChatAllowed(chatId: string): void
}

const ballotValue = z.object({ action: z.literal('poll_ballot'), pollId: z.string().min(1),
  digest: z.string().regex(/^[a-f0-9]{64}$/), optionId: z.string().min(1).nullable() }).strict()

/** Production assembly for real Work/Task/Run and authenticated WS callbacks.
 * The caller owns lifecycle tracking; this class starts no timer or model. */
export class PollHost {
  readonly runtime: PollRuntime
  constructor(private readonly deps: PollHostDeps) {
    this.runtime = new PollRuntime({ ...deps, db: deps.registry.db,
      binding: ref => this.resolveRun(ref),
      authorizeSavedContext: async (context, origin, guard) => {
        const current = () => { guard(); deps.assertLifecycleCurrent(); deps.assertChatAllowed(origin.chatId) }
        current()
        const access = await deps.authorizeSavedContext(context, origin, current)
        current(); access.assertCurrent()
        return { ...access, assertCurrent: () => { current(); access.assertCurrent() } }
      },
      recordSource: (ref, source) => {
        const binding = this.resolveRun(ref)
        binding.assertCurrent()
        deps.recordSource({ sessionKey: ref.sessionKey, acpSessionId: binding.provenance.sources.acpSessionId,
          spaceId: binding.origin.spaceId, chatId: binding.origin.chatId }, source)
        binding.assertCurrent()
      },
    })
  }

  /** Called only after the WS SDK authenticated the event. No HTTP/model ballot route. */
  async handleCardAction(action: CardAction): Promise<{ toast: { type: 'success' | 'error'; content: string } } | undefined> {
    if (action.value.action !== 'poll_ballot') return undefined
    try {
      const input = pollCallback(action)
      const current = () => {
        assertRequestCurrent(); this.deps.assertLifecycleCurrent(); this.deps.assertChatAllowed(input.chatId)
      }
      current()
      const result = await this.runtime.vote(input, current)
      current()
      return { toast: { type: 'success', content: result.message } }
    } catch (error) {
      if (error instanceof PollError) return { toast: { type: 'error', content: error.message } }
      // Unknown provider/programming failures retain their real cause in the
      // host callback boundary; never convert them to a successful ballot.
      throw error
    }
  }

  private resolveRun(ref: PollRunRef): PollRuntimeBinding {
    const binding = this.deps.binding(ref), signature = identity(binding)
    const initial = this.deps.registry.workContexts.get(binding.workKey)
    const check = () => {
      assertRequestCurrent(); this.deps.assertLifecycleCurrent(); binding.assertCurrent()
      const fresh = this.deps.binding(ref)
      fresh.assertCurrent()
      const { registry, attempts, contexts, spaces } = this.deps
      const run = attempts.get(ref.runId), task = registry.getTask(binding.taskId), session = registry.getSession(ref.sessionKey)
      const work = registry.workContexts.get(binding.workKey), dispatch = registry.dispatches.get(binding.taskId)
      const space = spaces.get(binding.spaceId)
      if (identity(fresh) !== signature || ref.runId !== binding.runId || ref.sessionKey !== binding.sessionKey ||
        binding.chatType !== 'group' || !binding.openId || !initial || !work || work.lifecycle !== 'open' || work.pauseReasons.length ||
        work.controlEpoch !== initial.controlEpoch || work.inputSeq !== initial.inputSeq || work.authorityOpenId !== binding.openId ||
        !run || run.state !== 'running' || run.stage !== 'task' || run.taskId !== binding.taskId || run.actorOpenId !== binding.openId ||
        run.workKey !== binding.workKey || run.sessionKey !== ref.sessionKey || run.acpSessionId !== binding.acpSessionId ||
        !task || task.status !== 'running' || task.stopReason || task.sessionKey !== ref.sessionKey || task.requesterOpenId !== binding.openId ||
        registry.taskWork.get(task.id)?.key !== binding.workKey || !session || session.status === 'archived' ||
        session.acpSessionId !== binding.acpSessionId || session.chatId !== binding.chatId || session.chatType !== 'group' ||
        !space || space.status !== 'active' || space.kind !== 'group' || space.chatId !== binding.chatId ||
        !dispatch || dispatch.inbound.senderType !== 'user' || dispatch.inbound.senderOpenId !== binding.openId ||
        dispatch.inbound.messageId !== task.messageId || dispatch.inbound.chatId !== binding.chatId || dispatch.inbound.chatType !== 'group' ||
        !contexts.isEligible(ref.runId, true)) throw new PollError('denied')
      this.deps.assertChatAllowed(binding.chatId)
    }
    check()
    const sources = this.deps.sources.get(ref.sessionKey), context = this.deps.contexts.contextForRun(ref.runId)
    if (!sources || sources.acpSessionId !== binding.acpSessionId || sources.spaceId !== binding.spaceId ||
      sources.chatId !== binding.chatId || !context) throw new PollError('denied')
    const task = this.deps.registry.getTask(binding.taskId)!
    return { origin: { runId: ref.runId, sessionKey: ref.sessionKey, taskId: task.id, workKey: binding.workKey,
      ownerOpenId: binding.openId, spaceId: binding.spaceId, chatId: binding.chatId, chatType: 'group', requestMessageId: task.messageId },
      provenance: structuredClone({ sources, memoryRefs: context.notes }), assertCurrent: check }
  }
}

function identity(binding: PollHostBinding): string { return pollDigest({ ...binding, assertCurrent: undefined }) }

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** Read platform sequence and actor from the authenticated envelope only. SDK
 * versions may retain header or flatten it; conflicting fields are rejected. */
export function pollCallback(action: CardAction): PollCallback {
  const value = ballotValue.safeParse(action.value), raw = object(action.raw), header = object(raw.header)
  const operator = object(raw.operator), context = object(raw.context)
  const field = (name: string) => {
    const direct = raw[name], nested = header[name]
    if (direct !== undefined && nested !== undefined && direct !== nested) throw new PollError('invalid')
    const selected = direct ?? nested
    if (typeof selected !== 'string' || !selected) throw new PollError('invalid')
    return selected
  }
  if (!value.success || !action.operatorOpenId || !action.chatId || !action.messageId ||
    operator.open_id !== action.operatorOpenId || (context.open_chat_id ?? raw.open_chat_id) !== action.chatId ||
    (context.open_message_id ?? raw.open_message_id) !== action.messageId) throw new PollError('invalid')
  const eventId = field('event_id'), eventTimeMicros = field('create_time')
  if (!/^\d{1,24}$/.test(eventTimeMicros) || BigInt(eventTimeMicros) <= 0n) throw new PollError('invalid')
  return { pollId: value.data.pollId, digest: value.data.digest, optionId: value.data.optionId,
    operatorOpenId: action.operatorOpenId, chatId: action.chatId, messageId: action.messageId, eventId, eventTimeMicros }
}
