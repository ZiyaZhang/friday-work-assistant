import type { ContentBlock, McpServer, PromptResponse, SessionInfo, SetSessionConfigOptionResponse } from '@agentclientprotocol/sdk'
import { Gate } from '../core/gate.js'
import { AcpRuntime, AcpRuntimeError, DEFAULT_MAX_CONCURRENT,
  type AcpRuntimeClient, type AcpRuntimeOptions, type PromptOptions,
  type SessionConfigSnapshot, type UpdateListener } from './runtime.js'

export type AcpRuntimeMode = 'workspace' | 'managed'

/** Host-owned persistent mapping. bindOnce must synchronously reject a different existing mode. */
export interface AcpRuntimeBindings {
  get(sessionId: string): AcpRuntimeMode | undefined
  bindOnce(sessionId: string, mode: AcpRuntimeMode): void
}

export interface AcpRuntimePoolOptions {
  workspace: Omit<AcpRuntimeOptions, 'gate' | 'maxConcurrent'>
  managed: Omit<AcpRuntimeOptions, 'gate' | 'maxConcurrent'>
  bindings: AcpRuntimeBindings
  maxConcurrent?: number
}

/** Two fixed processes, one prompt budget. ACP IDs retain their original process across restarts. */
export class AcpRuntimePool implements AcpRuntimeClient {
  private readonly runtimes: Record<AcpRuntimeMode, AcpRuntime>
  private readonly gate: Gate
  private readonly starting = new Map<AcpRuntimeMode, Promise<void>>()
  private readonly stopping = new Map<AcpRuntimeMode, Promise<void>>()
  private readonly epochs: Record<AcpRuntimeMode, number> = { workspace: 0, managed: 0 }

  constructor(private readonly opts: AcpRuntimePoolOptions) {
    this.gate = new Gate(Math.max(1, opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT))
    this.runtimes = {
      workspace: new AcpRuntime({ ...opts.workspace, gate: this.gate }),
      managed: new AcpRuntime({ ...opts.managed, gate: this.gate }),
    }
  }

  // Catalog discovery remains a workspace fact; per-session generation comes from its own process.
  get isAlive(): boolean { return this.isModeReady('workspace') }
  get currentGeneration(): number { return this.runtimes.workspace.currentGeneration }
  start(): Promise<void> { return this.startMode('workspace') }

  startMode(mode: AcpRuntimeMode): Promise<void> {
    if (this.stopping.has(mode)) return Promise.reject(new AcpRuntimeError('ACP 进程正在停止', 'dead'))
    const pending = this.starting.get(mode)
    if (pending) return pending
    const runtime = this.runtimes[mode]
    if (runtime.isAlive) return Promise.resolve()
    const epoch = this.epochs[mode]
    const operation = runtime.start().then(() => {
      if (this.epochs[mode] !== epoch || !runtime.isAlive) throw new AcpRuntimeError('ACP 启动期间已停止', 'dead')
    }).catch(async (error: unknown) => {
      // A failed initialize is not a usable process, even if its transport is still open.
      if (this.epochs[mode] === epoch) await this.stopMode(mode)
      throw error
    }).finally(() => {
      if (this.starting.get(mode) === operation) this.starting.delete(mode)
    })
    this.starting.set(mode, operation)
    return operation
  }

  stopMode(mode: AcpRuntimeMode): Promise<void> {
    const pending = this.stopping.get(mode)
    if (pending) return pending
    this.epochs[mode] += 1
    const operation = this.runtimes[mode].stop().finally(() => {
      if (this.stopping.get(mode) === operation) this.stopping.delete(mode)
    })
    this.stopping.set(mode, operation)
    return operation
  }

  async stop(): Promise<void> {
    const results = await Promise.allSettled([this.stopMode('workspace'), this.stopMode('managed')])
    for (const result of results) if (result.status === 'rejected') throw result.reason
  }

  /** Startup migration only: caller must identify a genuine pre-pool Registry session. */
  registerLegacyWorkspace(sessionId: string): void { this.bind(sessionId, 'workspace') }

