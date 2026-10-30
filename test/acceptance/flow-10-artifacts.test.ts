import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { acceptanceHost, closeAll } from './host.js'

afterEach(closeAll)

/**
 * §11.10 产物和边界：原型交付回到原话题并只给原受众；发送只能取自本次工作区；私信只到发起人。
 * Opening the prototype in a browser, clicking through it, narrow-screen screenshots and native read/network probes of the
 * execution environment are real-machine checks and stay marked 待验 in the acceptance record.
 */
describe('acceptance 10 · artifacts and boundaries', () => {
  it('delivers a generated prototype to the origin topic from the Run workspace only, refuses paths outside it, and lets a Run message no one but the person who asked', async () => {
    const t = await acceptanceHost()
    const outside = join(t.home, 'outside-secret.html')
    writeFileSync(outside, '<html>SECRET_OUTSIDE</html>')
    const results: Record<string, { status: number; body: Record<string, unknown> }> = {}
    const { task } = await t.run([{ kind: 'hook', run: async () => {
      const cwd = [...t.agent.state.sessions.values()].at(-1)!.cwd
      mkdirSync(join(cwd, 'artifacts'), { recursive: true })
      writeFileSync(join(cwd, 'artifacts', 'prototype.html'), '<html><body><button>试一下</button></body></html>')
      results.prototype = await t.tool('file/send', { path: 'artifacts/prototype.html', note: '原型在这里，点按钮试试' })
      results.escape = await t.tool('file/send', { path: '../outside-secret.html' })
      results.absolute = await t.tool('file/send', { path: outside })
      results.dm = await t.tool('dm', { text: '给你私信发了一份' })
    } }, { kind: 'text', text: '原型已发在话题里。' }])
    expect(task?.status).toBe('done')
    expect(results.prototype!.status).toBe(200)
    expect([403, 404]).toContain(results.escape!.status)
    expect(results.absolute!.status).toBe(403)
    // The prototype went once to the origin topic; nothing from outside the workspace was ever uploaded.
    const files = t.fake.sent.filter(item => item.kind === 'replyFile')
    expect(files).toHaveLength(1)
    expect(files[0]!.target).toBe(task!.messageId)
    expect(t.fake.sent.filter(item => item.kind === 'sendFileToChat' || item.kind === 'sendFileToUser')).toHaveLength(0)
    expect(JSON.stringify(t.fake.sent)).not.toContain('SECRET_OUTSIDE')
    // A Run can only message the person who asked, never a third party or another chat.
    expect(results.dm).toMatchObject({ status: 200, body: { to: 'alice' } })
    const dms = t.fake.sent.filter(item => item.kind === 'sendToUser')
    expect(dms.map(item => item.target)).toEqual(['alice'])
    // Every outgoing artifact has a ledger row bound to this Task; the audience is the origin space.
    const ledger = t.db.prepare("SELECT delivery_key, status, audience FROM deliveries WHERE delivery_key LIKE ? AND delivery_key LIKE '%:tool:%'").all(`task:${task!.id}:%`) as { delivery_key: string; status: string; audience: string }[]
    expect(ledger.length).toBeGreaterThanOrEqual(2)
    expect(ledger.every(row => row.status === 'sent')).toBe(true)
    expect(ledger.filter(row => row.delivery_key.includes(':tool:here:')).every(row => JSON.parse(row.audience).spaceId === t.group.id)).toBe(true)
  })
})
