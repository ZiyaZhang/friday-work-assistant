/**
 * 进程内的假 dsh ACP agent：用 SDK 的 AgentApp 实现，行为可编程，供运行时/编排器测试。
 */
import { agent, methods, PROTOCOL_VERSION, RequestError, type AgentApp, type ContentBlock } from '@agentclientprotocol/sdk'

export interface FakeTurnStep {
  kind: 'tool' | 'text' | 'permission' | 'thought' | 'sleep' | 'hook'
  /** tool: 标题；text/thought: 文本 */
  text?: string
  toolKind?: 'read' | 'edit' | 'execute' | 'search' | 'fetch' | 'think' | 'other'
  /** tool / permission: 随 tool_call 报出的 rawInput（默认 { command: 'rm -rf build' }） */
  rawInput?: unknown
  /**
   * permission: 照真实 dsh 的样子——先发 tool_call（kind other、title=工具名、rawInput），
   * 再发只带 toolCallId 的 request_permission（没有 title/kind/rawInput），option id 是 allow-once / reject-once。
   */
  bare?: boolean
  ms?: number
  /** hook: 在这一轮的中途跑一段测试代码（模拟工具在网关侧产生的副作用，比如"读了别的群"） */
  run?: () => void | Promise<void>
}

export interface FakeAgentState {
  sessions: Map<string, { cwd: string; prompts: string[]; mcpServers: unknown[] }>
  /** 收到过 cancel 的会话（日志，不清） */
  cancelled: string[]
  /** 当前这轮要中止的会话；下一轮 prompt 开始时清掉（照真实 dsh：cancel 只作用于进行中的那轮） */
  cancelPending: Set<string>
  /** 所有收到过的 prompt（会话关掉也留着，便于断言） */
  allPrompts: { sessionId: string; mcpServers: unknown[]; text: string }[]
  resumed: string[]
  permissionDecisions: string[]
  /** 每轮 prompt 的脚本；默认：一个 read 工具 + 一段文本 */
  script: FakeTurnStep[]
  counter: number
  /** 在 session/resume 返回前跑一段测试代码（模拟恢复等待期间网关侧发生的变化，比如用户撤权） */
  onResume?: (sessionId: string) => void | Promise<void>
  /** 在 session/new 返回前跑一段测试代码（模拟准入之后、派发之前网关侧发生的控制变化） */
  onNewSession?: (sessionId: string) => void | Promise<void>
}

