import type { DeliveryStatus } from './delivery.js'
import type { BugInfoKind } from './bugs.js'

export interface AskBugQuestionInput {
  id: number
  question: string
  kind: 'info'
  missingInfo?: string[]
  infoKind?: BugInfoKind
}

export interface AskBugQuestionReceipt {
  question_id: number
  question: string
  resolution: 'open' | 'answered' | 'declined' | 'cancelled'
  delivery_status: DeliveryStatus | 'not_started'
  message_id?: string
  budget: { occupied: number; max: number }
  next: 'continue_independent_work' | 'not_sent'
}

export interface ResolveBugQuestionReplyInput {
  questionId: number
  replyId: number
  outcome: 'answered' | 'declined' | 'unavailable'
}
