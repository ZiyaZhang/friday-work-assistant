/**
 * 按 key 串行的任务队列：同一会话一次只跑一个 prompt（dsh ACP 的约束），不同会话并行。
 */
export class SerialQueue {
  private readonly chains = new Map<string, Promise<unknown>>()
  private readonly pendingCount = new Map<string, number>()

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve()
    this.pendingCount.set(key, (this.pendingCount.get(key) ?? 0) + 1)
    const next = prev
      .catch(() => undefined)
      .then(task)
      .finally(() => {
        const n = (this.pendingCount.get(key) ?? 1) - 1
        if (n <= 0) {
          this.pendingCount.delete(key)
          if (this.chains.get(key) === next) this.chains.delete(key)
        } else this.pendingCount.set(key, n)
      })
    this.chains.set(key, next)
    return next
  }

  /** 排队中（含正在执行）的任务数。 */
  pending(key: string): number {
    return this.pendingCount.get(key) ?? 0
  }
}
