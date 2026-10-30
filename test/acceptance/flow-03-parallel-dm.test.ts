import { afterEach, describe, expect, it } from 'vitest'
import { acceptanceHost, closeAll, waitUntil } from './host.js'

afterEach(closeAll)

/** §11.3 私聊并行：两个事项交错，问进度不打断；停止一个、另一个继续；明确回复旧问题回到旧工作。 */
describe('acceptance 03 · two requests in one private conversation', () => {
  it('queues the second request behind the first, answers progress from storage, stops only the asked Run, then continues the finished work on a quote reply', async () => {
    const t = await acceptanceHost()
    const a = await t.hold(t.dm({ text: '帮我整理 A 方案' }), 'A_FINAL')
    // B arrives while A runs: the same private conversation, its own Work, waiting its turn.
    const bMsg = t.dm({ text: '再看一下 B 报表' })
    const bRun = t.host.handleMessage(bMsg).catch(error => ({ error }))
    await waitUntil(() => t.registry.taskForMessage(bMsg.messageId)?.status === 'queued', 'B was not queued')
    const bTask = t.registry.taskForMessage(bMsg.messageId)!
    expect(bTask.sessionKey).toBe(a.session.sessionKey)
    expect(t.registry.taskWork.get(a.task.id)!.key).not.toBe(t.registry.taskWork.get(bTask.id)!.key)
    expect(t.attempts.get(a.runId)?.state).toBe('running')
    // Asking for progress is a control message: answered from persisted state, no model turn, nothing interrupted.
    const before = t.fake.sent.length, prompts = t.agent.state.allPrompts.length
    await t.host.handleMessage(t.dm({ text: 'A 的进展如何', parentId: a.msg.messageId }))
    expect(t.texts(before).join('\n')).toMatch(/还在处理|正在/)
    expect(t.agent.state.allPrompts).toHaveLength(prompts)
    expect(t.attempts.get(a.runId)?.state).toBe('running')
    // Stopping A is committed before the runtime is signalled and leaves the queued B untouched.
    await t.host.handleMessage(t.dm({ text: '停止 A', parentId: a.msg.messageId }))
    expect(t.registry.getTask(a.task.id)).toMatchObject({ status: 'running', stopReason: 'user_requested' })
    expect(t.attempts.get(a.runId)?.state).toBe('stop_requested')
    expect(t.registry.getTask(bTask.id)?.status).toBe('queued')
    t.agent.state.script = [{ kind: 'text', text: 'B_FINAL' }]
    a.release(); await a.result
    expect(t.registry.getTask(a.task.id)?.status).toBe('cancelled')
    expect(t.registry.workContexts.view(t.registry.taskWork.get(a.task.id)!.key)).toMatchObject({ activity: 'paused', pauseReasons: [{ reason: 'run_stop', causeRef: `run:${a.runId}` }] })
    await bRun
    expect(t.registry.getTask(bTask.id)?.status).toBe('done')
    expect(t.fake.answers().join('\n')).toContain('B_FINAL')
    expect(t.fake.answers().join('\n')).not.toContain('A_FINAL')
    // An explicit reply to the finished B request continues B's delegation in the same conversation, not A's.
    t.agent.state.script = [{ kind: 'text', text: 'B_CONTINUED' }]
    await t.host.handleMessage(t.dm({ text: '报表里再补一列', parentId: bMsg.messageId }))
    const bKey = t.registry.taskWork.get(bTask.id)!.key, inputs = t.registry.workContexts.inputs(bKey)
    expect(inputs).toHaveLength(2)
    const continued = t.registry.getTask(inputs[1]!.taskId)!
    expect(continued).toMatchObject({ sessionKey: a.session.sessionKey, status: 'done' })
    expect(t.registry.workContexts.view(bKey)).toMatchObject({ handledSeq: 2, activity: 'idle' })
    expect(t.registry.workContexts.view(t.registry.taskWork.get(a.task.id)!.key)).toMatchObject({ inputSeq: 1, activity: 'paused' })
    await waitUntil(() => t.fake.answers().join('\n').includes('B_CONTINUED'), 'continuation answer not delivered')
  })
})
