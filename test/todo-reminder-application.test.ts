import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { TodoReminderApplication, todoReminderKey, type TodoReminderResult } from '../src/core/todo-reminder-application.js'
import { Todos, type ReminderStage } from '../src/core/todos.js'
import { postContent } from '../src/feishu/post.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const NOW = 1_800_000_000_000, HOUR = 3600_000
const closes: (() => void)[] = []
afterEach(() => { vi.restoreAllMocks(); for (const close of closes.splice(0).reverse()) close() })
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }

function fixture(path = ':memory:') {
  const registry = new Registry(path)
  closes.push(() => registry.close())
  const sp = spaceDeps(registry.db)
  const group = sp.spaces.ensure({ kind: 'group', chatId: 'chat-group', openId: 'alice' })
  const dm = sp.spaces.ensure({ kind: 'p2p', chatId: 'chat-dm', openId: 'alice' })
  if (!registry.getSession('origin')) registry.createSession({ sessionKey: 'origin', chatId: 'chat-group', chatType: 'group', requesterOpenId: 'someone-else', cwd: '/synthetic' })
  const todos = new Todos(registry.db), feishu = new FakeFeishu(), transitions: TodoReminderResult[] = []
  feishu.members.set('chat-group', new Set(['alice', 'bob']))
  let now = NOW
  const options = { db: registry.db, registry, todos, ...sp, feishu: asFeishuClient(feishu), now: () => now, onStateChange: (r: TodoReminderResult) => transitions.push(r) }
  const app = new TodoReminderApplication(options)
  const add = (patch: Partial<Parameters<Todos['add']>[0]> = {}) => todos.add({ scope: `space:${group.id}`, title: '合成待办', dueMs: NOW + 12 * HOUR, createdBy: 'alice', sessionKey: 'origin', ...patch })
  const record = (id: number, due: number, stage: ReminderStage = '24h') => registry.db.prepare('SELECT * FROM deliveries WHERE delivery_key = ?').get(todoReminderKey(id, due, stage))
  return { registry, ...sp, group, dm, todos, feishu, app, options, add, record, transitions, setNow: (value: number) => { now = value } }
}

