import type { McpServer } from '@agentclientprotocol/sdk'
import type { AcpRuntimeClient } from '../acp/runtime.js'
import type { AcpRuntimeMode, AcpRuntimePool } from '../acp/runtime-pool.js'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import type { Registry, SessionRow } from './registry.js'
import type { RunAttempts } from './run-attempts.js'
import type { RuntimeContexts } from './runtime-contexts.js'
import type { SourceContexts } from './source-context.js'
import type { SkillProposals } from './skills.js'
import type { Spaces } from './space.js'
import type { SourceContext } from './source-context.js'
import { ExecutionMaterialError, type ExecutionMaterials } from './execution-materials.js'
import { RuntimeBindings } from './runtime-bindings.js'
import { ExecutionModePolicyError } from './execution-mode-policy.js'

export interface ManagedExecution {
  runtime: Pick<AcpRuntimePool, 'startMode' | 'modeForSession' | 'newSessionFor' | 'resumeSessionFor'>
  root: string
  profileDigest: string
  files: ExecutionMaterials
}

interface ManagedSession { profileDigest: string; cwd: string }

export interface PreparedExecutionSession {
  acpSessionId: string
  fresh: boolean
  reset: boolean
  historyMode: 'continue' | 'rebuild'
  mode: AcpRuntimeMode
  /** Rechecks the exact Run and, when old history is continued, its source authorization. Call after every await before dispatch. */
  assertCurrent(): void
}

/** A still-valid authorization for previously recorded sources; false means the old history is not eligible. */
export type SourceAuthorization = false | { assertCurrent(): void }

/** Owns ACP admission and rebinding. Business work, queues and final delivery stay with their applications. */
export class ExecutionSessions {
  constructor(private readonly deps: {
    runtime: AcpRuntimeClient
    registry: Registry
    attempts: RunAttempts
    contexts: RuntimeContexts
    sources: SourceContexts
    spaces: Spaces
    skills?: SkillProposals
    managed?: ManagedExecution
    /** Host-owned policy takes precedence over any per-call compatibility mode. */
    selectMode?: (runId: string) => AcpRuntimeMode
  }) {}

