import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpRuntime } from '../src/acp/runtime.js'
import { loadConfig } from '../src/config.js'
import { Bugs } from '../src/core/bugs.js'
import { BugQuestions } from '../src/core/bug-questions.js'
import { FeedbackControl } from '../src/core/feedback-control.js'
import { FeedbackWorkContext } from '../src/core/feedback-work-context.js'
import { InboundMaterials } from '../src/core/inbound-materials.js'
import { ChannelMemory } from '../src/core/memory.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry, type TaskRow } from '../src/core/registry.js'
import { SourceContexts } from '../src/core/source-context.js'
import { TaskEvents } from '../src/core/task-events.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { createFakeAgent } from './helpers/fake-agent.js'
import { asFeishuClient, FakeFeishu, historyMsg } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const closes: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks() })

function fixture(independent = true) {
  const home = mkdtempSync(join(tmpdir(), 'friday-work-history-')), dbPath = join(home, 'state.sqlite')
  const registry = new Registry(dbPath), sp = spaceDeps(registry.db)
  const space = sp.spaces.ensure({ kind: 'p2p', chatId: 'dm', openId: 'alice' })
  const cwd = join(home, 'workspace'); mkdirSync(cwd)
  registry.createSession({ sessionKey: 'session', chatId: 'dm', chatType: 'p2p', requesterOpenId: 'alice', cwd })
  // This marker is written by createSessionFor(independent=true). Later Tasks
  // can still be independent Work roots inside that persisted Session.
  if (independent) registry.setKv('work-origin:session', 'original-independent-input')
  closes.push(() => { registry.close(); rmSync(home, { recursive: true, force: true }) })
  let serial = 0
  const task = (text: string, opts: { from?: number; queued?: boolean; inbound?: Partial<InboundMessage> } = {}) => {
    const id = `human-${++serial}`
    const inbound: InboundMessage = { eventId: id, messageId: id, chatId: 'dm', chatType: 'p2p', senderOpenId: 'alice',
      senderType: 'user', msgType: 'text', text, mentions: [], createTimeMs: Date.now(), ...opts.inbound }
    const row = registry.createTaskOnce({ sessionKey: 'session', messageId: id, requesterOpenId: 'alice', prompt: text,
      inbound, ...(opts.from === undefined ? {} : { workFromTaskId: opts.from }) }).task
    if (!opts.queued) registry.updateTask(row.id, { status: 'done', finishedAt: Date.now() })
    return { row: registry.getTask(row.id)!, inbound }
  }
  return { home, dbPath, registry, sp, space, cwd, task, materials: new InboundMaterials(registry) }
}

