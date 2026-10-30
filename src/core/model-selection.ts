import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { AcpRuntimeClient, SessionConfigSnapshot } from '../acp/runtime.js'
import type { Space, Spaces } from './space.js'
import type { RunModel, RunModels } from './run-models.js'

export interface ModelRoute { providerId: string; modelId: string; accountRef: string }
export interface ModelPolicy { defaultRoute: ModelRoute; allowed: ModelRoute[] }
export interface ModelChoice extends ModelRoute { value: string; label: string }
export class ModelSelectionError extends Error {
  constructor(readonly status: 400 | 409 | 503, readonly code: string, message: string) { super(message) }
}
const routeSchema = z.object({ providerId: z.string().min(1).max(200), modelId: z.string().min(1).max(300),
  accountRef: z.string().min(1).max(200) }).strict()

/** Configuration contains route IDs and non-secret account references only. */
export function parseModelPolicy(env: NodeJS.ProcessEnv): ModelPolicy {
  const defaultRoute = routeSchema.parse({ providerId: env.FRIDAY_ACP_MODEL_PROVIDER ?? 'deepseek-official',
    modelId: env.FRIDAY_ACP_MODEL ?? 'deepseek-v4-flash', accountRef: env.FRIDAY_MODEL_ACCOUNT ?? 'deployment' })
  let allowed: ModelRoute[] = [defaultRoute]
  if (env.FRIDAY_ALLOWED_MODELS) {
    try { allowed = z.array(routeSchema).min(1).parse(JSON.parse(env.FRIDAY_ALLOWED_MODELS)) }
    catch { throw new Error('FRIDAY_ALLOWED_MODELS 必须是包含 providerId、modelId、accountRef 的 JSON 数组') }
  }
  const keys = allowed.map(route => JSON.stringify([route.providerId, route.modelId]))
  if (new Set(keys).size !== keys.length || !allowed.some(route => sameRoute(route, defaultRoute))) {
    throw new Error('模型允许列表不能重复，并且必须包含默认模型及其账户引用')
  }
  return { defaultRoute, allowed }
}
function sameRoute(a: ModelRoute, b: ModelRoute) {
  return a.providerId === b.providerId && a.modelId === b.modelId && a.accountRef === b.accountRef
}
function decode(value: string): [string, string] | undefined {
  try {
    const parts: unknown = JSON.parse(value)
    if (Array.isArray(parts) && parts.length === 2 && parts.every(part => typeof part === 'string' && part.length)) return parts as [string, string]
  } catch { /* Unsupported selectors are not converted into a guessed route. */ }
  return undefined
}
function modelOption(snapshot: SessionConfigSnapshot | undefined) {
  const option = snapshot?.configOptions?.find(option => option.id === 'model')
  return option?.type === 'select' ? option : undefined
}
export function modelSelectionTag(space: Space): string {
  return createHash('sha256').update(JSON.stringify([space.id, space.kind, space.chatId, space.status,
    space.config.modelSelection !== undefined, space.config.modelSelection ?? null])).digest('hex')
}

/** Model choice is an application operation; permissions remain with the authenticated entrypoint. */
export class ModelApplication {
  private discovery?: SessionConfigSnapshot
  private discovering?: Promise<SessionConfigSnapshot>
  constructor(private readonly deps: {
    runtime: Pick<AcpRuntimeClient, 'start' | 'newSession' | 'closeSession' | 'sessionConfig' | 'setConfigOption' | 'currentGeneration'>
    spaces: Spaces; runs: RunModels; policy: () => ModelPolicy; now?: () => number
  }) {}

  private choices(snapshot: SessionConfigSnapshot | undefined): ModelChoice[] {
    const option = modelOption(snapshot)
    if (!option) throw new ModelSelectionError(503, 'model_catalog_unavailable', '暂时无法读取可用模型。')
    const items = option.options.flatMap(item => 'options' in item ? item.options : [item])
    return items.flatMap(item => {
      const pair = decode(item.value)
      const route = pair && this.deps.policy().allowed.find(route => route.providerId === pair[0] && route.modelId === pair[1])
      return route ? [{ ...route, value: item.value, label: item.name }] : []
    })
  }

