import { homedir } from 'node:os'
import { DEFAULT_MAX_CONCURRENT } from './acp/runtime.js'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { resolveFeishuProxy } from './feishu/proxy.js'
import { USER_SCOPE_EXTRAS, userScopesFor, type UserScopeExtra } from './feishu/oauth.js'
import { parseModelPolicy, type ModelPolicy } from './core/model-selection.js'
import { normalizeExecutorBaseUrl } from './github/executor-client.js'

export type PermissionMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export type PermissionPolicy = 'auto' | 'safe' | 'deny'

export interface FridayConfig {
  /** Opt-in public admission policy; managed tools are not an OS sandbox. */
  publicMode?: boolean
  /** Daily new-task ceiling for non-admin users in public mode; zero suspends new work. */
  publicDailyTasks?: number | 'unlimited'
  /** Host-only remote execution service. Unconfigured means no remote commands. */
  executor?: { baseUrl: string; secret: string; proxyUrl?: string }
  feishu: {
    appId: string
    appSecret: string
    domain: 'feishu' | 'lark'
    botName: string
    /** 访问飞书用的 HTTP 代理（开发机场景）；不设则直连 */
    proxyUrl?: string
    /** 收到任务 / 完成 / 失败时贴在原消息上的表情（飞书 emoji_type）；undefined 表示不贴 */
    /**
     * 消息回执表情。每个状态一个，人不点开任何东西也知道发生了什么：
     * 收到 / 排队 / 等你拍板 / 完成 / 没做完 / 失败。
     */
    reactions: { ack?: string; queued?: string; waiting?: string; done?: string; partial?: string; fail?: string }
    /** 回执以外的表情。like = 主动巡检时给明确有用的消息点的赞（FRIDAY_KUDOS_EMOJI，默认 THUMBSUP） */
    emoji: { like: string }
    /** 个人授权：OAuth 回调地址（要在开发者后台"安全设置 → 重定向 URL"登记）与申请的用户权限 */
    oauth: {
      redirectUri: string
      scopes: string[]
      /**
       * 回调服务监听的地址和端口。默认只绑本机——那对**开发机自己**是对的，
       * 但浏览器不在这台机器上，所以对外必须绑一个别人到得了的地址。
       * 只有 /oauth/callback 一条路径在这上面，内部 API 仍然只在 127.0.0.1。
       */
      callbackHost: string
      callbackPort: number
      /**
       * 公网中转。有它的时候回调落在 Cloudflare Worker 上，网关自己去把 code 取回来——
       * 这是让**不在内网的人**也能走完授权的唯一办法（浏览器到不了容器）。
       * 没有它的时候一切照旧，走本机那条回调。
       */
      relay?: { baseUrl: string; token: string }
    }
    /** 兼容旧部署保留的字段；过程卡片已停用，不再控制消息发送。 */
    progressCardDelayMs: number
  }
  dsh: {
    command: string
    profile: string
    home: string
    permissionMode: PermissionMode
    /** 透传给 dsh 子进程的额外环境变量（模型 key 等） */
    env: Record<string, string>
    routerTimeoutMs: number
    models?: ModelPolicy
    /** Admission mode for new interactive work; a running ACP never changes mode. */
    executionMode?: 'workspace' | 'managed'
  }
  workspace: {
    root: string
    /**
     * 谁的工作区里能挂 repos/（共享代码检出）。
     * repos 是全局共享的，挂进谁的工作区，谁就能读写里面所有仓库——
     * 开给同事之前必须收紧，所以默认只有 admins。
     */
    repos: {
      /** 白名单里的 open_id（私聊工作区） */
      users: string[]
      /** 显式开了 repos 的群 chat_id */
      chats: string[]
    }
  }
  console?: { baseUrl: string; tenantKeys: string[]; allowInsecureLoopback: boolean }
  internalApi: {
    host: string
    port: number
    /** 进程内生成的 HMAC 密钥，用来给每个会话签发 capability token */
    secret: string
  }
  /** 待办镜像到飞书「任务」。需新版应用权限 task:task:writeonly + task:task:read。 */
  feishuTasks: {
    enabled: boolean
    everyMs: number
  }
  memory: {
    /** 轮末记忆整理：每轮结束让模型把值得记的存下来（同一会话，前缀缓存） */
    reflect: boolean
    /** 夜间整理的小时（0-23，本地时区）；-1 = 关 */
    consolidateHour: number
    /** 没用工具时，回答至少这么长才做整理 */
    reflectMinChars: number
  }
  /** 群级主动模式的节奏（按群 !proactive on 开启） */
  proactive: {
    quietMs: number
    minMessages: number
    maxPerHour: number
    dormantAfter: number
    /** 第一次被拉进群时默认开主动模式，开启人记为拉群的人（FRIDAY_PROACTIVE_DEFAULT_ON，默认开） */
    /** 兼容旧配置；新群始终由负责人在功能卡勾选开启，不再自动开启。 */
    defaultOn: boolean
  }
  /** 主动巡检里的点赞：每群每个自然日最多几个（FRIDAY_KUDOS_MAX_PER_DAY，默认 3，0 = 不点赞） */
  kudos: { maxPerDay: number }
  /** 需求投票（FRIDAY_POLLS，默认 off）。打开后仍须群负责人在本群开启（/space set polls on）才可用。 */
  polls: { enabled: boolean }
  /** 会议旁听（FRIDAY_MEETINGS，默认 off）。打开后仍须发起人所在空间和本人私聊都开启（/space set meetings on）才可用。 */
  meetings: { enabled: boolean }
  /**
   * 自己开的 PR 进入发布版本后，是否回告原报障人（FRIDAY_RELEASE_REPORTER_NOTICES，默认 off）。
   * 关着时只回告开 PR 的原会话；开着时再按案件关联的 Issue 找到 bug_reports 的原会话各回告一次。
   */
  releaseReporterNotices: { enabled: boolean }
  /** Friday 自己开的 PR 上有值得看的新回复时推回原会话（FRIDAY_PR_REPLY_DIGEST=on；默认关）。 */
  prReplyDigest: { enabled: boolean }
  /**
   * Friday 自己建的 Issue 正文里维护受影响人数块（FRIDAY_ISSUE_AFFECTED_COUNT，默认 off）。
   * 关着时不构造轮询、不读案件、不调 GitHub；开着时也只写 FRIDAY_GITHUB_WRITE_REPOS 里的仓库。
   */
  issueAffectedCount: { enabled: boolean }
  /**
   * 成员对照表（飞书多维表格）。表格天天有人改，所以 Friday 是**跟着它变**，不是灌一次就算。
   * 没配就退回 data/members.tsv 那份种子，只是那份会过期。
   */
  identityRoster?: {
    appToken: string
    tableId?: string
    refreshMs: number
  }
  policy: {
    permission: PermissionPolicy
    permissionTimeoutMs: number
    /**
     * 可信用户（open_id）：他们发起的任务里，沙箱升级 / 跑命令一类的权限请求自动放行（仍记日志、卡片里能看到命令）。
     * 其他人发起的仍要在卡片上点"允许"。
     */
    trustedUsers: string[]
    /**
     * 全局管理员（open_id）：可以把记忆晋升到企业层、改任何空间的配置。
     * 不填则沿用 FRIDAY_TRUSTED_USERS（可信用户本来就是最高信任那一档）。
     */
    admins: string[]
    allowedChats: string[]
    maxHistoryPerCall: number
    promptTimeoutMs: number
    /**
     * 同时最多跑几轮（FRIDAY_MAX_CONCURRENT_TURNS）。跨会话的全局上限——
     * 同一个话题本来就串行，这条管的是"十个群同时 @"。
     */
    maxConcurrentTurns: number
    /**
     * 一轮最多用多少步工具（FRIDAY_MAX_STEPS_PER_TURN），0 = 不限。
     * 到了就打断，然后逼它交一份"我查到哪、卡在哪"的收尾——
     * 超时作废什么都拿不到，明说没做完至少人能接着往下走。
     */
    maxStepsPerTurn: number
    /** 多久还没出结果就先回一句"收到"；0 = 不回 */
    ackAfterMs: number
    /** 自己开的 PR 就绪多久没人 review 就提醒；0 = 不提醒 */
    prReviewOverdueMs: number
    /** 第一档提醒过之后仍没人 review、就绪满多久就升级提醒空间负责人一次（FRIDAY_PR_REVIEW_ESCALATE_MS，默认 48 小时）；0 = 不升级 */
    prReviewEscalateMs: number
    /** issue 安静多久才问一句「这个没人接吗」；0 = 关掉 */
    issueUnclaimedMs: number
    /** Extra attempts for settled local repository preparation; 0 disables automatic retry. */
    preparationRetries?: number
  }
  dbPath: string
}