async function hostFixture(independent = true) {
  const t = fixture(independent), fake = new FakeFeishu(), log = createLogger('work-history-test', 'error')
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic', FEISHU_APP_SECRET: 'synthetic', FRIDAY_HOME: t.home,
    FRIDAY_REFLECT: 'off', FRIDAY_PROMPT_TIMEOUT_MS: '5000' })
  mkdirSync(cfg.workspace.root, { recursive: true })
  const { app, state } = createFakeAgent({ script: [{ kind: 'text', text: '已处理当前委托。' }] })
  const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: app },
    onPermission: async () => ({ outcome: { outcome: 'cancelled' } }), log })
  closes.push(async () => { await runtime.stop() })
  const host = new Orchestrator({ cfg, registry: t.registry, memory: new ChannelMemory(t.registry.db), ...t.sp,
    feishu: asFeishuClient(fake), runtime, tokens: new TokenIssuer('synthetic'),
    apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', botOpenId: 'bot', log })
  const forward = (body: string, opts: { from?: number } = {}) => {
    const input = t.task('[合并转发消息]', { ...opts, inbound: { msgType: 'merge_forward' } })
    fake.messages.set(input.inbound.messageId, historyMsg({ ...input.inbound, senderName: '合成用户' }))
    fake.forwarded.set(input.inbound.messageId, [historyMsg({ messageId: `${input.inbound.messageId}-child`, chatId: 'original-source', text: body })])
    return input
  }
  const execute = async (row: TaskRow) => {
    host.wakeQueuedTask(row.id)
    await vi.waitFor(() => expect(t.registry.getTask(row.id)?.status).not.toMatch(/queued|running/))
    expect(t.registry.getTask(row.id)).toMatchObject({ status: 'done', error: null })
    return state.allPrompts.at(-1)!.text
  }
  return { ...t, fake, runtime, state, host, forward, execute }
}

describe('implicit history is scoped to persisted Work', () => {
  it('queries only same-Work human receipts in chronological order and keeps navigation independent', () => {
    const t = fixture(), a = t.task('A original'), b = t.task('B unrelated')
    const a2 = t.task('A addition', { from: a.row.id })
    const event = new TaskEvents(t.registry).admit({ key: 'history-test-event', kind: 'issue_assessment', sourceTaskId: a.row.id,
      targetSessionKey: 'session', domainId: 'assessment', prompt: 'HOST EVENT IS NOT A HUMAN INPUT' }).task
    const current = t.task('A continues', { from: a2.row.id })
    expect(t.registry.listInboundWorkTasksBefore(current.row.id, 20).map(row => row.id)).toEqual([a.row.id, a2.row.id])
    expect(t.registry.listInboundWorkTasksBefore(current.row.id, 1).map(row => row.id)).toEqual([a2.row.id])
    expect(t.registry.listInboundWorkTasksBefore(b.row.id, 20)).toEqual([])
    expect(t.registry.listInboundWorkTasksBefore(999_999, 20)).toEqual([])
    expect(t.registry.listInboundTasksBefore('session', current.row.id, 20).map(row => row.id)).toContain(b.row.id)
    expect(t.registry.dispatches.get(event.id)?.inbound.senderType).toBe('bot')
  })

  it('retains same-Work history after reopening SQLite, without unrelated newer inputs exhausting the bound', () => {
    const t = fixture(), origin = t.task('original')
    for (let i = 0; i < 65; i++) t.task(`unrelated-${i}`)
    const current = t.task('continue original', { from: origin.row.id })
    const reopened = new Registry(t.dbPath)
    try { expect(reopened.listInboundWorkTasksBefore(current.row.id, 1).map(row => row.id)).toEqual([origin.row.id]) }
    finally { reopened.close() }
  })

  it('does not treat same-session old inputs or another Work selected references as current bound material', () => {
    const t = fixture(), source = t.task('resource', { inbound: { fileKey: 'supplied-file', msgType: 'file' } })
    const unrelated = t.task('work with selected resource'), current = t.task('independent work')
    t.materials.bind(unrelated.row, unrelated.inbound, [{ ref: 'selected', taskId: source.row.id, message: source.inbound }])
    expect(t.materials.boundToTask(current.row.id, source.inbound)).toBe(false)
    expect(t.materials.boundToTask(current.row.id, unrelated.inbound)).toBe(false)
    // Explicit reference grants only the selected material, not the other Work.
    t.materials.bind(current.row, current.inbound, [{ ref: 'explicit', taskId: source.row.id, message: source.inbound }])
    expect(t.materials.boundToTask(current.row.id, source.inbound)).toBe(true)
    expect(t.registry.taskWork.get(current.row.id)?.key).not.toBe(t.registry.taskWork.get(source.row.id)?.key)
  })

  it('carries explicitly selected material through later inputs of the same Work', () => {
    const t = fixture(), source = t.task('explicit cross-Work source'), origin = t.task('summarize selected source')
    t.materials.bind(origin.row, origin.inbound, [{ ref: 'explicit', taskId: source.row.id, message: source.inbound }])
    t.task('unrelated intervening Work')
    const current = t.task('continue summary', { from: origin.row.id })
    expect(t.materials.boundToTask(current.row.id, source.inbound)).toBe(true)
    expect(t.materials.boundToTask(current.row.id, origin.inbound)).toBe(true)
  })

  it('does not inject prior feedback from unrelated Work unless the host has an explicit reference', () => {
    const t = fixture(), bugs = new Bugs(t.registry.db), questions = new BugQuestions(t.registry.db, bugs)
    const feedback = new FeedbackControl(t.registry, bugs, questions)
    const context = new FeedbackWorkContext({ registry: t.registry, bugs, feedback, questions })
    const prior = t.task('prior feedback'), bucket = bugs.record({ spaceId: t.space.id, chatId: 'dm', messageId: prior.inbound.messageId,
      reporterOpenId: 'alice', title: 'OLD_WORK_FEEDBACK', text: prior.inbound.text }).bucket
    const current = t.task('independent request'), input = { taskId: current.row.id, sessionKey: 'session', spaceId: t.space.id,
      chatId: 'dm', chatType: 'p2p' as const, actorOpenId: 'alice', scopes: ['bug:read'] }
    expect(context.read(input).feedback).toEqual([])
    expect(context.read({ ...input, referencedTaskIds: [prior.row.id] }).feedback).toMatchObject([{ id: bucket.id, relation: 'candidate' }])
    const continuation = t.task('same Work followup', { from: prior.row.id })
    expect(context.read({ ...input, taskId: continuation.row.id }).feedback).toMatchObject([{ id: bucket.id, relation: 'linked' }])
  })
})

describe('actual Orchestrator prompt rebuild', () => {
  // A private chat is one continuous conversation (2026-09-29): every Work of the chat shares one ACP, so nothing is
  // rebuilt between requests; when the ACP is really lost, the rebuild restores the person's own messages from the
  // whole conversation. Explicitly bound material still comes only from the Work that selected it.
  const loseAcp = async (t: Awaited<ReturnType<typeof hostFixture>>) => {
    const session = t.registry.getSession('session')!
    await t.runtime.closeSession(session.acpSessionId!)
    t.registry.updateSession('session', { acpSessionId: null })
  }

  it.each([true, false])('keeps A, B and A-continued in one ACP, and a real rebuild restores the whole private conversation (independent session: %s)', async independent => {
    const t = await hostFixture(independent), a = t.task('ACTUAL_WORK_A_ORIGINAL', { queued: true })
    await t.execute(a.row)
    const b = t.task('ACTUAL_WORK_B_UNRELATED', { queued: true })
    // Warm continuation: the conversation is in the ACP already, the prompt carries only the new message.
    expect(await t.execute(b.row)).not.toContain('ACTUAL_WORK_A_ORIGINAL')
    const again = t.task('ACTUAL_WORK_A_CONTINUES', { from: a.row.id, queued: true })
    await t.execute(again.row)
    expect(new Set(t.state.allPrompts.map(item => item.sessionId)).size).toBe(1)
    expect(t.registry.taskWork.get(again.row.id)).toEqual(t.registry.taskWork.get(a.row.id))
    await loseAcp(t)
    const rebuilt = t.task('ACTUAL_WORK_A_AFTER_LOSS', { from: a.row.id, queued: true })
    const prompt = await t.execute(rebuilt.row)
    expect(prompt).toContain('ACTUAL_WORK_A_ORIGINAL')
    expect(prompt).toContain('ACTUAL_WORK_B_UNRELATED')
    expect(prompt).toContain('ACTUAL_WORK_A_AFTER_LOSS')
    expect(new Set(t.state.allPrompts.map(item => item.sessionId)).size).toBe(2)
    expect(t.registry.listTasks('session')).toHaveLength(4)
  })

  it('restores earlier text of the conversation into a fresh runtime, but never reads old forwarded resources', async () => {
    const t = await hostFixture()
    t.task('OLD_TEXT_COMES_BACK_AS_CONVERSATION')
    const old = t.forward('OLD_WORK_FORWARDED_BODY_MUST_STAY_OUT')
    const read = vi.spyOn(t.fake, 'getMessageItems')
    const current = t.task('ONLY_CURRENT_WORK_INPUT', { queued: true })
    const prompt = await t.execute(current.row)
    expect(prompt).toContain('ONLY_CURRENT_WORK_INPUT')
    expect(prompt).toContain('OLD_TEXT_COMES_BACK_AS_CONVERSATION')
    expect(prompt).not.toContain('OLD_WORK_FORWARDED_BODY_MUST_STAY_OUT')
    expect(read.mock.calls.some(([id]) => id === old.inbound.messageId)).toBe(false)
    expect(new SourceContexts(t.registry).get('session')?.inboundMaterials ?? []).toEqual([])
  })

  it('rebuilds the conversation plus the material this Work explicitly selected', async () => {
    const t = await hostFixture(), source = t.forward('EXPLICIT_ORIGINAL_REPORT_BODY')
    const origin = t.task('SAME_WORK_ORIGINAL_INSTRUCTION')
    t.materials.bind(origin.row, origin.inbound, [{ ref: 'selected-original', taskId: source.row.id, message: source.inbound }])
    t.task('UNRELATED_AFTER_ORIGINAL')
    const current = t.task('SAME_WORK_CONTINUATION', { from: origin.row.id, queued: true })
    const prompt = await t.execute(current.row)
    expect(prompt).toContain('SAME_WORK_ORIGINAL_INSTRUCTION')
    expect(prompt).toContain('SAME_WORK_CONTINUATION')
    expect(prompt).toContain('EXPLICIT_ORIGINAL_REPORT_BODY')
    // The person's other request is part of the same private conversation now.
    expect(prompt).toContain('UNRELATED_AFTER_ORIGINAL')
    expect(new SourceContexts(t.registry).get('session')?.inboundMaterials).toContainEqual(expect.objectContaining({ messageId: source.inbound.messageId }))
  })

  it('binds only the explicitly selected material of another Work; that Work\'s text returns as conversation, not as material', async () => {
    const t = await hostFixture(), source = t.forward('SELECTED_OLD_WORK_REPORT')
    t.task('OTHER_INPUT_FROM_OLD_WORK', { from: source.row.id })
    const current = t.task('NEW_WORK_USING_SELECTED_REPORT', { queued: true })
    t.materials.bind(current.row, current.inbound, [{ ref: 'explicit-report', taskId: source.row.id, message: source.inbound }])
    const prompt = await t.execute(current.row)
    expect(prompt).toContain('SELECTED_OLD_WORK_REPORT')
    expect(prompt).toContain('OTHER_INPUT_FROM_OLD_WORK')
    expect(prompt).not.toContain('本次请求引用的用户材料：\n\nOTHER_INPUT_FROM_OLD_WORK')
    expect(new SourceContexts(t.registry).get('session')?.inboundMaterials?.map(item => item.messageId)).toEqual([source.inbound.messageId])
    expect(t.registry.taskWork.get(current.row.id)?.key).not.toBe(t.registry.taskWork.get(source.row.id)?.key)
  })
})
