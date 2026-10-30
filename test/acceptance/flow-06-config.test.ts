import { afterEach, describe, expect, it } from 'vitest'
import { presentationTag } from '../../src/core/space-application.js'
import { acceptanceHost, closeAll } from './host.js'

afterEach(closeAll)

/** §11.6 配置：聊天与网页修改同一字段走同一应用操作；并发旧版本被拒；页面显示实际技能版本与模型状态。 */
describe('acceptance 06 · one configuration fact, several entry points', () => {
  it('applies a chat command and a console command to the same presentation field with the same CAS, refusing the stale version', async () => {
    const t = await acceptanceHost(), alice = t.login('alice')
    const overview = async (openId = 'alice') => (await t.queries.read(t.login(openId), t.group.id, 'overview')).body.data as Record<string, any>
    const initial = await overview()
    expect(initial).toMatchObject({ settings: { brevity: 'normal' }, canConfigure: true, models: { status: expect.any(String) }, skills: [] })
    const staleTag = initial.settingsTag as string
    // Chat entry: the same application operation, so the console's stored tag is now stale.
    const before = t.fake.sent.length
    await t.host.handleMessage(t.message({ text: '@Friday /space set brevity short' }))
    expect(t.texts(before).join('\n')).toContain('简短')
    expect(t.spaces.get(t.group.id)?.config.brevity).toBe('short')
    expect(t.agent.state.allPrompts).toHaveLength(0)
    const stale = t.commands.execute(alice, t.group.id, { operation: 'space.presentation', requestId: 'config_request_00001', expectedTag: staleTag, patch: { ack: 'none' } })
    await expect(stale).rejects.toMatchObject({ status: 409 })
    expect(t.spaces.get(t.group.id)?.config.ack ?? 'card').not.toBe('none')
    // Web entry with the current version succeeds, and both changes are visible as one fact.
    const current = presentationTag(t.spaces.get(t.group.id)!)
    const applied = await t.commands.execute(alice, t.group.id, { operation: 'space.presentation', requestId: 'config_request_00002', expectedTag: current, patch: { ack: 'none' } })
    expect(applied.body).toMatchObject({ replayed: false, appliedResult: { changed: true, state: 'updated', tag: expect.any(String) } })
    expect(t.spaces.get(t.group.id)?.config).toMatchObject({ brevity: 'short', ack: 'none' })
    const after = await overview()
    expect(after).toMatchObject({ settings: { brevity: 'short', statusFeedback: 'none' } })
    expect(after.settingsTag).not.toBe(staleTag)
    // A member without configure rights reads the same facts but cannot change them from either entry.
    expect(await overview('bob')).toMatchObject({ canConfigure: false, settings: { brevity: 'short' } })
    await expect(t.commands.execute(t.login('bob'), t.group.id, { operation: 'space.presentation', requestId: 'config_request_00003', expectedTag: after.settingsTag, patch: { brevity: 'detailed' } }))
      .rejects.toMatchObject({ status: 403 })
    const denied = t.fake.sent.length
    await t.host.handleMessage(t.message({ text: '@Friday /space set brevity detailed', senderOpenId: 'bob' }))
    expect(t.spaces.get(t.group.id)?.config.brevity).toBe('short')
    expect(t.texts(denied)).toHaveLength(1)
  })
})
