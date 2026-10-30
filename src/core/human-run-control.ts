import type { Space } from './space.js'

export class HumanRunControlError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, readonly code: string, message: string) {
    super(message)
    this.name = 'HumanRunControlError'
  }
}

export interface HumanRunTarget {
  actorOpenId: string
  spaceId: string
  runId: string
  taskId: number
  assertCurrent: () => Space
}

export interface HumanRunStopResult {
  result: 'stop_requested' | 'already_stopping' | 'already_finished'
  runId: string
  taskId: number
  afterCommit: () => void
}

/** A whole delegation (`task:<rootTaskId>`), not one Run: cancelling ends every queued and running input of it. */
export interface HumanWorkTarget {
  actorOpenId: string
  spaceId: string
  workKey: string
  assertCurrent: () => Space
}

export interface HumanWorkResumeResult {
  result: 'resumed' | 'already_resumed'
  workKey: string
  revision: number
  afterCommit: () => void
}

export interface HumanWorkCancelResult {
  result: 'cancelled' | 'already_cancelled'
  workKey: string
  revision: number
  affectedRunIds: string[]
  cancelledTaskIds: number[]
  afterCommit: () => void
}
