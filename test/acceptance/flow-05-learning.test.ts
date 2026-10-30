import { afterEach, describe, expect, it } from 'vitest'
import { historyMsg } from '../helpers/fake-feishu.js'
import { acceptanceHost, closeAll } from './host.js'

afterEach(closeAll)

/**
 * §11.5 学习：自动候选 → 本人明确纠正 → 生效 → 换新会话仍正确 → 来源失效后不能继续引用；明确忘记的内容不复活。
 * Workspace mode (production default) refuses to turn another group's material into local memory at all; the managed-mode
 * personal-memory path is covered by test/personal-memory-*.test.ts.
 */
describe('acceptance 05 · learning that stays tied to the person and the source', () => {
  it('a model candidate is applied only after the person confirms, is seen by later sessions, claims no unverified source, and does not come back after an explicit forget', async () => {
    const t = await acceptanceHost(), scope = `space:${t.group.id}`
    t.fake.histories.set('group', [historyMsg({ messageId: 'om_decision', chatId: 'group', text: '这期周三发布', senderOpenId: 'bob', senderName: '李四', createTimeMs: Date.now() - 3_600_000 })])
    // 1. A Run reads this group's own history and records a candidate; the candidate is not a fact yet.
    let candidate!: { id: number; status: string }
    await t.run([{ kind: 'hook', run: async () => {
      // The group's own recent history also holds this request message once it is cached; the decision must be among the items.
      expect((await t.tool<{ items: { messageId: string }[] }>('chat/history', { hours_back: 24 })).body.items).toContainEqual(expect.objectContaining({ messageId: 'om_decision' }))
      const saved = await t.tool<{ note: { id: number; status: string }; confirmation_command: string }>('memory/save', { title: '发布日期', body: '这期周三发布', kind: 'fact' })
      expect(saved.status).toBe(200); candidate = saved.body.note
      expect(saved.body.confirmation_command).toBeUndefined()
    } }, { kind: 'text', text: '记下了：这期周三发布。' }], { text: '@Friday 群里定了哪天发布？' })
    expect(t.memory.get(candidate.id)).toMatchObject({ status: 'candidate', scope })
    // 2. The person corrects it in a new request; the correction supersedes the candidate and only the person's command confirms it.
    let corrected!: { id: number }
    await t.run([{ kind: 'hook', run: async () => {
      const saved = await t.tool<{ note: { id: number }; replacement: { id: number; status: string } }>('memory/save', { title: '发布日期', body: '改到周四发布', kind: 'fact', replaces: candidate.id })
      expect(saved.status).toBe(200); corrected = saved.body.note
      expect(saved.body.replacement).toEqual({ id: candidate.id, status: 'applied' })
    } }, { kind: 'text', text: '已更正为周四。' }], { text: '@Friday 不对，改到周四了', threadId: 'topic-2' })
    expect(t.memory.get(candidate.id)?.status).toBe('superseded')
    expect(t.memory.get(corrected.id)?.status).toBe('candidate')
    // First show the host-owned full version in this topic, then acknowledge that exact display.
    await t.host.handleMessage(t.message({ text: `@Friday /memory confirm ${corrected.id}`, threadId: 'topic-2' }))
    expect(t.memory.get(corrected.id)?.status).toBe('candidate')
    await t.host.handleMessage(t.message({ text: `@Friday /memory confirm ${corrected.id}`, threadId: 'topic-2' }))
    expect(t.memory.get(corrected.id)).toMatchObject({ status: 'confirmed' })
    // 3. A later session in another topic sees the confirmed fact and never the superseded wording.
    const search = async (topic: string) => {
      // Automatic question/answer candidates of earlier turns are their own records; the flow is about the fact.
      let notes: { id: number; body: string; kind: string }[] = []
      await t.run([{ kind: 'hook', run: async () => { notes = (await t.tool<{ notes: { id: number; body: string; kind: string }[] }>('memory/search', { query: '发布' })).body.notes.filter(note => note.kind === 'fact') } },
        { kind: 'text', text: '按记录回答。' }], { text: '@Friday 发布日期是？', threadId: topic })
      return notes
    }
    expect((await search('topic-3')).map(note => note.body)).toEqual(['改到周四发布'])
    // 4. Workspace-mode notes carry no verified message source (the runtime's inputs are not fully observed), so a recall of the
    //    group message neither invalidates them nor is claimed as their provenance; exact-source invalidation belongs to verified
    //    (managed) reads and is covered by test/memory-source-invalidation.test.ts.
    expect(t.db.prepare('SELECT state, sources_json FROM memory_provenance WHERE note_id = ?').get(corrected.id)).toEqual({ state: 'legacy_unverified', sources_json: '[]' })
    t.host.handleRecall({ messageId: 'om_decision', chatId: 'group', raw: {} })
    expect(t.memory.get(corrected.id)?.status).toBe('confirmed')
    expect((await search('topic-4')).map(note => note.body)).toEqual(['改到周四发布'])
    // 5. An explicit forget is final: a later session does not see the note and a fresh candidate is a new record, not a revival.
    let forgotten = false
    await t.run([{ kind: 'hook', run: async () => { forgotten = (await t.tool('memory/forget', { id: corrected.id })).status === 200 } }, { kind: 'text', text: '已忘记。' }], { text: '@Friday 把发布日期那条忘掉', threadId: 'topic-5' })
    expect(forgotten).toBe(true)
    expect(t.memory.get(corrected.id)).toBeUndefined()
    expect(await search('topic-6')).toEqual([])
    let again!: { id: number }
    await t.run([{ kind: 'hook', run: async () => { again = (await t.tool<{ note: { id: number } }>('memory/save', { title: '发布日期', body: '周四发布', kind: 'fact' })).body.note } },
      { kind: 'text', text: '重新记下。' }], { text: '@Friday 记一下：周四发布', threadId: 'topic-7' })
    expect(again.id).toBeGreaterThan(corrected.id)
    expect(t.memory.get(again.id)?.status).toBe('candidate')
  })

  it('workspace mode never turns another group\'s material read as the person into local memory', async () => {
    const t = await acceptanceHost()
    t.fake.nextToken = { accessToken: 'alice-token', expiresIn: 7200, refreshToken: 'alice-refresh', refreshTokenExpiresIn: 30 * 86400, scope: 'im:message:readonly im:message.group_msg:get_as_user' }
    t.fake.identities.set('alice-token', { openId: 'alice', name: '张三', tenantKey: 'tenant' })
    t.fake.userChats.set('alice-token', [{ chatId: 'group', name: '合成群' } as never])
    t.fake.userHistories.set('group', [historyMsg({ messageId: 'om_decision', chatId: 'group', text: '这期周三发布', senderOpenId: 'bob', senderName: '李四', createTimeMs: Date.now() - 3_600_000 })])
    await t.userTokens.complete({ code: 'synthetic-code', state: t.userTokens.begin('alice'), redirectUri: t.cfg.feishu.oauth.redirectUri, openId: 'alice' })
    let saved!: { status: number; body: { error?: string } }
    await t.run([{ kind: 'hook', run: async () => {
      expect((await t.tool('chat/history', { chat: 'group', hours_back: 24 })).body).toMatchObject({ items: [{ messageId: 'om_decision' }] })
      saved = await t.tool('memory/save', { title: '发布日期', body: '这期周三发布', kind: 'fact' })
    } }, { kind: 'text', text: '群里说这期周三发布。' }], t.dm({ text: '群里定了哪天发布？' }))
    expect(saved.status).toBe(403)
    expect(saved.body.error).toContain('这一轮已经读过别的群')
    expect(t.memory.recent(`space:${t.spaces.get('dm:alice' as never)?.id ?? ''}`)).toEqual([])
    // The answer itself still reaches the person in the DM; only the durable memory write is refused.
    expect(t.fake.answers().join('\n')).toContain('周三发布')
  })
})
