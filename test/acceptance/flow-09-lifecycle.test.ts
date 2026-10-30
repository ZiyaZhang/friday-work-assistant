import { afterEach, describe, expect, it } from 'vitest'
import { acceptanceHost, closeAll, deferred } from './host.js'

afterEach(closeAll)

/** §11.9 生命周期：运行中停用空间 / 取消委托；迟到的工具结果不能重新开启工作或改投新受众。 */
describe('acceptance 09 · lifecycle changes during a Run', () => {
  it('a space disabled mid-Run refuses every later tool write and delivery; the Run ends without reopening anything', async () => {
    const t = await acceptanceHost(), entered = deferred(), release = deferred()
    t.releases.push(release.resolve)
    const late: { route: string; status: number }[] = []
    let hookError: unknown
    t.agent.state.script = [{ kind: 'hook', run: async () => {
      try {
        expect((await t.tool('todo/add', { title: '停用前登记的待办' })).status).toBe(200)
        entered.resolve(); await release.promise
        for (const [route, body] of [['todo/add', { title: '停用后不该出现的待办' }], ['dm', { text: '停用后不该发出的私信' }], ['memory/save', { title: '停用后', body: '不该保存' }]] as const) {
          late.push({ route, status: (await t.tool(route, body as Record<string, unknown>)).status })
        }
      } catch (error) { hookError ??= error; throw error }
    } }, { kind: 'text', text: 'LATE_MODEL_ANSWER' }]
    const msg = t.message(), result = t.host.handleMessage(msg).catch(error => ({ error })); t.pending.push(result)
    await entered.promise
    const task = t.registry.taskForMessage(msg.messageId)!, runId = t.host.resolveActorForSession(task.sessionKey)!.runId!
    expect(t.todos.list(`space:${t.group.id}` as never)).toHaveLength(1)
    // The space owner disables the space while the model is still working.
    expect(t.spaces.archive(t.group.id)).toBe(true)
    release.resolve(); await result
    if (hookError) throw hookError
    expect(late.map(item => item.status)).toEqual([403, 403, 403])
    expect(t.todos.list(`space:${t.group.id}` as never)).toHaveLength(1)
    expect(t.fake.sent.filter(item => item.kind === 'sendToUser')).toHaveLength(0)
    expect(t.fake.answers().join('\n')).not.toContain('LATE_MODEL_ANSWER')
    expect(t.memory.recent(`space:${t.group.id}`)).toEqual([])
    expect(t.registry.getTask(task.id)).toMatchObject({ status: 'cancelled', stopReason: 'access_changed' })
    expect(t.attempts.get(runId)).toMatchObject({ state: 'cancelled', stopReason: 'access_changed' })
    // The delegation is not reopened by the late result and no new Run may start in the disabled space.
    const work = t.registry.taskWork.get(task.id)!.key
    expect(t.registry.workContexts.view(work)).toMatchObject({ activity: 'idle', handledSeq: 1 })
    const before = t.fake.sent.length
    await t.host.handleMessage(t.message({ text: '再试一次', mentions: [], parentId: msg.messageId, rootId: msg.messageId }))
    expect(t.agent.state.allPrompts).toHaveLength(1)
    expect(t.texts(before).join('\n')).not.toContain('LATE_MODEL_ANSWER')
  })

  it('a delegation cancelled from the console ends its running Run before any result is delivered, and a late tool call is refused', async () => {
    const t = await acceptanceHost(), entered = deferred(), release = deferred()
    t.releases.push(release.resolve)
    let lateStatus = 0
    t.agent.state.script = [{ kind: 'hook', run: async () => {
      entered.resolve(); await release.promise
      lateStatus = (await t.tool('todo/add', { title: '取消后不该出现的待办' })).status
    } }, { kind: 'text', text: 'CANCELLED_MODEL_ANSWER' }]
    const msg = t.message(), result = t.host.handleMessage(msg).catch(error => ({ error })); t.pending.push(result)
    await entered.promise
    const task = t.registry.taskForMessage(msg.messageId)!, key = t.registry.taskWork.get(task.id)!.key
    const receipt = await t.commands.execute(t.login('alice'), t.group.id, { operation: 'work.cancel', requestId: 'lifecycle_cancel_0001', workKey: key, expectedRevision: 1 })
    expect(receipt.body.appliedResult).toMatchObject({ state: 'cancelled', affectedRunIds: [expect.any(String)] })
    release.resolve(); await result
    expect(lateStatus).toBe(403)
    expect(t.todos.list(`space:${t.group.id}` as never)).toHaveLength(0)
    expect(t.fake.answers().join('\n')).not.toContain('CANCELLED_MODEL_ANSWER')
    expect(t.registry.getTask(task.id)).toMatchObject({ status: 'cancelled', stopReason: 'user_requested' })
    expect(t.registry.workContexts.view(key)).toMatchObject({ lifecycle: 'cancelled', activity: 'idle' })
  })
})
