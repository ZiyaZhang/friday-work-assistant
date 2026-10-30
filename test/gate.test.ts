/**
 * 全局并发闸门。
 */
import { describe, expect, it } from 'vitest'
import { Gate, GateAborted } from '../src/core/gate.js'

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('Gate', () => {
  it('放行到上限，之后排队', async () => {
    const g = new Gate(2)
    const a = await g.acquire()
    const b = await g.acquire()
    expect(g.load()).toEqual({ active: 2, waiting: 0, max: 2 })

    let thirdIn = false
    const positions: number[] = []
    const third = g.acquire((p) => positions.push(p)).then((rel) => {
      thirdIn = true
      return rel
    })
    await tick()
    expect(thirdIn).toBe(false)
    expect(positions).toEqual([1])
    expect(g.load()).toEqual({ active: 2, waiting: 1, max: 2 })

    a()
    const relC = await third
    expect(thirdIn).toBe(true)
    expect(g.load()).toEqual({ active: 2, waiting: 0, max: 2 })
    b()
    relC()
    expect(g.load()).toEqual({ active: 0, waiting: 0, max: 2 })
  })

  it('先到先得：排队顺序就是被唤醒的顺序', async () => {
    const g = new Gate(1)
    const first = await g.acquire()
    const order: string[] = []
    const p1 = g.acquire().then((r) => { order.push('b'); return r })
    const p2 = g.acquire().then((r) => { order.push('c'); return r })
    await tick()
    first()
    ;(await p1)()
    ;(await p2)()
    expect(order).toEqual(['b', 'c'])
  })

  it('释放是幂等的：finally 里重复调用不会凭空多出位置', async () => {
    const g = new Gate(1)
    const rel = await g.acquire()
    rel()
    rel()
    rel()
    expect(g.load().active).toBe(0)
    // 位置没有被还多，上限仍然是 1
    await g.acquire()
    let second = false
    void g.acquire().then(() => { second = true })
    await tick()
    expect(second).toBe(false)
  })

  it('没排队就不叫 onQueued——人不该为一个没发生的等待收到提示', async () => {
    const g = new Gate(1)
    let called = 0
    await g.acquire(() => { called += 1 })
    expect(called).toBe(0)
  })

  it('同步交接许可，释放后立刻到来的请求不能插队或突破上限', async () => {
    const g = new Gate(1), first = await g.acquire()
    const order: string[] = []
    const second = g.acquire().then(release => { order.push('second'); return release })
    first()
    const third = g.acquire().then(release => { order.push('third'); return release })
    expect(g.load()).toEqual({ active: 1, waiting: 1, max: 1 })
    const releaseSecond = await second
    expect(order).toEqual(['second'])
    expect(g.load().active).toBe(1)
    releaseSecond()
    ;(await third)()
    expect(order).toEqual(['second', 'third'])
    expect(g.load()).toEqual({ active: 0, waiting: 0, max: 1 })
  })

  it.each([false, true])('排队提示抛错时不遗留等待者或占用许可（已交接=%s）', async handedOff => {
    const g = new Gate(1), first = await g.acquire()
    const failed = g.acquire(() => { throw new Error('notice unavailable') })
    // The rejection continuation has not run; release may still find this waiter.
    if (handedOff) first()
    await expect(failed).rejects.toThrow('notice unavailable')
    expect(g.load()).toEqual({ active: handedOff ? 0 : 1, waiting: 0, max: 1 })
    first()
    const next = await g.acquire()
    next()
    expect(g.load().active).toBe(0)
  })
})

describe('Gate 里的中断', () => {
  it('排队时被打断就立刻退出队列，不会占着队首', async () => {
    const g = new Gate(1)
    const held = await g.acquire()
    const ac = new AbortController()
    const queued = g.acquire(undefined, ac.signal)
    await tick()
    expect(g.load().waiting).toBe(1)

    ac.abort()
    await expect(queued).rejects.toThrow(GateAborted)
    expect(g.load().waiting).toBe(0)

    // 被打断的那个没有占着位置：放开手里的许可后，后来的人立刻能拿到
    let later = false
    const p = g.acquire().then((r) => { later = true; return r })
    held()
    ;(await p)()
    expect(later).toBe(true)
  })

  it('已经 abort 的信号直接拒绝，不占许可', async () => {
    const g = new Gate(1)
    const ac = new AbortController()
    ac.abort()
    await expect(g.acquire(undefined, ac.signal)).rejects.toThrow(GateAborted)
    expect(g.load().active).toBe(0)
  })

  it('许可交接后、等待者恢复前收到 stop，不复活该轮并把位置让给下一位', async () => {
    const g = new Gate(1), first = await g.acquire(), stopped = new AbortController()
    const second = g.acquire(undefined, stopped.signal)
    first()
    stopped.abort()
    const third = g.acquire()
    await expect(second).rejects.toThrow(GateAborted)
    const releaseThird = await third
    expect(g.load()).toEqual({ active: 1, waiting: 0, max: 1 })
    releaseThird()
    expect(g.load().active).toBe(0)
  })
})
