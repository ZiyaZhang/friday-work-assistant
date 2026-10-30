#!/usr/bin/env node
import { PersonalMcpConnections } from './personal/mcp-connections.js'
import { createRemoteMcp } from './personal/mcp-transport.js'
import { GmailConnections, createGmailHttp, loadGmailConfig } from './gmail/connection.js'
import { PersonalDevices, ensurePersonalDeviceSchema } from './personal/devices.js'
import { PersonalDesktopBridge, createDesktopRelayFetch } from './personal/desktop-bridge.js'
import { GmailCollector } from './gmail/collector.js'
import { GmailMailbox } from './gmail/mailbox.js'
import { EmailDrafts } from './gmail/drafts.js'
import { GitHubUserConnections, loadConnectionKey, createGitHubUserHttp, loadGitHubUserConfig } from './github/user-connection.js'
/**
 * Friday 入口：网关 + 控制面 + dsh ACP 运行时，一个进程。
 *
 *   friday            正常启动
 *   friday --doctor   只做环境体检（dsh、profile、飞书凭证、工作区），不连长连接
 */
import { execFile, execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { loadConfig, type FridayConfig } from './config.js'
import { ConsoleAuth } from './web/console-auth.js'
import { createConsoleRouter } from './web/console-router.js'
import { HumanSpaceAccess } from './core/human-space-access.js'
import { ConsoleQueries } from './core/console-queries.js'
import { ConsoleCommands } from './core/console-commands.js'
import { ConsoleOperations } from './core/console-operations.js'
import { DeliveryReconciliation } from './core/delivery-reconciliation.js'
import { SpaceApplication } from './core/space-application.js'
import { TodoApplication } from './core/todo-application.js'
import { PersonalCollectionStore } from './core/personal-collection.js'
import { PersonalCollectionHost } from './core/personal-collection-host.js'
import { createLogger, type Logger } from './log.js'
import { AcpRuntime } from './acp/runtime.js'
import { AcpRuntimePool } from './acp/runtime-pool.js'
import { prepareManagedProfile } from './acp/managed-profile.js'
import { RuntimeBindings } from './core/runtime-bindings.js'
import { ExecutionMaterials } from './core/execution-materials.js'
import type { ManagedExecution } from './core/execution-sessions.js'
import { IngressClassifier } from './acp/ingress-classifier.js'
import { TextRunner } from './acp/text-runner.js'
import { FeishuClient } from './feishu/client.js'
import { FeishuMinutes } from './feishu/minutes.js'
import { ensureMinutesDraftSchema } from './core/minutes-drafts.js'
import { FeishuMeetings } from './feishu/meetings.js'
import { MeetingSessions } from './core/meeting-sessions.js'
import { Polls, ensurePollSchema } from './core/polls.js'
import { describeProxy } from './feishu/proxy.js'
import { startFeishuWs } from './feishu/ws.js'
import { Registry } from './core/registry.js'
import { ChannelMemory } from './core/memory.js'
import { MessageCache } from './core/message-cache.js'
import { MessageService } from './core/messages.js'
import { Todos } from './core/todos.js'
import { Identities } from './core/identities.js'
import { IdentityDirectory } from './core/identity-directory.js'
import { Bugs } from './core/bugs.js'
import { FeedbackControl } from './core/feedback-control.js'
import { BugQuestions } from './core/bug-questions.js'
import { DeliveryService } from './core/delivery.js'
import { Inbox } from './core/inbox.js'
import { TodoCompletionHost } from './core/todo-completion-host.js'
import { Circles } from './core/circles.js'
import { ChatReadScope } from './core/chat-read-scope.js'
import { dmSpaceId, Spaces } from './core/space.js'
import { PolicyService } from './core/policy.js'
import { migrateScopesToSpaces } from './core/migrate.js'
import { RoutineScheduler, RoutineStore } from './core/routines.js'
import { Locks } from './core/locks.js'
import { Proactive } from './core/proactive.js'
import { Signals } from './core/signals.js'
import { WikiDocs } from './core/wiki.js'
import { PmoStore } from './core/pmo.js'
import { Bitable } from './feishu/bitable.js'
import { UserTokenStore } from './feishu/oauth.js'
import { OAuthRelay, createRelayFetch, createRelayState } from './feishu/oauth-relay.js'
import { completeConnection } from './feishu/connect-completion.js'
import { SkillProposals } from './core/skills.js'
import { prepareBuiltinSkillBundle, builtinSkillProfilePatch, assertBuiltinSkillProfileDump, BuiltinSkillProfileError, BuiltinSkillReader, type BuiltinSkillBundle } from './core/builtin-skill-bundle.js'
import { assertConfiguredModelsCatalogued, configuredDeepseekModels, ModelCatalogError } from './core/model-catalog.js'
import { GitHubIdentity, loadGitHubConfig } from './github/identity.js'
import { ChangeManager, ChangeSnapshotError } from './github/changes.js'
import { ChangePreparationOperations } from './github/preparation-operations.js'
import { ExecutorClient } from './github/executor-client.js'
import { RepositoryExecutions, RepositoryExecutionSnapshotChanged } from './github/executions.js'
import { RepositoryExecutionOutputs } from './github/execution-output.js'
import { PrWatch } from './core/pr-watch.js'
import { IssueWatch } from './core/issue-watch.js'
import { WorkAssessments } from './core/work-assessment.js'
import { FeishuTaskSync } from './core/feishu-task-sync.js'
import { FeishuTasks } from './feishu/tasks.js'
import { GitHubProjectView } from './github/project-view.js'
import { IssueLinks } from './github/issues.js'
import { IssueAffectedCount } from './github/issue-affected-count.js'
import { ModelApplication } from './core/model-selection.js'
import { RunModels } from './core/run-models.js'
import { RunAttempts } from './core/run-attempts.js'
import { Orchestrator } from './core/orchestrator.js'
import { TokenIssuer } from './internal/tokens.js'
import { createInternalApi } from './internal/api.js'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
/** 仓库根：dist/index.js 或 src/index.ts 的上一级 */
const REPO_ROOT = resolve(HERE, '..')

/**
 * dsh 子进程能看到的环境变量白名单（照 Claude Tag "凭证不进沙箱" 的原则：
 * 网关的 FEISHU_APP_SECRET、FRIDAY_API_SECRET、GitLab/GitHub token 等一律不继承）。
 * 模型 key 等 dsh 需要的变量由 config 的 dsh.env 单独放行；代理变量只在 FRIDAY_DSH_PROXY=1 时注入。
 */
const DSH_INHERIT_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'GIT_SSL_CAINFO']

export function dshEnv(cfg: FridayConfig, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const k of DSH_INHERIT_ENV) if (base[k] !== undefined) env[k] = base[k] as string
  return {
    ...env,
    ...cfg.dsh.env,
    DSH_HOME: cfg.dsh.home,
    DSH_PERMISSION_MODE: cfg.dsh.permissionMode,
    DSH_TELEMETRY_MODE: 'OFF',
  }
}

/** 从 acp 模板生成 friday profile（幂等），并同步 patch 与 skills。 */
export async function ensureDshProfile(cfg: FridayConfig, log: Logger): Promise<{ profileDir: string; created: boolean; bundle: BuiltinSkillBundle }> {
  const profileDir = join(cfg.dsh.home, 'profiles', cfg.dsh.profile)
  mkdirSync(cfg.dsh.home, { recursive: true })
  let created = false
  if (!existsSync(join(profileDir, 'package.json'))) {
    log.info('creating dsh profile from acp template', { profileDir })
    await execFileAsync(cfg.dsh.command, [cfg.dsh.profile, '--from-default-profile', 'acp', '--dump-config'], {
      env: dshEnv(cfg),
      maxBuffer: 16 * 1024 * 1024,
    })
    created = true
  }
  const patchSrc = join(REPO_ROOT, 'profiles', 'friday', 'cordis.patch.yml')
  const patchTarget = join(profileDir, 'cordis.patch.yml')
  const bundle = prepareBuiltinSkillBundle(join(REPO_ROOT, 'skills'), join(cfg.dsh.home, 'friday-skill-bundles'))
  const marker = '\n# Friday managed skill discovery\n'
  const basePatch = readFileSync(process.env.FRIDAY_KEEP_PROFILE_PATCH === '1' ? patchTarget : patchSrc, 'utf8').split(marker)[0]!
  // Even an explicitly retained model/profile customization uses the managed skill roots.
  writeFileSync(patchTarget, basePatch.trimEnd() + marker + builtinSkillProfilePatch(bundle))
  try {
    // DSH also applies its home patch after the profile; inspect the composed
    // configuration without booting plugins or evaluating its JavaScript tags.
    const { stdout } = await execFileAsync(cfg.dsh.command, [cfg.dsh.profile, '--dump-config'], {
      env: dshEnv(cfg), timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
    })
    assertBuiltinSkillProfileDump(stdout, bundle)
    // 同一份 dump 顺手核一件事：这次要跑的模型在目录里登记了没有。
    // 没登记 = 被当成只收文字 = 人发来的截图读不了，而且失败得毫无线索。
    const unverified = assertConfiguredModelsCatalogued(stdout, configuredDeepseekModels(cfg.dsh.env))
    if (unverified) log.warn('model catalogue shape not recognised; cannot verify the boot model declares its input modalities')
  } catch (err) {
    if (err instanceof BuiltinSkillProfileError || err instanceof ModelCatalogError) throw err
    // exec errors include stdout/stderr, which can contain model credentials.
    throw new Error('无法读取 DSH 的有效技能配置，请检查 DSH 安装和配置。')
  }
  return { profileDir, created, bundle }
}

