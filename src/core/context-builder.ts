/** Ordinary-turn context assembly; the host owns authorization, external reads and Run lifetime. */
import type { HistoryMessage } from '../feishu/client.js'
import type { BugQuestions } from './bug-questions.js'
import type { ChannelMemory, ScopeSpec } from './memory.js'
import { buildTurnPrompt, type TurnContext } from './prompt.js'
import type { ContextReceipt } from './receipt.js'
import type { Registry } from './registry.js'
import type { FeedbackWorkContext } from './feedback-work-context.js'
import type { RunSkillSet } from './skills.js'

export interface TurnContextInput {
  taskId: number
  session: { key: string; chatId: string; chatType: 'group' | 'p2p' }
  actor: { openId?: string; name: string; description: string }
  space: { id: string; prefs: { brevity?: string; notes: string[] }; circle?: string }
  botName: string
  chatName: string
  messageId: string
  body: string
  nowMs: number
  isFirstTurn: boolean
  /** Already authorized by the host; this module does not expand or grant scopes. */
  memoryScopes: ScopeSpec[]
  /** Production hosts prepare and register this exact material before building. */
  preparedMemory?: ReturnType<ChannelMemory['composeForPrompt']>
  historyMode?: 'continue' | 'rebuild'
  prior: { items: HistoryMessage[]; complete: boolean; note?: string }
  attachmentsNote?: string
  circleNote?: string
  excludedSources: string[]
  skillSet?: RunSkillSet
  steerOf?: string
  followup?: TurnContext['followup']
  /** Current host-approved scopes and exact, host-recorded reading references. */
  feedbackAccess?: { scopes: readonly string[]; referencedTaskIds?: readonly number[] }
  /** What this conversation can read, from the host's actual authorization state. */
  readingNote?: string
}

export interface PreparedTurnContext {
  prompt: string
  receipt: ContextReceipt
  /** Scopes actually queried, including empty layers; do not narrow accumulated source gates. */
  memoryScopes: string[]
}

/** Reads current local facts on every build, including warm ACP turns. No cache or persistent manifest. */
export class TurnContextBuilder {
  constructor(private readonly deps: { memory: ChannelMemory; registry: Registry; questions?: BugQuestions; feedbackContext?: FeedbackWorkContext }) {}

  build(input: TurnContextInput): PreparedTurnContext {
    const { session, actor, space } = input
    const omitted = input.historyMode === 'rebuild' ? input.prior.items.filter(item => item.senderType === 'app').length : 0
    const omissionNote = omitted ? `重建上下文时未载入 ${omitted} 条旧助手消息；人类原文仍保留。` : undefined
    const prior = {
      ...input.prior,
      items: input.historyMode === 'rebuild' ? input.prior.items.filter(item => item.senderType !== 'app') : input.prior.items,
      note: [input.prior.note, omissionNote].filter(Boolean).join('；') || undefined,
    }
    const composed = input.preparedMemory ?? this.deps.memory.composeForPrompt(input.memoryScopes, input.body)
    const questionContext = input.feedbackAccess && !input.feedbackAccess.scopes.includes('bug:read')
      ? [] : this.questionContext(input.taskId, space.id, session.key)
    const feedbackContext = actor.openId && input.feedbackAccess ? this.deps.feedbackContext?.read({
      taskId: input.taskId, sessionKey: session.key, spaceId: space.id, chatId: session.chatId, chatType: session.chatType,
      actorOpenId: actor.openId, ...input.feedbackAccess,
    }) : undefined
    const receipt: ContextReceipt = {
      sessionKey: session.key,
      atMs: input.nowMs,
      where: session.chatType === 'p2p' ? '私聊' : `群「${input.chatName}」`,
      spaceId: space.id,
      actor: actor.description,
      memory: composed.used,
      priorMessages: prior.items.length,
      attachments: input.attachmentsNote ? 1 : 0,
      prefs: space.prefs.notes.length + (space.prefs.brevity ? 1 : 0),
      circle: session.chatType === 'group' ? space.circle : undefined,
      crossSpace: [],
      excluded: [...input.excludedSources, ...(!input.prior.complete && input.prior.note ? [input.prior.note] : []), ...(omissionNote ? [omissionNote] : [])],
      ...(input.skillSet ? { skillSet: { digest: input.skillSet.digest, builtinDigest: input.skillSet.builtinDigest,
        available: input.skillSet.skills.map(skill => ({ name: skill.name, proposalId: skill.proposalId, contentDigest: skill.contentDigest })) } } : {}),
    }
    return {
      prompt: buildTurnPrompt({
        botName: input.botName,
        chatName: input.chatName,
        chatId: session.chatId,
        chatType: session.chatType,
        sessionKey: session.key,
        requesterName: actor.name,
        requesterOpenId: actor.openId,
        messageId: input.messageId,
        nowMs: input.nowMs,
        isFirstTurn: input.isFirstTurn,
        priorThreadMessages: prior.items,
        priorThreadNote: prior.note,
        memoryBlock: composed.text,
        circleNote: input.circleNote,
        spacePrefs: space.prefs,
        body: input.body,
        skillSet: input.skillSet,
        attachmentsNote: input.attachmentsNote,
        steerOf: input.steerOf,
        amendedRequests: this.deps.registry.listAmendedTasks(input.taskId),
        questionContext,
        feedbackContext,
        followup: input.followup,
        readingNote: input.readingNote,
      }),
      receipt,
      memoryScopes: [...new Set(composed.used.layers.map((layer) => layer.scope))],
    }
  }

  private questionContext(taskId: number, spaceId: string, sessionKey: string): TurnContext['questionContext'] {
    const { questions } = this.deps
    return (questions?.forTask(taskId) ?? []).map(({ question, reply }) => {
      if (question.spaceId !== spaceId || question.sessionKey !== sessionKey) throw new Error('补问不属于当前空间或工作')
      const context = questions!.readContext(question.bucketId, spaceId)
      const current = context.questions.find((q) => q.id === question.id)!
      return {
        feedback_id: context.bucket.id, title: context.bucket.title, intake_phase: context.bucket.intakePhase,
        issue_url: context.bucket.issueUrl, missing_info: context.bucket.missingInfo,
        question_id: current.id, current_reply_id: reply.id, resolution: current.resolution, question: current.question,
        original_request: { message_id: current.origin.messageId, text: current.origin.text },
        replies: current.replies.map((r) => ({ reply_id: r.id, message_id: r.messageId, open_id: r.senderOpenId,
          outcome: r.outcome, text: r.text })),
      }
    })
  }
}
