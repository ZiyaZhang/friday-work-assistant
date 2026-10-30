import { afterEach, describe, expect, it } from 'vitest'
import { AUTH_EXPIRED } from '../../src/core/routines.js'
import { historyMsg } from '../helpers/fake-feishu.js'
import { acceptanceHost, closeAll } from './host.js'

afterEach(closeAll)

/** §11.4 关注群：授权过期 → 仅暂停实际受影响项 → 授权完成 → 保留手动暂停 → 从检查点接续；期间无假空结果、重复待办或重复报告。 */
describe('acceptance 04 · watched groups across an authorization expiry', () => {
  it('pauses only the watches that depend on the expired delegation, resumes them from their cursors after re-authorization, and never reports an empty window as a result', async () => {
    const t = await acceptanceHost()
    const dm = t.spaces.get(`dm:alice` as never) ?? t.spaces.ensure({ kind: 'p2p', chatId: 'dm-alice', openId: 'alice' })
    t.fake.nextToken = { accessToken: 'alice-token-1', expiresIn: 60, refreshToken: 'alice-refresh-1', refreshTokenExpiresIn: 60, scope: 'im:chat:readonly' }
    await t.userTokens.complete({ code: 'synthetic-code', state: t.userTokens.begin('alice'), redirectUri: t.cfg.feishu.oauth.redirectUri, openId: 'alice' })
    const watch = (name: string, runAs = 'alice', space = dm, everyMinutes = 60) => t.routines.add({ kind: 'watch', ownerOpenId: runAs, runAs, spaceId: space.id, chatId: space.chatId!, chatType: 'p2p',
      name, prompt: '总结合成群的新讨论，只报有意义的变化', schedule: { type: 'interval', everyMinutes }, watchChatIds: ['group'], now: created })
    // Routines created three hours ago with a cursor two hours ago: the watched window ends at the real present.
    const created = t.clock.now - 3 * 3600_000
    const active = watch('待恢复的盯群'), manual = watch('手动暂停的盯群')
    t.routines.setEnabled(manual.id, false, t.clock.now)
    const bobSpace = t.spaces.ensure({ kind: 'p2p', chatId: 'dm-bob', openId: 'bob' })
    t.fake.nextToken = { accessToken: 'bob-token', expiresIn: 7200, refreshToken: 'bob-refresh', refreshTokenExpiresIn: 30 * 86400, scope: 'im:chat:readonly' }
    await t.userTokens.complete({ code: 'synthetic-code-bob', state: t.userTokens.begin('bob'), redirectUri: t.cfg.feishu.oauth.redirectUri, openId: 'bob' })
    const bobs = watch('别人的盯群', 'bob', bobSpace, 24 * 60)
    // The scheduler's own entry: move the clock to the window and let it claim, start, run and finish the occurrence.
    const execute = async (id: number) => {
      const routine = t.routines.get(id)!
      if (routine.enabled) t.clock.now = Math.max(t.clock.now, routine.nextRunAt + 1000)
      const ran = await t.tick()
      const latest = t.db.prepare('SELECT status FROM routine_occurrences WHERE routine_id = ? ORDER BY id DESC LIMIT 1').get(id) as { status: string } | undefined
      return ran === 0 ? 'no_window' : latest?.status === 'done' ? 'ok' : latest?.status ?? 'unknown'
    }
    const cursor = Math.floor(created / 1000) + 3600
    expect(t.routines.advanceMessageCursor(active.id, t.routines.configVersion(active.id)!, Math.floor(created / 1000), cursor)).toBe(true)
    // Both tokens of alice expire; bob's delegation is untouched.
    t.clock.now += 61_000
    expect(t.userTokens.isConnected('alice')).toBe(false)
    expect(t.userTokens.isConnected('bob')).toBe(true)
    const sentBefore = t.fake.sent.length, promptsBefore = t.agent.state.allPrompts.length
    expect(await execute(active.id)).toBe('skipped')
    expect(t.routines.get(active.id)).toMatchObject({ enabled: false, disabledReason: AUTH_EXPIRED, messageCursorSec: cursor })
    expect(t.routines.get(manual.id)).toMatchObject({ enabled: false, disabledReason: '手动停用' })
    expect(t.routines.get(bobs.id)).toMatchObject({ enabled: true })
    // No model turn, no digest, no duplicate: exactly one authorization card to the person, and nothing to the group.
    expect(t.agent.state.allPrompts).toHaveLength(promptsBefore)
    const notices = t.fake.sent.slice(sentBefore)
    expect(notices.filter(item => item.kind === 'sendToUser' && item.target === 'alice')).toHaveLength(1)
    expect(notices.filter(item => item.kind === 'sendToChat' || item.kind === 'replyMarkdown' || item.kind === 'replyText')).toHaveLength(0)
    expect(await execute(active.id)).toBe('no_window')
    expect(t.fake.sent.slice(sentBefore).filter(item => item.kind === 'sendToUser' && item.target === 'alice')).toHaveLength(1)
    // Re-authorization resumes only the delegation-paused watch, keeps the manual pause, and leaves the cursor where it stopped.
    t.fake.nextToken = { accessToken: 'alice-token-2', expiresIn: 7200, refreshToken: 'alice-refresh-2', refreshTokenExpiresIn: 30 * 86400, scope: 'im:message:readonly im:message.group_msg:get_as_user' }
    t.fake.identities.set('alice-token-2', { openId: 'alice', name: '张三', tenantKey: 'tenant' })
    await t.userTokens.complete({ code: 'synthetic-renewal', state: t.userTokens.begin('alice'), redirectUri: t.cfg.feishu.oauth.redirectUri })
    // stillPaused counts delegation-paused watches that could not resume; the manual pause is a separate fact, checked below.
    expect(await t.host.resumeAuthorizedRoutines('alice')).toEqual({ connected: true, resumed: 1, stillPaused: 0 })
    expect(t.routines.get(active.id)).toMatchObject({ enabled: true, disabledReason: null, messageCursorSec: cursor })
    expect(t.routines.get(manual.id)).toMatchObject({ enabled: false, disabledReason: '手动停用' })
    // The next execution reads the watched group as the person, from the cursor onwards, and its cursor moves only over what was actually returned.
    t.fake.userChats.set('alice-token-2', [{ chatId: 'group', name: '合成群' } as never])
    t.fake.userHistories.set('group', [historyMsg({ messageId: 'om_new', chatId: 'group', text: '新的决定：周四发布', senderOpenId: 'bob', senderName: '李四', createTimeMs: (cursor + 600) * 1000 }),
      historyMsg({ messageId: 'om_before_cursor', chatId: 'group', text: '已经读过的旧消息', senderOpenId: 'bob', senderName: '李四', createTimeMs: (cursor - 600) * 1000 })])
    let read: Record<string, unknown> | undefined
    t.agent.state.script = [{ kind: 'hook', run: async () => {
      const page = await t.tool('chat/history', { chat: 'group', start_time: new Date(cursor * 1000).toISOString(), end_time: new Date().toISOString() })
      read = page.body
    } }, { kind: 'text', text: '合成群有新决定：周四发布。' }]
    expect(await execute(active.id)).toBe('ok')
    expect(read).toMatchObject({ items: [{ messageId: 'om_new' }], coverage_complete: true })
    const advanced = t.routines.get(active.id)!.messageCursorSec!
    expect(advanced).toBeGreaterThan(cursor); expect(advanced).toBeLessThanOrEqual(Math.floor(Date.now() / 1000))
    expect(t.fake.sent.filter(item => item.kind === 'sendToUser' && item.target === 'alice' && JSON.stringify(item.payload).includes('周四发布'))).toHaveLength(1)
  })
})