describe('todo reminder application: actual Delivery receipts', () => {
  it('uses the actual deadline when first seen inside the 24h threshold, without numbered reply commands', async () => {
    const t = fixture(), todo = t.add({ title: '核对发布文案', dueMs: NOW + 30 * 60_000 })
    expect(await t.app.runDue()).toMatchObject({ sent: 1 })
    const body = JSON.stringify(t.feishu.sent[0]!.payload)
    const due = new Date(todo.dueMs!).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    expect(body).toContain(due)
    expect(body).toContain('截止（北京时间）')
    expect(body).not.toMatch(/明天|1 小时后|完成 #|卡在 xx|回“/)
    expect(await t.app.runDue()).toMatchObject({ sent: 0 })
  })
  it('delivers group and own DM once, preserving actual identity and receipt IDs', async () => {
    const t = fixture(), a = t.add(), b = t.add({ scope: `space:${t.dm.id}`, sessionKey: undefined })
    expect(await t.app.runDue()).toMatchObject({ sent: 2, attempted: 2 })
    expect(t.feishu.sent.map(s => [s.kind, s.target])).toEqual([['sendToChat', 'chat-group'], ['sendToUser', 'alice']])
    expect(t.record(a.id, a.dueMs!)).toMatchObject({ status: 'sent', actor_open_id: 'alice', remote_id: t.feishu.sent[0]!.messageId })
    expect(t.record(b.id, b.dueMs!)).toMatchObject({ status: 'sent', remote_id: t.feishu.sent[1]!.messageId })
    expect(t.todos.get(a.id)?.remindedStages).toEqual(['24h'])
    expect(await t.app.runDue()).toMatchObject({ sent: 0, attempted: 0 })
  })

  it('keeps an accepted-but-lost ACK unknown across stages, body changes and application restart', async () => {
    const t = fixture(), todo = t.add({ kind: 'freeze', dueMs: NOW + 5 * HOUR })
    const realSend = t.feishu.sendToChat.bind(t.feishu)
    vi.spyOn(t.feishu, 'sendToChat').mockImplementation(async (...args) => { await realSend(...args); throw new Error('synthetic lost ACK') })
    expect(await t.app.runDue()).toMatchObject({ attempted: 1, sent: 0, results: [expect.objectContaining({ status: 'unknown' })] })
    t.todos.update(todo.id, todo.scope, { title: '修改正文不产生新意图' })
    t.setNow(NOW + 4 * HOUR)
    const restarted = new TodoReminderApplication(t.options)
    expect(await restarted.runDue()).toMatchObject({ attempted: 0, results: [expect.objectContaining({ stage: '2h', status: 'unknown' })] })
    t.setNow(NOW + 6 * HOUR)
    expect((await restarted.runDue()).attempted).toBe(0)
    expect(t.feishu.sent).toHaveLength(1)
    expect(t.todos.get(todo.id)?.remindedStages).toEqual([])
    expect(t.record(todo.id, todo.dueMs!)?.status).toBe('unknown')
    expect(t.record(todo.id, todo.dueMs!, '2h')).toBeUndefined()
    expect(t.record(todo.id, todo.dueMs!, 'overdue')).toBeUndefined()
  })

  it('keeps an in-flight planned delivery from being bypassed by another scanner at a later stage', async () => {
    const t = fixture(), todo = t.add({ kind: 'freeze', dueMs: NOW + 5 * HOUR }), started = deferred(), ack = deferred()
    const real = t.feishu.sendToChat.bind(t.feishu)
    vi.spyOn(t.feishu, 'sendToChat').mockImplementation(async (...args) => { const id = await real(...args); started.resolve(); await ack.promise; return id })
    const first = t.app.runDue()
    await started.promise
    t.setNow(NOW + 4 * HOUR)
    expect(await new TodoReminderApplication(t.options).runDue()).toMatchObject({ sent: 0, attempted: 0, results: [expect.objectContaining({ status: 'unknown' })] })
    ack.resolve(); await first
    expect(t.feishu.sent).toHaveLength(1)
    expect(t.record(todo.id, todo.dueMs!, '2h')).toBeUndefined()
  })

  it('retains an old ACK but does not mark a changed due date, then delivers the new intent once', async () => {
    const t = fixture(), todo = t.add(), started = deferred(), ack = deferred()
    const real = t.feishu.sendToChat.bind(t.feishu)
    vi.spyOn(t.feishu, 'sendToChat').mockImplementationOnce(async (...args) => { const id = await real(...args); started.resolve(); await ack.promise; return id })
    const pending = t.app.runDue(); await started.promise
    t.todos.update(todo.id, todo.scope, { dueMs: NOW + 3 * HOUR })
    ack.resolve()
    expect(await pending).toMatchObject({ sent: 1, results: [expect.objectContaining({ status: 'sent', marked: false })] })
    expect(t.todos.get(todo.id)?.remindedStages).toEqual([])
    expect(t.record(todo.id, todo.dueMs!)).toMatchObject({ status: 'sent', remote_id: expect.any(String) })
    expect((await t.app.runDue()).sent).toBe(1)
    expect(t.feishu.sent).toHaveLength(2)
    expect(t.todos.get(todo.id)?.remindedStages).toEqual(['24h'])
  })

  it('recovers ACK-before-marker after SQLite reopen without posting or regenerating changed text', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'friday-reminder-ack-'))
    closes.push(() => rmSync(dir, { recursive: true, force: true }))
    const path = join(dir, 'db.sqlite'), t = fixture(path), todo = t.add()
    const marker = vi.spyOn(t.todos, 'acknowledgeReminder').mockImplementationOnce(() => { throw new Error('synthetic interruption after receipt') })
    expect(await t.app.runDue()).toMatchObject({ sent: 1, results: [expect.objectContaining({ marked: false, reason: 'marker_update_failed' })] })
    marker.mockRestore()
    expect(t.todos.get(todo.id)?.remindedStages).toEqual([])
    t.todos.update(todo.id, todo.scope, { title: '新的文字不会重发原意图' })
    const reopened = fixture(path)
    expect(await reopened.app.runDue()).toMatchObject({ sent: 0, recovered: 1, attempted: 0 })
    expect(reopened.feishu.sent).toEqual([])
    expect(reopened.todos.get(todo.id)?.remindedStages).toEqual(['24h'])
    expect(reopened.record(todo.id, todo.dueMs!)?.remote_id).toBe(t.feishu.sent[0]!.messageId)
  })

  it.each(['done', 'removed'])('retains the real receipt but never marks an item %s while its ACK was pending', async action => {
    const t = fixture(), todo = t.add(), started = deferred(), ack = deferred()
    const real = t.feishu.sendToChat.bind(t.feishu)
    vi.spyOn(t.feishu, 'sendToChat').mockImplementation(async (...args) => { const id = await real(...args); started.resolve(); await ack.promise; return id })
    const pending = t.app.runDue(); await started.promise
    if (action === 'done') t.todos.done(todo.id, todo.scope)
    else t.todos.remove(todo.id, todo.scope)
    ack.resolve()
    expect(await pending).toMatchObject({ sent: 1, results: [expect.objectContaining({ marked: false })] })
    expect(t.record(todo.id, todo.dueMs!)).toMatchObject({ status: 'sent', remote_id: t.feishu.sent[0]!.messageId })
    expect(t.todos.get(todo.id)?.remindedStages ?? []).toEqual([])
    expect((await t.app.runDue()).attempted).toBe(0)
    expect(t.feishu.sent).toHaveLength(1)
  })

  it('does not send a superseded stage when fresh membership await crosses the next reminder boundary', async () => {
    const t = fixture(), todo = t.add({ kind: 'freeze', dueMs: NOW + 5 * HOUR }), reading = deferred(), release = deferred()
    vi.spyOn(t.feishu, 'chatMemberOpenIds').mockImplementationOnce(async () => { reading.resolve(); await release.promise; return new Set(['alice']) })
    const pending = t.app.runDue(); await reading.promise
    t.setNow(NOW + 4 * HOUR); release.resolve()
    expect(await pending).toMatchObject({ attempted: 0, results: [expect.objectContaining({ status: 'stale', reason: 'stage_changed' })] })
    expect(t.record(todo.id, todo.dueMs!)).toBeUndefined()
    expect(await t.app.runDue()).toMatchObject({ attempted: 1, sent: 1 })
    expect(t.record(todo.id, todo.dueMs!, '2h')?.status).toBe('sent')
    expect(t.todos.get(todo.id)?.remindedStages).toEqual(['72h', '24h', '2h'])
  })

  it.each(['done', 'cancelled', 'removed', 'rescheduled', 'archived', 'rebound', 'role-revoked', 'text-changed'])('rejects %s during fresh membership await before any planned row or POST', async (action) => {
    const t = fixture(), todo = t.add(), reading = deferred(), release = deferred()
    vi.spyOn(t.feishu, 'chatMemberOpenIds').mockImplementation(async () => { reading.resolve(); await release.promise; return new Set(['alice']) })
    const pending = t.app.runDue(); await reading.promise
    if (action === 'done') t.todos.done(todo.id, todo.scope)
    if (action === 'cancelled') t.todos.transition(todo.id, todo.scope, 'cancelled')
    if (action === 'removed') t.todos.remove(todo.id, todo.scope)
    if (action === 'rescheduled') t.todos.update(todo.id, todo.scope, { dueMs: NOW + HOUR })
    if (action === 'archived') t.spaces.archive(t.group.id)
    if (action === 'rebound') t.spaces.rebind(t.group.id, 'different-chat')
    if (action === 'role-revoked') t.spaces.removeMember(t.group.id, 'alice')
    if (action === 'text-changed') t.todos.update(todo.id, todo.scope, { title: 'new title' })
    release.resolve()
    expect((await pending).attempted).toBe(0)
    expect(t.feishu.sent).toEqual([])
    expect(t.record(todo.id, todo.dueMs!)).toBeUndefined()
    expect(t.todos.get(todo.id)?.remindedStages ?? []).toEqual([])
  })

  it.each(['missing-creator', 'missing-origin', 'wrong-dm', 'legacy-unknown', 'left-group', 'lookup-failed'])('fails closed for %s without forging actor or successful reminder state', async (reason) => {
    const t = fixture()
    const todo = t.add(reason === 'missing-creator' ? { createdBy: undefined }
      : reason === 'missing-origin' ? { sessionKey: undefined }
        : reason === 'wrong-dm' ? { scope: `space:${t.dm.id}`, createdBy: 'bob' }
          : reason === 'legacy-unknown' ? { scope: 'circle:legacy' } : {})
    if (reason === 'left-group') t.feishu.members.set('chat-group', new Set(['bob']))
    if (reason === 'lookup-failed') vi.spyOn(t.feishu, 'chatMemberOpenIds').mockRejectedValue(new Error('synthetic lookup unavailable'))
    expect(await t.app.runDue()).toMatchObject({ attempted: 0, results: [expect.objectContaining({ status: 'unavailable' })] })
    expect(t.feishu.sent).toEqual([])
    expect(t.record(todo.id, todo.dueMs!)).toBeUndefined()
    expect(t.todos.get(todo.id)?.remindedStages).toEqual([])
  })

  it('preserves old stage markers and reaches valid rows beyond old reminded/undeliverable prefixes with a real POST limit', async () => {
    const t = fixture()
    for (let i = 0; i < 220; i++) { const old = t.add({ createdBy: undefined }); t.todos.markReminded(old.id, ['24h']) }
    for (let i = 0; i < 55; i++) t.add({ createdBy: undefined })
    const first = t.add(), second = t.add()
    const result = await t.app.runDue(1)
    expect(result).toMatchObject({ attempted: 1, sent: 1 })
    expect(t.todos.get(first.id)?.remindedStages).toEqual(['24h'])
    expect(t.todos.get(second.id)?.remindedStages).toEqual([])
    const transitions = t.transitions.filter(r => r.status === 'unavailable').length
    expect(transitions).toBe(55)
    expect(await t.app.runDue(1)).toMatchObject({ attempted: 1, sent: 1 })
    expect(t.transitions.filter(r => r.status === 'unavailable')).toHaveLength(transitions)
    expect(t.feishu.sent).toHaveLength(2)
    expect(t.registry.db.prepare('SELECT count(*) n FROM deliveries').get()?.n).toBe(2)
  })

  it('counts unknown POSTs against the batch limit; on the next scan that unresolved row does not starve another todo', async () => {
    const t = fixture(), a = t.add(), b = t.add()
    const real = t.feishu.sendToChat.bind(t.feishu)
    vi.spyOn(t.feishu, 'sendToChat').mockImplementationOnce(async (...args) => { await real(...args); throw new Error('lost ACK') })
    expect(await t.app.runDue(1)).toMatchObject({ attempted: 1, sent: 0 })
    expect(t.record(b.id, b.dueMs!)).toBeUndefined()
    expect(await t.app.runDue(1)).toMatchObject({ attempted: 1, sent: 1 })
    expect(t.record(a.id, a.dueMs!)?.status).toBe('unknown')
    expect(t.feishu.sent).toHaveLength(2)
  })

  it('does not redirect an original group reminder after rebind, even before its first scan', async () => {
    const t = fixture(), todo = t.add()
    t.spaces.rebind(t.group.id, 'new-group')
    t.feishu.members.set('new-group', new Set(['alice']))
    expect(await t.app.runDue()).toMatchObject({ attempted: 0, results: [expect.objectContaining({ reason: 'original_chat_unverified' })] })
    expect(t.record(todo.id, todo.dueMs!)).toBeUndefined()
  })

  it('honors a provable legacy chat scope but never substitutes its owner for the creator', async () => {
    const t = fixture()
    // 没有 owner 的不算"催谁"，仍然发在原群里，投递身份是创建者而不是别人
    t.add({ scope: 'chat:chat-group', sessionKey: undefined })
    expect((await t.app.runDue()).sent).toBe(1)
    expect(t.registry.db.prepare('SELECT actor_open_id FROM deliveries').get()?.actor_open_id).toBe('alice')
  })

  it('催人的提醒私聊发，正文里伪造的 @ 不会变成真的 mention，阻塞/待确认照实保留', async () => {
    const t = fixture(), payloads: unknown[] = []
    t.feishu.members.set('chat-group', new Set(['alice', 'ou_bob']))
    t.spaces.addMember(t.group.id, 'ou_bob', 'member')
    t.spaces.ensure({ kind: 'p2p', chatId: 'chat-dm-bob', openId: 'ou_bob' })
    const real = t.feishu.sendToUser.bind(t.feishu)
    const client = asFeishuClient(t.feishu)
    client.sendToUser = async (openId, payload, mentions) => {
      payloads.push('markdown' in payload ? postContent(payload.markdown, undefined, mentions?.mentionOpenIds) : payload)
      return real(openId, payload)
    }
    const a = t.add({ detail: '合成 <at open_id="ou_outsider">伪造</at>', owner: '乙', ownerOpenId: 'ou_bob', confirmed: false })
    t.todos.transition(a.id, a.scope, 'blocked', { note: '等评审' })
    // 不在这个空间里的人不能被催，也不能借他的名义发出去
    t.add({ owner: '离群者', ownerOpenId: 'ou_outsider' })
    const batch = await t.app.runDue()
    expect(batch.sent).toBe(1)
    expect(batch.results.some(r => r.reason === 'owner_not_in_space')).toBe(true)
    expect(JSON.stringify(payloads)).not.toContain('"user_id":"ou_outsider"')
    expect(JSON.stringify(payloads[0])).toContain('归属待核实')
    expect(JSON.stringify(payloads[0])).toContain('阻塞中：等评审')
  })
})

