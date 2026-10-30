import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Registry } from '../src/core/registry.js'
import type { InboundMessage } from '../src/feishu/mention.js'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
function setup(chatType: 'p2p' | 'group' = 'p2p') {
  const dir = mkdtempSync(join(tmpdir(), 'friday-recent-works-')), registry = new Registry(join(dir, 'db'))
  cleanups.push(() => { registry.close(); rmSync(dir, { recursive: true, force: true }) })
  const session = (key = 'session', chatId = 'chat', actor = 'alice', threadId?: string) => registry.createSession({ sessionKey: key, chatId,
    chatType, cwd: dir, requesterOpenId: actor, threadId })
  session()
  let serial = 0
  const task = (options: { sessionKey?: string; actor?: string; amendsTaskId?: number; status?: 'done' | 'failed' | 'running' | 'cancelled'; stopReason?: string } = {}) => {
    const s = registry.getSession(options.sessionKey ?? 'session')!, actor = options.actor ?? 'alice'
    const inbound: InboundMessage = { messageId: `m${++serial}`, eventId: `e${serial}`, chatId: s.chatId, chatType, text: `human ${serial}`,
      senderType: 'user', senderOpenId: actor, msgType: 'text', mentions: [], createTimeMs: Date.now() }
    const t = registry.createTaskOnce({ sessionKey: s.sessionKey, requesterOpenId: actor, messageId: inbound.messageId,
      prompt: inbound.text, inbound, amendsTaskId: options.amendsTaskId }).task
    registry.updateTask(t.id, { status: options.status ?? 'done', stopReason: options.stopReason })
    return registry.getTask(t.id)!
  }
  const list = (over: Partial<Parameters<Registry['listRecentInboundWorkTargets']>[0]> = {}) => registry.listRecentInboundWorkTargets({
    chatId: 'chat', chatType, actorOpenId: 'alice', sessionKey: 'session', ...over })
  return { registry, session, task, list }
}

describe('recent human work target query', () => {
  it('is bounded newest-first after deduplicating each work root, even with many amendments', () => {
    const t = setup(), roots = Array.from({ length: 10 }, () => t.task())
    let latest = roots[0]!
    for (let i = 0; i < 20; i++) latest = t.task({ amendsTaskId: latest.id })
    expect(t.list().map(task => task.id)).toEqual([latest.id, ...roots.slice(-5).reverse().map(task => task.id)])
    expect(new Set(t.list().map(task => t.registry.taskWork.get(task.id)!.key)).size).toBe(6)
  })
  it('filters identity, chat and archived sessions before limiting', () => {
    const t = setup(), mine = t.task()
    t.session('other-chat', 'elsewhere'); t.task({ sessionKey: 'other-chat' })
    t.session('other-actor', 'chat', 'bob'); t.task({ sessionKey: 'other-actor', actor: 'bob' })
    t.session('archived'); t.task({ sessionKey: 'archived' }); t.registry.updateSession('archived', { status: 'archived' })
    expect(t.list({ limit: 1 }).map(task => task.id)).toEqual([mine.id])
  })
  it('requires an original real user receipt and a matching persistent inbound envelope', () => {
    const t = setup(), valid = t.task(), malformed = t.task(), wrongActor = t.task()
    t.registry.createTaskOnce({ sessionKey: 'session', messageId: 'synthetic', requesterOpenId: 'alice', prompt: 'system task' })
    t.registry.db.prepare('UPDATE task_dispatches SET inbound=? WHERE task_id=?').run('invalid JSON', malformed.id)
    t.registry.db.prepare("UPDATE task_dispatches SET inbound=json_set(inbound,'$.senderOpenId','bob') WHERE task_id=?").run(wrongActor.id)
    expect(t.list().map(task => task.id)).toEqual([valid.id])
  })
  it('does not fall back to an older completed input when the latest input was cancelled or is active', () => {
    const t = setup(), first = t.task(), second = t.task()
    t.task({ amendsTaskId: first.id, status: 'cancelled', stopReason: 'user_requested' })
    t.task({ amendsTaskId: second.id, status: 'running' })
    expect(t.list()).toEqual([])
  })
  it('does not revive a completed or cancelled delegation from an old successful attempt', () => {
    const t = setup(), completed = t.task(), cancelled = t.task()
    t.registry.workContexts.control(t.registry.taskWork.get(completed.id)!.key, { action: 'complete', causeRef: 'human' })
    t.registry.workContexts.control(t.registry.taskWork.get(cancelled.id)!.key, { action: 'cancel', causeRef: 'human' })
    expect(t.list()).toEqual([])
  })
  it('keeps group candidates within the current Session or explicit shared topic', () => {
    const t = setup('group'), original = t.task()
    t.session('same-topic', 'chat', 'alice', 'thread-a'); const same = t.task({ sessionKey: 'same-topic' })
    t.session('other-topic', 'chat', 'alice', 'thread-b'); t.task({ sessionKey: 'other-topic' })
    expect(t.list().map(task => task.id)).toEqual([original.id])
    expect(t.list({ threadId: 'thread-a' }).map(task => task.id)).toEqual([same.id, original.id])
  })
})