/** One shutdown owner: a deadline may end the process, never close a DB still in use. */
export function gatewayShutdown(input: {
  host: Pick<Orchestrator, 'beginShutdown' | 'waitForShutdown'>
  api: { beginShutdown(): void; waitForShutdown(ms: number): Promise<{ drained: boolean; pending: number }> }
  stop(): Promise<void>
  release(): void
  closeDatabase(): void
  exit(): void
  log: Logger
  timeoutMs?: number
}): () => Promise<void> {
  let shutdown: Promise<void> | undefined
  return () => shutdown ??= (async () => {
    const deadline = Date.now() + (input.timeoutMs ?? 10_000)
    input.api.beginShutdown()
    input.host.beginShutdown()
    const remaining = () => Math.max(0, deadline - Date.now())
    let stopped = false
    const stopping = input.stop().then(() => { stopped = true }, error => { input.log.warn('shutdown transport stop failed', { error }) })
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([stopping, new Promise<void>(resolve => { timer = setTimeout(resolve, remaining()) })])
    if (timer) clearTimeout(timer)
    const [host, api] = await Promise.all([input.host.waitForShutdown(remaining()), input.api.waitForShutdown(remaining())])
    const drained = stopped && host.drained && api.drained
    if (!drained) input.log.warn('shutdown deadline reached; unresolved effects retained', { transportsStopped: stopped, hostPending: host.pending, apiPending: api.pending })
    // No await after here. Timed-out owners can still need SQLite; process exit
    // closes it through the OS without running those callbacks against a closed DB.
    input.release()
    if (drained) input.closeDatabase()
    input.exit()
  })()
}

/** Owned runtime directory: no worker MCP, skills or user profile patches are copied. */
export function createIngressClassifier(cfg: FridayConfig, log: Logger): { classifier: IngressClassifier; close: () => Promise<void> } {
  const parent = join(dirname(cfg.dbPath), 'runtime')
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  const home = mkdtempSync(join(parent, 'router-'))
  const profileDir = join(home, 'profiles', 'friday-router')
  const cwd = join(home, 'workspace')
  mkdirSync(profileDir, { recursive: true })
  mkdirSync(cwd)
  for (const file of ['package.json', 'cordis.patch.yml']) copyFileSync(join(REPO_ROOT, 'profiles', 'friday-router', file), join(profileDir, file))
  const env = { ...dshEnv(cfg), DSH_HOME: home,
    FRIDAY_ROUTER_MODEL_PROVIDER: cfg.dsh.env.FRIDAY_ROUTER_MODEL_PROVIDER ?? cfg.dsh.env.FRIDAY_MODEL_PROVIDER ?? 'deepseek-official',
    FRIDAY_ROUTER_MODEL: cfg.dsh.env.FRIDAY_ROUTER_MODEL ?? cfg.dsh.env.FRIDAY_MODEL ?? 'deepseek-flash' }
  const classifier = new IngressClassifier({ cwd, timeoutMs: cfg.dsh.routerTimeoutMs, log,
    createRuntime: () => new AcpRuntime({
      transport: { kind: 'spawn', command: cfg.dsh.command, args: ['--profile', 'friday-router'], cwd, env },
      onPermission: async () => ({ outcome: { outcome: 'cancelled' } }), maxConcurrent: 1, log,
    }) })
  return { classifier, close: async () => { await classifier.stop(); rmSync(home, { recursive: true, force: true }) } }
}

/** The commit this checkout is at, read once at startup; undefined when it cannot be read (not a git checkout, git missing). */
export function gitHead(root: string = REPO_ROOT): string | undefined {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined
  } catch { return undefined }
}

/** A tool-less model runner on the router profile, in its own temporary home; the caller closes it. */
export function createRouterTextRunner(cfg: FridayConfig, log: Logger): { run(prompt: string): Promise<string>; close(): Promise<void> } {
  const parent = join(dirname(cfg.dbPath), 'runtime')
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  const home = mkdtempSync(join(parent, 'judge-'))
  const profileDir = join(home, 'profiles', 'friday-router'), cwd = join(home, 'workspace')
  mkdirSync(profileDir, { recursive: true })
  mkdirSync(cwd)
  for (const file of ['package.json', 'cordis.patch.yml']) copyFileSync(join(REPO_ROOT, 'profiles', 'friday-router', file), join(profileDir, file))
  const env = { ...dshEnv(cfg), DSH_HOME: home,
    FRIDAY_ROUTER_MODEL_PROVIDER: cfg.dsh.env.FRIDAY_ROUTER_MODEL_PROVIDER ?? cfg.dsh.env.FRIDAY_MODEL_PROVIDER ?? 'deepseek-official',
    FRIDAY_ROUTER_MODEL: cfg.dsh.env.FRIDAY_ROUTER_MODEL ?? cfg.dsh.env.FRIDAY_MODEL ?? 'deepseek-flash' }
  const runner = new TextRunner({ cwd, timeoutMs: Math.max(cfg.dsh.routerTimeoutMs, 30_000),
    createRuntime: () => new AcpRuntime({ transport: { kind: 'spawn', command: cfg.dsh.command, args: ['--profile', 'friday-router'], cwd, env },
      onPermission: async () => ({ outcome: { outcome: 'cancelled' } }), maxConcurrent: 1, log }) })
  return { run: prompt => runner.run(prompt), close: async () => { await runner.close(); rmSync(home, { recursive: true, force: true }) } }
}

export function mcpServerEntry(): string {
  const dist = join(REPO_ROOT, 'dist', 'mcp', 'server.js')
  if (existsSync(dist)) return dist
  // 开发模式（tsx）下回退到源码；node 22 需要 --import tsx 才能跑 .ts，这里用 tsx 的 cli 包装
  return join(REPO_ROOT, 'src', 'mcp', 'server.ts')
}

/** dsh llm-deepseek 默认协议 messages 的官方根。 */
const MESSAGES_DEFAULT_BASE = 'https://api.deepseek.com/anthropic'

/**
 * 用 1 个 token 的 Messages 请求探一下模型端点：区分"key 不对"（401）、"路径不对"（404）和"通了"。
 * 只在 doctor 里用；不经代理（和 dsh 子进程一致），key 不出现在输出里。
 */
export async function probeModel(baseUrl: string, apiKey: string | undefined, model: string): Promise<{ ok: boolean; detail: string }> {
  if (!apiKey) return { ok: false, detail: '没有 DEEPSEEK_API_KEY' }
  const url = `${baseUrl.replace(/\/$/, '')}/v1/messages`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 25_000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, authorization: `Bearer ${apiKey}`, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
      signal: ctrl.signal,
    })
    const text = await res.text()
    let msg = ''
    try {
      const j = JSON.parse(text) as { error?: { message?: string }; model?: string }
      msg = j.error?.message ?? (j.model ? `model=${j.model}` : '')
    } catch {
      msg = text.slice(0, 120)
    }
    if (res.ok) return { ok: true, detail: `${url} 通了（${msg || 'HTTP ' + res.status}）` }
    if (res.status === 401 || res.status === 403) return { ok: false, detail: `HTTP ${res.status}，key 被拒：${msg}` }
    if (res.status === 404) return { ok: false, detail: `HTTP 404，端点路径不对：${url}` }
    return { ok: false, detail: `HTTP ${res.status}：${msg}` }
  } catch (err) {
    return { ok: false, detail: `连不上 ${url}：${(err as Error).message}` }
  } finally {
    clearTimeout(timer)
  }
}

