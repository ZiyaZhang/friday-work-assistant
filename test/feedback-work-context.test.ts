import { afterEach, describe, expect, it } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { Bugs } from '../src/core/bugs.js'
import { BugQuestions } from '../src/core/bug-questions.js'
import { FeedbackControl } from '../src/core/feedback-control.js'
import { FeedbackWorkContext, type FeedbackWorkContextInput } from '../src/core/feedback-work-context.js'
import { RoutineStore } from '../src/core/routines.js'
import { ChannelMemory } from '../src/core/memory.js'
import { TurnContextBuilder, type TurnContextInput } from '../src/core/context-builder.js'
import { DeliveryService } from '../src/core/delivery.js'
import { spaceDeps } from './helpers/space.js'
import { spaceScope } from '../src/core/space.js'

const closers: (() => void)[] = []
afterEach(() => { for (const close of closers.splice(0)) close() })

function setup() {
  const registry = new Registry(':memory:')
  closers.push(() => registry.close())
  const bugs = new Bugs(registry.db), questions = new BugQuestions(registry.db, bugs), routines = new RoutineStore(registry.db)
  const feedback = new FeedbackControl(registry, bugs, questions, routines), memory = new ChannelMemory(registry.db)
  const sp = spaceDeps(registry.db), { spaces } = sp, space = spaces.ensure({ kind: 'group', chatId: 'chat-a', openId: 'alice' })
  registry.createSession({ sessionKey: 'session-a', chatId: 'chat-a', chatType: 'group', requesterOpenId: 'alice', cwd: '/synthetic/a' })
  let next = 0
  const task = (prompt: string, options: { sessionKey?: string; requesterOpenId?: string; amendsTaskId?: number; workFromTaskId?: number } = {}) => registry.createTaskOnce({
    sessionKey: 'session-a', requesterOpenId: 'alice', messageId: `message-${++next}`, prompt, ...options,
  }).task
  const record = (title: string, source = task(title), sourceSpace = space.id, chatId = 'chat-a') => bugs.record({
    spaceId: sourceSpace, chatId, messageId: source.messageId, reporterOpenId: source.requesterOpenId!, title, text: source.prompt,
  }).bucket
  const input = (current: ReturnType<typeof task>): FeedbackWorkContextInput => ({
    taskId: current.id, sessionKey: current.sessionKey, actorOpenId: 'alice', spaceId: space.id, chatId: 'chat-a', chatType: 'group',
    scopes: ['bug:read', 'bug:write', 'routine:read', 'routine:write'],
  })
  const context = new FeedbackWorkContext({ registry, bugs, questions, feedback, routines })
  const builder = new TurnContextBuilder({ registry, memory, questions, feedbackContext: context })
  const turn = (current: ReturnType<typeof task>): TurnContextInput => ({
    taskId: current.id, session: { key: current.sessionKey, chatId: 'chat-a', chatType: 'group' },
    actor: { openId: 'alice', name: '小林', description: '当前成员' }, space: { id: space.id, prefs: { notes: [] } },
    botName: 'Friday', chatName: '合成群', messageId: current.messageId, body: current.prompt, nowMs: Date.now(), isFirstTurn: false,
    memoryScopes: [{ scope: spaceScope(space.id), label: '本群' }], prior: { items: [], complete: true }, excludedSources: [],
    feedbackAccess: { scopes: input(current).scopes },
  })
  const routine = (name: string, overrides: Partial<Parameters<RoutineStore['add']>[0]> = {}) => routines.add({
    kind: 'schedule', chatId: 'chat-a', chatType: 'group', spaceId: space.id, ownerOpenId: 'alice',
    name, prompt: '只读合成对象', schedule: { type: 'interval', everyMinutes: 60 }, deliverTo: 'chat', ...overrides,
  })
  return { registry, bugs, questions, routines, feedback, memory, spaces, sp, space, task, record, input, context, builder, turn, routine }
}

