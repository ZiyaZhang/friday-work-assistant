/**
 * 单宿主进程锁。gateway 排除活动网关，保证启动恢复时没有旧发送者；
 * scheduler 保留带心跳的定时工作锁。两者共享记录格式，接管条件不同。
 */
import { hostname } from 'node:os'
import type { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS process_locks (
  name TEXT PRIMARY KEY,
  pid INTEGER NOT NULL,
  host TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL
);
`

export interface LockHolder {
  pid: number
  host: string
  acquiredAt: number
  heartbeatAt: number
}

/** 心跳超过这么久没更新，就认为持有者已经死了 */
export const LOCK_STALE_MS = 90_000

export class Locks {
  private readonly pid = process.pid
  private readonly host = hostname()

  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = () => Date.now(),
  ) {
    db.exec(SCHEMA)
  }

  holder(name: string): LockHolder | undefined {
    const r = this.db.prepare('SELECT * FROM process_locks WHERE name = ?').get(name) as Record<string, unknown> | undefined
    return r ? { pid: Number(r.pid), host: String(r.host), acquiredAt: Number(r.acquired_at), heartbeatAt: Number(r.heartbeat_at) } : undefined
  }

  /** 单机同 PID 命名空间的网关排他锁。活进程不因心跳过期被接管。 */
  acquireExclusive(name: string): LockHolder | undefined {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.holder(name)
      if (current && (current.host !== this.host || current.pid !== this.pid) && this.holderAlive(current)) {
        this.db.exec('COMMIT')
        return current
      }
      const now = this.now()
      this.db.prepare(`INSERT INTO process_locks (name,pid,host,acquired_at,heartbeat_at) VALUES (?,?,?,?,?)
        ON CONFLICT(name) DO UPDATE SET pid=excluded.pid,host=excluded.host,acquired_at=excluded.acquired_at,heartbeat_at=excluded.heartbeat_at`)
        .run(name, this.pid, this.host, now, now)
      this.db.exec('COMMIT')
      return undefined
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  /**
   * 本机上这个 pid 还活着吗。部署时旧进程常被 SIGKILL 掉（来不及 release），
   * 这时候等 90s 心跳过期是白等——进程都没了，锁立刻可以接管。
   * 只对同一台机器有效：别的机器的 pid 我们无从判断，老老实实等心跳。
   */
  private holderAlive(h: LockHolder): boolean {
    if (h.host !== this.host) return true
    try {
      process.kill(h.pid, 0)
      return true
    } catch (err) {
      // EPERM = 进程在、但不是我们能发信号的；只有 ESRCH 才是真的没了
      return (err as NodeJS.ErrnoException).code !== 'ESRCH'
    }
  }

  /**
   * 拿锁。已经是自己的就续期；别人的锁只有**心跳过期或者持有进程已经没了**才接管。
   * 返回 undefined = 拿到了；返回当前持有者 = 没拿到（调用方据此跳过定时工作）。
   */
  acquire(name: string): LockHolder | undefined {
    const now = this.now()
    const cur = this.holder(name)
    const mine = cur && cur.pid === this.pid && cur.host === this.host
    if (cur && !mine && now - cur.heartbeatAt < LOCK_STALE_MS && this.holderAlive(cur)) return cur
    this.db
      .prepare('INSERT INTO process_locks (name, pid, host, acquired_at, heartbeat_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET pid = excluded.pid, host = excluded.host, acquired_at = CASE WHEN process_locks.pid = excluded.pid AND process_locks.host = excluded.host THEN process_locks.acquired_at ELSE excluded.acquired_at END, heartbeat_at = excluded.heartbeat_at')
      .run(name, this.pid, this.host, now, now)
    return undefined
  }

  /** 心跳：只有自己持有时才更新（别人接管后就不再续了）。 */
  heartbeat(name: string): boolean {
    const n = Number(this.db.prepare('UPDATE process_locks SET heartbeat_at = ? WHERE name = ? AND pid = ? AND host = ?').run(this.now(), name, this.pid, this.host).changes)
    return n > 0
  }

  /** 自己是不是当前持有者。定时任务每次跑之前问一句。 */
  holds(name: string): boolean {
    const cur = this.holder(name)
    return Boolean(cur && cur.pid === this.pid && cur.host === this.host && this.now() - cur.heartbeatAt < LOCK_STALE_MS)
  }

  /** 正常退出时释放，好让新进程立刻接手，不用等心跳过期。 */
  release(name: string): void {
    this.db.prepare('DELETE FROM process_locks WHERE name = ? AND pid = ? AND host = ?').run(name, this.pid, this.host)
  }
}
