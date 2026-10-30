import { describe, expect, it } from 'vitest'
import { meetingRuntimeFixture } from './helpers/meeting-runtime.js'
import { meetingSource } from '../src/core/meeting-source.js'
import { spaceScope } from '../src/core/space.js'
import { materialProvenanceCovers, type MaterialProvenance } from '../src/core/execution-materials.js'
import { ExecutionMaterialRuntime } from '../src/core/execution-material-runtime.js'
import { TaskEvents, validTaskEventDispatch } from '../src/core/task-events.js'
import { Registry } from '../src/core/registry.js'
import { join } from 'node:path'
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

describe('meeting host runtime composition', () => {
  it('admits the observed end as a durable host event in the same Work and never revives a paused parent', async () => {
    const t = meetingRuntimeFixture(), id = await t.end()
    const first = t.queueDraft.mock.results[0]!.value, event = t.taskEvents.get(first.task.id)!
    expect(first.created).toBe(true)
    expect(t.registry.taskWork.get(first.task.id)?.key).toBe(t.run.workKey)
    const dispatch = t.registry.dispatches.get(first.task.id)!
    expect(dispatch.inbound.senderType).toBe('bot')
    expect(dispatch.inbound.messageId).toBe(first.task.messageId)
    expect(validTaskEventDispatch(t.registry.db, first.task.id, dispatch.inbound)).toBe(true)
    expect(t.registry.db.prepare('SELECT kind FROM work_inputs WHERE task_id=?').get(first.task.id)?.kind).toBe('evidence')
    await t.runtime.tick()
    expect(t.queueDraft.mock.results[1]!.value).toMatchObject({ created: false, task: { id: first.task.id } })
    const reopened = new Registry(join(t.home, 'db'))
    try {
      expect(new TaskEvents(reopened).get(first.task.id)).toEqual(event)
      expect(reopened.dispatches.pending().some(value => value.taskId === first.task.id && value.inbound.senderType === 'bot')).toBe(true)
    } finally { reopened.close() }
    const lease = t.taskEvents.lease(first.task.id)!
    t.registry.workContexts.control(t.run.workKey, { action: 'pause', reason: 'run_stop', causeRef: 'user-stop' })
    expect(() => lease()).toThrow()
    expect(validTaskEventDispatch(t.registry.db, first.task.id, dispatch.inbound)).toBe(false)
    expect(() => t.taskEvents.admit({ key: 'different-observation', kind: 'meeting_draft', sourceTaskId: t.task.id,
      targetSessionKey: t.ref.sessionKey, domainId: id, prompt: 'Another event' })).toThrow()
    expect(t.registry.workContexts.get(t.run.workKey)?.pauseReasons).toContainEqual({ reason: 'run_stop', causeRef: 'user-stop' })
  })
  it('uses real Task/Run authority, exact approval, Delivery ACK and owner confirmation before writing Todos', async () => {
    const t = meetingRuntimeFixture(), id = await t.end()
    expect(t.approvals).toHaveBeenCalledWith(expect.objectContaining({ operation: 'join', meetingNumber: '123456789', actorOpenId: 'alice' }))
    await t.runtime.application.join(t.ref, { meetingNumber: '123456789' })
    expect(t.provider.join).toHaveBeenCalledTimes(1); expect(t.approvals).toHaveBeenCalledTimes(1)
    const source = meetingSource(t.sessions.get(id)!)
    const read = await t.runtime.application.read(t.ref, { sessionId: id })
    expect(read.contextHints?.request).toMatchObject({ text: t.task.prompt, messageId: t.task.messageId, linkStatus: 'not_resolved' })
    expect(read.contextHints).not.toHaveProperty('memoryScopes')
    expect(t.queueDraft).toHaveBeenCalledWith(expect.objectContaining({ id }), expect.stringContaining(id), expect.stringContaining('friday_read_meeting'), source)
    const result = await t.runtime.application.proposeDraft(t.ref, { sessionId: id, summary: '实际取得的合成事实。'.repeat(500),
      actions: [{ title: 'My action', ownerOpenId: 'alice', detail: 'One real action' }, { title: 'Proposed action for another participant', owner: 'Other person' }] })
    expect(result.reviewDelivered).toBe(true); expect(t.todos.list(spaceScope(t.dm.id))).toEqual([])
    const d = t.sessions.draft(result.draftId)!
    expect(t.fake.sent.length).toBeGreaterThan(2); expect(t.fake.sent.every(value => value.target === 'alice')).toBe(true)
    expect(t.registry.db.prepare("SELECT count(*) AS n FROM deliveries WHERE status='sent'").get()!.n).toBe(t.fake.sent.length)
    const accepted = await t.runtime.application.decideDraft({ draftId: d.id, digest: d.digest, decision: 'accept', operatorOpenId: 'alice', chatId: t.dm.chatId!, messageId: d.reviewMessageId! }, () => {})
    expect(accepted.todoIds).toHaveLength(2)
    const [mine, other] = accepted.todoIds.map(todoId => t.todos.get(todoId)!)
    expect(mine?.confirmed).toBe(true); expect(other?.confirmed).toBe(false)
    expect(t.todos.getProvenance(mine!.id)?.contextSnapshot.meetingSources).toEqual([source])
    expect(t.todos.getProvenance(mine!.id)?.request).toBeNull()
    expect(t.authorized.at(-1)?.sources.meetingSources).toEqual([])
    expect(t.registry.taskWork.get(t.task.id)?.key).toBe(t.run.workKey)
  })

  it('rejects source denial, receipt changes, cross-audience and stopped runs without writing or delivering', async () => {
    const t = meetingRuntimeFixture(), id = await t.end(), source = meetingSource(t.sessions.get(id)!)
    const audience = { openId: 'alice', spaceId: t.dm.id, chatId: t.dm.chatId!, chatType: 'p2p' as const }
    const allowed = await t.runtime.checkSources([source], audience, () => {})
    expect(allowed.status).toBe('allowed')
    expect((await t.runtime.checkSources([source], { ...audience, chatType: 'group' }, () => {})).status).toBe('denied')
    expect((await t.runtime.checkSources([source], { ...audience, openId: 'bob' }, () => {})).status).toBe('denied')
    expect((await t.runtime.checkSources([{ ...source, eventsDigest: 'wrong' }], audience, () => {})).status).toBe('denied')
    t.state.sourceStatus = 'unavailable'
    expect(await t.runtime.checkSources([source], audience, () => {})).toMatchObject({ status: 'unavailable', reason: 'synthetic_access_failure' })
    t.state.sourceStatus = 'allowed'; t.state.sourceRevision++
    expect(() => allowed.assertCurrent()).toThrow('source changed')
    t.state.current = false
    await expect(t.runtime.application.read(t.ref, { sessionId: id })).rejects.toThrow('host stopped')
    expect(t.fake.sent).toEqual([])
  })

  it('rechecks exact meeting source after awaited authorization and retains its lease through final delivery', async () => {
    const t = meetingRuntimeFixture(), id = await t.end(), source = meetingSource(t.sessions.get(id)!), blocked = deferred(), entered = deferred()
    t.state.beforeSource = async () => { entered.resolve(); await blocked.promise }
    const result = t.runtime.checkSources([source], { openId: 'alice', spaceId: t.dm.id, chatId: t.dm.chatId!, chatType: 'p2p' }, () => {})
    await entered.promise; t.sessions.revoke(id); blocked.resolve()
    await expect(result).rejects.toMatchObject({ code: 'changed' })
    expect(t.fake.sent).toEqual([])
  })

  it('does not issue confirmation when full text delivery is unknown, or repeat a POST after a late cancellation', async () => {
    const t = meetingRuntimeFixture(), id = await t.end(), blocked = deferred(), entered = deferred()
    t.state.beforeSend = async () => { entered.resolve(); await blocked.promise }
    const pending = t.runtime.application.proposeDraft(t.ref, { sessionId: id, summary: 'Full review body', actions: [{ title: 'Not yet committed' }] })
    await entered.promise; t.state.current = false; blocked.resolve()
    await expect(pending).rejects.toThrow('host stopped')
    expect(t.fake.sent).toHaveLength(1)
    expect(t.sessions.get(id)?.currentDraftId).toBeTruthy()
    expect(t.sessions.draft(t.sessions.get(id)!.currentDraftId!)?.reviewMessageId).toBeUndefined()
    expect(t.todos.list(spaceScope(t.dm.id))).toEqual([])
    expect(t.registry.db.prepare('SELECT status FROM deliveries').get()?.status).toBe('sent')
  })

  it('revalidates draft-only extra sources at acceptance, independently of the original meeting context', async () => {
    const t = meetingRuntimeFixture(), id = await t.end()
    t.sources.addExternal(t.ref.sessionKey, { kind: 'document', ref: 'extra-private-document', personalOpenId: 'alice', access: 'user' })
    const proposed = await t.runtime.application.proposeDraft(t.ref, { sessionId: id, summary: 'Draft using additional context', actions: [{ title: 'Action' }] })
    const d = t.sessions.draft(proposed.draftId)!
    expect(t.sessions.get(id)!.context.sources.external).toEqual([])
    t.state.sourceStatus = 'denied'
    await expect(t.runtime.application.decideDraft({ draftId: d.id, digest: d.digest, decision: 'accept', operatorOpenId: 'alice', chatId: t.dm.chatId!, messageId: d.reviewMessageId! }, () => {})).rejects.toMatchObject({ code: 'denied' })
    expect(t.todos.list(spaceScope(t.dm.id))).toEqual([])
    t.state.sourceStatus = 'allowed'
    await t.runtime.application.decideDraft({ draftId: d.id, digest: d.digest, decision: 'accept', operatorOpenId: 'alice', chatId: t.dm.chatId!, messageId: d.reviewMessageId! }, () => {})
    expect(t.authorized.at(-1)?.sources.external.map(item => item.ref)).toEqual(['extra-private-document'])
  })

  it('keeps meeting provenance on consumed/derived managed files and rejects a transformation that drops it', async () => {
    const t = meetingRuntimeFixture(), id = await t.end(), source = meetingSource(t.sessions.get(id)!)
    const proof: MaterialProvenance = { sources: { ...t.sources.get(t.ref.sessionKey)!, meetingSources: [source] }, memoryRefs: [] }
    const material = new ExecutionMaterialRuntime({ sources: t.sources, contexts: t.contexts,
      access: { check: async () => ({ status: 'allowed', assertCurrent: () => {} }) }, binding: () => ({ ...t.binding,
        mode: 'managed', readScopes: () => [spaceScope(t.dm.id)], deliver: async () => { throw new Error('not used') } }) })
    material.resolve(t.run.id).consume(proof); material.resolve(t.run.id).consume(proof)
    expect(t.sources.get(t.ref.sessionKey)?.meetingSources).toEqual([source])
    const dropped = structuredClone(proof); delete dropped.sources.meetingSources
    expect(materialProvenanceCovers(dropped, proof)).toBe(false)
    expect(materialProvenanceCovers(proof, dropped)).toBe(true)
  })
})
