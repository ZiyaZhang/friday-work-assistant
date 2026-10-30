import type { DatabaseSync } from 'node:sqlite'

export type OAuthAttemptState = 'pending' | 'exchanging' | 'connected' | 'denied' | 'expired' | 'superseded' | 'failed' | 'interrupted'
export interface OAuthAttempt { state: string; openId: string; expiresAt: number; status: OAuthAttemptState }

/** One current authorization attempt per person. Codes and tokens are never stored here. */
export class OAuthAttempts {
  constructor(private readonly db: DatabaseSync, private readonly now: () => number) {
    db.exec(`CREATE TABLE IF NOT EXISTS oauth_attempts (
      state TEXT PRIMARY KEY,
      open_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','exchanging','connected','denied','expired','superseded','failed','interrupted')),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_current_attempt ON oauth_attempts(open_id)
      WHERE status IN ('pending','exchanging');`)
  }

  begin(state: string, openId: string, expiresAt: number): void {
    this.db.exec('SAVEPOINT begin_oauth_attempt')
    try {
      this.invalidate(openId)
      this.db.prepare("INSERT INTO oauth_attempts (state,open_id,status,created_at,expires_at,updated_at) VALUES (?,?,'pending',?,?,?)")
        .run(state, openId, this.now(), expiresAt, this.now())
      this.db.exec('RELEASE SAVEPOINT begin_oauth_attempt')
    } catch (error) {
      this.db.exec('ROLLBACK TO SAVEPOINT begin_oauth_attempt; RELEASE SAVEPOINT begin_oauth_attempt')
      throw error
    }
  }

  get(state: string): OAuthAttempt | undefined {
    return this.db.prepare('SELECT state,open_id AS openId,expires_at AS expiresAt,status FROM oauth_attempts WHERE state=?')
      .get(state) as unknown as OAuthAttempt | undefined
  }

  owner(state: string): string | undefined {
    const attempt = this.get(state)
    return attempt?.status === 'pending' && attempt.expiresAt > this.now() ? attempt.openId : undefined
  }

  /** Synchronous claim precedes exchanging a one-use code with the provider. */
  claim(state: string, openId: string): boolean {
    return Boolean(this.db.prepare("UPDATE oauth_attempts SET status='exchanging',updated_at=? WHERE state=? AND open_id=? AND status='pending' AND expires_at>?")
      .run(this.now(), state, openId, this.now()).changes)
  }

  isExchanging(state: string, openId: string): boolean {
    const attempt = this.get(state)
    return attempt?.status === 'exchanging' && attempt.openId === openId
  }

  finish(state: string, status: 'connected' | 'failed'): boolean {
    return Boolean(this.db.prepare("UPDATE oauth_attempts SET status=?,updated_at=? WHERE state=? AND status='exchanging'")
      .run(status, this.now(), state).changes)
  }

  deny(state: string): boolean {
    return Boolean(this.db.prepare("UPDATE oauth_attempts SET status='denied',updated_at=? WHERE state=? AND status='pending'")
      .run(this.now(), state).changes)
  }

  invalidate(openId: string): void {
    this.db.prepare("UPDATE oauth_attempts SET status='superseded',updated_at=? WHERE open_id=? AND status IN ('pending','exchanging')")
      .run(this.now(), openId)
  }

  /** After the gateway lock: a code exchange interrupted by a crash is never replayed. */
  recover(): OAuthAttempt[] {
    this.db.prepare("UPDATE oauth_attempts SET status='interrupted',updated_at=? WHERE status='exchanging'").run(this.now())
    this.db.prepare("UPDATE oauth_attempts SET status='expired',updated_at=? WHERE status='pending' AND expires_at<=?").run(this.now(), this.now())
    return this.db.prepare("SELECT state,open_id AS openId,expires_at AS expiresAt,status FROM oauth_attempts WHERE status='pending' ORDER BY created_at")
      .all() as unknown as OAuthAttempt[]
  }
}
