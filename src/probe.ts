/**
 * 部署后识别探测：用生产配置真跑一次入口识别，确认本人原话（例如「记住：…」）仍能被识别。
 * 只调识别模型：不读写数据库、不发消息、不碰任何会话。退出码 0 表示全部通过。
 * 进程 ready 不等于业务正常：意图识别失败时 /healthz 可能一直是好的。
 *
 *   node --no-warnings=ExperimentalWarning --env-file=.env dist/probe.js
 */
import type { IngressClassificationInput, IngressDecision } from './acp/ingress-classifier.js'

export interface ProbeCase { name: string; input: IngressClassificationInput; accept(decision: IngressDecision): boolean }
export interface ProbeResult { name: string; ok: boolean; kind?: string; error?: string; ms: number }

/** Synthetic sentences only; nothing here comes from a real conversation. */
export const PROBE_CASES: ProbeCase[] = [
  { name: 'explicit_preference',
    input: { message: { text: '记住：我习惯周五下午写周报，周五上午不要给我安排别的事' }, candidates: [], allowExplicitPreference: true },
    accept: decision => decision.kind === 'memory_save_preference' && decision.spans.length > 0 },
  { name: 'new_request',
    input: { message: { text: '帮我看看今天有哪些待办' }, candidates: [] },
    accept: decision => decision.kind === 'new_work' || decision.kind === 'work_request' || decision.kind === 'clarify' },
]

export async function runProbe(classify: (input: IngressClassificationInput) => Promise<IngressDecision>,
  cases: readonly ProbeCase[] = PROBE_CASES, now: () => number = Date.now): Promise<{ ok: boolean; results: ProbeResult[] }> {
  const results: ProbeResult[] = []
  for (const probe of cases) {
    const started = now()
    try {
      const decision = await classify(probe.input)
      results.push({ name: probe.name, ok: probe.accept(decision), kind: decision.kind, ms: now() - started })
    } catch (error) {
      const code = (error as { code?: unknown })?.code
      results.push({ name: probe.name, ok: false, error: typeof code === 'string' ? code : error instanceof Error ? error.message : String(error), ms: now() - started })
    }
  }
  return { ok: results.every(result => result.ok), results }
}

const isEntrypoint = process.argv[1] && /probe\.(js|ts)$/.test(process.argv[1])
if (isEntrypoint) {
  // The gateway modules load only when run as a command, so importing this file (tests) stays light.
  const [{ loadConfig }, { createLogger }, { createIngressClassifier }] = await Promise.all([import('./config.js'), import('./log.js'), import('./index.js')])
  const ingress = createIngressClassifier(loadConfig(), createLogger('probe', 'warn'))
  const finish = async (ok: boolean, output: unknown) => {
    process.stdout.write(`${JSON.stringify(output)}\n`)
    await ingress.close().catch(() => undefined)
    process.exit(ok ? 0 : 1)
  }
  await runProbe(input => ingress.classifier.classify(input))
    .then(result => finish(result.ok, result), error => finish(false, { ok: false, error: error instanceof Error ? error.message : String(error) }))
}
