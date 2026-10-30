import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChannelMemory } from '../src/core/memory.js'
import { deliverCorrectedMemory, deliverForgottenMemory } from '../src/core/memory-receipt.js'
import { Registry } from '../src/core/registry.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const registries: Registry[] = []
afterEach(() => { for (const registry of registries.splice(0)) registry.close() })
function setup(kind: 'group' | 'p2p' = 'group') {
  const registry = new Registry(':memory:'); registries.push(registry)
  const memory = new ChannelMemory(registry.db), sp = spaceDeps(registry.db), fake = new FakeFeishu()
  const space = sp.spaces.ensure({ kind, chatId: 'chat', openId: 'alice' })
  const note = memory.add({ scope: `space:${space.id}`, kind: 'fact', title: 'OLD PRIVATE TITLE', body: 'OLD PRIVATE BODY' })
  memory.remove(note.id, note.scope)
  fake.members.set('chat', new Set(['alice']))
  const input = { noteId: note.id, runId: 'old-invalidated-run', changedScope: note.scope, spaceId: space.id, chatId: 'chat', chatType: kind,
    actorOpenId: 'alice', messageId: 'human-message', threadId: kind === 'group' ? 'topic' : undefined }
  const run = () => deliverForgottenMemory({ registry, memory, ...sp, feishu: asFeishuClient(fake), now: () => 1_800_000_000_000 }, input)
  return { registry, memory, ...sp, fake, space, note, input, run }
}

describe('committed memory control receipt', () => {
  it.each(['group', 'p2p'] as const)('delivers the fixed deletion fact once in %s, without any forgotten content', async kind => {
    const t = setup(kind)
    expect(await t.run()).toMatchObject({ status: 'sent', replayed: false })
    expect(await t.run()).toMatchObject({ status: 'sent', replayed: true })
    expect(t.fake.sent).toHaveLength(1)
    const delivered = JSON.stringify(t.fake.sent)
    expect(delivered).toContain('已删除这条记忆。')
    expect(delivered).not.toContain('OLD PRIVATE')
    expect(t.fake.sent[0]?.target).toBe(kind === 'group' ? 'human-message' : 'chat')
  })

  it('checks fresh group membership despite a retained local owner role', async () => {
    const t = setup(); t.fake.members.set('chat', new Set())
    const read = vi.spyOn(t.fake, 'chatMemberOpenIds')
    await expect(t.run()).rejects.toMatchObject({ code: 'denied' })
    expect(read).toHaveBeenCalledWith('chat', { fresh: true })
    expect(t.fake.sent).toHaveLength(0)
  })

  it('rechecks the space after the membership request completes', async () => {
    const t = setup()
    vi.spyOn(t.fake, 'chatMemberOpenIds').mockImplementationOnce(async () => {
      t.spaces.archive(t.space.id)
      return new Set(['alice'])
    })
    await expect(t.run()).rejects.toMatchObject({ code: 'denied' })
    expect(t.fake.sent).toHaveLength(0)
  })

  it('keeps an uncertain remote result and does not resend on retry', async () => {
    const t = setup()
    const send = vi.spyOn(t.fake, 'replyText').mockRejectedValue(new Error('connection lost after remote acceptance'))
    await expect(t.run()).rejects.toMatchObject({ code: 'unknown' })
    await expect(t.run()).rejects.toMatchObject({ code: 'unknown' })
    expect(send).toHaveBeenCalledTimes(1)
    expect(t.registry.db.prepare('SELECT status FROM deliveries').get()).toMatchObject({ status: 'unknown' })
  })

  it('does not acknowledge a tombstone belonging to another space', async () => {
    const t = setup(), other = t.spaces.ensure({ kind: 'group', chatId: 'other', openId: 'alice' })
    t.input.spaceId = other.id
    await expect(t.run()).rejects.toThrow('没有对应的记忆删除记录')
    expect(t.fake.sent).toHaveLength(0)
  })

  it('does not disclose another Space candidate merely by naming its changed scope', async () => {
    const t = setup(), other = t.spaces.ensure({ kind: 'group', chatId: 'other', openId: 'alice' })
    const note = t.memory.add({ scope: `space:${other.id}`, kind: 'fact', title: 'FOREIGN TITLE', body: 'FOREIGN BODY' })
    await expect(deliverCorrectedMemory({ registry: t.registry, memory: t.memory, spaces: t.spaces, policy: t.policy,
      circles: t.circles, feishu: asFeishuClient(t.fake), now: Date.now }, { ...t.input, noteId: note.id, changedScope: note.scope }))
      .rejects.toThrow('没有对应的候选更正记录')
    expect(t.fake.sent).toHaveLength(0)
  })

  it('rechecks the shared layer after waiting for membership, without granting access to a different Circle', async () => {
    const t = setup()
    t.circles.join('chat', 'synthetic-circle', 'alice')
    const note = t.memory.add({ scope: 'circle:synthetic-circle', kind: 'fact', title: 'SHARED TITLE', body: 'SHARED BODY' })
    vi.spyOn(t.fake, 'chatMemberOpenIds').mockImplementationOnce(async () => {
      t.circles.join('chat', 'different-circle', 'alice')
      return new Set(['alice'])
    })
    await expect(deliverCorrectedMemory({ registry: t.registry, memory: t.memory, spaces: t.spaces, policy: t.policy,
      circles: t.circles, feishu: asFeishuClient(t.fake), now: Date.now }, { ...t.input, noteId: note.id, changedScope: note.scope }))
      .rejects.toMatchObject({ code: 'denied' })
    expect(t.fake.sent).toHaveLength(0)
  })
})