describe('bounded feedback work context from real SQLite relationships', () => {
  it('reads explicitly referenced case facts without joining their Work or changing records', () => {
    const t = setup(), sourceA = t.task('隐藏按钮建议'), a = t.record('隐藏按钮建议', sourceA)
    const sourceB = t.task('另一个案件'), b = t.record('另一个案件', sourceB)
    const reminder = t.routine('检查演示文稿')
    t.routines.setEnabled(reminder.id, false)
    const current = t.task('这条隐藏按钮的建议先不跟了，保留记录。检查演示文稿的提醒也继续保持暂停。')
    const beforeWork = t.registry.taskWork.get(current.id)
    const input = { ...t.input(current), referencedTaskIds: [sourceB.id, sourceA.id] }
    expect(t.context.read(t.input(current)).feedback).toEqual([])
    const before = t.context.read(input)
    expect(before.feedback.map(item => [item.id, item.relation])).toEqual([[b.id, 'candidate'], [a.id, 'candidate']])
    t.bugs.setIntake({ bucketId: a.id, spaceId: t.space.id, phase: 'awaiting_info', missingInfo: ['出现位置'], note: '限定尚未补齐' })
    const updated = t.context.read(input)
    expect(updated.feedback.find(item => item.id === a.id)).toMatchObject({ intake_phase: 'awaiting_info', missing_info: ['出现位置'], note: '限定尚未补齐' })
    expect(updated.routines).toContainEqual(expect.objectContaining({ id: reminder.id, enabled: false, disabled_reason: '手动停用' }))
    expect(t.registry.taskWork.get(current.id)).toEqual(beforeWork)
    expect(t.registry.listAmendedTasks(current.id)).toEqual([])
    expect(t.bugs.get(a.id)?.intakePhase).toBe('awaiting_info') // Reading the stop request is not applying it.
    expect(t.routines.get(reminder.id)?.messageCursorSec).toBeNull()
  })

  it('distinguishes a genuine work chain from an interleaved case in the same session', () => {
    const t = setup(), origin = t.task('原请求 A'), a = t.record('案件 A', origin), b = t.record('案件 B')
    const addition = t.task('补充 A', { amendsTaskId: origin.id })
    const current = t.task('继续补充 A', { amendsTaskId: addition.id })
    const view = t.context.read(t.input(current))
    expect(view.work_key).toBe(`task:${origin.id}`)
    expect(view.feedback.map(item => [item.id, item.relation])).toEqual([[a.id, 'linked']])
    expect(view.feedback.some(item => item.id === b.id)).toBe(false)
    expect(new Set(view.feedback.map(item => item.id)).size).toBe(view.feedback.length)
    expect(view.feedback[0]?.source_task_ids).toContain(current.id)
  })

  it('follows an explicit work root even without inventing an amendment edge', () => {
    const t = setup(), origin = t.task('已登记问题原请求'), a = t.record('案件 A', origin)
    const reply = t.task('精确答复', { workFromTaskId: origin.id })
    expect(t.registry.listAmendedTasks(reply.id)).toEqual([])
    expect(t.context.read(t.input(reply)).feedback).toContainEqual(expect.objectContaining({ id: a.id, relation: 'linked' }))
  })

  it('uses an exact same-chat reference as a candidate without joining its separate work', () => {
    const t = setup()
    t.registry.createSession({ sessionKey: 'session-b', chatId: 'chat-a', chatType: 'group', requesterOpenId: 'alice', cwd: '/synthetic/b' })
    const prior = t.task('B 工作', { sessionKey: 'session-b' }), b = t.record('B 案件', prior)
    const current = t.task('需要操作 B 的控制请求')
    expect(t.context.read(t.input(current)).feedback).toEqual([])
    const view = t.context.read({ ...t.input(current), referencedTaskIds: [prior.id] })
    expect(view.feedback).toContainEqual(expect.objectContaining({ id: b.id, relation: 'candidate', source_task_ids: [prior.id] }))
    expect(view.work_key).not.toBe(t.registry.taskWork.get(prior.id)?.key)
  })

  it('does not expose other spaces, actors, synthetic receipts or retired referenced sessions', () => {
    const t = setup(), other = t.spaces.ensure({ kind: 'group', chatId: 'chat-b', openId: 'bob' })
    t.registry.createSession({ sessionKey: 'private', chatId: 'chat-b', chatType: 'group', requesterOpenId: 'bob', cwd: '/synthetic/private' })
    const privateTask = t.task('SECRET_OTHER_SPACE', { sessionKey: 'private', requesterOpenId: 'bob' })
    t.record('SECRET_OTHER_SPACE', privateTask, other.id, 'chat-b')
    const otherActor = t.task('OTHER_ACTOR', { requesterOpenId: 'bob' }); t.record('OTHER_ACTOR', otherActor)
    const system = t.registry.createTaskOnce({ sessionKey: 'session-a', messageId: 'system-anchor', requesterOpenId: 'alice', prompt: 'SYSTEM_RECEIPT' }, 'routine:1:window').task
    t.record('SYSTEM_RECEIPT', system)
    t.registry.createSession({ sessionKey: 'archived', chatId: 'chat-a', chatType: 'group', requesterOpenId: 'alice', cwd: '/synthetic/archived' })
    const retired = t.task('RETIRED', { sessionKey: 'archived' }); t.record('RETIRED', retired)
    t.registry.updateSession('archived', { status: 'archived' })
    const current = t.task('当前请求'), view = t.context.read({ ...t.input(current), referencedTaskIds: [privateTask.id, otherActor.id, system.id, retired.id] })
    expect(view.feedback).toEqual([])
    expect(view.coverage.missing_links).toBe(true)
    expect(() => t.context.read({ ...t.input(current), actorOpenId: 'bob' })).toThrow('当前任务或身份')
  })

  it('obeys independent read scopes and does not grant controls through a read-only view', () => {
    const t = setup(), origin = t.task('只读案件'), a = t.record('只读案件', origin)
    const current = t.task('当前查询', { workFromTaskId: origin.id })
    t.routine('本群提醒')
    const noRead = t.context.read({ ...t.input(current), scopes: ['bug:write', 'routine:write'] })
    expect(noRead.feedback).toEqual([]); expect(noRead.routines).toEqual([])
    const readOnly = t.context.read({ ...t.input(current), scopes: ['bug:read'] })
    expect(readOnly.feedback[0]).toMatchObject({ id: a.id, operations: ['read'] })
    expect(readOnly.routines).toEqual([])
  })

  it('keeps user notes associated without restoring the stopped case or seeding execution', () => {
    const t = setup(), origin = t.task('已停原请求'), a = t.record('案件 A', origin)
    t.bugs.stopFollowing(a.id, t.space.id)
    const current = t.task('更正原话，不恢复委托')
    t.bugs.captureUserNote({ bucketId: a.id, spaceId: t.space.id, chatId: 'chat-a', messageId: current.messageId, reporterOpenId: 'alice', text: current.prompt })
    expect(t.context.read(t.input(current)).feedback[0]).toMatchObject({ id: a.id, relation: 'linked', intake_phase: 'cancelled', operations: ['read', 'capture_user_note'] })
    expect(t.feedback.taskStopped(current.id)).toBe(false)
    expect(t.feedback.taskStopped(origin.id)).toBe(true)
    expect(t.bugs.get(a.id)?.count).toBe(1)
  })

  it('bounds candidate and routine injection, preserving the linked case and explicit coverage', () => {
    const t = setup(), origin = t.task('当前工作起点'), linked = t.record('LINKED_CASE', origin)
    const references: number[] = []
    for (let i = 0; i < 65; i++) {
      const source = t.task(`candidate-${i}`); t.record(`candidate-${i}`, source); references.push(source.id)
    }
    for (let i = 0; i < 13; i++) t.routine(`routine-${i}`)
    const current = t.task('继续当前工作', { workFromTaskId: origin.id })
    const view = t.context.read({ ...t.input(current), referencedTaskIds: references.reverse() })
    expect(view.feedback).toHaveLength(8)
    expect(view.feedback[0]).toMatchObject({ id: linked.id, relation: 'linked' })
    expect(view.routines).toHaveLength(12)
    expect(view.coverage).toMatchObject({ history_truncated: false, references_truncated: true, feedback_truncated: true, routines_truncated: true })
    expect(view.feedback.some(item => item.title === 'candidate-0')).toBe(false)
  })

  it('shows only manageable current-scope routines, preserving their actual paused state', () => {
    const t = setup(), visible = t.routine('群内暂停'), other = t.spaces.ensure({ kind: 'group', chatId: 'chat-b', openId: 'bob' })
    t.routines.setEnabled(visible.id, false)
    t.routine('别群机密', { chatId: 'chat-b', spaceId: other.id })
    t.routine('私人机密', { chatType: 'p2p', ownerOpenId: 'bob' })
    const current = t.task('查询职责')
    expect(t.context.read(t.input(current)).routines.map(item => item.name)).toEqual(['群内暂停'])
    expect(t.routines.get(visible.id)?.enabled).toBe(false)
  })

  it('renders ordinary cases once on warm turns and rereads their current stopped phase', () => {
    const t = setup(), origin = t.task('唯一案件标题'), a = t.record('唯一案件标题', origin)
    const current = t.task('看看当前状态'), turn = t.turn(current)
    turn.feedbackAccess = { ...turn.feedbackAccess!, referencedTaskIds: [origin.id] }
    t.bugs.setIntake({ bucketId: a.id, spaceId: t.space.id, phase: 'new', note: '旧回复曾声称已停止跟进，但没有执行控制' })
    const first = t.builder.build(turn)
    expect(first.prompt.match(/唯一案件标题/g)).toHaveLength(1)
    expect(first.prompt).toContain('"relation":"candidate"')
    expect(first.prompt).toContain('"following_stopped":false')
    t.bugs.stopFollowing(a.id, t.space.id)
    const after = t.builder.build(turn)
    expect(after.prompt).toContain('"intake_phase":"cancelled"')
    expect(after.prompt).toContain('"following_stopped":true')
    expect(after.prompt).not.toContain('"intake_phase":"new"')
    const withoutRead = t.builder.build({ ...turn, feedbackAccess: { scopes: [] } })
    expect(withoutRead.prompt).not.toContain('唯一案件标题')
    expect(t.registry.taskWork.get(current.id)?.rootTaskId).toBe(current.id)
  })

  it('merges real question replies into the latest case view without duplicating the case or leaking denied reads', async () => {
    const t = setup(), origin = t.task('真正的原请求'), a = t.record('唯一补问案件标题', origin)
    const question = t.questions.prepare({ bucketId: a.id, spaceId: t.space.id, sessionKey: origin.sessionKey,
      originTaskId: origin.id, targetOpenId: 'alice', kind: 'info', question: 'QUESTION_CONTENT_CANARY',
      anchor: { tenantId: 'test-tenant', appId: 'test-app', chatId: 'chat-a', messageId: origin.messageId } })
    await new DeliveryService(t.registry.db, { ...t.sp,
      resolveContext: async () => ({ actorOpenId: 'alice', audience: { kind: 'group', spaceId: t.space.id, chatId: 'chat-a', replyToMessageId: origin.messageId },
        sources: [{ ref: origin.messageId, spaceId: t.space.id, chatId: 'chat-a' }], provenanceComplete: true, expiresAt: Date.now() + 60_000 }),
      send: async () => ({ remoteId: 'question-remote' }),
    }).deliver({ key: question.deliveryKey, contextRef: 'question-context', payload: { text: question.question } })
    const current = t.task('材料拿不到', { workFromTaskId: origin.id })
    const reply = t.questions.acceptReply(question.id, { messageId: current.messageId, senderOpenId: 'alice', taskId: current.id })
    t.registry.updateTask(current.id, { status: 'running' })
    t.questions.resolveReply(question.id, reply.id, current.id, 'unavailable')
    t.bugs.setIntake({ bucketId: a.id, spaceId: t.space.id, phase: 'awaiting_info', missingInfo: ['仍未知的触发条件'] })
    t.bugs.linkIssue(a.id, 'https://github.com/synthetic/repo/issues/17')
    const before = t.questions.readContext(a.id, t.space.id)
    const result = t.builder.build(t.turn(current))
    expect(result.prompt.match(/唯一补问案件标题/g)).toHaveLength(1)
    expect(result.prompt).toContain('"current_reply_id":' + reply.id)
    expect(result.prompt).toContain('"outcome":"unavailable"')
    expect(result.prompt).toContain('"intake_phase":"linked_issue"')
    expect(result.prompt).toContain('真正的原请求')
    expect(result.prompt).toContain('仍未知的触发条件')
    const denied = t.builder.build({ ...t.turn(current), feedbackAccess: { scopes: ['routine:read'] } })
    expect(denied.prompt).not.toContain('QUESTION_CONTENT_CANARY')
    expect(denied.prompt).not.toContain('唯一补问案件标题')
    expect(t.questions.readContext(a.id, t.space.id)).toEqual(before)
  })
})