const PASSTHROUGH_ENV = [
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'ANTHROPIC_API_KEY',
  'FRIDAY_MODEL_PROVIDER',
  'FRIDAY_MODEL',
  'FRIDAY_ACP_MODEL_PROVIDER',
  'FRIDAY_ACP_MODEL',
  'FRIDAY_ROUTER_MODEL_PROVIDER',
  'FRIDAY_ROUTER_MODEL',
  'FRIDAY_MODEL_BASE_URL',
  'FRIDAY_MODEL_API',
  'DSH_TOOLS_MODE',
  'PATH',
  'HOME',
  'LANG',
  'TZ',
]

function req(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key]
  if (!v) throw new Error(`缺少环境变量 ${key}（参考 .env.example）`)
  return v
}

function int(env: NodeJS.ProcessEnv, key: string, dflt: number, opts: { allowZero?: boolean } = {}): number {
  const v = env[key]
  if (v === undefined || v === '') return dflt
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0 || (n === 0 && !opts.allowZero)) throw new Error(`环境变量 ${key} 必须是${opts.allowZero ? '非负' : '正'}整数，收到 ${v}`)
  return n
}

/** 逗号或空白分隔的列表（open_id、chat_id 一类）。 */
function list(v: string | undefined): string[] {
  return (v ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function publicDailyTasks(raw: string | undefined): number | 'unlimited' {
  if (raw === undefined || raw.trim() === '') return 'unlimited'
  if (raw.trim() === 'unlimited') return 'unlimited'
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(Number(raw))) throw new Error('FRIDAY_PUBLIC_DAILY_TASKS 必须为非负整数或 unlimited')
  return Number(raw)
}

/** 0–23 的小时，或 off（返回 -1）。 */
function hourOrOff(env: NodeJS.ProcessEnv, key: string, dflt: number): number {
  const raw = (env[key] ?? '').trim()
  if (!raw) return dflt
  if (raw.toLowerCase() === 'off') return -1
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0 || n > 23) throw new Error(`环境变量 ${key} 必须是 0–23 的整数或 off，收到 ${raw}`)
  return n
}