async function doctor(cfg: FridayConfig, log: Logger): Promise<number> {
  let failures = 0
  const ok = (name: string, detail?: string): void => {
    process.stdout.write(`  ✔ ${name}${detail ? `  ${detail}` : ''}\n`)
  }
  const bad = (name: string, detail: string): void => {
    failures += 1
    process.stdout.write(`  ✘ ${name}  ${detail}\n`)
  }
  process.stdout.write('Friday doctor\n')
  process.stdout.write(`  node ${process.version}\n`)
  ok('飞书出网', cfg.feishu.proxyUrl ? `经代理 ${describeProxy(cfg.feishu.proxyUrl)}` : '直连（未设置 FRIDAY_FEISHU_PROXY / HTTPS_PROXY）')
  const modelBase = cfg.dsh.env.DEEPSEEK_BASE_URL ?? MESSAGES_DEFAULT_BASE
  ok('模型端点', `${cfg.dsh.env.FRIDAY_MODEL_PROVIDER ?? 'deepseek-official'} / ${cfg.dsh.env.FRIDAY_MODEL ?? 'deepseek-flash'} @ ${modelBase}${cfg.dsh.env.HTTPS_PROXY ? '（dsh 经代理，NO_PROXY 已含内网）' : '（dsh 不走代理）'}`)
  if (cfg.dsh.env.DEEPSEEK_BASE_URL && !/\/anthropic\/?$/.test(cfg.dsh.env.DEEPSEEK_BASE_URL)) {
    bad('模型端点', `dsh 的 llm-deepseek 默认走 Messages 协议，DEEPSEEK_BASE_URL 要以 /anthropic 结尾，否则会打到不存在的 ${cfg.dsh.env.DEEPSEEK_BASE_URL.replace(/\/$/, '')}/v1/messages`)
  }
  if ((cfg.dsh.env.FRIDAY_MODEL_PROVIDER ?? 'deepseek-official') === 'deepseek-official') {
    const probe = await probeModel(modelBase, cfg.dsh.env.DEEPSEEK_API_KEY, cfg.dsh.env.FRIDAY_MODEL ?? 'deepseek-flash')
    if (probe.ok) ok('模型 key', probe.detail)
    else bad('模型 key', probe.detail)
  }
  try {
    const { stdout } = await execFileAsync(cfg.dsh.command, ['--version'], { env: dshEnv(cfg) })
    ok('dsh', stdout.trim())
  } catch (err) {
    bad('dsh', `找不到 ${cfg.dsh.command}：npm i -g @deepseek-ai/dsh （${(err as Error).message}）`)
  }
  try {
    const { profileDir, created } = await ensureDshProfile(cfg, log)
    ok('dsh profile', `${profileDir}${created ? '（刚创建）' : ''}`)
  } catch (err) {
    bad('dsh profile', (err as Error).message)
  }
  try {
    const feishu = new FeishuClient({ ...cfg.feishu, log })
    const id = await feishu.botOpenId()
    ok('feishu 凭证', `bot open_id=${id}`)
  } catch (err) {
    bad('feishu 凭证', (err as Error).message)
  }
  try {
    mkdirSync(cfg.workspace.root, { recursive: true })
    const repos = join(cfg.workspace.root, 'repos')
    const names = existsSync(repos) ? readdirSync(repos) : []
    ok('工作区', `${cfg.workspace.root}（repos: ${names.length ? names.join(', ') : '空，建议 clone deepseek-harness 到 repos/'}）`)
  } catch (err) {
    bad('工作区', (err as Error).message)
  }
  ok('MCP 入口', mcpServerEntry())
  const ghCfg = loadGitHubConfig()
  if (ghCfg) {
    try {
      ok('GitHub 身份', await new GitHubIdentity(ghCfg, log).describe())
    } catch (err) {
      bad('GitHub 身份', (err as Error).message)
    }
  } else ok('GitHub 身份', '未配置（GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY_PATH/GITHUB_APP_INSTALLATION_ID，或过渡期 GITHUB_TOKEN）')
  process.stdout.write(failures ? `\n${failures} 项需要处理\n` : '\n一切就绪，运行 npm start\n')
  return failures ? 1 : 0
}

