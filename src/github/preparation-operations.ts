import { withoutRequestLease } from '../core/request-lease.js'
import type { ChangeIdentity, ChangeManager, ChangePreparation } from './changes.js'

export interface PreparationQuery extends Omit<ChangeIdentity, 'signal' | 'assertAuthorized'> {
  operationKey: string
  repo: string
  base?: string
  /** Querying Run identity, supplied by the host; used only to remember returned views. */
  attemptKey: string
  /** Host authority for the actual querying Run, not a model-supplied claim. */
  assertCurrent(): void
}

export interface PreparationStart extends PreparationQuery {
  branchHint?: string
  /** Must belong to the Run. A caller's HTTP/MCP request signal is not an operation lifetime. */
  runSignal: AbortSignal
  /** Called after durable reservation and before IO; records the existing RunApiCalls reference. */
  onPreparation?: (receipt: { id: string }) => void
}

export interface PreparationReceipt { preparation: ChangePreparation }
export interface PreparationWait { timeoutMs?: number; signal?: AbortSignal }
interface RunningPreparation { attemptKey: string; cancel: AbortController; settled: Promise<void> }
interface PreparationView { observed: boolean; changeId?: string }

/** Owns only in-process effects already admitted by ChangeManager's durable
 * receipt. It does not dispatch Tasks, retry operations or invent business state. */
export class ChangePreparationOperations {
  private readonly running = new Map<string, RunningPreparation>()
  private readonly views = new Map<string, Map<string, PreparationView>>()
  private readonly shutdown = new AbortController()

  constructor(private readonly deps: { changes: ChangeManager }) {}

  async start(input: PreparationStart): Promise<PreparationReceipt> {
    return withoutRequestLease(async () => {
      this.shutdown.signal.throwIfAborted()
      input.runSignal.throwIfAborted()
      input.assertCurrent()
      if (!input.attemptKey.trim() || !input.operationKey.trim()) throw new Error('准备副本缺少真实运行与操作标识')
      const previous = this.deps.changes.preparationForRequest(this.identity(input))
      if (previous && (this.running.has(previous.id) || previous.state === 'preparing' ||
        previous.state === 'prepared' || previous.attemptKey === input.attemptKey)) {
        input.onPreparation?.({ id: previous.id })
        input.assertCurrent()
        input.runSignal.throwIfAborted()
        if (previous.state === 'prepared') {
          // A prepared row alone is not proof that its usable checkout still exists.
          await this.deps.changes.prepare({ ...this.identity(input), attemptKey: input.attemptKey,
            signal: input.runSignal, branchHint: input.branchHint })
          input.runSignal.throwIfAborted(); input.assertCurrent()
        }
        return this.read(input)
      }

      const cancel = new AbortController()
      const signal = AbortSignal.any([input.runSignal, this.shutdown.signal, cancel.signal])
      const assertCurrent = () => { signal.throwIfAborted(); input.assertCurrent() }
      let id: string | undefined
      // ChangeManager reserves synchronously before its first await. Async Git
      // continuations inherit no HTTP request lease, only this explicit Run lease.
      const operation = this.deps.changes.prepare({ ...this.identity(input), attemptKey: input.attemptKey,
        branchHint: input.branchHint, signal, assertAuthorized: assertCurrent,
        onPreparation: receipt => {
          input.onPreparation?.(receipt)
          assertCurrent()
          id = receipt.id
        } })
      // Always observe the Promise, including validation or receipt failures before
      // reservation. Failure state is written by ChangeManager before settlement.
      const settled = operation.then(result => {
        // Completion is not consumption. Retain an unfinished model-visible view
        // until a later result actually returns this prepared checkout to that Run.
        if (id) for (const views of this.views.values()) {
          const view = views.get(id)
          if (view) view.changeId = result.id
        }
      }, () => undefined)
      if (!id) {
        await operation
        throw new Error('准备副本没有返回持久操作收据')
      }
      const operationId = id
      const tracked = { attemptKey: input.attemptKey, cancel, settled: settled.finally(() => {
        if (this.running.get(operationId) === tracked) this.running.delete(operationId)
      }) }
      this.running.set(operationId, tracked)
      return this.read(input)
    })
  }