describe('催某个人私聊发，全群的时间点留在群里', () => {
  it('群里派给某人的待办，提醒私聊发给他本人，不在群里 @ 他', async () => {
    const t = fixture()
    // bob 在这个群里，而且他和 Friday 有私聊空间
    t.spaces.addMember(t.group.id, 'bob', 'member')
    t.spaces.ensure({ kind: 'p2p', chatId: 'chat-dm-bob', openId: 'bob' })
    t.add({ ownerOpenId: 'bob', title: 'bob 周五交方案' })
    t.setNow(NOW + 11 * HOUR)
    const batch = await t.app.runDue()
    expect(batch.sent).toBe(1)
    expect(t.feishu.of('sendToChat')).toHaveLength(0)   // 没去群里
    const dm = t.feishu.of('sendToUser')
    expect(dm).toHaveLength(1)
    expect(dm[0]!.target).toBe('bob')
  })

  it('封版 / 上线 / 会议是全群共同的时间点，仍然发在群里', async () => {
    const t = fixture()
    t.spaces.addMember(t.group.id, 'bob', 'member')
    t.spaces.ensure({ kind: 'p2p', chatId: 'chat-dm-bob', openId: 'bob' })
    t.add({ ownerOpenId: 'bob', kind: 'freeze', title: '9/25 18:00 封版' })
    t.setNow(NOW + 11 * HOUR)
    const batch = await t.app.runDue()
    expect(batch.sent).toBe(1)
    expect(t.feishu.of('sendToChat')).toHaveLength(1)
    expect(t.feishu.of('sendToUser')).toHaveLength(0)
  })

  it('负责人没有私聊空间就不发，也不退回群里催他', async () => {
    const t = fixture()
    t.spaces.addMember(t.group.id, 'bob', 'member')
    t.add({ ownerOpenId: 'bob', title: 'bob 周五交方案' })
    t.setNow(NOW + 11 * HOUR)
    const batch = await t.app.runDue()
    expect(batch.sent).toBe(0)
    expect(t.feishu.of('sendToChat')).toHaveLength(0)
    expect(t.feishu.of('sendToUser')).toHaveLength(0)
    expect(batch.results[0]).toMatchObject({ status: 'unavailable', reason: 'owner_dm_unavailable' })
  })

  it('没有指定负责人的待办不算催谁，照旧发在群里', async () => {
    const t = fixture()
    t.add({ title: '这件事还没人认领' })
    t.setNow(NOW + 11 * HOUR)
    const batch = await t.app.runDue()
    expect(batch.sent).toBe(1)
    expect(t.feishu.of('sendToChat')).toHaveLength(1)
  })
})
