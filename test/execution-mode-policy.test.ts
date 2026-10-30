import { describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.js'
import { selectExecutionMode } from '../src/core/execution-mode-policy.js'

describe('host execution admission policy', () => {
  it.each(['workspace', 'managed'] as const)('preserves %s for internal deployments and administrator interactive work', defaultMode => {
    for (const unattended of [false, true]) for (const admin of [false, true]) {
      expect(selectExecutionMode({ publicMode: false, defaultMode, unattended, requesterOpenId: 'alice', isAdmin: () => admin })).toBe(defaultMode)
    }
    expect(selectExecutionMode({ publicMode: true, defaultMode, unattended: false, requesterOpenId: 'alice', isAdmin: () => true })).toBe(defaultMode)
  })

  it.each([true, false])('public background work cannot borrow its sponsor admin=%s privilege', admin => {
    expect(selectExecutionMode({ publicMode: true, defaultMode: 'workspace', unattended: true, requesterOpenId: 'alice', isAdmin: () => admin })).toBe('managed')
  })

  it('requires managed for ordinary users and unknown actors regardless of ownership or execution permission', () => {
    const isAdmin = vi.fn(() => false)
    expect(selectExecutionMode({ publicMode: true, defaultMode: 'workspace', unattended: false, requesterOpenId: 'alice', isAdmin })).toBe('managed')
    expect(selectExecutionMode({ publicMode: true, defaultMode: 'workspace', unattended: false, isAdmin: () => true })).toBe('managed')
    expect(isAdmin).toHaveBeenCalledExactlyOnceWith('alice')
  })

  it('uses current administrator authority instead of retaining a prior answer', () => {
    let admin = true
    const input = { publicMode: true, defaultMode: 'workspace' as const, unattended: false, requesterOpenId: 'alice', isAdmin: () => admin }
    expect(selectExecutionMode(input)).toBe('workspace'); admin = false; expect(selectExecutionMode(input)).toBe('managed')
  })
})

describe('FRIDAY_PUBLIC_MODE configuration', () => {
  const env = { FEISHU_APP_ID: 'synthetic-app', FEISHU_APP_SECRET: 'synthetic-secret' }
  it('is opt-in and retains the internal workspace default', () => {
    const cfg = loadConfig(env)
    expect(cfg.publicMode).toBe(false); expect(cfg.dsh.executionMode).toBe('workspace')
  })
  it.each([['true', true], ['1', true], ['false', false], ['0', false]] as const)('reads %s explicitly', (raw, expected) => {
    expect(loadConfig({ ...env, FRIDAY_PUBLIC_MODE: raw }).publicMode).toBe(expected)
  })
  it('rejects an unknown public-mode value instead of quietly exposing workspace execution', () => {
    expect(() => loadConfig({ ...env, FRIDAY_PUBLIC_MODE: 'ture' })).toThrow('FRIDAY_PUBLIC_MODE')
  })
})
