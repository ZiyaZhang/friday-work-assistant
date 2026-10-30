import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { UserTokenStore, type OAuthProvider } from '../src/feishu/oauth.js'

function fixture() {
  const db = new DatabaseSync(':memory:')
  let now = 1000, sequence = 0
  const provider: OAuthProvider = {
    exchangeCode: vi.fn(async (code: string) => ({ accessToken: `synthetic-${code}`, scope: 'scope-current' })),
    refresh: vi.fn(async () => ({ accessToken: 'synthetic-refreshed' })),
  }
  const make = () => new UserTokenStore(db, provider, () => now, () => `synthetic-state-${++sequence}`)
  return { db, provider, make, store: make(), setNow: (value: number) => { now = value } }
}

describe('durable personal authorization attempts', () => {
  it('restores an unexpired pending card after gateway restart and exchanges it exactly once', async () => {
    const t = fixture(), state = t.store.begin('alice'), restarted = t.make()
    expect(restarted.recoverAuthorizations()).toEqual([{ state, openId: 'alice', expiresAt: 601000, status: 'pending' }])
    expect(restarted.ownerOfState(state)).toBe('alice')
    await restarted.complete({ state, code: 'one', redirectUri: 'synthetic-redirect' })
    await expect(t.store.complete({ state, code: 'one', redirectUri: 'synthetic-redirect' })).resolves.toMatchObject({ openId: 'alice', accessToken: 'synthetic-one' })
    expect(t.provider.exchangeCode).toHaveBeenCalledTimes(1)
  })

  it('supersedes earlier unused cards, so an old serial callback cannot replace the latest grant', async () => {
    const t = fixture(), earlier = t.store.begin('alice'), latest = t.store.begin('alice')
    await t.store.complete({ state: latest, code: 'new', redirectUri: 'synthetic-redirect' })
    await expect(t.store.complete({ state: earlier, code: 'old', redirectUri: 'synthetic-redirect' })).rejects.toThrow('已经使用')
    expect(t.store.get('alice')?.accessToken).toBe('synthetic-new')
    expect(t.provider.exchangeCode).toHaveBeenCalledTimes(1)
  })

  it('an old completed callback cannot claim success for a replacement or disconnected grant', async () => {
    const t = fixture(), earlier = t.store.begin('alice')
    await t.store.complete({ state: earlier, code: 'old', redirectUri: 'synthetic-redirect' })
    const latest = t.store.begin('alice')
    await t.store.complete({ state: latest, code: 'new', redirectUri: 'synthetic-redirect' })
    await expect(t.store.complete({ state: earlier, code: 'old', redirectUri: 'synthetic-redirect' })).rejects.toThrow('已经使用')
    t.store.disconnect('alice')
    await expect(t.store.complete({ state: latest, code: 'new', redirectUri: 'synthetic-redirect' })).rejects.toThrow('已经使用')
    expect(t.provider.exchangeCode).toHaveBeenCalledTimes(2)
  })

  it('a new card wins over an earlier in-flight identity verification', async () => {
    const t = fixture(), earlier = t.store.begin('alice')
    let release!: (identity: { openId: string }) => void
    const verifying = new Promise<{ openId: string }>(resolve => { release = resolve })
    let entered!: () => void
    const enteredVerification = new Promise<void>(resolve => { entered = resolve })
    const old = t.store.complete({ state: earlier, code: 'old', redirectUri: 'synthetic-redirect',
      verify: async () => { entered(); return verifying } })
    await enteredVerification
    const latest = t.store.begin('alice')
    await t.store.complete({ state: latest, code: 'new', redirectUri: 'synthetic-redirect' })
    release({ openId: 'alice' })
    await expect(old).rejects.toThrow('连接已变更')
    expect(t.store.get('alice')?.accessToken).toBe('synthetic-new')
  })

  it('disconnect invalidates a pending exchange across store instances', async () => {
    const t = fixture(), state = t.store.begin('alice')
    let release!: (value: { accessToken: string }) => void
    vi.mocked(t.provider.exchangeCode).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const pending = t.store.complete({ state, code: 'old', redirectUri: 'synthetic-redirect' })
    t.make().disconnect('alice')
    release({ accessToken: 'synthetic-late' })
    await expect(pending).rejects.toThrow('连接已变更')
    expect(t.store.get('alice')).toBeUndefined()
  })

  it('does not repeat an exchange whose result was lost during restart', async () => {
    const t = fixture(), state = t.store.begin('alice')
    t.db.prepare("UPDATE oauth_attempts SET status='exchanging' WHERE state=?").run(state)
    const restarted = t.make()
    expect(restarted.recoverAuthorizations()).toEqual([])
    await expect(restarted.complete({ state, code: 'possibly-consumed', redirectUri: 'synthetic-redirect' })).rejects.toThrow('已经使用')
    expect(t.provider.exchangeCode).not.toHaveBeenCalled()
    expect(t.db.prepare('SELECT status FROM oauth_attempts WHERE state=?').get(state)?.status).toBe('interrupted')
  })

  it('records denial once without removing a previous valid connection or blocking a new card', async () => {
    const t = fixture()
    await t.store.complete({ state: t.store.begin('alice'), code: 'existing', redirectUri: 'synthetic-redirect' })
    const state = t.store.begin('alice')
    expect(t.store.denyAuthorization(state)).toBe(true)
    expect(t.store.denyAuthorization(state)).toBe(false)
    expect(t.store.ownerOfState(state)).toBeUndefined()
    expect(t.store.get('alice')?.accessToken).toBe('synthetic-existing')
    expect(t.store.ownerOfState(t.store.begin('alice'))).toBe('alice')
  })

  it('expired cards stay unusable after restart, including the exact expiry boundary', () => {
    const t = fixture(), state = t.store.begin('alice')
    t.setNow(601000)
    const restarted = t.make()
    expect(restarted.ownerOfState(state)).toBeUndefined()
    expect(restarted.recoverAuthorizations()).toEqual([])
    expect(t.db.prepare('SELECT status FROM oauth_attempts WHERE state=?').get(state)?.status).toBe('expired')
  })

  it('commits token storage and successful attempt together', async () => {
    const t = fixture(), state = t.store.begin('alice')
    t.db.exec("CREATE TRIGGER fail_oauth_commit BEFORE UPDATE ON oauth_attempts WHEN NEW.status='connected' BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END")
    await expect(t.store.complete({ state, code: 'one', redirectUri: 'synthetic-redirect' })).rejects.toThrow('synthetic storage failure')
    expect(t.store.get('alice')).toBeUndefined()
    expect(t.db.prepare('SELECT status FROM oauth_attempts WHERE state=?').get(state)?.status).toBe('failed')
  })
})
