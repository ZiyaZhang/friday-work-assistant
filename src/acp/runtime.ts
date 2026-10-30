/**
 * ACP 运行时：Friday 作为 ACP client，驱动一个 `dsh --profile <friday>` 子进程。
 *
 * 为什么是 ACP 而不是 dsh 的 SDK 线：dsh 0.1.6 的 stdio SDK 协议只有
 * initialize / session/prompt / shutdown，没有 cancel、没有审批回传、也不能跨重启
 * resume；ACP 三者都有（session/resume、session/cancel、session/request_permission），
 * 见 packages/acp/acp/README.md。
 *
 * 一个子进程承载多个 session；每个 session 同一时刻只能有一个 prompt 在跑
 * （dsh 约束 "one prompt at a time per session"），串行由上层队列保证。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { Gate } from '../core/gate.js'
import {
  client as createClientApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type AgentApp,
  type ClientConnection,
  type ContentBlock,
  type McpServer,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionInfo,
  type SessionConfigOption,
  type SessionNotification,
  type SessionUpdate,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
} from '@agentclientprotocol/sdk'
import type { Logger } from '../log.js'

export type AcpTransport =
  | { kind: 'spawn'; command: string; args: string[]; env: Record<string, string>; cwd?: string }
  | { kind: 'inproc'; agent: AgentApp }

export type UpdateListener = (update: SessionUpdate, notification: SessionNotification) => void
export type PermissionHandler = (request: RequestPermissionRequest, signal: AbortSignal) => Promise<RequestPermissionResponse>

/** ACP 的上下文占用，不代表本轮输入/输出 token 账单。 */
export interface SessionConfigSnapshot {
  generation: number
  configOptions?: SessionConfigOption[]
  contextOccupancy?: { used: number; size: number }
}

export interface PromptOptions {
  timeoutMs?: number
  signal?: AbortSignal
  onQueued?: (position: number) => void
  onStarted?: () => void
  /** 获得 Gate 名额后、真正发请求前同步复验；抛出即不发送。不得返回 Promise。 */
  beforeDispatch?: () => void
}

export interface AcpRuntimeOptions {
  /**
   * 同时最多跑几轮 prompt（FRIDAY_MAX_CONCURRENT_TURNS）。
   * 一台开发机上一个 dsh 进程，超过这个数不是更快，是大家一起慢。
   */
  maxConcurrent?: number
  /** 多个执行进程共用同一并发额度；提供时优先于 maxConcurrent。 */
  gate?: Gate
  transport: AcpTransport
  onPermission: PermissionHandler
  log: Logger
  /** 子进程退出（非 stop() 引起）时回调；上层据此让后续 prompt 走 ensureSession → resume */
  onExit?: (info: { code: number | null; signal: NodeJS.Signals | null }) => void
}

export class AcpRuntimeError extends Error {
  constructor(message: string, readonly kind: 'not-started' | 'dead' | 'timeout' | 'protocol' | 'session-not-found') {
    super(message)
    this.name = 'AcpRuntimeError'
  }
}

interface ActiveSession extends SessionConfigSnapshot {
  cwd: string
  mcpServers: McpServer[]
}

/** 没配就用这个：3 轮。一台开发机、一个 dsh 进程、一份模型配额，再多是自己挤自己。 */
export const DEFAULT_MAX_CONCURRENT = 3

/** Host consumers depend on these operations, not one concrete process implementation. */
export interface AcpRuntimeClient {
  readonly isAlive: boolean
  readonly currentGeneration: number
  start(): Promise<void>
  stop(): Promise<void>
  newSession(cwd: string, mcpServers?: McpServer[]): Promise<string>
  resumeSession(sessionId: string, cwd: string, mcpServers?: McpServer[]): Promise<boolean>
  isSessionActive(sessionId: string): boolean
  sessionConfig(sessionId: string): SessionConfigSnapshot | undefined
  listSessions(cwd?: string): Promise<SessionInfo[]>
  closeSession(sessionId: string): Promise<void>
  subscribe(sessionId: string, listener: UpdateListener): () => void
  prompt(sessionId: string, prompt: ContentBlock[], opts?: PromptOptions): Promise<PromptResponse>
  load(): { active: number; waiting: number; max: number }
  cancel(sessionId: string): Promise<void>
  setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<SetSessionConfigOptionResponse>
}

