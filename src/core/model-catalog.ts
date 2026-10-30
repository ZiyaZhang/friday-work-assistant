/**
 * 跑着的那个模型，必须在模型目录里说清楚自己能吃什么。
 *
 * 真机上撞到的：人发来一张截图 + 一句话，Friday 说「我没有支持图片输入的模型」。
 * 图其实已经下载好了，模型也确实读得了图——实测同一个端点、同一个模型名发 image block 能答对。
 * 坏在目录：dsh 自带的 advisory catalog 只认 `deepseek-flash` 和 `deepseek-v4-pro`，
 * **我们实际在跑的 `deepseek-v4-flash` 根本不在里面**。不在目录里，`inputModalities` 就缺省成 `["text"]`，
 * `read_image` 在 `assertImageCapableRoute` 处直接拒绝，模型只能把那句错误转述成「我没有视觉模型」。
 *
 * 所以这里要守的不是"把已知模型列全"——那是枚举，下一个新模型照样掉进同一个坑。
 * 要守的是这条规则：**Friday 启动时会用哪个模型，目录里就必须有哪个模型**。
 * 有人把 FRIDAY_ACP_MODEL 指到一个没登记的新模型，启动就该失败，而不是等几个月后
 * 某个同事发来一张截图、得到一句莫名其妙的「我读不了图」。
 *
 * 一个例外是刻意留的：如果目录本身的形状读不懂（比如 dsh 升级改了插件 id），
 * 那是"证明不了"而不是"证明有问题"，只告警不拦启动——拦了就是一次没必要的生产事故。
 */
import { parseDocument } from 'yaml'

/** 不配环境变量时 profile 里写死的那几个默认值；`test/model-catalog.test.ts` 守住它们和 profile 一致。 */
export const MODEL_DEFAULTS = {
  provider: 'deepseek-official',
  /** `- id: acp` 的 model */
  acpModel: 'deepseek-v4-flash',
  /** `- id: agent-default-model` 的 model */
  agentModel: 'deepseek-flash',
} as const

/** 只有这个 provider 的模型走 dsh 自带的 llm-deepseek 目录。 */
const DEEPSEEK_PROVIDER = MODEL_DEFAULTS.provider

export class ModelCatalogError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`模型 ${missing.join('、')} 没有登记在 DSH 的模型目录里。`
      + '没登记的模型会被当成只收文字，read_image 会拒绝看图，人发来的截图就读不了。'
      + '请在 profiles/friday/cordis.patch.yml 的 llm-deepseek.models 里补上它，'
      + '并按实测结果写明 inputModalities。')
    this.name = 'ModelCatalogError'
  }
}

/** Friday 这次启动实际会用到的 deepseek 模型；别的 provider 不归这份目录管。 */
export function configuredDeepseekModels(env: NodeJS.ProcessEnv): string[] {
  const pick = (providerKey: string, modelKey: string, dfltModel: string): string | undefined => {
    const provider = env[providerKey]?.trim() || env.FRIDAY_MODEL_PROVIDER?.trim() || MODEL_DEFAULTS.provider
    if (provider !== DEEPSEEK_PROVIDER) return undefined
    return env[modelKey]?.trim() || env.FRIDAY_MODEL?.trim() || dfltModel
  }
  const ids = [
    pick('FRIDAY_ACP_MODEL_PROVIDER', 'FRIDAY_ACP_MODEL', MODEL_DEFAULTS.acpModel),
    pick('FRIDAY_MODEL_PROVIDER', 'FRIDAY_MODEL', MODEL_DEFAULTS.agentModel),
  ].filter((id): id is string => Boolean(id))
  return [...new Set(ids)]
}

/** 读得懂的目录，或者读不懂时的 undefined——两者要分开，因为后者不该拦启动。 */
export function catalogueModelIds(dump: string): string[] | undefined {
  let tree: unknown
  try {
    if (Buffer.byteLength(dump) > 16 * 1024 * 1024) return undefined
    // !!js 当成惰性数据读，绝不求值；dump 里可能有模型凭据，任何原文都不许漏出去。
    const document = parseDocument(dump, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => ({ unevaluatedJs: value }) }] })
    if (document.errors.length) return undefined
    tree = document.toJS({ maxAliasCount: 100 })
  } catch { return undefined }
  const ids: string[] = []
  const seen = new Set<unknown>()
  let count = 0
  let found = false
  const visit = (rows: unknown, parentActive: boolean): void => {
    if (!Array.isArray(rows) || seen.has(rows)) return
    seen.add(rows)
    for (const row of rows) {
      if (++count > 10_000 || !row || typeof row !== 'object' || Array.isArray(row)) return
      const entry = row as Record<string, unknown>
      const active = parentActive && entry.disabled !== true
      if (entry.group === true) { visit(entry.config, active); continue }
      if (!active) continue
      if (entry.id !== 'llm-deepseek' && entry.name !== '@deepseek-ai/dsh-llm-deepseek') continue
      const config = entry.config
      if (!config || typeof config !== 'object' || Array.isArray(config)) continue
      const models = (config as Record<string, unknown>).models
      if (!Array.isArray(models)) continue
      found = true
      for (const model of models) {
        if (model && typeof model === 'object' && !Array.isArray(model)) {
          const id = (model as Record<string, unknown>).id
          if (typeof id === 'string' && id) ids.push(id)
        }
      }
    }
  }
  visit(tree, true)
  return found ? ids : undefined
}

/**
 * 目录读得懂却没有我们要跑的模型 → 抛错，不让它带着"读不了图"上线。
 * 目录压根读不懂 → 交给调用方记一条告警：证明不了不等于有问题。
 */
export function assertConfiguredModelsCatalogued(dump: string, configured: readonly string[]): { unverified: true } | undefined {
  if (!configured.length) return undefined
  const catalogued = catalogueModelIds(dump)
  if (catalogued === undefined) return { unverified: true }
  const missing = configured.filter((id) => !catalogued.includes(id))
  if (missing.length) throw new ModelCatalogError(missing)
  return undefined
}