async function main(): Promise<void> {
  const log = createLogger('friday')
  const cfg = loadConfig()
  if (process.argv.includes('--doctor')) {
    process.exit(await doctor(cfg, log))
  }

  const registry = new Registry(cfg.dbPath)
  const locks = new Locks(registry.db)
  const GATEWAY_LOCK = 'gateway'
  const activeGateway = locks.acquireExclusive(GATEWAY_LOCK)
  if (activeGateway) {
    registry.close()
    throw new Error(`已有 Friday 网关占用此数据库（${activeGateway.host}, pid=${activeGateway.pid}）`)
  }
  const { bundle: builtinBundle } = await ensureDshProfile(cfg, log)
  const stale = registry.failStaleTasks('网关重启，任务中断')
  if (stale) log.warn('stale tasks failed', { count: stale })
  const memory = new ChannelMemory(registry.db)
  const messageCache = new MessageCache(registry.db)
  const todos = new Todos(registry.db)
  const todoApplication = new TodoApplication({ db: registry.db, todos })
  // 私聊读取范围：默认全开，本人可以逐个停读。网关和模型共用同一份判定。
  const readScope = new ChatReadScope(registry.db)
  const personalCollection = new PersonalCollectionStore(registry.db, todos, Date.now, readScope)
  const routines = new RoutineStore(registry.db)
  const bugs = new Bugs(registry.db)
  const questions = new BugQuestions(registry.db, bugs)
  const feedback = new FeedbackControl(registry, bugs, questions, routines)
  // 收件箱：等人拍板的事。不单独推送，蹭下一次对话的末尾捎带（最多 3 次）
  const inbox = new Inbox(registry.db)
  // 人的身份映射（GitHub 登录名 ↔ 飞书显示名 ↔ open_id）。
  // TSV 只是**兜底种子**：真正的事实源是飞书那张成员对照表，配了 FRIDAY_IDENTITY_BASE 就跟着它变。
  const identities = new Identities(registry.db)
  {
    const seeded = identities.seedFrom(join(REPO_ROOT, 'data', 'members.tsv'))
    if (seeded) log.info('identities seeded', { rows: seeded, total: identities.count() })
  }
  // circles 的构造函数会把老的 spaces 表改名成 circles，必须在 Spaces 之前跑
  const circles = new Circles(registry.db)
  const spaces = new Spaces(registry.db)
  const policy = new PolicyService(spaces, { admins: cfg.policy.admins, mode: cfg.policy.permission })
  // 启动时尚无活动发送者；planned 可能已到远端，先保留为 unknown，再释放确定未发的问题预留。
  const interruptedDeliveries = new DeliveryService(registry.db, {
    spaces, policy, resolveContext: async () => undefined,
    send: async () => { throw new Error('启动恢复不发送消息') },
  }).recoverInterrupted()
  const cancelledQuestions = questions.recoverUnsent()
  if (interruptedDeliveries || cancelledQuestions) log.warn('delivery recovery completed without replay', { interruptedDeliveries, cancelledQuestions })
  migrateScopesToSpaces(registry.db, spaces, log)
  // 主动模式的节奏：部署默认值 + 空间负责人的覆盖（!space set proactive / criteria）
  const wiki = new WikiDocs(registry.db)
  const pmo = new PmoStore(registry.db)
  const proactive = new Proactive(registry.db, { ...cfg.proactive, tuningFor: (chatId) => spaces.byChat(chatId)?.config.proactive })
  // 主动模式的唯一入口：消息归一化成信号，到阈值才起一轮（docs/signals.md）
  const signals = new Signals(registry.db)
  const feishu = new FeishuClient({ ...cfg.feishu, docDomain: process.env.FRIDAY_DOC_DOMAIN?.trim() || undefined, log: log.child('feishu') })
  const minutes = new FeishuMinutes(feishu.client)
  // 妙记行动项草稿表总是建（与迁移适配器相同）；只有本人在私聊要求把妙记行动项记成待办时才写入，决定后只留决定记录。
  ensureMinutesDraftSchema(registry.db)
  // 会议旁听默认关：两张会议表总是建（与迁移适配器相同，开关不改变库结构，构造函数只建表）；FRIDAY_MEETINGS=on 才接会议平台、构造会议运行时、挂路由和定时。
  const meetingSessions = new MeetingSessions(registry.db)
  const meetings = cfg.meetings.enabled ? { sessions: meetingSessions, provider: new FeishuMeetings(feishu.client) } : undefined
  // 需求投票默认关：表结构总是建（与迁移适配器相同，开关不改变库结构）；FRIDAY_POLLS=on 才构造投票运行时、挂路由和定时。
  ensurePollSchema(registry.db)
  const polls = cfg.polls.enabled ? { store: new Polls(registry.db), bugs } : undefined
  const userTokens = new UserTokenStore(registry.db, feishu, Date.now,
    cfg.feishu.oauth.relay ? () => createRelayState(cfg.feishu.oauth.relay!.token) : undefined)
  const skills = new SkillProposals(registry.db, new Set(builtinBundle.names))
  const ghCfg = loadGitHubConfig()
  const personalGithubProxy = ghCfg?.proxyUrl ?? cfg.feishu.proxyUrl
  const github = ghCfg ? new GitHubIdentity(ghCfg, log.child('github')) : undefined
  const personalGithub = new GitHubUserConnections({ db: registry.db, key: loadConnectionKey(join(dirname(cfg.dbPath), 'connection.key')),
    config: loadGitHubUserConfig(cfg.feishu.oauth.relay, personalGithubProxy), http: createGitHubUserHttp(personalGithubProxy),
    temporaryReader: github?.mode === 'pat' ? github : undefined, tokenRelay: cfg.feishu.oauth.relay, log: log.child('personal-github') })
  const gmail = new GmailConnections({ db: registry.db, key: loadConnectionKey(join(dirname(cfg.dbPath), 'connection.key')),
    config: loadGmailConfig(cfg.feishu.oauth.relay), http: createGmailHttp(cfg.feishu.proxyUrl) })
  const mailbox = new GmailMailbox({ db: registry.db, connections: gmail })
  const personalMcp = new PersonalMcpConnections({ db: registry.db, key: loadConnectionKey(join(dirname(cfg.dbPath), 'connection.key')),
    remote: createRemoteMcp(cfg.feishu.proxyUrl), audience: owner => {
      if (!orchestrator || orchestrator.isClosing) throw new Error('Friday 尚未就绪。')
      const space = spaces.get(dmSpaceId(owner))
      if (!space || space.status !== 'active' || space.kind !== 'p2p' || !space.chatId || spaces.roleOf(space.id, owner) !== 'owner' ||
        policy.decide({ spaceId: space.id, openId: owner, action: 'read' }).decision !== 'allow') throw new Error('请在本人 Friday 私聊中连接。')
      return space
    } })
  ensurePersonalDeviceSchema(registry.db)
  const devices = cfg.feishu.oauth.relay ? new PersonalDevices({ db: registry.db,
    encryptionKey: loadConnectionKey(join(dirname(cfg.dbPath), 'connection.key')), relayToken: cfg.feishu.oauth.relay.token,
    baseUrl: cfg.feishu.oauth.relay.baseUrl, lifetimeMs: 30 * 86_400_000, assertOwner: owner => {
      if (!orchestrator || orchestrator.isClosing) throw new Error('Friday 尚未就绪。')
      const space = spaces.get(dmSpaceId(owner))
      if (!space || space.status !== 'active' || space.kind !== 'p2p' || !space.chatId || spaces.roleOf(space.id, owner) !== 'owner' ||
        policy.decide({ spaceId: space.id, openId: owner, action: 'read' }).decision !== 'allow') throw new Error('请在本人 Friday 私聊中连接。')
    } }) : undefined
  const emailDrafts = new EmailDrafts({ db: registry.db, connections: gmail, mailbox,
    authorize: (draft, guard) => { if (!orchestrator) throw new Error('Friday 尚未就绪。'); return orchestrator.authorizeEmailDraft(draft, guard) } })
  if (github) log.info('github identity configured', { mode: github.mode })
  const gitCacheDir = process.env.FRIDAY_GIT_CACHE ?? join(cfg.workspace.root, '..', 'git')
  const changes = github ? new ChangeManager({ db: registry.db, cacheDir: gitCacheDir, github, transport:github.transport, proxyUrl: ghCfg?.proxyUrl, log: log.child('changes') }) : undefined
  changes?.recoverPreparations()
  const preparations = changes ? new ChangePreparationOperations({ changes }) : undefined
  const executorClient = cfg.executor && github && changes ? new ExecutorClient(cfg.executor) : undefined
  const executions = executorClient && github && changes ? new RepositoryExecutions({
    db: registry.db,
    client: executorClient,
    snapshot: async (identity, input) => {
      try { return await changes.executionSnapshot({ ...identity, ...input }) }
      catch (error) {
        if (error instanceof ChangeSnapshotError) throw new RepositoryExecutionSnapshotChanged()
        throw error
      }
    },
    authorize: (identity, repo) => () => {
      identity.assertAuthorized()
      if (!orchestrator || orchestrator.isClosing || !github.repoWritable(repo) ||
        !orchestrator.canPublishToRepository(identity.sessionKey, repo)) {
        throw new Error('当前工作或资料来源不允许交给此仓库执行环境')
      }
    },
  }) : undefined
  // Verified artifact copies stay beside the gateway Git cache, outside every worker workspace.
  const executionOutputs = executions && executorClient && changes ? new RepositoryExecutionOutputs({ executions, client: executorClient, changes,
    outputRoot: join(gitCacheDir, 'execution-output') }) : undefined
  const prWatch = new PrWatch(registry.db)
  const issueWatch = github ? new IssueWatch(registry.db) : undefined
  // 接单评估账本（work_assessments）总是建（与迁移适配器相同，开关不改变库结构）；构造函数只建表。运行时只在 GitHub 与受控执行都配置时由编排器构造。
  const assessments = new WorkAssessments(registry.db)
  // 只在开着的时候才造：关着的时候连表都不建，数据库里不留一张永远空着的表。
  const taskSync = cfg.feishuTasks.enabled
    ? new FeishuTaskSync({ db: registry.db, todos, tasks: new FeishuTasks(feishu.client), log, cancellation: 'delete',
      assertCurrent: () => { if (!orchestrator || orchestrator.isClosing) throw new Error('Task synchronization host is closing') },
      permissionVersion: () => cfg.feishu.appId,
    })
    : undefined
  const botOpenId = await feishu.botOpenId()
  const tokens = new TokenIssuer(cfg.internalApi.secret)
  const messages = new MessageService(feishu, messageCache, log.child('messages'))

  let orchestrator: Orchestrator | undefined
  let oauthRelay: OAuthRelay | undefined
  let githubOAuthRelay: OAuthRelay | undefined
  let gmailOAuthRelay: OAuthRelay | undefined
  const workspaceRuntime = {
    transport: { kind: 'spawn', command: cfg.dsh.command, args: ['--profile', cfg.dsh.profile], env: dshEnv(cfg), cwd: cfg.workspace.root },
    onPermission: (req, signal) => {
      if (!orchestrator) return Promise.resolve({ outcome: { outcome: 'cancelled' as const } })
      return orchestrator.runWhileActive(() => orchestrator!.handlePermission(req, signal))
    },
    onExit: (info) => log.error('dsh exited unexpectedly; will restart on next task', info),
    log: log.child('acp'),
  } satisfies ConstructorParameters<typeof AcpRuntime>[0]
  const managedProfile = cfg.publicMode || cfg.dsh.executionMode === 'managed' ? await prepareManagedProfile({
    command: cfg.dsh.command, env: dshEnv(cfg), root: join(dirname(cfg.dbPath), 'runtime'),
    provider: cfg.dsh.models!.defaultRoute.providerId, model: cfg.dsh.models!.defaultRoute.modelId,
  }) : undefined
  const bindings = new RuntimeBindings(registry)
  if (managedProfile) bindings.importLegacyWorkspace()
  const runtime = managedProfile ? new AcpRuntimePool({ workspace: workspaceRuntime,
    managed: { transport: managedProfile.transport,
      onPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      onExit: info => log.error('managed dsh exited; next task will prepare a new context', info), log: log.child('managed-acp') },
    bindings, maxConcurrent: cfg.policy.maxConcurrentTurns,
  }) : new AcpRuntime({ ...workspaceRuntime, maxConcurrent: cfg.policy.maxConcurrentTurns })
  const managed: ManagedExecution | undefined = managedProfile && runtime instanceof AcpRuntimePool ? {
    runtime, root: join(managedProfile.home, 'executions'), profileDigest: managedProfile.profileDigest,
    files: new ExecutionMaterials(registry.db, join(dirname(cfg.dbPath), 'materials')),
  } : undefined
  new RunAttempts(registry.db)
  const runModels = new RunModels(registry.db)
  const models = new ModelApplication({ runtime, spaces, runs: runModels, policy: () => cfg.dsh.models! })
  const projects = github ? new GitHubProjectView(registry.db, github) : undefined
  const consoleAuth = cfg.console ? new ConsoleAuth({ db: registry.db, provider: feishu, appId: cfg.feishu.appId,
    domain: cfg.feishu.domain, ...cfg.console }) : undefined
  const consoleAccess = consoleAuth ? new HumanSpaceAccess({ spaces, policy, feishu, assertActor: actor => consoleAuth.assertCurrent(actor) }) : undefined
  const consoleRouter = consoleAuth && consoleAccess ? createConsoleRouter(consoleAuth, new ConsoleQueries({
    waitingRepositoryChecks: key => orchestrator?.githubCi?.waitingForWork(key) ?? false,
    access: consoleAccess, models, runModels, userTokens,
    registry, memory, todos, routines, skills, github, projects, defaults: { brevity: 'short', reflect: cfg.memory.reflect },
  }), new ConsoleCommands({ access: consoleAccess, operations: new ConsoleOperations(registry.db, { sessions: consoleAuth.sessions }),
    spaces, routines, todos, models, spaceApplication: new SpaceApplication({ db: registry.db, spaces }),
    todoApplication,
    reconciliation: new DeliveryReconciliation(registry.db, { spaces, policy, feishu, botOpenId }),
    persistRoutineControl: (id, action, options) => orchestrator!.persistRoutineControl(id, action, options),
    assertHumanRunTarget: input => orchestrator!.assertHumanRunTarget(input),
    persistHumanRunStop: input => orchestrator!.persistHumanRunStop(input),
    assertHumanWorkTarget: input => orchestrator!.assertHumanWorkTarget(input),
    persistHumanWorkCancel: (input, opts) => orchestrator!.persistHumanWorkCancel(input, opts),
    persistHumanWorkResume: (input, opts) => orchestrator!.persistHumanWorkResume(input, opts),
  })) : undefined

  // 同一个实例给网关的 PMO 同步和模型的通用建表用；两边共用同一套飞书权限与错误码。
  const bitable = new Bitable(feishu.client)
  // 成员对照表 → 身份表。启动拉一次，之后按 refreshMs 定时跟；失败只记日志，不拖累启动。
  const identityDirectory = cfg.identityRoster
    ? new IdentityDirectory({ identities, bitable, log: log.child('identity-roster') },
        { appToken: cfg.identityRoster.appToken, tableId: cfg.identityRoster.tableId })
    : undefined
  let identityTimer: ReturnType<typeof setInterval> | undefined
  let initialIdentityPull: Promise<unknown> = Promise.resolve()
  if (identityDirectory && cfg.identityRoster) {
    const pull = () => identityDirectory.refresh().catch((err) => log.warn('identity roster refresh failed', { err: String(err) }))
    initialIdentityPull = pull()
    identityTimer = setInterval(() => { void orchestrator!.runWhileActive(pull).catch(err => log.warn('identity roster refresh stopped', { err })) }, Math.max(60_000, cfg.identityRoster.refreshMs))
    identityTimer.unref()
  }

  // 待办按证据标完成：只在本人的交互任务里判断；话题消息取自消息缓存，标完成走 TodoApplication
  const todoCompletion = new TodoCompletionHost({ db: registry.db, todos, todoApplication: new TodoApplication({ db: registry.db, todos }),
    messages: messageCache, spaces, policy, readScope, members: chatId => feishu.chatMemberOpenIds(chatId, { fresh: true }), domain: cfg.feishu.domain })

  const api = createInternalApi({
    version: gitHead(),
    todoApplication,
    taskSync,
    // 我的一天由编排器构造（需要当前 Run、来源登记与原群成员核验）；取值时才读，避免构造顺序问题。
    get myDay() { return orchestrator?.myDay },
    bitable,
    minutes,
    readScope,
    // 开发机直连公网不通；抓网页复用飞书那条出网代理，另给 FRIDAY_WEB_PROXY 可单独指定
    webProxyUrl: process.env.FRIDAY_WEB_PROXY?.trim() || cfg.feishu.proxyUrl,
    authorizePublicWebRequest: (cap, url) => {
      if (!orchestrator) throw new Error('联网请求的宿主尚未就绪')
      return orchestrator.authorizePublicWebRequest(cap, url)
    },
    get materials() { return orchestrator?.materials },
    meetingsEnabled: cfg.meetings.enabled,
    get meetings() { return orchestrator?.meetings?.application },
    get minutesTodos() { return orchestrator?.minutesTodos },
    pollsEnabled: cfg.polls.enabled,
    get polls() { return orchestrator?.polls?.runtime },
    // 只读接单评估由编排器构造（需要当前 Run、来源租约与群成员核验）；取值时才读。没有 GitHub 或受控执行时保持 undefined，路由返回 503。
    get issueAssessment() { return orchestrator?.issueAssessment },
    isManagedRun: runId => orchestrator?.isManagedRun(runId) ?? false,
    registerExecutionFile: (runId, input, assertCurrent) => orchestrator!.registerExecutionFile(runId, input, assertCurrent),
    captureTodoProvenance: (sessionKey, runId) => orchestrator!.captureTodoProvenance(sessionKey, runId),
    captureEmailDraftSource: (sessionKey, runId) => orchestrator!.captureEmailDraftSource(sessionKey, runId),
    consumeEmailDraft: (sessionKey, runId, draft) => orchestrator!.consumeEmailDraft(sessionKey, runId, draft),
    builtinSkills: new BuiltinSkillReader(builtinBundle),
    consoleRouter,
    appId: cfg.feishu.appId,
    feishuDomain: cfg.feishu.domain,
    feishu,
    identities,
    ...(identityDirectory ? { refreshIdentities: () => identityDirectory.refresh({ minIntervalMs: 60_000 }) } : {}),
    bugs,
    questions,
    feedback,
    stopFeedback: (key, runId, id, manageRoutines) => orchestrator!.stopFeedback(key, runId, id, manageRoutines),
    canPersistFeedbackState: (key, runId, id) => orchestrator?.canPersistFeedbackState(key, runId, id) ?? false,
    recordDomainOperation: (key, runId, receipt) => orchestrator!.recordDomainOperation(key, runId, receipt),
    memory,
    registry,
    messages,
    messageCache,
    todos,
    routines,
    inbox,
    userTokens,
    oauthRedirectUri: cfg.feishu.oauth.redirectUri,
    onAuthorizationCompleted: (openId) => orchestrator!.resumeAuthorizedRoutines(openId),
    onAccessBlocked: (actor, failure, purpose) => orchestrator!.onAccessBlocked(actor, failure, purpose),
    disconnectPersonalConnection: (openId, expected) => orchestrator!.disconnectPersonalConnection(openId, expected),
    memoryRuntime: {
      recordRead: (runId, refs) => orchestrator!.recordMemoryRead(runId, refs),
      search: (runId, scopes, query, limit) => orchestrator!.searchMemory(runId, scopes, query, limit),
      add: (runId, input) => orchestrator!.addMemory(runId, input),
      forget: (runId, id, scope) => orchestrator!.forgetMemory(runId, id, scope),
    },
    presentMemoryCandidate: (actor, noteId, revision) => orchestrator!.presentMemoryCandidate(actor, noteId, revision),
    stopRoutine: (id, mode) => orchestrator!.stopRoutine(id, mode),
    controlRoutine: (id, action, options) => orchestrator!.controlRoutine(id, action, options),
    updateRoutine: (id, patch, options) => orchestrator!.updateRoutine(id, patch, options),
    noteRoutineOverlaps: (id, actorOpenId) => orchestrator!.noteRoutineOverlaps(id, actorOpenId),
    refreshProposalCard: id => orchestrator!.refreshProposalCard(id),
    pendingDecisions: (ownerOpenId, context) => orchestrator!.pendingDecisions(ownerOpenId, context),
    resolveDecision: input => orchestrator!.resolveDecision(input),
    todoCompletion,
    skills,
    proposeSkill: (key, runId, input) => orchestrator!.proposeSkill(key, runId, input),
    disableSkill: (key, runId, input) => orchestrator!.disableSkill(key, runId, input),
    circles,
    spaces,
    policy,
    github,
    personalGithub, gmail, mailbox, emailDrafts, personalMcp,
    showEmailDraft: (owner, id) => orchestrator!.emailCards!.show(owner, id),
    projects,
    changes,
    preparations,
    executions,
    preparationRunSignal: (sessionKey, runId) => orchestrator!.preparationRunSignal(sessionKey, runId),
    personalMcpRunSignal: (sessionKey, runId) => orchestrator!.personalMcpRunSignal(sessionKey, runId),
    executionOutputs,
    issueLinks: new IssueLinks(registry.db),
    botName: cfg.feishu.botName,
    confirm: (input) => (orchestrator ? orchestrator.confirmAction(input) : Promise.resolve(false)),
    resolveActorForSession: (sessionKey) => orchestrator?.resolveActorForSession(sessionKey),
    allowedRoutesForSession: (sessionKey) => orchestrator?.allowedRoutesForSession(sessionKey),
    onCrossSpaceRead: (sessionKey, read) => orchestrator?.noteCrossSpaceRead(sessionKey, read),
    onChatHistoryRead: (sessionKey, read) => orchestrator?.noteChatHistoryRead(sessionKey, read),
    onMessageRead: (sessionKey, runId, receipt) => orchestrator!.noteMessageRead(sessionKey, runId, receipt),
    onExternalSourceRead: (sessionKey, read) => orchestrator?.noteExternalSource(sessionKey, read),
    canPersistDerivedState: (sessionKey, purpose) => orchestrator?.canPersistDerivedState(sessionKey, purpose) ?? false,
    canPersistPersonalMemory: (sessionKey) => orchestrator?.canPersistPersonalMemory(sessionKey) ?? false,
    deliverToolResult: (sessionKey, runId, input) => orchestrator!.deliverToolResult(sessionKey, runId, input),
    askBugQuestion: (sessionKey, runId, input) => orchestrator!.askBugQuestion(sessionKey, runId, input),
    resolveBugQuestionReply: (sessionKey, runId, input) => orchestrator!.resolveBugQuestionReply(sessionKey, runId, input),
    onRepositoryRead: (sessionKey, repo, grant) => orchestrator?.noteRepositoryRead(sessionKey, repo, grant),
    armRepositoryCi: (sessionKey, runId, input) => orchestrator!.armRepositoryCi(sessionKey, runId, input),
    repositoryIssueFollowup: (sessionKey, runId, input) => orchestrator!.repositoryIssueFollowup(sessionKey, runId, input),
    repositoryCiControl: (sessionKey, runId, input) => orchestrator!.repositoryCiControl(sessionKey, runId, input),
    repositoryCiTracking: (sessionKey, runId, input) => orchestrator!.repositoryCiTracking(sessionKey, runId, input),
    recordRepositoryResult: (sessionKey, runId, receipt) => orchestrator!.recordRepositoryResult(sessionKey, runId, receipt),
    captureRepositoryIssueOrigin: (sessionKey, runId, repo) => orchestrator!.captureRepositoryIssueOrigin(sessionKey, runId, repo),
    canPublishToRepository: (sessionKey, repo) => orchestrator?.canPublishToRepository(sessionKey, repo) ?? false,
    // 每一项都要列全——漏一项，那条能力就静默变成 undefined，真机上就这么漏掉过一次授权卡。
    // 防漏靠类型：ApiDeps 里这些字段都是必填的，少写一个就是编译错误（TS2741），不是运行时的沉默。
    // 也不能图省事换成一个 getter 整体转发：createInternalApi 在**构造时**就把这个字段取走，
    // 那时 orchestrator 还没赋值，网关会直接起不来。
    abilities: {
      status: (a) => orchestrator!.abilities.status(a),
      report: (a) => orchestrator!.abilities.report(a),
      wiki: (a) => orchestrator!.abilities.wiki(a),
      handover: (a) => orchestrator!.abilities.handover(a),
      groups: (a) => orchestrator!.abilities.groups(a),
      offerConnect: (a, extras) => orchestrator!.abilities.offerConnect(a, extras),
      connect: (a, extras) => orchestrator!.abilities.connect(a, extras),
      pmo: (a, args) => orchestrator!.abilities.pmo(a, args),
      settings: (a, args) => orchestrator!.abilities.settings(a, args),
      proactive: (a, args) => orchestrator!.abilities.proactive(a, args),
      notedTodos: (a, ids, mode) => orchestrator!.abilities.notedTodos(a, ids, mode),
      ccRepositoryWrite: (a, what) => orchestrator!.abilities.ccRepositoryWrite(a, what),
      explain: (a) => orchestrator!.abilities.explain(a),
      selfcheck: (a, args) => orchestrator!.abilities.selfcheck(a, args),
    },
    trustedUsers: cfg.policy.trustedUsers,
    tokens,
    log: log.child('api'),
    maxHistoryPerCall: cfg.policy.maxHistoryPerCall,
  })
  await new Promise<void>((resolve, reject) => {
    api.server.once('error', reject)
    api.server.listen(cfg.internalApi.port, cfg.internalApi.host, () => resolve())
  })
  const apiBaseUrl = `http://${cfg.internalApi.host}:${cfg.internalApi.port}`
  log.info('internal api listening', { apiBaseUrl })

  // 个人授权的回调单独监听：浏览器不在这台机器上，绑 127.0.0.1 的话任何人都打不开，
  // 授权其实成了、人却停在一个打不开的页面上。这个 server 只认 /oauth/callback。
  await new Promise<void>((resolve, reject) => {
    api.callbackServer.once('error', reject)
    api.callbackServer.listen(cfg.feishu.oauth.callbackPort, cfg.feishu.oauth.callbackHost, () => resolve())
  })
  const reachable = cfg.feishu.oauth.callbackHost !== '127.0.0.1' && cfg.feishu.oauth.callbackHost !== 'localhost'
  log.info('oauth callback listening', {
    at: `http://${cfg.feishu.oauth.callbackHost}:${cfg.feishu.oauth.callbackPort}/oauth/callback`,
    redirectUri: cfg.feishu.oauth.redirectUri,
    // 只绑本机时说清楚后果：别人走完授权会看到一个打不开的页面
    reachableByOthers: reachable,
  })
  if (!reachable && !cfg.feishu.oauth.relay) {
    log.warn('oauth callback 只绑在本机：别人完成授权后会停在一个打不开的页面上。' +
      '配 FRIDAY_OAUTH_RELAY_URL + FRIDAY_OAUTH_RELAY_TOKEN 走公网中转，或设 FRIDAY_OAUTH_HOST + FRIDAY_OAUTH_REDIRECT_URI')
  }

  // 公网中转：回调落在 Cloudflare Worker 上，网关自己去取 code。
  // 这是让**不在内网、也不在这台机器上**的人走完授权的唯一办法——
  // 浏览器到不了这个容器，而回调是飞书把人的浏览器送过来，轮询替代不了那一跳。
  if (cfg.feishu.oauth.relay) {
    gmailOAuthRelay = new OAuthRelay({ ...cfg.feishu.oauth.relay, fetch: createRelayFetch(cfg.feishu.proxyUrl), log: log.child('gmail-oauth'),
      onCode: ({ openId, state, code }) => orchestrator!.runWhileActive(async () => {
        try { await gmail.complete(state, openId, code); registry.setKv(`gmail-connection-error:${openId}`, '') }
        catch { registry.setKv(`gmail-connection-error:${openId}`, '这次连接未完成，可以重新连接 Gmail。已有连接和草稿仍保留。'); await orchestrator!.personalOnboarding?.githubConnectionChanged(openId).catch(() => undefined); return }
        await orchestrator!.personalOnboarding?.githubConnectionChanged(openId).catch(() => log.warn('Gmail connection card refresh deferred'))
      }),
      onDenied: ({ openId, state }) => orchestrator!.runWhileActive(async () => {
        gmail.deny(state, openId); registry.setKv(`gmail-connection-error:${openId}`, '这次未授权 Gmail。需要时可以重新连接。'); await orchestrator!.personalOnboarding?.githubConnectionChanged(openId)
      }) })
    gmail.onBegin = (state, owner, expires) => gmailOAuthRelay!.watch(state, owner, expires)
    githubOAuthRelay = new OAuthRelay({ ...cfg.feishu.oauth.relay, fetch: createRelayFetch(cfg.feishu.proxyUrl), log: log.child('github-oauth'),
      onCode: ({ openId, state, code }) => orchestrator!.runWhileActive(async () => {
        try {
          await personalGithub.complete(state, openId, code)
        } catch {
          await orchestrator!.personalOnboarding?.githubConnectionChanged(openId).catch(() => undefined)
          await feishu.sendToUser(openId, { text: 'GitHub 连接未完成，请在账号连接卡重试。' })
          return
        }
        await orchestrator!.personalOnboarding?.githubConnectionChanged(openId).catch(() => log.warn('GitHub connection card refresh deferred'))
      }),
      onDenied: ({ openId, state }) => orchestrator!.runWhileActive(async () => {
        personalGithub.deny(state, openId)
        await orchestrator!.personalOnboarding?.githubConnectionChanged(openId)
      }),
    })
    personalGithub.onBegin = (state, owner, expires) => githubOAuthRelay!.watch(state, owner, expires)
    oauthRelay = new OAuthRelay({
      ...cfg.feishu.oauth.relay,
      fetch: createRelayFetch(cfg.feishu.proxyUrl),
      log: log.child('oauth-relay'),
      // 和本机回调走**同一个** completeConnection：核对授权人、恢复关注任务，一件不少。
      onCode: ({ openId, code, state }) => orchestrator!.runWhileActive(async () => {
        const r = await completeConnection({
          userTokens,
          redirectUri: cfg.feishu.oauth.redirectUri,
          whoAmI: (accessToken) => feishu.whoAmI(accessToken),
          onCompleted: (id) => orchestrator!.resumeAuthorizedRoutines(id),
          log: log.child('oauth-relay'),
        }, { code, state })
        if (orchestrator!.isClosing) return
        if (!r.ok || !orchestrator!.personalOnboarding?.authorizationPresented(openId)) {
          await feishu.sendToUser(openId, { text: r.ok ? `${r.detail}` : `${r.title}：${r.detail}` })
        }
      }),
      onDenied: ({ state, openId, reason }) => orchestrator!.runWhileActive(async () => {
        if (!userTokens.denyAuthorization(state)) return
        await feishu.sendToUser(openId, { text: `${reason}。想再来一次就跟我说一声，我重新把授权卡发给你。` })
      }),
    })
    // 挂在 begin 上而不是挂在两个调用点上：state 只在那一个地方诞生。
    userTokens.onBegin = (state, openId) => oauthRelay!.watch(state, openId)
    log.info('oauth relay enabled', { baseUrl: cfg.feishu.oauth.relay.baseUrl, redirectUri: cfg.feishu.oauth.redirectUri })
  }

  mkdirSync(cfg.workspace.root, { recursive: true })
  await runtime.start()
  const ingress = createIngressClassifier(cfg, log.child('ingress'))

  orchestrator = new Orchestrator({
    todoApplication,
    personalCollection,
    cfg,
    feishu,
    minutes,
    meetings,
    polls,
    runtime,
    changes,
    preparations,
    executions,
    prWatch,
    bugs,
    issueWatch,
    identities,
    ...(identityDirectory ? { refreshIdentities: () => identityDirectory.refresh({ minIntervalMs: 60_000 }) } : {}),
    assessments,
    github,
    personalGithub, gmail, mailbox, emailDrafts, personalMcp, devices, taskSync,
    managed,
    repositoryAllowed: repo => github?.repoAllowed(repo) ?? false,
    models,
    ingressClassifier: ingress.classifier,
    prReplyJudge: cfg.prReplyDigest.enabled ? () => createRouterTextRunner(cfg, log.child('pr-reply-judge')) : undefined,
    registry,
    memory,
    messages,
    routines,
    inbox,
    userTokens,
    skills,
    builtinSkillDigest: builtinBundle.digest,
    todos,
    questions,
    circles,
    feedback,
    spaces,
    policy,
    wiki,
    bitable,
    readScope,
    pmo,
    proactive,
    signals,
    tokens,
    apiBaseUrl,
    mcpServerPath: mcpServerEntry(),
    botOpenId,
    log: log.child('orchestrator'),
  })

  void orchestrator.runWhileActive(() => initialIdentityPull)
  // 启动只做一次：上次进程中断时仍在评估的记录标为 interrupted；不自动重评，需要新的真人请求。
  const interruptedAssessments = assessments.recoverInterrupted()
  if (interruptedAssessments) log.warn('unfinished issue assessments interrupted', { count: interruptedAssessments })
  const interruptedRuns = orchestrator.recoverRuns()
  if (interruptedRuns) log.warn('unfinished run attempts interrupted', { count: interruptedRuns })
  // Pending cards survive a gateway restart. Do not extend their original expiry,
  // or replay a one-use provider exchange interrupted after it was claimed.
  for (const pending of userTokens.recoverAuthorizations()) oauthRelay?.watch(pending.state, pending.openId, pending.expiresAt)
  void orchestrator.recoverHandoffs().catch((err) => log.error('inbound handoff recovery failed', { err }))

  const ws = await startFeishuWs({
    ...cfg.feishu,
    log: log.child('ws'),
    onMessage: (msg) => orchestrator!.runWhileActive(() => orchestrator!.handleMessage(msg)),
    onCardAction: (action) => orchestrator!.runWhileActive(() => orchestrator!.handleCardAction(action)),
    onMenu: (ev) => orchestrator!.runWhileActive(() => orchestrator!.handleMenu(ev)),
    onChatLifecycle: (ev) => orchestrator!.runWhileActive(() => orchestrator!.handleChatLifecycle(ev)),
    onRecall: (ev) => orchestrator!.runWhileActive(() => orchestrator!.handleRecall(ev)),
    onReaction: (ev) => orchestrator!.runWhileActive(() => orchestrator!.handleReaction(ev)),
  })
  // 计时器继续使用已有调度锁；启动恢复已经由不抢占活进程的 gateway 锁保护。
  const SCHEDULER_LOCK = 'scheduler'
  let hadLock = !locks.acquire(SCHEDULER_LOCK)
  if (!hadLock) log.warn('scheduler lock held by another process; timers stay idle until it goes stale', { ...locks.holder(SCHEDULER_LOCK) })
  // 每 30s 续一次心跳（过期阈值 90s）；别人的锁过期了就在这里接管
  const lockTimer = setInterval(() => {
    void orchestrator!.recoverHandoffs().catch((err) => log.error('inbound handoff recovery failed', { err }))
    if (meetings && locks.holds(SCHEDULER_LOCK)) void orchestrator!.runWhileActive(() => orchestrator!.meetings?.tick()).catch(err => log.warn('meeting lifecycle stopped', { err }))
    if (polls && locks.holds(SCHEDULER_LOCK)) void orchestrator!.runWhileActive(() => orchestrator!.polls?.runtime.tick()).catch(err => log.warn('poll lifecycle stopped', { err }))
    if (locks.holds(SCHEDULER_LOCK)) void orchestrator!.runWhileActive(() => orchestrator!.personalGithubDiscovery?.tick()).catch(() => log.warn('personal GitHub discovery deferred'))
    if (locks.holds(SCHEDULER_LOCK)) void orchestrator!.runWhileActive(() => orchestrator!.personalWorkSync?.tick()).catch(() => log.warn('personal work sync deferred'))
    const other = locks.acquire(SCHEDULER_LOCK)
    if (!other && !hadLock) log.info('scheduler lock acquired', { pid: process.pid })
    if (other && hadLock) log.warn('scheduler lock lost', { ...other })
    hadLock = !other
  }, 30_000)
  const scheduling = (): boolean => !orchestrator!.isClosing && locks.holds(SCHEDULER_LOCK)
  const desktopBridge = devices && cfg.feishu.oauth.relay && orchestrator.personalDesktop ? new PersonalDesktopBridge({ devices,
    baseUrl: cfg.feishu.oauth.relay.baseUrl, token: cfg.feishu.oauth.relay.token, fetch: createDesktopRelayFetch(cfg.feishu.proxyUrl), enabled: scheduling,
    changed: owner => orchestrator!.personalOnboarding!.githubConnectionChanged(owner),
    prepare: (owner, request, guard) => orchestrator!.personalDesktop!.prepare(owner, request, guard),
    execute: (actor, request, requestId) => orchestrator!.personalDesktop!.execute(actor, request, requestId),
    afterCommit: () => orchestrator!.personalDesktop!.afterCommit(), afterRollback: () => orchestrator!.personalDesktop!.discardEffects(),
    warn: message => log.warn(message) }) : undefined
  const desktopTimer = setInterval(() => { if (scheduling()) void orchestrator!.runWhileActive(() => desktopBridge?.tick() ?? Promise.resolve()).catch(() => log.warn('Desktop update deferred')) }, 1500)
  desktopTimer.unref()
  let collectionRunner: ReturnType<typeof createRouterTextRunner> | undefined
  let gmailRunner: ReturnType<typeof createRouterTextRunner> | undefined
  const gmailCollector = new GmailCollector({ db: registry.db, connections: gmail, mailbox,
    enabled: owner => scheduling() && orchestrator!.personalOnboarding?.settings(owner).collection === true && spaces.get(dmSpaceId(owner))?.status === 'active',
    assertActive: () => { if (!scheduling()) throw new Error('Gmail collection paused') },
    run: prompt => (gmailRunner ??= createRouterTextRunner(cfg, log.child('gmail-collection-model'))).run(prompt),
    onChange: owner => orchestrator!.personalOnboarding?.workProgress(owner) ?? Promise.resolve() })
  const gmailTimer = setInterval(() => { if (scheduling()) void orchestrator!.runWhileActive(() => gmailCollector.tick()).catch(() => log.warn('Gmail collection deferred')) }, 30_000)
  const collector = new PersonalCollectionHost({ store: personalCollection, feishu, userTokens, spaces, policy, readScope,
    botOpenId, isAssistantInput: message => registry.isAssistantInput(message),
    domain: cfg.feishu.domain, enabled: scheduling,
    run: prompt => (collectionRunner ??= createRouterTextRunner(cfg, log.child('personal-collection-model'))).run(prompt),
    onResult: async ({ openId, ...result }) => {
      log.info('personal collection page', result)
      await orchestrator!.personalOnboarding?.collectionProgress(openId)
    } })
  const collectionTimer = setInterval(() => {
    if (scheduling()) void orchestrator!.runWhileActive(() => collector.tick()).catch(() => log.warn('personal collection stopped'))
  }, 10_000)
  collectionTimer.unref()
  // Friday 自己建的 Issue 里的受影响人数块（FRIDAY_ISSUE_AFFECTED_COUNT，默认关）：关着时不构造，下面 PR 定时器里这一项什么都不做。
  for (const pending of gmail.pending()) gmailOAuthRelay?.watch(pending.state, pending.owner, pending.expires)
  for (const pending of personalGithub.pending()) githubOAuthRelay?.watch(pending.state, pending.owner, pending.expires)

  const issueAffectedCount = cfg.issueAffectedCount.enabled && github
    ? new IssueAffectedCount({ db: registry.db, links: new IssueLinks(registry.db), github, enabled: true, botOpenId, log: log.child('issue-affected-count'),
      assertCurrent: () => { if (!scheduling()) throw new Error('调度锁已失去或宿主正在关闭，停止写 Issue 人数块') } })
    : undefined
  if (cfg.issueAffectedCount.enabled) log.info(issueAffectedCount ? 'issue affected count enabled' : 'issue affected count enabled without GitHub identity; not started')

  const scheduler = new RoutineScheduler({ store: routines, run: (r, occurrence) => orchestrator!.runRoutine(r, { occurrence }), runTick: tick => orchestrator!.runWhileActive(tick), log: log.child('routines'), enabled: scheduling,
    onDisabled: (routine, reason) => void orchestrator!.runWhileActive(() => orchestrator!.notifyRoutineDisabled(routine, reason))
      .catch((err) => log.warn('routine disable notice failed', { id: routine.id, err })) })
  scheduler.start()
  const reminderTimer = setInterval(() => {
    if (!scheduling()) return
    void orchestrator!.runWhileActive(() => orchestrator!.remindDueTodos()).catch((err) => log.warn('todo reminders failed', { err }))
    void orchestrator!.runWhileActive(() => orchestrator!.expireProposals()).catch((err) => log.warn('proposal expiry failed', { err }))
    void orchestrator!.runWhileActive(() => orchestrator!.expireMinutesDrafts()).catch((err) => log.warn('minutes draft expiry failed', { err }))
    void orchestrator!.runWhileActive(() => orchestrator!.resumeDueRoutines()).catch((err) => log.warn('routine resume failed', { err }))
    // 主动模式：只问"有没有攒下的信号到阈值了"，不到点就去猜
    void orchestrator!.runWhileActive(() => orchestrator!.sweepSignals()).catch((err) => log.warn('signal sweep failed', { err }))
  }, 60_000)
  // 自己开的 PR：合并了、被关了、就绪太久没人看（两档）、合并后进了发布版本，各说一句。
  // 没有自己开过 PR 时这一圈什么都不查，空转很便宜。
  const prTimer = setInterval(() => {
    if (!scheduling()) return
    void orchestrator!.runWhileActive(() => orchestrator!.sweepIssueReplies())
      .catch((err) => log.warn('issue reply sweep failed', { err }))
    void orchestrator!.runWhileActive(() => orchestrator!.sweepRepositoryChecks())
      .catch((err) => log.warn('repository CI sweep failed', { err }))
    void orchestrator!.runWhileActive(() => orchestrator!.sweepPullRequests(cfg.policy.prReviewOverdueMs, cfg.policy.prReviewEscalateMs))
      .catch((err) => log.warn('pr sweep failed', { err }))
    if (cfg.prReplyDigest.enabled) void orchestrator!.runWhileActive(() => orchestrator!.sweepPullRequestReplies())
      .catch((err) => log.warn('pr reply sweep failed', { err }))
    // 人数块自己按 10 分钟到期判断；人数没变的 Issue 不读 GitHub。
    if (issueAffectedCount) void orchestrator!.runWhileActive(() => issueAffectedCount.sweep())
      .catch((err) => log.warn('issue affected count sweep failed', { err }))
  }, 5 * 60_000)
  // PMO 看板：绑了才跑；没变的行不会重写，所以空转很便宜
  const pmoTimer = setInterval(() => {
    if (!scheduling()) return
    void orchestrator!.runWhileActive(() => orchestrator!.syncPmo()).catch((err) => log.warn('pmo sync failed', { err }))
  }, 5 * 60_000)
  // 夜间整理：每小时看一眼到点没有（每个空间每天最多一次，由 orchestrator 自己去重）
  const consolidateTimer = setInterval(() => {
    if (!scheduling()) return
    if (cfg.memory.consolidateHour < 0) return
    const local = new Date(Date.now() + 8 * 3600_000)
    if (local.getUTCHours() !== cfg.memory.consolidateHour) return
    void orchestrator!.runWhileActive(() => orchestrator!.consolidateMemories()).catch((err) => log.warn('memory consolidation failed', { err }))
    // 全局自检包含私聊任务正文，已停用。/selfcheck 仅检查发起空间。
  }, 30 * 60_000)
  // 待办 ↔ 飞书任务。没开就整个不建定时器——比每轮进来再 return 少一层空转，
  // 也让日志里看不到一个根本没启用的东西在跑。
  let feishuTaskTimer: ReturnType<typeof setInterval> | undefined
  if (cfg.feishuTasks.enabled && cfg.feishuTasks.everyMs > 0) {
    feishuTaskTimer = setInterval(() => {
      if (!scheduling()) return
      void orchestrator!.runWhileActive(() => taskSync!.sweep()).then((r) => {
        // A blocked sweep carries blockedCapabilities in r: the log names which scope is missing.
        if (r.created || r.completed || r.pulledBack || r.updated || r.reopened || r.cancelled || r.transferred || r.retried || r.conflicts || r.unknown || r.blocked) log.info('feishu task sync', { ...r })
      }).catch((err) => log.warn('feishu task sync failed', { err }))
    }, cfg.feishuTasks.everyMs)
    feishuTaskTimer.unref()
  }
  reminderTimer.unref()
  lockTimer.unref()
  // 没人接的 issue：半小时看一眼。没有哪个空间绑过仓库时这一圈什么都不查，空转很便宜。
  const issueTimer = setInterval(() => {
    if (!scheduling()) return
    void orchestrator!.runWhileActive(() => orchestrator!.sweepIssues(cfg.policy.issueUnclaimedMs))
      .catch((err) => log.warn('issue sweep failed', { err }))
  }, 30 * 60_000)
  issueTimer.unref()
  prTimer.unref()
  log.info('Friday is up', { bot: cfg.feishu.botName, botOpenId, profile: cfg.dsh.profile, workspace: cfg.workspace.root, routines: routines.listAll().filter((r) => r.enabled).length, proactiveChats: proactive.listEnabled().length })

  const stopGateway = gatewayShutdown({ host: orchestrator, api, log,
    stop: async () => {
      scheduler.stop()
      for (const timer of [reminderTimer, consolidateTimer, pmoTimer, prTimer, lockTimer, issueTimer, feishuTaskTimer, identityTimer, collectionTimer, gmailTimer, desktopTimer]) clearInterval(timer)
      const desktopStopping = desktopBridge?.close()
      proactive.cancelAll()
      oauthRelay?.close()
      githubOAuthRelay?.close()
      gmailOAuthRelay?.close()
      ws.stop()
      await Promise.all([desktopStopping, ingress.close(), runtime.stop(), collectionRunner?.close(), gmailRunner?.close()])
      managedProfile?.close()
      api.server.closeAllConnections()
      api.callbackServer.closeAllConnections()
      await Promise.all([new Promise<void>(resolve => api.server.close(() => resolve())),
        new Promise<void>(resolve => api.callbackServer.close(() => resolve()))])
    },
    release: () => { locks.release(SCHEDULER_LOCK); locks.release(GATEWAY_LOCK) },
    closeDatabase: () => registry.close(), exit: () => process.exit(0),
  })
  const shutdown = (signal: string): Promise<void> => {
    log.info('shutting down', { signal })
    return stopGateway()
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

const isEntrypoint = process.argv[1] && /index\.(js|ts)$/.test(process.argv[1])
if (isEntrypoint) {
  main().catch((err) => {
    process.stderr.write(`Friday 启动失败: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
    process.exit(1)
  })
}