export function createFakeAgent(initial?: Partial<FakeAgentState>): { app: AgentApp; state: FakeAgentState } {
  const state: FakeAgentState = {
    sessions: new Map(),
    cancelled: [],
    cancelPending: new Set(),
    allPrompts: [],
    resumed: [],
    permissionDecisions: [],
    script: [
      { kind: 'tool', text: '读取话题', toolKind: 'read' },
      { kind: 'text', text: '这是假回答。' },
    ],
    counter: 0,
    ...initial,
  }

  // DSH close releases runtime resources; persisted conversation can be resumed.
  const closedSessions = new Map<string, FakeAgentState['sessions'] extends Map<string, infer S> ? S : never>()
  const app = agent({ name: 'fake-dsh' })
    .onRequest(methods.agent.initialize, async () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} }))
    .onRequest(methods.agent.session.new, async ({ params }) => {
      state.counter += 1
      const sessionId = `fake-session-${state.counter}`
      state.sessions.set(sessionId, { cwd: params.cwd, prompts: [], mcpServers: params.mcpServers })
      await state.onNewSession?.(sessionId)
      return { sessionId }
    })
    .onRequest(methods.agent.session.resume, async ({ params }) => {
      const s = state.sessions.get(params.sessionId) ?? closedSessions.get(params.sessionId)
      if (!s) throw RequestError.resourceNotFound(params.sessionId)
      if (s.cwd !== params.cwd) throw RequestError.invalidParams({ cwd: params.cwd }, 'session cwd does not match')
      if (params.mcpServers !== undefined) s.mcpServers = params.mcpServers
      await state.onResume?.(params.sessionId)
      state.sessions.set(params.sessionId, s)
      closedSessions.delete(params.sessionId)
      state.resumed.push(params.sessionId)
      return {}
    })
    .onRequest(methods.agent.session.list, async () => ({
      sessions: [...state.sessions.entries()].map(([sessionId, s]) => ({ sessionId, cwd: s.cwd })),
    }))
    .onRequest(methods.agent.session.close, async ({ params }) => {
      const s = state.sessions.get(params.sessionId)
      if (s) closedSessions.set(params.sessionId, s)
      state.sessions.delete(params.sessionId)
      return {}
    })
    .onRequest(methods.agent.session.setConfigOption, async () => ({ configOptions: [] }))
    .onNotification(methods.agent.session.cancel, async ({ params }) => {
      state.cancelled.push(params.sessionId)
      state.cancelPending.add(params.sessionId)
    })
    .onRequest(methods.agent.session.prompt, async ({ params, client, signal }) => {
      const s = state.sessions.get(params.sessionId)
      if (!s) throw RequestError.resourceNotFound(params.sessionId)
      const promptText = params.prompt.map((b: ContentBlock) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n')
      s.prompts.push(promptText)
      state.allPrompts.push({ sessionId: params.sessionId, mcpServers: s.mcpServers, text: promptText })
      state.cancelPending.delete(params.sessionId)
      let step = 0
      for (const item of state.script) {
        step += 1
        if (signal.aborted || state.cancelPending.has(params.sessionId)) return { stopReason: 'cancelled' as const }
        if (item.kind === 'sleep') {
          await new Promise((r) => setTimeout(r, item.ms ?? 50))
          continue
        }
        if (item.kind === 'hook') {
          await item.run?.()
          continue
        }
        if (item.kind === 'tool') {
          const toolCallId = `call-${step}`
          await client.notify(methods.client.session.update, {
            sessionId: params.sessionId,
            update: { sessionUpdate: 'tool_call', toolCallId, title: item.text ?? 'tool', kind: item.toolKind ?? 'read', status: 'in_progress', ...(item.rawInput !== undefined ? { rawInput: item.rawInput } : {}) },
          })
          await client.notify(methods.client.session.update, {
            sessionId: params.sessionId,
            update: { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' },
          })
          continue
        }
        if (item.kind === 'thought') {
          await client.notify(methods.client.session.update, {
            sessionId: params.sessionId,
            update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: item.text ?? '' } },
          })
          continue
        }
        if (item.kind === 'permission') {
          const toolCallId = `call-${step}`
          const rawInput = item.rawInput ?? { command: 'rm -rf build' }
          if (item.bare) {
            await client.notify(methods.client.session.update, {
              sessionId: params.sessionId,
              update: { sessionUpdate: 'tool_call', toolCallId, title: item.text ?? 'bash', kind: 'other', status: 'in_progress', rawInput },
            })
          }
          const res = await client.request(methods.client.session.requestPermission, {
            sessionId: params.sessionId,
            toolCall: item.bare ? { toolCallId } : { toolCallId, title: item.text ?? 'bash', kind: item.toolKind ?? 'execute', rawInput },
            options: item.bare
              ? [
                  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
                  { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
                ]
              : [
                  { optionId: 'allow', name: '允许', kind: 'allow_once' },
                  { optionId: 'reject', name: '拒绝', kind: 'reject_once' },
                ],
          })
          const decision = res.outcome.outcome === 'selected' ? res.outcome.optionId.replace(/-once$/, '') : 'cancelled'
          state.permissionDecisions.push(decision)
          if (item.bare) {
            await client.notify(methods.client.session.update, {
              sessionId: params.sessionId,
              update: { sessionUpdate: 'tool_call_update', toolCallId, status: decision === 'allow' ? 'completed' : 'failed' },
            })
          }
          if (decision !== 'allow') {
            await client.notify(methods.client.session.update, {
              sessionId: params.sessionId,
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '操作未获批准，已跳过。' } },
            })
          }
          continue
        }
        await client.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: item.text ?? '' } },
        })
      }
      return { stopReason: 'end_turn' as const }
    })

  return { app, state }
}