export class AcpRuntime implements AcpRuntimeClient {
  private conn?: ClientConnection
  private child?: ChildProcessWithoutNullStreams
  private alive = false
  private stopping = false
  /** 每次（重）启动 +1；session 的 generation 落后就说明它在旧进程里，需要 resume */
  private generation = 0
  private readonly listeners = new Map<string, Set<UpdateListener>>()
  private readonly sessions = new Map<string, ActiveSession>()
  private readonly pendingResumes = new Map<string, symbol>()
  private readonly log: Logger
  /** 全局并发闸门：同时最多几轮 prompt 在跑 */
  private readonly gate: Gate

  constructor(private readonly opts: AcpRuntimeOptions) {
    this.log = opts.log
    this.gate = opts.gate ?? new Gate(Math.max(1, opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT))
  }

  get isAlive(): boolean {
    return this.alive
  }

  get currentGeneration(): number {
    return this.generation
  }

  /** 拉起子进程（或进程内 fake agent）并完成 initialize 握手。可重复调用用于重启。 */
  async start(): Promise<void> {
    if (this.alive) return
    this.stopping = false
    this.generation += 1
    const generation = this.generation
    const app = createClientApp({ name: 'friday' })
      .onNotification(methods.client.session.update, ({ params }) => {
        if (this.alive && this.generation === generation) this.dispatchUpdate(params)
      })
      .onRequest(methods.client.session.requestPermission, ({ params, signal }) => this.opts.onPermission(params, signal))

    const t = this.opts.transport
    if (t.kind === 'spawn') {
      const child = spawn(t.command, t.args, {
        cwd: t.cwd,
        env: t.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      this.child = child
      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8').trimEnd()
        if (text) this.log.debug('dsh stderr', { text: text.slice(0, 2000) })
      })
      child.on('exit', (code, signal) => {
        if (this.generation !== generation) return
        const wasAlive = this.alive
        this.alive = false
        this.log.warn('dsh process exited', { code, signal, stopping: this.stopping })
        if (wasAlive && !this.stopping) this.opts.onExit?.({ code, signal })
      })
      this.conn = app.connect(
        ndJsonStream(
          Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
          Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
        ),
      )
    } else {
      // 进程内连接（测试用 fake agent）：SDK 会在两个 App 之间架一对 TransformStream。
      this.conn = app.connect(t.agent)
    }
    this.alive = true
    if (!this.conn) throw new AcpRuntimeError('ACP 连接未建立', 'protocol')
    await this.conn.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: 'friday', version: '0.1.0' },
    })
    this.log.info('ACP initialized', { generation: this.generation })
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.alive = false
    try {
      this.conn?.close()
    } catch {
      /* ignore */
    }
    const child = this.child
    if (child && child.exitCode === null) {
      child.stdin.end()
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          resolve()
        }, 5000)
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
    this.child = undefined
    this.conn = undefined
    this.sessions.clear()
    this.pendingResumes.clear()
  }

  private agent() {
    if (!this.alive || !this.conn) throw new AcpRuntimeError('dsh 未运行', this.conn ? 'dead' : 'not-started')
    return this.conn.agent
  }

  private assertGeneration(generation: number): void {
    if (!this.alive || this.generation !== generation) {
      throw new AcpRuntimeError('ACP 进程已更换或停止', 'dead')
    }
  }

  private activeSession(sessionId: string): ActiveSession {
    const session = this.sessions.get(sessionId)
    if (!session || !this.isSessionActive(sessionId)) {
      throw new AcpRuntimeError('ACP 会话未激活', 'session-not-found')
    }
    return session
  }

  // ---- session 生命周期 ----

  async newSession(cwd: string, mcpServers: McpServer[] = []): Promise<string> {
    const generation = this.generation
    const res = await this.agent().request(methods.agent.session.new, { cwd, mcpServers })
    this.assertGeneration(generation)
    this.sessions.set(res.sessionId, { cwd, mcpServers, generation, configOptions: structuredClone(res.configOptions ?? undefined) })
    this.log.info('session created', { sessionId: res.sessionId, cwd })
    return res.sessionId
  }

  /**
   * 跨重启续接。dsh 校验 cwd 必须一致；找不到 session 时返回 false，让上层新建。
   */
  async resumeSession(sessionId: string, cwd: string, mcpServers: McpServer[] = []): Promise<boolean> {
    const generation = this.generation
    const pending = Symbol(sessionId)
    this.pendingResumes.set(sessionId, pending)
    try {
      const res = await this.agent().request(methods.agent.session.resume, { sessionId, cwd, mcpServers })
      this.assertGeneration(generation)
      if (this.pendingResumes.get(sessionId) !== pending) {
        throw new AcpRuntimeError('续接期间 ACP 会话已关闭或更换', 'session-not-found')
      }
      this.sessions.set(sessionId, { cwd, mcpServers, generation, configOptions: structuredClone(res.configOptions ?? undefined) })
    } catch (err) {
      if (isNotFoundError(err)) {
        this.log.warn('session not resumable', { sessionId, err: String(err) })
        return false
      }
      throw err
    } finally {
      if (this.pendingResumes.get(sessionId) === pending) this.pendingResumes.delete(sessionId)
    }
    this.log.info('session resumed', { sessionId, cwd })
    return true
  }

  /** 会话在当前进程里是否已激活（新建或已 resume）。 */
  isSessionActive(sessionId: string): boolean {
    const s = this.sessions.get(sessionId)
    return s !== undefined && s.generation === this.generation && this.alive
  }

  /** 仅返回当前进程中已激活会话的独立快照；未提供目录不等同空目录。 */
  sessionConfig(sessionId: string): SessionConfigSnapshot | undefined {
    if (!this.isSessionActive(sessionId)) return undefined
    const { generation, configOptions, contextOccupancy } = this.sessions.get(sessionId)!
    return structuredClone({ generation, configOptions, contextOccupancy })
  }

  async listSessions(cwd?: string): Promise<SessionInfo[]> {
    const out: SessionInfo[] = []
    let cursor: string | null | undefined
    do {
      const res = await this.agent().request(methods.agent.session.list, { cwd: cwd ?? null, cursor: cursor ?? null })
      out.push(...res.sessions)
      cursor = res.nextCursor
    } while (cursor)
    return out
  }

  async closeSession(sessionId: string): Promise<void> {
    // 先失效，关闭的 ACK 尚未回来时也不能接纳配置更新或发新 prompt。
    this.sessions.delete(sessionId)
    this.pendingResumes.delete(sessionId)
    this.listeners.delete(sessionId)
    await this.agent().request(methods.agent.session.close, { sessionId })
  }

  // ---- 消息 ----

  subscribe(sessionId: string, listener: UpdateListener): () => void {
    let set = this.listeners.get(sessionId)
    if (!set) {
      set = new Set()
      this.listeners.set(sessionId, set)
    }
    set.add(listener)
    return () => {
      set?.delete(listener)
    }
  }

  private dispatchUpdate(n: SessionNotification): void {
    if (!this.isSessionActive(n.sessionId)) return
    const session = this.sessions.get(n.sessionId)!
    if (n.update.sessionUpdate === 'config_option_update') {
      session.configOptions = structuredClone(n.update.configOptions)
    } else if (n.update.sessionUpdate === 'usage_update') {
      session.contextOccupancy = { used: n.update.used, size: n.update.size }
    }
    const set = this.listeners.get(n.sessionId)
    if (!set || set.size === 0) {
      this.log.debug('update without listener', { sessionId: n.sessionId, kind: n.update.sessionUpdate })
      return
    }
    for (const l of set) {
      try {
        l(n.update, n)
      } catch (err) {
        this.log.error('update listener threw', { err })
      }
    }
  }

  /**
   * 发一轮 prompt，阻塞到 turn 结束。超时或外部 abort 时发 session/cancel，
   * 然后仍等待 agent 返回（dsh 会以 stopReason=cancelled 收尾）。
   */
  async prompt(
    sessionId: string,
    prompt: ContentBlock[],
    opts: PromptOptions = {},
  ): Promise<PromptResponse> {
    // 闸门放在这里而不是各个调用方：定时任务、主动巡检、自检、夜间整理、轮末反思
    // 每一条都会发 prompt，漏掉任何一条，"全局上限"就不是全局的。
    // **超时计时在拿到许可之后才开始**——让人因为排队而超时，等于把拥塞
    // 伪装成失败，最难查的那种。
    const session = this.activeSession(sessionId)
    const releaseSlot = await this.gate.acquire(opts.onQueued, opts.signal)
    try {
      opts.signal?.throwIfAborted()
      opts.onStarted?.()
      if (this.activeSession(sessionId) !== session) {
        throw new AcpRuntimeError('排队期间 ACP 会话已更换', 'session-not-found')
      }
      return await this.promptNow(sessionId, prompt, opts)
    } finally {
      releaseSlot()
    }
  }

  /** 当前有几轮在跑、几轮在排队。`!status` 用。 */
  load(): { active: number; waiting: number; max: number } {
    return this.gate.load()
  }

  private async promptNow(
    sessionId: string,
    prompt: ContentBlock[],
    opts: PromptOptions = {},
  ): Promise<PromptResponse> {
    const agent = this.agent()
    opts.signal?.throwIfAborted()
    const guardResult: unknown = opts.beforeDispatch?.()
    if (guardResult && typeof (guardResult as PromiseLike<unknown>).then === 'function') {
      void Promise.resolve(guardResult).catch(() => undefined)
      throw new AcpRuntimeError('beforeDispatch 必须同步完成', 'protocol')
    }
    opts.signal?.throwIfAborted()
    let timer: NodeJS.Timeout | undefined
    let timedOut = false
    const onAbort = (): void => {
      void this.cancel(sessionId)
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true
        void this.cancel(sessionId)
      }, opts.timeoutMs)
    }
    try {
      const res = await agent.request(methods.agent.session.prompt, { sessionId, prompt })
      if (timedOut) throw new AcpRuntimeError(`任务超过 ${opts.timeoutMs}ms 被中止`, 'timeout')
      return res
    } finally {
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
    }
  }

  async cancel(sessionId: string): Promise<void> {
    if (!this.alive || !this.conn) return
    try {
      await this.conn.agent.notify(methods.agent.session.cancel, { sessionId })
    } catch (err) {
      this.log.warn('cancel failed', { sessionId, err })
    }
  }

  async setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<SetSessionConfigOptionResponse> {
    const session = this.activeSession(sessionId)
    const params: SetSessionConfigOptionRequest = typeof value === 'boolean'
      ? { sessionId, configId, value, type: 'boolean' }
      : { sessionId, configId, value }
    const res = await this.agent().request(methods.agent.session.setConfigOption, params)
    this.assertGeneration(session.generation)
    if (this.sessions.get(sessionId) !== session) throw new AcpRuntimeError('ACP 会话已关闭或重新激活', 'session-not-found')
    session.configOptions = structuredClone(res.configOptions)
    return res
  }
}

/**
 * dsh 对"续接不了"的会话回 JSON-RPC -32602（`session is not resumable: <id>` /
 * `session cwd does not match: <cwd>`），标准 ACP 实现回 -32002 resource_not_found。
 * 这两类都当作"需要新建"，其他错误（传输断开等）继续抛出。
 */
function isNotFoundError(err: unknown): boolean {
  const code = (err as { code?: number })?.code
  if (code === -32002 || code === -32602) return true
  const msg = String((err as { message?: string })?.message ?? err).toLowerCase()
  return (
    msg.includes('not found') ||
    msg.includes('not resumable') ||
    msg.includes('unknown session') ||
    msg.includes('no such session') ||
    msg.includes('does not match') ||
    msg.includes('resource_not_found')
  )
}

export function textBlock(text: string): ContentBlock {
  return { type: 'text', text }
}
