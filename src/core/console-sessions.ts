import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export interface ConsoleActor {
  sessionId: string
  appId: string
  tenantKey: string
  openId: string
  name: string | null
  createdAt: number
  expiresAt: number
}

export interface ConsoleSessionCredentials {
  actor: ConsoleActor
  token: string
}

interface SessionRow {
  id: string; token_hash: string; csrf_token: string; app_id: string; tenant_key: string; open_id: string
  name: string | null; created_at: number; expires_at: number; last_seen_at: number; revoked_at: number | null
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

/** Browser authentication only. No Agent capability, platform token or business state is stored here. */
export class ConsoleSessionStore {
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly idleTimeoutMs: number

  constructor(private readonly db: DatabaseSync, opts: { now?: () => number; ttlMs?: number; idleTimeoutMs?: number } = {}) {
    this.now = opts.now ?? Date.now
    this.ttlMs = opts.ttlMs ?? 8 * 3600_000
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 30 * 60_000
    if (![this.ttlMs, this.idleTimeoutMs].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Invalid console session lifetime')
    db.exec(`CREATE TABLE IF NOT EXISTS console_sessions (
      id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, csrf_token TEXT NOT NULL,
      app_id TEXT NOT NULL, tenant_key TEXT NOT NULL, open_id TEXT NOT NULL, name TEXT,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, revoked_at INTEGER
    );`)
  }

  /** The caller has already verified the platform identity. Rotation and old-session revocation are atomic. */
  create(identity: Pick<ConsoleActor, 'appId' | 'tenantKey' | 'openId' | 'name'>, previous?: ConsoleActor): ConsoleSessionCredentials {
    if (![identity.appId, identity.tenantKey, identity.openId].every(value => typeof value === 'string' && value.trim())) throw new Error('Missing console identity')
    const now = this.now(), token = randomBytes(32).toString('base64url')
    const actor: ConsoleActor = { ...identity, sessionId: randomUUID(), createdAt: now, expiresAt: now + this.ttlMs }
    this.db.exec('SAVEPOINT console_session_create')
    try {
      if (previous) {
        if (!this.isCurrent(previous) || previous.appId !== identity.appId || previous.tenantKey !== identity.tenantKey || previous.openId !== identity.openId) {
          throw new Error('Console session changed')
        }
        this.revoke(previous.sessionId)
      }
      this.db.prepare(`INSERT INTO console_sessions
        (id,token_hash,csrf_token,app_id,tenant_key,open_id,name,created_at,expires_at,last_seen_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(actor.sessionId, hash(token), randomBytes(32).toString('base64url'),
          actor.appId, actor.tenantKey, actor.openId, actor.name, now, actor.expiresAt, now)
      this.db.exec('RELEASE console_session_create')
      return { actor, token }
    } catch (error) {
      this.db.exec('ROLLBACK TO console_session_create; RELEASE console_session_create')
      throw error
    }
  }

  authenticate(token: string): ConsoleActor | undefined {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined
    const row = this.db.prepare('SELECT * FROM console_sessions WHERE token_hash=?').get(hash(token)) as unknown as SessionRow | undefined
    if (!this.alive(row)) return undefined
    this.db.prepare('UPDATE console_sessions SET last_seen_at=? WHERE id=?').run(this.now(), row.id)
    return actorOf(row)
  }

  isCurrent(actor: ConsoleActor): boolean {
    const row = this.row(actor.sessionId)
    return this.alive(row) && row.app_id === actor.appId && row.tenant_key === actor.tenantKey && row.open_id === actor.openId &&
      row.created_at === actor.createdAt && row.expires_at === actor.expiresAt
  }

  csrfFor(actor: ConsoleActor): string | undefined {
    return this.isCurrent(actor) ? this.row(actor.sessionId)?.csrf_token : undefined
  }

  acceptsCsrf(actor: ConsoleActor, supplied: string): boolean {
    const expected = this.csrfFor(actor)
    return Boolean(expected && /^[A-Za-z0-9_-]{43}$/.test(supplied) && equal(expected, supplied))
  }

  revoke(sessionId: string): boolean {
    return Boolean(this.db.prepare('UPDATE console_sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(this.now(), sessionId).changes)
  }

  private row(id: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM console_sessions WHERE id=?').get(id) as unknown as SessionRow | undefined
  }

  private alive(row: SessionRow | undefined): row is SessionRow {
    const now = this.now()
    return Boolean(row && row.revoked_at === null && row.expires_at > now && row.last_seen_at + this.idleTimeoutMs > now)
  }
}

function actorOf(row: SessionRow): ConsoleActor {
  return { sessionId: row.id, appId: row.app_id, tenantKey: row.tenant_key, openId: row.open_id, name: row.name,
    createdAt: row.created_at, expiresAt: row.expires_at }
}
