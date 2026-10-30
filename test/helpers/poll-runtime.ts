import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, vi } from 'vitest'
import { Registry } from '../../src/core/registry.js'
import { RunAttempts } from '../../src/core/run-attempts.js'
import { SourceContexts } from '../../src/core/source-context.js'
import { Polls, type PollOrigin } from '../../src/core/polls.js'
import { PollRuntime } from '../../src/core/poll-runtime.js'
import type { PollSourceReceipt } from '../../src/core/poll-source.js'
import { Bugs } from '../../src/core/bugs.js'
import { spaceScope } from '../../src/core/space.js'
import { spaceDeps } from './space.js'
import { FakeFeishu, asFeishuClient } from './fake-feishu.js'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).reverse().forEach(close => close()) })
export function pollRuntimeFixture() {
  const home = mkdtempSync(join(tmpdir(), 'friday-poll-runtime-')), registry = new Registry(join(home, 'db'))
  cleanups.push(() => { registry.close(); rmSync(home, { recursive: true, force: true }) })
  const sp = spaceDeps(registry.db), group = sp.spaces.ensure({ kind: 'group', chatId: 'synthetic-group', openId: 'alice' })
  sp.spaces.addMember(group.id, 'bob', 'member'); sp.spaces.addMember(group.id, 'carol', 'member')
  registry.createSession({ sessionKey: 'session-a', chatId: group.chatId!, chatType: 'group', cwd: home, requesterOpenId: 'alice' })
  const inbound = { eventId: 'event-a', messageId: 'message-a', chatId: group.chatId!, chatType: 'group' as const, senderOpenId: 'alice', senderType: 'user' as const,
    msgType: 'text', text: 'Ask the group which synthetic option they prefer.', mentions: [], createTimeMs: 1 }
  const { task } = registry.createTaskOnce({ sessionKey: 'session-a', messageId: inbound.messageId, requesterOpenId: 'alice', prompt: inbound.text, inbound })
  const attempts = new RunAttempts(registry.db), run = attempts.begin({ sessionKey: 'session-a', workKey: registry.taskWork.get(task.id)!.key, triggerKey: inbound.messageId,
    taskId: task.id, stage: 'task', actorOpenId: 'alice', now: 1 })!
  attempts.bindRuntime(run.id, 'acp-a'); registry.updateTask(task.id, { status: 'running' })
  const contexts = new SourceContexts(registry), sourceBinding = { sessionKey: run.sessionKey, runId: run.id, spaceId: group.id, chatId: group.chatId!, chatType: 'group' as const, acpSessionId: 'acp-a' }
  contexts.initialize(sourceBinding, [spaceScope(group.id)])
  const origin: PollOrigin = { runId: run.id, taskId: task.id, workKey: run.workKey, sessionKey: run.sessionKey, ownerOpenId: 'alice',
    spaceId: group.id, chatId: group.chatId!, chatType: 'group', requestMessageId: inbound.messageId }
  const context = { sources: contexts.get(run.sessionKey)!, memoryRefs: [] }
  const state = { live: true, sourceRevision: 1, sourceStatus: 'allowed' as 'allowed' | 'denied' | 'unavailable', now: Date.now(), failSend: false,
    beforeSource: undefined as (() => Promise<void>) | undefined, beforeMembers: undefined as (() => Promise<void>) | undefined,
    beforeName: undefined as (() => Promise<void>) | undefined, beforeSend: undefined as (() => Promise<void>) | undefined,
    audienceChat: group.chatId!, members: new Set(['alice', 'bob', 'carol']) }
  const current = () => { if (!state.live) throw new Error('host stopped') }
  const runCurrent = () => { current(); const active = attempts.get(run.id); if (active?.state !== 'running' || active.stage !== 'task' || active.actorOpenId !== origin.ownerOpenId) throw new Error('run changed') }
  const polls = new Polls(registry.db, () => state.now), bugs = new Bugs(registry.db), fake = new FakeFeishu(), feishu = asFeishuClient(fake), sources: PollSourceReceipt[] = []
  const send = vi.fn(async (chatId, payload) => { await state.beforeSend?.(); if (state.failSend) throw new Error('lost ACK'); return feishu.sendToChat(chatId, payload) })
  const runtime = new PollRuntime({ db: registry.db, polls, bugs, ...sp, now: () => state.now,
    feishu: { sendToChat: send, chatMemberOpenIds: async () => { await state.beforeMembers?.(); return state.members } },
    participantName: async id => { await state.beforeName?.(); const name = ({ alice: 'Alice', bob: 'Bob', carol: 'Carol' } as Record<string, string>)[id]; return name ? { status: 'known', name } : { status: 'unknown' } },
    binding(ref) { if (ref.runId !== origin.runId || ref.sessionKey !== origin.sessionKey) throw new Error('wrong Run'); return { origin: structuredClone(origin), provenance: structuredClone(context), assertCurrent: runCurrent } },
    async authorizeSavedContext(_context, _origin, guard) {
      const version = state.sourceRevision; await state.beforeSource?.(); guard()
      const check = () => { guard(); if (version !== state.sourceRevision) throw new Error('source changed') }
      return state.sourceStatus === 'allowed' ? { status: 'allowed', assertCurrent: check } : { status: state.sourceStatus, reason: 'synthetic_source_failure', assertCurrent: check }
    }, async resolveDelivery(_poll, _ref, guard) { guard(); return { actorOpenId: 'alice', audience: { kind: 'group', spaceId: group.id, chatId: state.audienceChat },
      sources: [{ ref: 'actual-origin', spaceId: group.id, chatId: group.chatId }], provenanceComplete: true, expiresAt: state.now + 60_000,
      isCurrent: () => { guard(); return true } } }, recordSource: (_ref, source) => { runCurrent(); sources.push(structuredClone(source)) }, assertLifecycleCurrent: current })
  const ref = { sessionKey: run.sessionKey, runId: run.id }, input = { question: 'Which approach should we discuss?', choices: ['Review existing evidence', 'Collect a new example'] }
  const open = () => runtime.create(ref, input)
  const vote = (id: string, optionId: string | null, eventTimeMicros = '1000000', actor = 'bob', eventId = `event:${eventTimeMicros}:${actor}`) => {
    const poll = polls.get(id)!; return runtime.vote({ pollId: id, digest: poll.contentDigest, messageId: poll.messageId!, chatId: group.chatId!,
      operatorOpenId: actor, optionId, eventId, eventTimeMicros }, current)
  }
  return { home, registry, sp, group, task, run, ref, attempts, origin, context, state, polls, bugs, runtime, fake, send, sources, input, open, vote, current }
}