  async prepare(input: {
    session: SessionRow
    runId: string
    trackSources: boolean
    mode?: AcpRuntimeMode
    assertCurrent(): void
    mcpServers(): McpServer[]
    /** Checks the current personal-space admission, then any exact old memory versions. */
    authorizeMemory(acpSessionId: string | null): Promise<boolean>
    /** The returned guard is re-run after every later await; a failure rebuilds a clean context instead of continuing. */
    authorizeSources?(sources: SourceContext): Promise<SourceAuthorization>
    readScopes(): readonly string[]
  }): Promise<PreparedExecutionSession> {
    const { runtime, registry, attempts, contexts, sources, spaces, skills } = this.deps
    const { session, runId } = input
    const attempt = attempts.get(runId)
    if (!attempt || !attempt.workKey || attempt.sessionKey !== session.sessionKey) throw new Error('执行与当前事项不匹配')
    const mode = this.deps.selectMode?.(runId) ?? input.mode ?? 'workspace', managed = this.deps.managed
    const check = () => {
      input.assertCurrent()
      const current = attempts.get(runId)
      if (!current || current.state !== 'running' || current.workKey !== attempt.workKey || current.sessionKey !== session.sessionKey) {
        throw new Error('执行与当前事项不匹配')
      }
      if (this.deps.selectMode && this.deps.selectMode(runId) !== mode) throw new ExecutionModePolicyError('mode_changed')
    }
    if (mode === 'managed' && !managed) throw new ExecutionModePolicyError('managed_unavailable')
    check()
    if (mode === 'managed') await managed!.runtime.startMode(mode)
    else if (!runtime.isAlive) await runtime.start()
    check()
    const mcpServers = input.mcpServers()
    // A person's private chat is one continuous conversation (2026-09-29): its ACP carries every Work of that chat, so
    // the model keeps what was said and answered across requests, like OpenClaw's main session. Elsewhere conversation
    // membership is not Work ownership: check all recorded users of this ACP, and a legacy history already shared by
    // several Works cannot be safely resumed.
    const sameWork = !session.acpSessionId || (session.chatType === 'p2p'
      ? this.historyBelongsToConversation(session.acpSessionId, session.sessionKey)
      : this.historyBelongsTo(session.acpSessionId, session.sessionKey, attempt.workKey))
    const manifest = sources.get(session.sessionKey)
    const origin = spaces.byChat(session.chatId)
    let sourceKnown = sameWork && (!input.trackSources || Boolean(manifest && manifest.acpSessionId === session.acpSessionId
      && manifest.spaceId === origin?.id && manifest.chatId === session.chatId))
    let sourceGuard: (() => void) | undefined
    if (sourceKnown && manifest && input.authorizeSources) {
      const access = await input.authorizeSources(manifest)
      if (access === false) sourceKnown = false
      else sourceGuard = () => access.assertCurrent()
    }
    check()
    // The Run guard is separate: a stopped Run must fail, while a changed source grant only drops the old history.
    const dropStaleSources = (): void => {
      if (!sourceGuard) return
      try { sourceGuard() } catch { sourceKnown = false; sourceGuard = undefined }
    }
    const dispatchGuard = (continued: boolean): (() => void) => {
      const guard = continued ? sourceGuard : undefined
      return () => { check(); guard?.() }
    }
    const skillSet = skills?.getRunSkillSet(runId)
    // Do not authorize/admit another Work's memory into the new Run. Null still lets
    // the host validate this person's current space before a fresh context is created.
    const sourceMemoryKnown = await input.authorizeMemory(sameWork ? session.acpSessionId : null)
    check(); dropStaleSources()
    const memoryKnown = sameWork && sourceMemoryKnown && (!session.acpSessionId || contexts.canResume(session.sessionKey, session.acpSessionId, runId))
    const previousSkills = registry.getKv(`runtime-skills:${session.sessionKey}`)
    const skillsKnown = !skills || Boolean(skillSet && previousSkills === JSON.stringify({ acpSessionId: session.acpSessionId, digest: skillSet.digest }))
    // Persistent mode survives disabling the managed runtime; only unregistered legacy IDs default to workspace.
    const previousMode = session.acpSessionId ? new RuntimeBindings(registry).get(session.acpSessionId) ?? 'workspace' : mode
    const previousExecution = session.acpSessionId && mode === 'managed' ? this.managedSession(session.acpSessionId) : undefined
    const sameMode = previousMode === mode && (mode !== 'managed' || Boolean(previousExecution &&
      previousExecution.profileDigest === managed!.profileDigest && previousExecution.cwd.startsWith(managed!.root + '/')))
    let generationKnown = true
    const checkPreviousGeneration = (): void => {
      if (mode !== 'managed' || !session.acpSessionId) return
      if (!origin) throw new Error('执行空间不存在')
      // Host-only metadata check, guarded by the current Run before it is bound to an ACP.
      managed!.files.list({ sessionKey: session.sessionKey, spaceId: origin.id,
        generation: session.acpSessionId, runId, assertCurrent: check }, { limit: 1 })
    }
    const bind = (id: string): void => {
      check()
      if (!attempts.bindRuntime(runId, id)) throw new Error('执行已结束')
      contexts.bind(runId, session.sessionKey, id)
      if (skillSet) registry.setKv(`runtime-skills:${session.sessionKey}`, JSON.stringify({ acpSessionId: id, digest: skillSet.digest }))
    }
    if (session.acpSessionId) {
      // DSH replaces Run credentials only after close/resume; the old source manifest remains intact.
      if (runtime.isSessionActive(session.acpSessionId)) {
        await runtime.closeSession(session.acpSessionId)
        check(); dropStaleSources()
      }
      if (sameMode && sourceKnown && skillsKnown && memoryKnown) {
        try { checkPreviousGeneration() }
        catch (error) {
          if (!(error instanceof ExecutionMaterialError) || error.code !== 'generation_invalid') throw error
          generationKnown = false
        }
      }
      if (sameMode && sourceKnown && skillsKnown && memoryKnown && generationKnown) {
        const resumed = mode === 'managed'
          ? await managed!.runtime.resumeSessionFor(mode, session.acpSessionId, previousExecution!.cwd, mcpServers)
          : await runtime.resumeSession(session.acpSessionId, session.cwd, mcpServers)
        if (resumed) {
          try { check(); dropStaleSources() }
          catch (error) { await runtime.closeSession(session.acpSessionId).catch(() => undefined); throw error }
          if (sourceKnown) {
            try { this.registration(() => { checkPreviousGeneration(); bind(session.acpSessionId!) }) }
            catch (error) { await runtime.closeSession(session.acpSessionId).catch(() => undefined); throw error }
            return { acpSessionId: session.acpSessionId, fresh: false, reset: false, historyMode: 'continue', mode, assertCurrent: dispatchGuard(true) }
          }
          // The resumed history is no longer authorized: release it and start a clean context below.
          await runtime.closeSession(session.acpSessionId).catch(() => undefined)
        }
        check()
      }
    }
    check()
    let cwd = session.cwd
    if (mode === 'managed') {
      mkdirSync(managed!.root, { recursive: true, mode: 0o700 })
      cwd = mkdtempSync(join(managed!.root, 'session-'))
    }
    const id = mode === 'managed' ? await managed!.runtime.newSessionFor(mode, cwd, mcpServers)
      : await runtime.newSession(cwd, mcpServers)
    try {
      check()
      // A clean context never inherits a grant that failed after preflight.
      dropStaleSources()
      this.registration(() => {
        bind(id)
        if (mode === 'managed') {
          registry.setKv(`managed-execution:${id}`, JSON.stringify({ cwd, profileDigest: managed!.profileDigest }))
          if (!origin) throw new Error('执行空间不存在')
          managed!.files.openGeneration({ sessionKey: session.sessionKey, spaceId: origin.id, generation: id, runId, assertCurrent: check })
        }
        check()
        registry.updateSession(session.sessionKey, { acpSessionId: id })
        if (input.trackSources) {
          const currentOrigin = spaces.byChat(session.chatId)
          if (currentOrigin) sources.initialize({ sessionKey: session.sessionKey, acpSessionId: id,
            spaceId: currentOrigin.id, chatId: session.chatId }, input.readScopes())
        }
      })
    } catch (error) {
      await runtime.closeSession(id).catch(() => undefined)
      throw error
    }
    // New ACPs have no prior transcript, including when a same-Work resume failed.
    // The host reconstructs this Work's admitted inputs instead of replaying a conversation.
    return { acpSessionId: id, fresh: true, reset: Boolean(session.acpSessionId), historyMode: 'rebuild', mode,
      assertCurrent: dispatchGuard(false) }
  }

