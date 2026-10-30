import { AsyncLocalStorage } from 'node:async_hooks'

/** Request lifetime only; Run authority and business control remain separate. */
const requests = new AsyncLocalStorage<AbortSignal>()
export class RequestEndedError extends Error {
  constructor() { super('本次工具请求已结束；已开始的操作仍按真实结果记录。'); this.name = 'RequestEndedError' }
}
export function assertRequestCurrent(signal = requests.getStore()): void {
  if (signal?.aborted) throw new RequestEndedError()
}
/** Lets an existing bounded wait end with its caller, without aborting its Run. */
export function currentRequestSignal(): AbortSignal | undefined { return requests.getStore() }
export function withRequestLease<T>(signal: AbortSignal | undefined, operation: () => T): T {
  if (!signal) return operation()
  assertRequestCurrent(signal)
  return requests.run(signal, operation)
}
/** Only already durable input/dispatch execution may outlive the HTTP that woke it. */
export function withoutRequestLease<T>(operation: () => T): T { return requests.exit(operation) }
