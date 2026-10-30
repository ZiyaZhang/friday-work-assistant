import { describe, expect, it } from 'vitest'
import { AcpRuntime, textBlock } from '../src/acp/runtime.js'
import { createLogger } from '../src/log.js'
import { createFakeAgent } from './helpers/fake-agent.js'
import type { SessionUpdate } from '@agentclientprotocol/sdk'

const log = createLogger('test', 'error')

describe('AcpRuntime (in-process fake dsh)', () => {
  it('initializes, creates a session, streams updates and settles the prompt', async () => {
    const { app, state } = createFakeAgent()
    const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: app }, onPermission: async () => ({ outcome: { outcome: 'cancelled' } }), log })
    await runtime.start()
    expect(runtime.isAlive).toBe(true)
    const id = await runtime.newSession('/tmp/ws', [])
    expect(id).toBe('fake-session-1')
    expect(runtime.isSessionActive(id)).toBe(true)

    const updates: SessionUpdate[] = []
    const unsub = runtime.subscribe(id, (u) => updates.push(u))
    const res = await runtime.prompt(id, [textBlock('hello')], { timeoutMs: 5000 })
    unsub()
    expect(res.stopReason).toBe('end_turn')
    expect(updates.map((u) => u.sessionUpdate)).toEqual(['tool_call', 'tool_call_update', 'agent_message_chunk'])
    expect(state.sessions.get(id)?.prompts).toEqual(['hello'])
    await runtime.stop()
    expect(runtime.isAlive).toBe(false)
  })

  it('routes permission requests to the handler', async () => {
    const { app, state } = createFakeAgent({ script: [{ kind: 'permission', text: 'bash', toolKind: 'execute' }, { kind: 'text', text: 'done' }] })
    const seen: string[] = []
    const runtime = new AcpRuntime({
      transport: { kind: 'inproc', agent: app },
      onPermission: async (req) => {
        seen.push(req.toolCall.title ?? '')
        return { outcome: { outcome: 'selected', optionId: 'allow' } }
      },
      log,
    })
    await runtime.start()
    const id = await runtime.newSession('/tmp/ws')
    await runtime.prompt(id, [textBlock('go')])
    expect(seen).toEqual(['bash'])
    expect(state.permissionDecisions).toEqual(['allow'])
    await runtime.stop()
  })

  it('resume returns false for unknown sessions and true for known ones', async () => {
    const { app, state } = createFakeAgent()
    const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: app }, onPermission: async () => ({ outcome: { outcome: 'cancelled' } }), log })
    await runtime.start()
    expect(await runtime.resumeSession('nope', '/tmp/ws')).toBe(false)
    const id = await runtime.newSession('/tmp/ws')
    await runtime.stop()
    // 模拟重启：同一个 fake agent 保留了 session，新 runtime resume
    const runtime2 = new AcpRuntime({ transport: { kind: 'inproc', agent: app }, onPermission: async () => ({ outcome: { outcome: 'cancelled' } }), log })
    await runtime2.start()
    expect(runtime2.isSessionActive(id)).toBe(false)
    expect(await runtime2.resumeSession(id, '/tmp/ws')).toBe(true)
    expect(runtime2.isSessionActive(id)).toBe(true)
    expect(state.resumed).toEqual([id])
    expect(await runtime2.resumeSession(id, '/other/cwd')).toBe(false)
    await runtime2.stop()
  })

  it('cancels on timeout and on abort signal', async () => {
    const { app, state } = createFakeAgent({ script: [{ kind: 'sleep', ms: 80 }, { kind: 'sleep', ms: 80 }, { kind: 'text', text: 'late' }] })
    const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: app }, onPermission: async () => ({ outcome: { outcome: 'cancelled' } }), log })
    await runtime.start()
    const id = await runtime.newSession('/tmp/ws')
    await expect(runtime.prompt(id, [textBlock('slow')], { timeoutMs: 30 })).rejects.toThrow(/被中止/)
    expect(state.cancelled).toContain(id)

    const id2 = await runtime.newSession('/tmp/ws')
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 20)
    const res = await runtime.prompt(id2, [textBlock('slow')], { signal: ac.signal })
    expect(res.stopReason).toBe('cancelled')
    await runtime.stop()
  })

  it('lists sessions across pages', async () => {
    const { app } = createFakeAgent()
    const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: app }, onPermission: async () => ({ outcome: { outcome: 'cancelled' } }), log })
    await runtime.start()
    await runtime.newSession('/a')
    await runtime.newSession('/b')
    const list = await runtime.listSessions()
    expect(list.map((s) => s.cwd).sort()).toEqual(['/a', '/b'])
    await runtime.stop()
  })
})