  /** Metadata-only ACP session: no MCP credentials, prompt, business Task or model call. */
  private async discover(): Promise<SessionConfigSnapshot> {
    await this.deps.runtime.start()
    if (this.discovery?.generation === this.deps.runtime.currentGeneration) return this.discovery
    if (this.discovering) return this.discovering
    this.discovering = (async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'friday-model-catalog-'))
      let sessionId: string | undefined
      try {
        sessionId = await this.deps.runtime.newSession(cwd, [])
        const snapshot = this.deps.runtime.sessionConfig(sessionId)
        if (!snapshot || snapshot.generation !== this.deps.runtime.currentGeneration) throw new ModelSelectionError(503, 'model_catalog_unavailable', '模型目录已失效，请重试。')
        this.choices(snapshot)
        this.discovery = snapshot
        return snapshot
      } finally {
        if (sessionId) await this.deps.runtime.closeSession(sessionId).catch(() => undefined)
        await rm(cwd, { recursive: true, force: true })
      }
    })()
    try { return await this.discovering } finally { this.discovering = undefined }
  }

  async catalog(spaceId: string, assertCurrent: () => void) {
    assertCurrent()
    const snapshot = await this.discover()
    assertCurrent()
    const space = this.deps.spaces.get(spaceId)!
    return { generation: snapshot.generation, choices: this.choices(snapshot), tag: modelSelectionTag(space),
      selected: space.config.modelSelection?.value ?? null, defaultRoute: this.deps.policy().defaultRoute,
      legacyPreferences: space.config.models ?? null }
  }

  /** Synchronous persistence fits the same ConsoleOperations transaction as its receipt. */
  select(spaceId: string, input: { value: string | null; expectedTag: string; generation: number }) {
    const space = this.deps.spaces.get(spaceId)
    if (!space || space.status !== 'active' || modelSelectionTag(space) !== input.expectedTag) throw new ModelSelectionError(409, 'settings_changed', '空间设置已变化，请刷新后再修改。')
    if (!this.discovery || this.discovery.generation !== input.generation || input.generation !== this.deps.runtime.currentGeneration) throw new ModelSelectionError(409, 'model_catalog_changed', '模型目录已变化，请重新查看。')
    const choices = this.choices(this.discovery)
    if (input.value === null ? !choices.some(choice => sameRoute(choice, this.deps.policy().defaultRoute)) : !choices.some(choice => choice.value === input.value)) {
      throw new ModelSelectionError(400, 'model_not_allowed', '当前部署未提供这个模型。')
    }
    const changed = space.config.modelSelection === undefined || (space.config.modelSelection?.value ?? null) !== input.value
    const updated = this.deps.spaces.patchConfig(spaceId, { modelSelection: input.value === null ? null : { value: input.value } })!
    return { changed, tag: modelSelectionTag(updated) }
  }

  async prepare(runId: string, spaceId: string, sessionId: string, assertCurrent: () => void, deploymentDefault = false): Promise<RunModel> {
    assertCurrent()
    const { runtime, runs, spaces } = this.deps
    const existing = runs.get(runId)
    if (existing) { this.assertPin(existing); return existing }
    const snapshot = runtime.sessionConfig(sessionId)
    const choices = this.choices(snapshot)
    // Undefined has no selection intent. Null explicitly adopts the deployment default.
    // Background runs also have an explicit deployment-owned choice.
    const selection = deploymentDefault ? null : spaces.get(spaceId)?.config.modelSelection
    const choice = selection ? choices.find(choice => choice.value === selection.value) : choices.find(choice => sameRoute(choice, this.deps.policy().defaultRoute))
    if (!choice) throw new ModelSelectionError(503, 'model_not_allowed', '所选模型目前不可用，这次还没有开始执行。')
    if (selection === undefined && modelOption(snapshot)?.currentValue !== choice.value) {
      throw new ModelSelectionError(409, 'model_selection_required', '这个会话的模型与部署默认不同。请在空间模型设置里选择，或者跟我说一声用回默认。')
    }
    try { await runtime.setConfigOption(sessionId, 'model', choice.value) }
    catch {
      assertCurrent()
      throw new ModelSelectionError(503, 'model_configuration_failed', '模型设置未成功，这次还没有开始执行。')
    }
    assertCurrent()
    const current = runtime.sessionConfig(sessionId)
    if (!current || current.generation !== snapshot!.generation || modelOption(current)?.currentValue !== choice.value ||
      !this.deps.policy().allowed.some(route => sameRoute(route, choice))) {
      throw new ModelSelectionError(409, 'model_selection_changed', '模型设置未生效，这次还没有开始执行。')
    }
    return runs.prepare({ runId, acpSessionId: sessionId, runtimeGeneration: current.generation, selector: choice.value,
      providerId: choice.providerId, modelId: choice.modelId, accountRef: choice.accountRef, preparedAt: this.now() })
  }

  private assertPin(pin: RunModel) {
    const snapshot = this.deps.runtime.sessionConfig(pin.acpSessionId)
    if (!snapshot || snapshot.generation !== pin.runtimeGeneration || modelOption(snapshot)?.currentValue !== pin.selector ||
      !this.deps.policy().allowed.some(route => sameRoute(route, pin))) {
      throw new ModelSelectionError(409, 'run_model_changed', '本次执行的模型配置已变化，请重新发起。')
    }
  }
  admit(pin: RunModel) {
    this.assertPin(pin)
    if (!this.deps.runs.admit(pin.runId, pin, this.now())) throw new ModelSelectionError(409, 'run_ended', '本次执行已停止。')
  }
  observeContext(pin: RunModel, used: number, size: number) {
    this.deps.runs.observeContext(pin.runId, pin, { used, size, observedAt: this.now() })
  }
  private now() { return this.deps.now?.() ?? Date.now() }
}
