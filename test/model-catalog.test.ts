/**
 * 跑着的模型要在目录里登记。
 *
 * 真机上的样子：发一张截图 + 一句「这张图里的构建号是多少」，Friday 回
 * 「这张截图我读不了：当前只有一个不支持图片输入的模型」。
 * 图其实已经下载到工作区了（36KB 的 png 躺在 downloads/ 里），模型也确实读得了图——
 * 拿同一个端点、同一个模型名直接发 image block，它一字不差地答出了图里的构建号。
 *
 * 坏的是目录：dsh 自带的 advisory catalog 只有 `deepseek-flash` 和 `deepseek-v4-pro`，
 * 我们在跑的 `deepseek-v4-flash` 不在里面。不在里面 → `inputModalities` 缺省成 `["text"]`
 * → `read_image` 在 `assertImageCapableRoute` 处抛 "does not declare image input"
 * → 模型把这句转述成「我没有视觉模型」。一句听起来像硬件限制的话，其实是一行配置漏了。
 *
 * 所以这组用例守的不是"列全已知模型"，而是这条规则：
 * **启动时会用哪个模型，目录里就得有哪个模型**；没有就别启动，别带着这个洞上线。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MODEL_DEFAULTS, ModelCatalogError, assertConfiguredModelsCatalogued,
  catalogueModelIds, configuredDeepseekModels,
} from '../src/core/model-catalog.js'

const PATCH = join(import.meta.dirname, '..', 'profiles', 'friday', 'cordis.patch.yml')
const patch = (): string => readFileSync(PATCH, 'utf8')

/** dump-config 的形状：顶层数组，每项一个插件。 */
function dump(models: { id: string; inputModalities?: string[] }[] | undefined, over: Record<string, unknown> = {}): string {
  const entry: Record<string, unknown> = { id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek', ...over }
  if (models) entry.config = { models }
  return JSON.stringify([{ id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' }, entry])
}

describe('发布出去的 profile 必须把在跑的模型说清楚', () => {
  it('目录覆盖了两个默认模型——少一个，人的截图就读不了', () => {
    const ids = catalogueModelIds(patch())
    expect(ids).toBeDefined()
    expect(ids).toContain(MODEL_DEFAULTS.acpModel)
    expect(ids).toContain(MODEL_DEFAULTS.agentModel)
  })

  it('ACP 跑的那个模型声明了收图——这正是当初漏掉的那一行', () => {
    const text = patch()
    const at = text.indexOf(`id: ${MODEL_DEFAULTS.acpModel}`)
    expect(at).toBeGreaterThan(-1)
    // 取这一条目录项到下一条之间的片段，别让隔壁模型的声明蒙混过关
    const next = text.indexOf('- id:', at)
    const block = text.slice(at, next === -1 ? undefined : next)
    expect(block).toMatch(/inputModalities:\s*\[\s*text\s*,\s*image\s*\]/)
  })

  it('目录是整体替换，所以 dsh 自带的两个也要写回来', () => {
    // 替换掉却不写回来，等于顺手把别人能用的模型删了。
    expect(catalogueModelIds(patch())).toEqual(expect.arrayContaining(['deepseek-flash', 'deepseek-v4-pro']))
  })

  it('profile 里写死的默认值和代码里的常量是同一个——两边飘了，检查就查错了对象', () => {
    const text = patch()
    expect(text).toContain(`process.env.FRIDAY_ACP_MODEL ?? '${MODEL_DEFAULTS.acpModel}'`)
    expect(text).toContain(`process.env.FRIDAY_MODEL ?? '${MODEL_DEFAULTS.agentModel}'`)
    expect(text).toContain(`process.env.FRIDAY_MODEL_PROVIDER ?? '${MODEL_DEFAULTS.provider}'`)
  })
})

describe('这次启动到底会用哪些模型', () => {
  it('什么都不配就是那两个默认值', () => {
    expect(configuredDeepseekModels({}).sort()).toEqual([MODEL_DEFAULTS.agentModel, MODEL_DEFAULTS.acpModel].sort())
  })

  it('两处指到同一个模型时只算一次', () => {
    expect(configuredDeepseekModels({ FRIDAY_MODEL: 'same', FRIDAY_ACP_MODEL: 'same' })).toEqual(['same'])
  })

  it('FRIDAY_MODEL 会兜住没单独配的那一路', () => {
    // profile 里 ACP 的 model 是 FRIDAY_ACP_MODEL ?? 默认值，但 config.ts 的透传让 FRIDAY_MODEL 也能生效
    expect(configuredDeepseekModels({ FRIDAY_MODEL: 'shared' })).toEqual(['shared'])
  })

  it('换到别的 provider 就不归这份目录管——别对着不相干的目录报错', () => {
    expect(configuredDeepseekModels({ FRIDAY_MODEL_PROVIDER: 'openai-compatible' })).toEqual([])
    expect(configuredDeepseekModels({ FRIDAY_ACP_MODEL_PROVIDER: 'openai-compatible' }))
      .toEqual([MODEL_DEFAULTS.agentModel])
  })

  it('只有空白的配置当成没配', () => {
    expect(configuredDeepseekModels({ FRIDAY_ACP_MODEL: '   ' })).toContain(MODEL_DEFAULTS.acpModel)
  })
})

describe('目录里没有就别启动', () => {
  it('登记了就放行', () => {
    expect(assertConfiguredModelsCatalogued(dump([{ id: 'a' }, { id: 'b' }]), ['a'])).toBeUndefined()
  })

  it('没登记就抛错，并且把缺的那个名字说出来', () => {
    // 这里不抛的话，下一个发截图的人只会收到一句「我没有视觉模型」，没人查得到是配置漏了。
    expect(() => assertConfiguredModelsCatalogued(dump([{ id: 'a' }]), ['a', 'newcomer']))
      .toThrow(/newcomer/)
    try {
      assertConfiguredModelsCatalogued(dump([{ id: 'a' }]), ['newcomer'])
    } catch (err) {
      expect(err).toBeInstanceOf(ModelCatalogError)
      expect((err as ModelCatalogError).missing).toEqual(['newcomer'])
      expect(String(err)).toContain('read_image')
    }
  })

  it('没有要核的模型（换了 provider）就什么都不做', () => {
    expect(assertConfiguredModelsCatalogued(dump(undefined), [])).toBeUndefined()
  })
})

describe('读不懂目录，只告警不拦启动', () => {
  /**
   * "证明不了"和"证明有问题"是两回事。dsh 升级改了插件 id，
   * 按"证明不了就拦"处理就是一次没必要的生产事故——上一次网关挂掉正是这么来的。
   */
  it('dump 里根本没有 llm-deepseek', () => {
    expect(assertConfiguredModelsCatalogued(JSON.stringify([{ id: 'tool-bash' }]), ['x'])).toEqual({ unverified: true })
  })

  it('有插件但没声明 models（就是在吃 dsh 自带的默认目录）', () => {
    expect(assertConfiguredModelsCatalogued(dump(undefined), ['x'])).toEqual({ unverified: true })
  })

  it('插件被关掉了', () => {
    expect(assertConfiguredModelsCatalogued(dump([{ id: 'a' }], { disabled: true }), ['x'])).toEqual({ unverified: true })
  })

  it('YAML 坏了', () => {
    expect(assertConfiguredModelsCatalogued('{{{ not yaml', ['x'])).toEqual({ unverified: true })
  })

  it('!!js 当惰性数据读，绝不求值', () => {
    const yaml = "- id: llm-deepseek\n  config:\n    models:\n      - id: !!js process.exit(1)\n      - id: real\n"
    // 求值了这个进程就没了；活着跑完并且只认得那个字符串 id，就说明没求值
    expect(catalogueModelIds(yaml)).toEqual(['real'])
  })

  it('超大 dump 直接判为读不懂，不去啃它', () => {
    expect(catalogueModelIds('x'.repeat(17 * 1024 * 1024))).toBeUndefined()
  })
})
