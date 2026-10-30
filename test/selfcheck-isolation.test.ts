import { afterEach, describe, expect, it } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { collectSelfCheck, renderSelfCheck } from '../src/core/selfcheck.js'

const registries: Registry[] = []
afterEach(() => { for (const r of registries.splice(0)) r.close() })

function setup() {
  const registry = new Registry(':memory:')
  registries.push(registry)
  const add = (sessionKey: string, chatId: string, chatType: 'group' | 'p2p', requester: string, taskRequester = requester) => {
    registry.createSession({ sessionKey, chatId, chatType, requesterOpenId: requester, cwd: '/unused' })
    const task = registry.createTask({ sessionKey, messageId: `message-${sessionKey}`, requesterOpenId: taskRequester, prompt: `prompt-${sessionKey}` })
    registry.updateTask(task.id, { status: 'failed', error: `error-${sessionKey}`, startedAt: 1000, finishedAt: 4000 })
    return task
  }
  add('group-a-1', 'chat-a', 'group', 'alice')
  add('group-a-2', 'chat-a', 'group', 'bob')
  add('group-b', 'chat-b', 'group', 'alice')
  add('dm-alice', 'dm-chat', 'p2p', 'alice')
  add('dm-bob', 'dm-chat', 'p2p', 'bob')
  add('dm-mismatched-task', 'dm-chat', 'p2p', 'alice', 'bob')
  registry.createTask({ sessionKey: 'no-session', messageId: 'orphan', prompt: 'orphan-secret' })
  return registry
}

describe('selfcheck only reads the authorized conversation', () => {
  it('keeps every topic in the current group, excluding other groups and DMs', () => {
    const registry = setup()
    const facts = collectSelfCheck(registry.db, 0, Date.now() + 1, { chatId: 'chat-a', chatType: 'group' })
    expect(facts.total).toBe(2)
    expect(facts.bad.map((t) => t.sessionKey).sort()).toEqual(['group-a-1', 'group-a-2'])
    const text = renderSelfCheck(facts, 'Friday')
    expect(text).not.toContain('prompt-group-b')
    expect(text).not.toContain('dm-')
    expect(text).not.toContain('orphan-secret')
  })

  it('requires both the private session owner and task requester to match', () => {
    const registry = setup()
    const facts = collectSelfCheck(registry.db, 0, Date.now() + 1, { chatId: 'dm-chat', chatType: 'p2p', requesterOpenId: 'alice' })
    expect(facts.total).toBe(1)
    expect(facts.bad.map((t) => t.sessionKey)).toEqual(['dm-alice'])
    const text = renderSelfCheck(facts, 'Friday')
    expect(text).not.toContain('bob')
    expect(text).not.toContain('mismatched')
    expect(text).not.toContain('group-')
  })

  it('fails closed when the caller scope or private identity is missing', () => {
    const registry = setup()
    expect(collectSelfCheck(registry.db, 0, Date.now() + 1).total).toBe(0)
    expect(collectSelfCheck(registry.db, 0, Date.now() + 1, { chatId: 'dm-chat', chatType: 'p2p' }).total).toBe(0)
    expect(collectSelfCheck(registry.db, 0, Date.now() + 1, { chatId: '', chatType: 'group' }).total).toBe(0)
  })

  it('intersects an optional session with the chat boundary instead of overriding it', () => {
    const registry = setup()
    const scope = { chatId: 'chat-a', chatType: 'group' as const }
    expect(collectSelfCheck(registry.db, 0, Date.now() + 1, { ...scope, sessionKey: 'group-a-1' }).total).toBe(1)
    expect(collectSelfCheck(registry.db, 0, Date.now() + 1, { ...scope, sessionKey: 'group-b' }).total).toBe(0)
    expect(collectSelfCheck(registry.db, 0, Date.now() + 1, { ...scope, sessionKey: 'dm-alice' }).total).toBe(0)
  })
})