  /** Every Run recorded on this ACP came from this same conversation (any Work of it). */
  private historyBelongsToConversation(acpSessionId: string, sessionKey: string): boolean {
    const row = this.deps.registry.db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN session_key = ? THEN 1 ELSE 0 END) AS owned FROM run_attempts WHERE acp_session_id = ?`).get(sessionKey, acpSessionId)
    return Boolean(row && Number(row.total) > 0 && Number(row.total) === Number(row.owned))
  }

  private historyBelongsTo(acpSessionId: string, sessionKey: string, workKey: string): boolean {
    const row = this.deps.registry.db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN session_key = ? AND work_key = ? THEN 1 ELSE 0 END) AS owned
      FROM run_attempts WHERE acp_session_id = ?`).get(sessionKey, workKey, acpSessionId)
    return Boolean(row && Number(row.total) > 0 && Number(row.total) === Number(row.owned))
  }

  /** Run, context, skill, material-generation and source bindings commit together; the runtime handle is closed by the caller on failure. */
  private registration<T>(action: () => T): T {
    const db = this.deps.registry.db
    db.exec('SAVEPOINT execution_session_registration')
    try { const result = action(); db.exec('RELEASE execution_session_registration'); return result }
    catch (error) { db.exec('ROLLBACK TO execution_session_registration; RELEASE execution_session_registration'); throw error }
  }

  private managedSession(id: string): ManagedSession | undefined {
    const raw = this.deps.registry.getKv(`managed-execution:${id}`)
    if (!raw) return undefined
    const value = JSON.parse(raw) as ManagedSession
    return value
  }
}