  read(input: PreparationQuery): PreparationReceipt {
    input.assertCurrent()
    const preparation = this.deps.changes.preparationForRequest(this.identity(input))
    if (!preparation) throw new Error('原仓库准备记录不存在')
    input.assertCurrent()
    if (!input.attemptKey.trim()) throw new Error('仓库准备查询缺少真实运行标识')
    let views = this.views.get(input.attemptKey)
    if (!views) { views = new Map(); this.views.set(input.attemptKey, views) }
    views.set(preparation.id, { observed: preparation.state === 'prepared',
      ...(preparation.result ? { changeId: preparation.result.id } : {}) })
    return { preparation }
  }

  /** Waiting is a request, not a new owner of the operation. Cancellation ends
   * this wait only; every return rechecks the real caller's current authority. */
  async wait(input: PreparationQuery, options: PreparationWait = {}): Promise<PreparationReceipt> {
    const timeoutMs = boundedWait(options.timeoutMs ?? 20_000)
    options.signal?.throwIfAborted()
    const current = this.read(input), active = this.running.get(current.preparation.id)
    if (active && current.preparation.state === 'preparing') await waitBounded(active.settled, timeoutMs, options.signal)
    options.signal?.throwIfAborted()
    return this.read(input)
  }

  pendingForRun(attemptKey: string): number {
    const views = this.views.get(attemptKey)
    return [...this.running].filter(([id, item]) => item.attemptKey === attemptKey || views?.has(id)).length
  }

  /** Retiring an effect after a host failure must not fabricate a user stop or
   * abort the surrounding Run's failure delivery. Only its owned Git is stopped. */
  cancelRun(attemptKey: string): void {
    for (const item of this.running.values()) if (item.attemptKey === attemptKey) {
      item.cancel.abort(new Error('本轮仓库准备已结束'))
    }
  }

  unobservedForRun(attemptKey: string): boolean {
    return [...(this.views.get(attemptKey)?.values() ?? [])].some(view => !view.observed)
  }

  /** Only call after a real list/read/edit returned this exact prepared change.
   * A model-supplied identifier alone is not evidence that the result was read. */
  observeResultForRun(attemptKey: string, changeId: string): void {
    const views = this.views.get(attemptKey)
    if (views) for (const view of views.values()) if (view.changeId === changeId) view.observed = true
  }

  /** Host returned a view but its enclosing HTTP result failed/cancelled. Keep
   * that uncertain return separate from durable operation completion. */
  markUnobservedForRun(attemptKey: string, preparationId: string): void {
    const view = this.views.get(attemptKey)?.get(preparationId)
    if (view) view.observed = false
  }

  releaseRun(attemptKey: string): void {
    if (this.pendingForRun(attemptKey)) throw new Error('原运行的仓库准备尚未结束')
    this.views.delete(attemptKey)
  }

  /** The host must call before retiring its Run. Rejections already have durable
   * domain receipts; this waits for actual Git exit/cleanup, not just socket close. */
  async settleRun(attemptKey: string): Promise<void> {
    for (;;) {
      const views = this.views.get(attemptKey)
      const pending = [...this.running].filter(([id, item]) => item.attemptKey === attemptKey || views?.has(id)).map(([, item]) => item)
      if (!pending.length) return
      await Promise.all(pending.map(item => item.settled))
    }
  }

  beginShutdown(): void { this.shutdown.abort(new Error('仓库准备服务正在关闭')) }

  async waitForShutdown(timeoutMs: number): Promise<{ drained: boolean; pending: number }> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new Error('等待时间无效')
    await waitBounded(Promise.all([...this.running.values()].map(item => item.settled)).then(() => undefined), timeoutMs)
    return { drained: this.running.size === 0, pending: this.running.size }
  }

  private identity(input: PreparationQuery): ChangeIdentity & { operationKey: string; repo: string; base?: string } {
    return { cwd: input.cwd, sessionKey: input.sessionKey, requesterOpenId: input.requesterOpenId,
      workKey: input.workKey, operationKey: input.operationKey, repo: input.repo, base: input.base,
      assertAuthorized: input.assertCurrent }
  }
}

function boundedWait(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 20_000) throw new Error('仓库准备查询每次最多等待20秒')
  return value
}

function waitBounded(promise: Promise<void>, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  if (!timeoutMs) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
    const done = () => { cleanup(); resolve() }
    const abort = () => { cleanup(); reject(signal?.reason ?? new Error('本次等待已取消')) }
    const timer = setTimeout(done, timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    promise.then(done, error => { cleanup(); reject(error) })
    if (signal?.aborted) abort()
  })
}
