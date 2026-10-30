import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Registry } from '../../src/core/registry.js'
import { RunAttempts } from '../../src/core/run-attempts.js'
import { RunApiCalls } from '../../src/core/run-api-calls.js'
import { RuntimeContexts } from '../../src/core/runtime-contexts.js'
import { SourceContexts } from '../../src/core/source-context.js'
import { MeetingSessions } from '../../src/core/meeting-sessions.js'
import { meetingSource } from '../../src/core/meeting-source.js'
import { MeetingRuntime, type MeetingRuntimeBinding } from '../../src/core/meeting-runtime.js'
import { Todos } from '../../src/core/todos.js'
import { spaceScope } from '../../src/core/space.js'
import { materialProvenanceCovers, type MaterialProvenance } from '../../src/core/execution-materials.js'
import { ExecutionMaterialRuntime } from '../../src/core/execution-material-runtime.js'
import { spaceDeps } from './space.js'
import { FakeFeishu, asFeishuClient } from './fake-feishu.js'
import type { MeetingEvent } from '../../src/feishu/meetings.js'
import { TaskEvents } from '../../src/core/task-events.js'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).reverse().forEach(close => close()) })
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
export function meetingRuntimeFixture() {
  const home = mkdtempSync(join(tmpdir(), 'friday-meeting-runtime-')), registry = new Registry(join(home, 'db'))
  cleanups.push(() => { registry.close(); rmSync(home, { recursive: true, force: true }) })
  const sp = spaceDeps(registry.db), dm = sp.spaces.ensure({ kind: 'p2p', chatId: 'dm-alice', openId: 'alice' })
  registry.createSession({ sessionKey: 'session-a', chatId: dm.chatId!, chatType: 'p2p', cwd: home, requesterOpenId: 'alice' })
  const inbound = { eventId: 'event-a', messageId: 'message-a', chatId: dm.chatId!, chatType: 'p2p' as const,
    senderOpenId: 'alice', senderType: 'user' as const, msgType: 'text', text: 'Join the synthetic meeting for me.', mentions: [], createTimeMs: 1 }
  const { task } = registry.createTaskOnce({ sessionKey: 'session-a', messageId: inbound.messageId, requesterOpenId: 'alice', prompt: inbound.text, inbound })
  const attempts = new RunAttempts(registry.db), calls = new RunApiCalls(registry.db), contexts = new RuntimeContexts(registry.db)
  const run = attempts.begin({ sessionKey: 'session-a', workKey: registry.taskWork.get(task.id)!.key, triggerKey: inbound.messageId,
    taskId: task.id, stage: 'task', actorOpenId: 'alice', now: 1 })!
  attempts.bindRuntime(run.id, 'acp-a'); contexts.bind(run.id, run.sessionKey, 'acp-a')
  registry.updateTask(task.id, { status: 'running' })
  const sources = new SourceContexts(registry), sessions = new MeetingSessions(registry.db), todos = new Todos(registry.db)
  const state = { current: true, authorized: true, sourceRevision: 1, sourceStatus: 'allowed' as 'allowed' | 'denied' | 'unavailable',
    beforeSource: undefined as (() => Promise<void>) | undefined, beforeSend: undefined as (() => Promise<void>) | undefined }
  const assertCurrent = () => { if (!state.current) throw new Error('host stopped') }
  const binding: MeetingRuntimeBinding = { sessionKey: run.sessionKey, runId: run.id, taskId: task.id, workKey: run.workKey,
    openId: 'alice', acpSessionId: 'acp-a', spaceId: dm.id, chatId: dm.chatId!, chatType: 'p2p', reviewSpaceId: dm.id, reviewChatId: dm.chatId!, assertCurrent }
  sources.initialize(binding, [spaceScope(dm.id)])
  const taskEvents = new TaskEvents(registry)
  const fake = new FakeFeishu(), feishu = asFeishuClient(fake), queueDraft = vi.fn((session, key, prompt) => taskEvents.admit({ key, kind: 'meeting_draft',
    sourceTaskId: session.origin.taskId, targetSessionKey: session.origin.sessionKey, domainId: session.id, prompt })), approvals = vi.fn(async () => ({ decision: state.authorized ? 'allow' : 'deny', requestId: 'approval-a' }))
  const events: MeetingEvent[] = [{ id: 'joined', type: 'participant_joined', joined: [{ participant: { id: 'bot' } }], left: [], transcripts: [], messages: [], shared: [] },
    { id: 'ended', type: 'participant_left', joined: [], left: [{ participant: { id: 'bot' }, reason: 2 }], transcripts: [{ text: 'Synthetic facts', speaker: { id: 'alice' } }], messages: [], shared: [] }]
  const provider = { join: vi.fn(async () => ({ meetingId: 'meeting-a', botParticipantId: 'bot' })), leave: vi.fn(async () => ({ participantId: 'bot' })),
    events: vi.fn(async () => ({ events, hasMore: false })), activeForUser: vi.fn(async () => [{ meetingId: 'meeting-a' }]) }
  const authorized: MaterialProvenance[] = []
  const runtime = new MeetingRuntime({ registry, attempts, contexts, calls, sources, sessions, todos, ...sp, provider,
    feishu: { sendToUser: async (actor, payload) => { await state.beforeSend?.(); return feishu.sendToUser(actor, payload) } },
    binding: ref => { if (ref.runId !== binding.runId || ref.sessionKey !== binding.sessionKey) throw new Error('wrong binding'); return binding },
    approve: approvals, async authorizeSavedContext(proof, _origin, check) {
      const revision = state.sourceRevision; authorized.push(structuredClone(proof)); await state.beforeSource?.(); check()
      const guard = () => { check(); if (revision !== state.sourceRevision) throw new Error('source changed') }
      return state.sourceStatus === 'allowed' ? { status: 'allowed', assertCurrent: guard } : { status: state.sourceStatus, reason: 'synthetic_access_failure', assertCurrent: guard }
    }, resolveDelivery: async (_ref, session, guard) => { guard(); return { actorOpenId: session.origin.ownerOpenId,
      audience: { kind: 'dm', spaceId: dm.id, openId: 'alice' }, sources: [{ ref: 'meeting-snapshot', spaceId: dm.id, chatId: dm.chatId }],
      provenanceComplete: true, expiresAt: Date.now() + 60_000, isCurrent: () => { guard(); return true } } },
    queueDraft, assertLifecycleCurrent: assertCurrent })
  const ref = { sessionKey: run.sessionKey, runId: run.id }
  const end = async () => { const joined = await runtime.application.join(ref, { meetingNumber: '123456789' }); await runtime.application.sync(ref, { sessionId: joined.sessionId }); return joined.sessionId }
  const startEvent = (taskId: number) => {
    const event = taskEvents.get(taskId)!, eventTask = registry.getTask(taskId)!, lease = taskEvents.lease(taskId)!
    lease(); attempts.finish(binding.runId, 'completed', Date.now()); registry.updateTask(binding.taskId, { status: 'done' })
    const next = attempts.begin({ workKey: registry.taskWork.get(taskId)!.key, sessionKey: event.targetSessionKey,
      triggerKey: event.key, taskId, stage: 'task', actorOpenId: eventTask.requesterOpenId!, now: Date.now() })!
    attempts.bindRuntime(next.id, `acp:${next.id}`); contexts.bind(next.id, next.sessionKey, `acp:${next.id}`)
    Object.assign(binding, { runId: next.id, taskId, sessionKey: next.sessionKey, workKey: next.workKey, acpSessionId: `acp:${next.id}`,
      assertCurrent: () => { assertCurrent(); lease() } })
    sources.initialize(binding, [spaceScope(dm.id)]); registry.updateTask(taskId, { status: 'running' })
    return next
  }
  return { home, registry, sp, dm, task, run, ref, attempts, contexts, calls, sources, sessions, todos, binding, state, fake, provider, approvals, queueDraft, runtime, end, authorized, taskEvents, startEvent }
}
