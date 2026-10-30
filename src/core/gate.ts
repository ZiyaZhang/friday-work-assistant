/**
 * 全局并发闸门：同时能有几轮 dsh prompt 在跑。
 *
 * 之前只有 `SerialQueue` 按 sessionKey 串行——同一个话题一次一轮（dsh 的硬约束），
 * **但不同话题之间完全没有上限**。一个人用的时候看不出来；开给一整个组之后，
 * 十个群同时 @ 就是十轮同时压在同一个 dsh 进程和同一份模型配额上，
 * 结果是每个人都变慢、然后一起超时——比让后来的人排 30 秒队糟得多。
 *
 * 先到先得（FIFO），不做优先级：插队规则一旦有了就得解释"凭什么他先"，
 * 而排队本身只要够快就没人在意。
 */
interface Waiter {
  resolve: () => void
  reject: (err: Error) => void
  granted: boolean
  cleanup?: () => void
}

/** 在闸门里排队时被中断（插话 / !stop / 超时），不是失败，是"这轮不用跑了"。 */
export class GateAborted extends Error {
  constructor() {
    super('在并发队列里等待时被中止')
    this.name = 'GateAborted'
  }
}

export class Gate {
  private active = 0
  private readonly waiters: Waiter[] = []

  constructor(private readonly max: number) {}

  /** 当前负载。`!status` 和排队提示用。 */
  load(): { active: number; waiting: number; max: number } {
    return { active: this.active, waiting: this.waiters.length, max: this.max }
  }

  /**
   * 拿一个许可，返回释放函数。**释放函数必须放在 finally 里**——
   * 漏掉一次，这个位置就永久少一个，而且是那种跑几天才发现的漏。
   *
   * `onQueued(位置)` 只在真的需要等的时候调用一次，给调用方机会告诉人"在排队"。
   */
  async acquire(onQueued?: (position: number) => void, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new GateAborted()
    if (this.active < this.max) {
      this.active += 1
      return this.release()
    }
    const position = this.waiters.length + 1
    // 等的时候被打断（有人插话、!stop、任务超时）就立刻退出队列。
    // 不退的话它还会占着队首，轮到它了再原地取消——白白卡住后面的人。
    const entry: Waiter = { resolve: () => undefined, reject: () => undefined, granted: false }
    try {
      await new Promise<void>((resolve, reject) => {
        entry.resolve = resolve
        entry.reject = reject
        this.waiters.push(entry)
        const onAbort = (): void => {
          const i = this.waiters.indexOf(entry)
          if (i >= 0) this.waiters.splice(i, 1)
          reject(new GateAborted())
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        entry.cleanup = () => signal?.removeEventListener('abort', onAbort)
        onQueued?.(position)
      })
    } catch (error) {
      // A queue-notice callback can throw. Remove its waiter, or return an already
      // handed-off permit if release happened before this rejection continued.
      const i = this.waiters.indexOf(entry)
      if (i >= 0) this.waiters.splice(i, 1)
      if (entry.granted) this.release()()
      throw error
    } finally {
      entry.cleanup?.()
    }
    // Abort can happen after resolve(), before this continuation. The permit was
    // reserved synchronously, so return it without admitting the stopped turn.
    if (signal?.aborted) {
      this.release()()
      throw new GateAborted()
    }
    return this.release()
  }

  private release(): () => void {
    let released = false
    return () => {
      // 幂等：调用方在 finally 里放，重入/重复调用不该把位置还两次
      if (released) return
      released = true
      const next = this.waiters.shift()
      if (next) {
        // Transfer the occupied slot directly: decrementing before the waiter
        // resumes lets a new acquire steal it and exceed the concurrency limit.
        next.granted = true
        next.resolve()
      } else this.active -= 1
    }
  }
}