function oneOf<T extends string>(env: NodeJS.ProcessEnv, key: string, allowed: readonly T[], dflt: T): T {
  const v = env[key]
  if (!v) return dflt
  if (!allowed.includes(v as T)) throw new Error(`环境变量 ${key} 只能是 ${allowed.join(' | ')}，收到 ${v}`)
  return v as T
}

/**
 * dsh 子进程要不要吃代理：模型端点常在内网，只有 web 工具需要出网。
 * FRIDAY_DSH_PROXY=1 时把 HTTP(S)_PROXY 传给 dsh，并保证 NO_PROXY 里有内网域名与本机地址。
 */
function dshProxyEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  if (env.FRIDAY_DSH_PROXY !== '1') return {}
  const proxy = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy
  if (!proxy) return {}
  const noProxy = new Set(
    (env.NO_PROXY ?? env.no_proxy ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
  // 直连的只有两类：本机，和**这个部署实际在用的**内网端点。
  //
  // 原来这里写了 `.deepseek.com`，本意是"内网模型端点不走代理"，但那个写法匹配所有子域，
  // 于是把**公网的** `api.deepseek.com` 一起排除了——而联网搜索打的正是它。
  // 结果是：就算把 FRIDAY_DSH_PROXY 打开，web_search 照样 `fetch failed`，
  // 而且报错里看到的是"端点连不上"，完全看不出问题其实出在 NO_PROXY 上。
  //
  // 改成跟着配置走：内网端点从 DEEPSEEK_BASE_URL 里取，代理自己也要直连（否则绕回自己）。
  // 这样换一个内网地址不用回来改这一行，也不会再顺手把公网域名一起排除掉。
  for (const d of ['localhost', '127.0.0.1', '::1', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']) noProxy.add(d)
  for (const url of [env.DEEPSEEK_BASE_URL, env.OPENAI_BASE_URL, env.FRIDAY_MODEL_BASE_URL, proxy]) {
    if (!url) continue
    try { noProxy.add(new URL(url).hostname) } catch { /* 配歪了就当没配，不影响其余直连项 */ }
  }
  const list = [...noProxy].join(',')
  return { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy, NO_PROXY: list, no_proxy: list }
}

export const REACTION_STATES = ['ack', 'queued', 'waiting', 'done', 'partial', 'fail'] as const
export type ReactionState = (typeof REACTION_STATES)[number]

/**
 * 键名全部在真实租户上验过（飞书《表情文案说明》里的 emoji_type）。
 * 别凭感觉起名：`Eyes`、`Thinking`、`Hourglass` 这些看着合理的都不存在，会被 231001 拒掉。
 */
export const DEFAULT_REACTIONS: Record<ReactionState, string> = {
  ack: 'OnIt', // 在做了
  queued: 'Typing', // 排着呢，还没轮到
  waiting: 'GLANCE', // 瞄一眼——球在你那儿，等你拍板
  done: 'DONE', // 答完了
  partial: 'THINKING', // 没做完，这是阶段结论
  fail: 'CrossMark', // 失败
}

/**
 * FRIDAY_REACTIONS：`off` 关掉。两种写法：
 *
 * - 逗号分隔的三个位置 `收到,完成,失败`——**保持老含义不变**。
 *   加了新状态就顺手把位置往后排的话，别人 `.env` 里写着的 `GLANCE,DONE,` 会一夜之间
 *   变成"收到=GLANCE、排队=DONE"，而且没有任何报错。这种改法比不加功能坏得多。
 * - `ack=OnIt,queued=Typing,fail=CrossMark` 按名字给，六个状态都能设，也不怕数错位置。
 *
 * 表情键名见飞书《表情文案说明》；写错了只是不贴（会打一条 warn），不会让这一轮失败。
 */
export function parseReactions(raw: string | undefined): FridayConfig['feishu']['reactions'] {
  if (raw === undefined) return { ...DEFAULT_REACTIONS }
  const v = raw.trim()
  if (!v || v === 'off' || v === 'none' || v === '0') return {}
  const parts = v.split(',').map((s) => s.trim())
  const out: FridayConfig['feishu']['reactions'] = {}
  if (parts.some((p) => p.includes('='))) {
    for (const p of parts) {
      const [k = '', val = ''] = p.split('=').map((x) => x.trim())
      if ((REACTION_STATES as readonly string[]).includes(k) && val) out[k as ReactionState] = val
    }
    return out
  }
  // 位置写法只认老的三个，含义不动
  const [ack, done, fail] = parts
  if (ack) out.ack = ack
  if (done) out.done = done
  if (fail) out.fail = fail
  return out
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): FridayConfig {
  const home = env.FRIDAY_HOME ?? join(homedir(), '.friday')
  const passthrough: Record<string, string> = { ...dshProxyEnv(env) }
  for (const k of PASSTHROUGH_ENV) if (env[k] !== undefined) passthrough[k] = env[k] as string

  return {
    publicMode: ['true', '1'].includes(oneOf(env, 'FRIDAY_PUBLIC_MODE', ['false', 'true', '0', '1'] as const, 'false')),
    publicDailyTasks: publicDailyTasks(env.FRIDAY_PUBLIC_DAILY_TASKS),
    executor: executorConfig(env),
    feishu: {
      appId: req(env, 'FEISHU_APP_ID'),
      appSecret: req(env, 'FEISHU_APP_SECRET'),
      domain: oneOf(env, 'FEISHU_DOMAIN', ['feishu', 'lark'] as const, 'feishu'),
      botName: env.FRIDAY_BOT_NAME ?? 'Friday',
      proxyUrl: resolveFeishuProxy(env),
      reactions: parseReactions(env.FRIDAY_REACTIONS),
      emoji: { like: env.FRIDAY_KUDOS_EMOJI?.trim() || 'THUMBSUP' },
      oauth: {
        // 默认仍然指向**内部 API 的端口**：那条 /oauth/callback 路由一直都在，
        // 而飞书后台的重定向白名单里配的就是它。加一个新的回调端口不该让已有配置失效——
        // 改了默认值就等于让线上所有授权立刻 20029（Invalid redirect URL）。
        // 想用一个别人到得了的地址时，显式配 FRIDAY_OAUTH_REDIRECT_URI，并去后台白名单加上它。
        redirectUri: env.FRIDAY_OAUTH_REDIRECT_URI ?? relayCallbackUri(env)
          ?? `http://127.0.0.1:${int(env, 'FRIDAY_API_PORT', 7788)}/oauth/callback`,
        callbackHost: env.FRIDAY_OAUTH_HOST?.trim() || '127.0.0.1',
        callbackPort: int(env, 'FRIDAY_OAUTH_PORT', 7789),
        // 公网中转。配上它，回调地址就走公网 Worker，任何人在任何网络里都能走完授权；
        // 不配就还是本机那条路，行为和以前一模一样。
        relay: relayConfig(env),
        // 默认只要免审的 core。附加组（watch / calendar）要后台单独开通，
        // 没开通却请求，整个授权页会 20027 报错，所以必须显式打开。
        scopes: (env.FRIDAY_USER_SCOPES ?? '').split(/[\s,]+/).filter(Boolean).length
          ? (env.FRIDAY_USER_SCOPES as string).split(/[\s,]+/).filter(Boolean)
          : userScopesFor((env.FRIDAY_USER_SCOPE_EXTRAS ?? '').split(/[\s,]+/).filter(Boolean)
              .filter((x): x is UserScopeExtra => (USER_SCOPE_EXTRAS as readonly string[]).includes(x))),
      },
      progressCardDelayMs: int(env, 'FRIDAY_PROGRESS_CARD_DELAY_MS', 4000, { allowZero: true }),
    },
    dsh: {
      command: env.DSH_COMMAND ?? 'dsh',
      profile: env.DSH_PROFILE ?? 'friday',
      home: env.DSH_HOME ?? join(home, 'dsh'),
      routerTimeoutMs: int(env, 'FRIDAY_ROUTER_TIMEOUT_MS', 15_000),
      models: parseModelPolicy(env),
      executionMode: oneOf(env, 'FRIDAY_DEFAULT_EXECUTION', ['workspace', 'managed'] as const, 'workspace'),
      permissionMode: oneOf(env, 'DSH_PERMISSION_MODE', ['read-only', 'workspace-write', 'danger-full-access'] as const, 'workspace-write'),
      env: passthrough,
    },
    workspace: {
      root: env.FRIDAY_WORKSPACE_ROOT ?? join(home, 'workspaces'),
      repos: {
        // 不配就等于"只有管理员"，这样把应用开给同事时不会顺手把代码检出也开出去
        users: list(env.FRIDAY_REPOS_USERS).length ? list(env.FRIDAY_REPOS_USERS) : (list(env.FRIDAY_ADMINS).length ? list(env.FRIDAY_ADMINS) : list(env.FRIDAY_TRUSTED_USERS)),
        chats: list(env.FRIDAY_REPOS_CHATS),
      },
    },
    console: env.FRIDAY_CONSOLE_BASE_URL?.trim() ? {
      baseUrl: env.FRIDAY_CONSOLE_BASE_URL.trim(), tenantKeys: list(env.FRIDAY_CONSOLE_TENANT_KEYS),
      allowInsecureLoopback: oneOf(env, 'FRIDAY_CONSOLE_DEV_HTTP', ['on', 'off'] as const, 'off') === 'on',
    } : undefined,
    identityRoster: env.FRIDAY_IDENTITY_BASE?.trim() ? {
      appToken: env.FRIDAY_IDENTITY_BASE.trim(),
      tableId: env.FRIDAY_IDENTITY_TABLE?.trim() || undefined,
      refreshMs: int(env, 'FRIDAY_IDENTITY_REFRESH_MS', 30 * 60_000),
    } : undefined,
    internalApi: {
      host: env.FRIDAY_API_HOST ?? '127.0.0.1',
      port: int(env, 'FRIDAY_API_PORT', 7788),
      secret: env.FRIDAY_API_SECRET ?? randomBytes(32).toString('hex'),
    },
    feishuTasks: {
      // 默认关：须先开通新版任务应用权限并真实验收。
      // 后台开通并发版之后设 FRIDAY_FEISHU_TASKS=1，不用改代码。
      enabled: env.FRIDAY_FEISHU_TASKS === '1',
      everyMs: int(env, 'FRIDAY_FEISHU_TASKS_EVERY_MS', 10 * 60_000),
    },
    memory: {
      reflect: oneOf(env, 'FRIDAY_REFLECT', ['on', 'off'] as const, 'on') === 'on',
      consolidateHour: hourOrOff(env, 'FRIDAY_CONSOLIDATE_HOUR', 3),
      reflectMinChars: int(env, 'FRIDAY_REFLECT_MIN_CHARS', 200),
    },
    proactive: {
      quietMs: int(env, 'FRIDAY_PROACTIVE_QUIET_MS', 3 * 60_000),
      minMessages: int(env, 'FRIDAY_PROACTIVE_MIN_MESSAGES', 3),
      maxPerHour: int(env, 'FRIDAY_PROACTIVE_MAX_PER_HOUR', 2),
      dormantAfter: int(env, 'FRIDAY_PROACTIVE_DORMANT_AFTER', 5),
      defaultOn: ['on', 'true', '1'].includes(oneOf(env, 'FRIDAY_PROACTIVE_DEFAULT_ON', ['on', 'off', 'true', 'false', '1', '0'] as const, 'on')),
    },
    kudos: { maxPerDay: int(env, 'FRIDAY_KUDOS_MAX_PER_DAY', 3, { allowZero: true }) },
    // 默认关：关着时不构造投票运行时、不挂投票路由、不签发投票作用域；投票表结构启动时照常建（与迁移适配器一致）。
    polls: { enabled: oneOf(env, 'FRIDAY_POLLS', ['on', 'off'] as const, 'off') === 'on' },
    // 默认关：关着时不构造会议运行时、不挂会议路由、不签发会议作用域、定时器不同步会议；会议表结构启动时照常建（与迁移适配器一致）。
    meetings: { enabled: oneOf(env, 'FRIDAY_MEETINGS', ['on', 'off'] as const, 'off') === 'on' },
    // 默认关：原会话的"已进入 vX"不受此开关影响；开着时才去查 PR 关闭的 Issue 并回告原报障人。
    releaseReporterNotices: { enabled: oneOf(env, 'FRIDAY_RELEASE_REPORTER_NOTICES', ['on', 'off'] as const, 'off') === 'on' },
    prReplyDigest: { enabled: oneOf(env, 'FRIDAY_PR_REPLY_DIGEST', ['on', 'off'] as const, 'off') === 'on' },
    // 默认关：关着时不构造人数块轮询；开着时只改 Friday 自己建的 Issue 里自己写的那一块，块被人改过就停止维护该 Issue。
    issueAffectedCount: { enabled: oneOf(env, 'FRIDAY_ISSUE_AFFECTED_COUNT', ['on', 'off'] as const, 'off') === 'on' },
    policy: {
      permission: oneOf(env, 'FRIDAY_PERMISSION_POLICY', ['auto', 'safe', 'deny'] as const, 'safe'),
      permissionTimeoutMs: int(env, 'FRIDAY_PERMISSION_TIMEOUT_MS', 10 * 60_000),
      trustedUsers: list(env.FRIDAY_TRUSTED_USERS),
      admins: list(env.FRIDAY_ADMINS).length ? list(env.FRIDAY_ADMINS) : list(env.FRIDAY_TRUSTED_USERS),
      allowedChats: (env.FRIDAY_ALLOWED_CHATS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      maxHistoryPerCall: int(env, 'FRIDAY_MAX_HISTORY', 500),
      promptTimeoutMs: int(env, 'FRIDAY_PROMPT_TIMEOUT_MS', 20 * 60_000),
      maxConcurrentTurns: Math.max(1, int(env, 'FRIDAY_MAX_CONCURRENT_TURNS', DEFAULT_MAX_CONCURRENT)),
      maxStepsPerTurn: Math.max(0, int(env, 'FRIDAY_MAX_STEPS_PER_TURN', 40, { allowZero: true })),
      /**
       * 多久还没出结果就先回一句"收到，我来处理"。0 = 不回。
       * 刻意做成**迟到**的：快的那些直接出结果，再补一句"收到"是噪音；
       * 慢的那些沉默着干几十分钟，对方根本不知道你接没接。
       */
      ackAfterMs: int(env, 'FRIDAY_ACK_AFTER_MS', 45_000, { allowZero: true }),
      /** 自己开的 PR 就绪多久还没人 review 就提醒一次；0 = 不提醒 */
      prReviewOverdueMs: int(env, 'FRIDAY_PR_REVIEW_OVERDUE_MS', 12 * 3600_000, { allowZero: true }),
      /** 第二档：第一档提醒过之后仍没人 review、就绪满这么久就升级提醒空间负责人一次；0 = 不升级 */
      prReviewEscalateMs: int(env, 'FRIDAY_PR_REVIEW_ESCALATE_MS', 48 * 3600_000, { allowZero: true }),
      issueUnclaimedMs: int(env, 'FRIDAY_ISSUE_UNCLAIMED_MS', 24 * 3600_000, { allowZero: true }),
      preparationRetries: int(env, 'FRIDAY_PREPARATION_RETRIES', 2, { allowZero: true }),
    },
    dbPath: env.FRIDAY_DB ?? join(home, 'friday.db'),
  }
}

/**
 * 公网中转（Cloudflare Worker）。
 *
 * 网关跑在只转发 ssh 的容器里，浏览器到不了它——而 OAuth 回调**必须**是浏览器
 * 到得了的地址，这一步没有轮询能替代。配上 URL 和 token，回调就落在公网 Worker 上，
 * 网关自己去取；内网、外网、别人的手机，都一样能走完。
 *
 * 两个都配齐才算数：只配 URL 会让网关拿着空 token 去取，一路 401 而看起来像"没人授权"。
 */
export function relayConfig(env: NodeJS.ProcessEnv): { baseUrl: string; token: string } | undefined {
  const baseUrl = env.FRIDAY_OAUTH_RELAY_URL?.trim().replace(/\/+$/, '')
  const token = env.FRIDAY_OAUTH_RELAY_TOKEN?.trim()
  if (!baseUrl && !token) return undefined
  if (!baseUrl || !token) throw new Error('OAuth relay URL 和 token 必须同时配置')
  const url = new URL(baseUrl)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('FRIDAY_OAUTH_RELAY_URL 必须是没有路径或查询参数的 HTTPS origin')
  if (env.FRIDAY_OAUTH_REDIRECT_URI && env.FRIDAY_OAUTH_REDIRECT_URI !== `${url.origin}/oauth/callback`)
    throw new Error('OAuth redirect URI 与 relay callback 不一致')
  return { baseUrl: url.origin, token }
}

export function executorConfig(env: NodeJS.ProcessEnv): FridayConfig['executor'] {
  const base = env.FRIDAY_EXECUTOR_URL?.trim(), secret = env.FRIDAY_EXECUTOR_TOKEN?.trim()
  if (!base && !secret) return undefined
  if (!base || !secret || secret.length < 32 || secret.length > 4096 || /[^\x21-\x7e]/.test(secret)) throw new Error('执行器 URL 和独立密钥必须完整配置')
  let baseUrl: string
  try { baseUrl = normalizeExecutorBaseUrl(base) } catch { throw new Error('执行器 URL 必须是无凭据、查询参数或片段的固定 HTTPS 路径') }
  return { baseUrl, secret, proxyUrl: executorProxy(env) }
}

/** 执行器专用代理：FRIDAY_EXECUTOR_PROXY 显式给 URL 就用它；填 direct/off/none/0 表示强制直连（代理到不了内网执行器时用）；
 * 没填才沿用飞书代理。 */
function executorProxy(env: NodeJS.ProcessEnv): string | undefined {
  const explicit = env.FRIDAY_EXECUTOR_PROXY?.trim()
  if (!explicit) return resolveFeishuProxy(env)
  if (/^(direct|off|none|0)$/i.test(explicit)) return undefined
  return explicit
}

/** 配了中转就把回调地址指过去；这个地址要同时加进飞书后台的重定向白名单。 */
function relayCallbackUri(env: NodeJS.ProcessEnv): string | undefined {
  const relay = relayConfig(env)
  return relay ? `${relay.baseUrl}/oauth/callback` : undefined
}
