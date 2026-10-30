/** Shared identities for execution and its read-only delivery history. */
export function routineExecutionKey(routineId: number, trigger:
  | { occurrenceId: number; configVersion: number }
  | { manualMessageId: string }): string {
  return 'occurrenceId' in trigger
    ? `routine:${routineId}:occurrence:${trigger.occurrenceId}:v${trigger.configVersion}`
    : `routine:${routineId}:manual:${trigger.manualMessageId}`
}

export function routineDigestDeliveryKey(executionKey: string): string { return `${executionKey}:digest` }

export function taskDeliveryContextRef(taskId: number, sessionKey: string): string {
  return `task:${taskId}:session:${sessionKey}`
}