  modeForSession(sessionId: string): AcpRuntimeMode | undefined { return this.opts.bindings.get(sessionId) }

  newSession(cwd: string, mcpServers: McpServer[] = []): Promise<string> {
    return this.newSessionFor('workspace', cwd, mcpServers)
  }

  async newSessionFor(mode: AcpRuntimeMode, cwd: string, mcpServers: McpServer[] = []): Promise<string> {
    const runtime = this.readyRuntime(mode)
    const generation = runtime.currentGeneration
    const id = await runtime.newSession(cwd, mcpServers)
    try {
      if (runtime.currentGeneration !== generation || !runtime.isSessionActive(id)) {
        throw new AcpRuntimeError('ACP 会话登记前已停止或更换', 'dead')
      }
      this.bind(id, mode)
      return id
    } catch (error) {
      await runtime.closeSession(id).catch(() => undefined)
      throw error
    }
  }

  async resumeSession(sessionId: string, cwd: string, mcpServers: McpServer[] = []): Promise<boolean> {
    const mode = this.modeForSession(sessionId)
    if (mode === undefined) throw this.unknownSession()
    return this.resumeSessionFor(mode, sessionId, cwd, mcpServers)
  }

  async resumeSessionFor(mode: AcpRuntimeMode, sessionId: string, cwd: string, mcpServers: McpServer[] = []): Promise<boolean> {
    if (this.modeForSession(sessionId) !== mode) throw this.unknownSession()
    return this.readyRuntime(mode).resumeSession(sessionId, cwd, mcpServers)
  }

  isSessionActive(sessionId: string): boolean {
    const mode = this.modeForSession(sessionId)
    return mode !== undefined && this.isModeReady(mode) && this.runtimes[mode].isSessionActive(sessionId)
  }

  sessionConfig(sessionId: string): SessionConfigSnapshot | undefined {
    const mode = this.modeForSession(sessionId)
    return mode === undefined ? undefined : this.runtimes[mode].sessionConfig(sessionId)
  }

  listSessions(cwd?: string): Promise<SessionInfo[]> { return this.runtimes.workspace.listSessions(cwd) }
  async closeSession(sessionId: string): Promise<void> { return this.forSession(sessionId).closeSession(sessionId) }
  subscribe(sessionId: string, listener: UpdateListener): () => void { return this.forSession(sessionId).subscribe(sessionId, listener) }
  async prompt(sessionId: string, prompt: ContentBlock[], opts?: PromptOptions): Promise<PromptResponse> {
    return this.forSession(sessionId).prompt(sessionId, prompt, opts)
  }
  load(): { active: number; waiting: number; max: number } { return this.gate.load() }
  async cancel(sessionId: string): Promise<void> { return this.forSession(sessionId).cancel(sessionId) }
  async setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<SetSessionConfigOptionResponse> {
    return this.forSession(sessionId).setConfigOption(sessionId, configId, value)
  }

  private bind(sessionId: string, mode: AcpRuntimeMode): void {
    const previous = this.modeForSession(sessionId)
    if (previous !== undefined && previous !== mode) throw this.unknownSession()
    this.opts.bindings.bindOnce(sessionId, mode)
    if (this.modeForSession(sessionId) !== mode) throw this.unknownSession()
  }

  private forSession(sessionId: string): AcpRuntime {
    const mode = this.modeForSession(sessionId)
    if (mode === undefined) throw this.unknownSession()
    return this.runtimes[mode]
  }

  private isModeReady(mode: AcpRuntimeMode): boolean {
    return this.runtimes[mode].isAlive && !this.starting.has(mode) && !this.stopping.has(mode)
  }

  private readyRuntime(mode: AcpRuntimeMode): AcpRuntime {
    if (!this.isModeReady(mode)) throw new AcpRuntimeError('ACP 进程尚未完成启动', 'not-started')
    return this.runtimes[mode]
  }

  private unknownSession(): AcpRuntimeError { return new AcpRuntimeError('ACP 会话缺少匹配的运行模式绑定', 'session-not-found') }
}
