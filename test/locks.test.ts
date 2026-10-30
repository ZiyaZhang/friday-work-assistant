import { describe, expect, it, vi } from 'vitest'
import { Locks, LOCK_STALE_MS } from '../src/core/locks.js'
import { Registry } from '../src/core/registry.js'
import { RoutineScheduler, RoutineStore } from '../src/core/routines.js'
import { createLogger } from '../src/log.js'

const log = createLogger('test', 'error')

describe('gateway recovery exclusion', () => {
  it('does not take a live gateway even after the scheduler heartbeat expires', () => {
    const registry = new Registry(':memory:')
    try {
      const active = new Locks(registry.db, () => 1)
      expect(active.acquireExclusive('gateway')).toBeUndefined()
      const next = new Locks(registry.db, () => LOCK_STALE_MS * 10)
      Object.defineProperty(next, 'pid', { value: process.pid + 7 })
      expect(next.acquireExclusive('gateway')?.pid).toBe(process.pid)
      expect(active.holder('gateway')?.pid).toBe(process.pid)
      active.release('gateway')
      expect(next.acquireExclusive('gateway')).toBeUndefined()
    } finally { registry.close() }
  })

  it('only reclaims a same-host gateway when its PID is gone', () => {
    const registry = new Registry(':memory:')
    try {
      const active = new Locks(registry.db)
      active.acquireExclusive('gateway')
      registry.db.prepare('UPDATE process_locks SET pid=? WHERE name=?').run(2 ** 22, 'gateway')
      expect(new Locks(registry.db).acquireExclusive('gateway')).toBeUndefined()
      registry.db.prepare('UPDATE process_locks SET host=? WHERE name=?').run('another-host', 'gateway')
      expect(new Locks(registry.db).acquireExclusive('gateway')?.host).toBe('another-host')
    } finally { registry.close() }
  })

  it('does not mistake a permission error when probing a PID for a dead process', () => {
    const registry = new Registry(':memory:')
    try {
      const locks = new Locks(registry.db)
      locks.acquireExclusive('gateway')
      registry.db.prepare('UPDATE process_locks SET pid=? WHERE name=?').run(2 ** 22, 'gateway')
      const probe = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }) })
      try { expect(locks.acquireExclusive('gateway')?.pid).toBe(2 ** 22) } finally { probe.mockRestore() }
    } finally { registry.close() }
  })
})

describe('单实例锁', () => {
  it('同一进程重复拿是续期，别人的锁只有心跳过期才接管', () => {
    const db = new Registry(':memory:').db
    let now = 1_000_000
    const a = new Locks(db, () => now)
    expect(a.acquire('scheduler')).toBeUndefined()
    expect(a.holds('scheduler')).toBe(true)
    const first = a.holder('scheduler')!.acquiredAt
    now += 1000
    expect(a.acquire('scheduler')).toBeUndefined()
    expect(a.holder('scheduler')!.acquiredAt).toBe(first) // 续期不重置持有起点
    expect(a.holder('scheduler')!.heartbeatAt).toBe(now)

    // 另一个"进程"：同一张表，但 pid 不同
    const b = new Locks(db, () => now)
    Object.defineProperty(b, 'pid', { value: a.holder('scheduler')!.pid + 1 })
    const blocked = b.acquire('scheduler')
    expect(blocked?.pid).toBe(a.holder('scheduler')!.pid)
    expect(b.holds('scheduler')).toBe(false)

    // a 不再心跳，过了阈值 b 才接管
    now += LOCK_STALE_MS - 1
    expect(b.acquire('scheduler')).toBeTruthy()
    now += 2
    expect(b.acquire('scheduler')).toBeUndefined()
    expect(b.holds('scheduler')).toBe(true)
    expect(a.holds('scheduler')).toBe(false)
    expect(a.heartbeat('scheduler')).toBe(false) // 被接管之后自己续不了
  })

  it('正常退出释放锁，另一个进程立刻能拿到', () => {
    const db = new Registry(':memory:').db
    let now = 1_000_000
    const a = new Locks(db, () => now)
    a.acquire('scheduler')
    const b = new Locks(db, () => now)
    Object.defineProperty(b, 'pid', { value: process.pid + 7 })
    expect(b.acquire('scheduler')).toBeTruthy()
    a.release('scheduler')
    expect(a.holder('scheduler')).toBeUndefined()
    expect(b.acquire('scheduler')).toBeUndefined()
    // 别人持有时 release 不误删
    a.release('scheduler')
    expect(b.holds('scheduler')).toBe(true)
  })

  it('没拿到锁的进程不跑定时任务', async () => {
    const db = new Registry(':memory:').db
    const store = new RoutineStore(db)
    store.add({ kind: 'schedule', chatId: 'oc_1', chatType: 'group', name: '日报', prompt: '写日报', schedule: { type: 'interval', everyMinutes: 5 }, now: Date.now() - 10 * 60_000 })
    const ran: string[] = []
    let holding = false
    const s = new RoutineScheduler({ store, run: async (r) => { ran.push(r.name); return 'ok' }, log, enabled: () => holding })
    expect(await s.tick()).toBe(0)
    expect(ran).toHaveLength(0)
    holding = true
    expect(await s.tick()).toBe(1)
    expect(ran).toEqual(['日报'])
  })
})

describe('部署重启：旧进程被杀掉没来得及还锁', () => {
  it('同机器上持有者的进程已经没了，立刻接管，不用等心跳过期', () => {
    const db = new Registry(':memory:').db
    let now = 1_000_000
    const dead = new Locks(db, () => now)
    // 一个本机上肯定不存在的 pid（99999 之上，且不会是自己）
    Object.defineProperty(dead, 'pid', { value: 2 ** 22 })
    dead.acquire('scheduler')
    expect(dead.holder('scheduler')!.pid).toBe(2 ** 22)

    const fresh = new Locks(db, () => now)
    now += 1000 // 远没到 90s
    expect(fresh.acquire('scheduler')).toBeUndefined() // 直接接管
    expect(fresh.holds('scheduler')).toBe(true)
  })

  it('持有者进程还活着就照常等心跳，不抢', () => {
    const db = new Registry(':memory:').db
    let now = 1_000_000
    const live = new Locks(db, () => now)
    live.acquire('scheduler') // 用的就是当前进程的 pid，活着
    const other = new Locks(db, () => now)
    Object.defineProperty(other, 'pid', { value: process.pid + 1 })
    now += 1000
    expect(other.acquire('scheduler')).toBeTruthy() // 没抢到
    now += LOCK_STALE_MS
    expect(other.acquire('scheduler')).toBeUndefined() // 心跳过期才接管
  })
})
