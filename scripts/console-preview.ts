/** Manual loopback UI fixture. Synthetic data only; no production config or platform client. */
import { createServer, type ServerResponse } from 'node:http'
import { Registry } from '../src/core/registry.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { ChannelMemory } from '../src/core/memory.js'
import { Todos } from '../src/core/todos.js'
import { RoutineStore } from '../src/core/routines.js'
import { SkillProposals } from '../src/core/skills.js'
import { Spaces, spaceScope } from '../src/core/space.js'
import { PolicyService } from '../src/core/policy.js'
import { DeliveryService } from '../src/core/delivery.js'
import { taskDeliveryContextRef } from '../src/core/execution-keys.js'
import { ConsoleAuth } from '../src/web/console-auth.js'
import { HumanSpaceAccess } from '../src/core/human-space-access.js'
import { ConsoleQueries } from '../src/core/console-queries.js'
import { ConsoleCommands } from '../src/core/console-commands.js'
import { ConsoleOperations } from '../src/core/console-operations.js'
import { RoutineApplication } from '../src/core/routine-application.js'
import { SpaceApplication } from '../src/core/space-application.js'
import { TodoApplication } from '../src/core/todo-application.js'
import { createConsoleRouter } from '../src/web/console-router.js'
import { GitHubIdentity, type GitHubHttp } from '../src/github/identity.js'
import { GitHubProjectView } from '../src/github/project-view.js'
import { FakeFeishu, asFeishuClient } from '../test/helpers/fake-feishu.js'
import { createLogger } from '../src/log.js'

const port = Number(process.argv[2] ?? '18982')
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Use a loopback development port between 1024 and 65535')
const base = `http://127.0.0.1:${port}`, actor = 'ou_console_demo_alice', tenant = 'tenant_console_demo', now = Date.now()
const registry = new Registry(':memory:'), runs = new RunAttempts(registry.db), memory = new ChannelMemory(registry.db)
const todos = new Todos(registry.db), routines = new RoutineStore(registry.db), skills = new SkillProposals(registry.db)
const spaces = new Spaces(registry.db), policy = new PolicyService(spaces, { admins: [], mode: 'safe' }), fake = new FakeFeishu()
const populated = spaces.ensure({ kind: 'group', chatId: 'oc_console_demo_team', openId: actor, title: '演示数据 · 产品协作' })
const empty = spaces.ensure({ kind: 'group', chatId: 'oc_console_demo_empty', openId: actor, title: '演示数据 · 空白群' })
for (const s of [populated, empty]) fake.members.set(s.chatId!, new Set([actor]))
fake.names.set(actor, '小林 · 演示数据')
spaces.patchConfig(populated.id, { brevity: 'short', reflect: false, projectRepos: ['test-org/test-repo'] })
const scope = spaceScope(populated.id)
const session = registry.createSession({ sessionKey: 'preview:team', chatId: populated.chatId!, chatType: 'group',
  cwd: '/synthetic-console-fixture-not-used', requesterOpenId: actor, title: '演示数据 · 产品协作', rootMessageId: 'om_demo_origin' })
const task = (id: string, prompt: string, state: 'done' | 'failed' = 'done') => {
  const created = registry.createTaskOnce({ sessionKey: session.sessionKey, messageId: id, requesterOpenId: actor, prompt }).task
  registry.updateTask(created.id, { status: 'running', startedAt: now - 90_000 })
  const run = runs.begin({ workKey: `work:task:${created.id}`, sessionKey: session.sessionKey, triggerKey: `demo:${id}`,
    stage: 'task', taskId: created.id, actorOpenId: actor, now: now - 90_000 })!
  registry.updateTask(created.id, { status: state, stopReason: state === 'done' ? 'end_turn' : 'delivery_unknown', finishedAt: now - 30_000 })
  runs.finish(run.id, state === 'done' ? 'completed' : 'failed', now - 30_000, state === 'done' ? 'end_turn' : 'delivery_unknown')
  return created
}
const sourceTask = task('om_demo_preference', '演示数据：以后项目周报先给结论，再给一个下一步。')
const preference = memory.add({ scope, sessionKey: session.sessionKey, kind: 'rule', title: '项目周报的表达方式',
  body: '演示数据：先给结论，再给一个最有用的下一步；详细依据按需展开。',
  source: { messageId: sourceTask.messageId, chatId: populated.chatId } })
const confirmation = task('om_demo_confirmation', '演示数据：确认刚才这条项目周报表达方式，作为本群长期规则。')
if (!memory.confirm(preference.id, scope, { by: actor, messageId: confirmation.messageId })) throw new Error('Synthetic confirmation failed')
memory.add({ scope, sessionKey: session.sessionKey, kind: 'fact', title: '周五演示的准备范围',
  body: '演示数据：候选记录——周五只展示已完成的界面流程，仍需负责人确认。', source: { messageId: 'om_demo_candidate', chatId: populated.chatId } })
const todoBase = { scope, createdBy: actor, sessionKey: session.sessionKey, owner: '小林', ownerOpenId: actor, source: '演示数据 · 本群明确委托' }
todos.add({ ...todoBase, title: '整理周五演示清单', detail: '只列已经验证的流程，并保留仍未完成的项目。', dueMs: now + 86_400_000 })
const blocked = todos.add({ ...todoBase, title: '核对授权页验收截图', detail: '等设计稿确认后再继续。', confirmed: false })
todos.transition(blocked.id, scope, 'blocked', { by: actor, note: '演示数据：等待设计稿确认。' })
const review = todos.add({ ...todoBase, title: '验收移动端空间切换', detail: '实现完成，等待实际页面验收。' })
todos.transition(review.id, scope, 'review', { by: actor, note: '演示数据：等待人工验收，不代表已完成。' })
const routine = routines.add({ kind: 'schedule', ownerOpenId: actor, runAs: actor, spaceId: populated.id, chatId: populated.chatId!, chatType: 'group',
  name: '每日项目简报', prompt: '演示数据：汇总本群项目待处理事项。', schedule: { type: 'daily', at: '09:30' }, deliveryPolicy: 'every_run', source: 'user' })
routines.setEnabled(routine.id, false)
const uncertain = task('om_demo_delivery', '演示数据：发送本周项目进展摘要。', 'failed')
const delivery = new DeliveryService(registry.db, { spaces, policy,
  resolveContext: async () => ({ actorOpenId: actor, provenanceComplete: true, expiresAt: Date.now() + 60_000,
    sources: [{ ref: 'synthetic-source', spaceId: populated.id, chatId: populated.chatId }],
    audience: { kind: 'group', spaceId: populated.id, chatId: populated.chatId!, replyToMessageId: uncertain.messageId } }),
  send: async () => { await fake.replyText(uncertain.messageId, '演示数据：摘要已在模拟平台接收。'); throw new Error('Synthetic lost ACK') },
})
try { await delivery.deliver({ key: `task:${uncertain.id}:final:0`, contextRef: taskDeliveryContextRef(uncertain.id, session.sessionKey), payload: { text: '演示数据：项目摘要' } }) }
catch { if (delivery.get(`task:${uncertain.id}:final:0`)?.status !== 'unknown') throw new Error('Unknown delivery fixture failed') }

const iso = (offset: number) => new Date(now + offset).toISOString(), day = 86_400_000
const issue = (number: number, title: string, extra: Record<string, unknown> = {}) => ({ number, title, state: 'open', state_reason: null,
  html_url: `https://github.com/test-org/test-repo/issues/${number}`, created_at: iso(-5 * day), updated_at: iso(-day), closed_at: null, assignees: [], ...extra })
const pull = issue(3, '演示数据：支持窄屏空间切换', { html_url: 'https://github.com/test-org/test-repo/pull/3', pull_request: {}, state: 'closed', closed_at: iso(-day), merged_at: iso(-day), draft: false, assignees: [{ login: 'demo-lin' }] })
const http: GitHubHttp = { async request<T>(method: string, path: string) {
  if (method !== 'GET') throw new Error('Preview forbids remote writes')
  const url = new URL(path, 'https://github.invalid')
  if (!url.pathname.startsWith('/repos/test-org/test-repo/')) throw new Error('Unknown synthetic repo')
  const data = url.searchParams.get('page') !== '1' ? [] : url.pathname.endsWith('/pulls') ? [pull] : [
    issue(1, '演示数据：完善登录失效说明', { assignees: [{ login: 'demo-lin' }] }),
    issue(2, '演示数据：待办完成后保留结果链接', { state: 'closed', state_reason: 'completed', closed_at: iso(-2 * day), assignees: [{ login: 'demo-zhou' }] }), pull,
  ]
  return { status: 200, data: data as T }
} }
const github = new GitHubIdentity({ apiUrl: 'https://github.invalid', token: 'synthetic-not-a-real-token', allowedRepos: ['test-org/test-repo'] }, createLogger('console-preview', 'error'), http)
const projects = new GitHubProjectView(registry.db, github)
await projects.sync('test-org/test-repo')

let exchangeCalls = 0
const auth = new ConsoleAuth({ db: registry.db, appId: 'cli_console_demo', domain: 'feishu', baseUrl: base, tenantKeys: [tenant], allowInsecureLoopback: true,
  provider: {
    exchangeCode: async (code, redirectUri) => { if (code !== 'synthetic-console-code' || redirectUri !== `${base}/console/auth/callback`) throw new Error('Invalid fixture OAuth code'); exchangeCalls++; return { accessToken: 'synthetic-console-access-token' } },
    whoAmI: async token => { if (token !== 'synthetic-console-access-token') throw new Error('Invalid fixture token'); return { openId: actor, tenantKey: tenant, name: '小林 · 演示数据' } },
  },
})
const access = new HumanSpaceAccess({ spaces, policy, feishu: asFeishuClient(fake), assertActor: a => auth.assertCurrent(a) })
const queries = new ConsoleQueries({ access, registry, memory, todos, routines, skills, github, projects, defaults: { brevity: 'normal', reflect: false } })
const routineApplication = new RoutineApplication({ registry, spaces, routines, attempts: runs, activeRuns: () => [], now: Date.now })
const router = createConsoleRouter(auth, queries, new ConsoleCommands({ access,
  operations: new ConsoleOperations(registry.db, { sessions: auth.sessions }), spaces, routines, todos,
  spaceApplication: new SpaceApplication({ db: registry.db, spaces }), todoApplication: new TodoApplication({ db: registry.db, todos }),
  persistRoutineControl: (id, action, options) => routineApplication.persistControl(id, action, options),
  assertHumanRunTarget: () => { throw new Error('This fixture has no running worker') },
  persistHumanRunStop: () => { throw new Error('This fixture has no running worker') },
}))
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
const html = (res: ServerResponse, body: string) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Friday 后台 · 合成演示</title><link rel="stylesheet" href="/console/app.css"><body><main><p class="eyebrow">仅本机 / 演示数据</p>${body}</main></body></html>`) }
const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', base)
    if (url.pathname === '/' || url.pathname === '/preview') {
      html(res, '<h1>Friday 后台演示</h1><p>全部为合成数据，只连接本机模拟身份服务；不会访问真实飞书。</p><p>包含一个有数据的产品群和一个空白群，可切换查看五个页面。</p><a class="primary" href="/console">打开后台</a>'); return
    }
    if (url.pathname === '/preview/identity' && req.method === 'GET') {
      const state = url.searchParams.get('state') ?? ''
      if (!/^[A-Za-z0-9_-]{43}$/.test(state)) { res.writeHead(400); res.end('Invalid synthetic login state'); return }
      const callback = `/console/auth/callback?code=synthetic-console-code&state=${encodeURIComponent(state)}`
      html(res, `<h1>模拟飞书身份确认</h1><p>演示用户：小林；仅用于本机合成数据验收。</p><p>继续会进入真实后台登录回调，验证刚才生成的 state 与浏览器 nonce。</p><a class="primary" href="${escape(callback)}">以演示用户继续</a>`); return
    }
    if (url.pathname === '/preview/status') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ fixture: true, memoryDatabase: true, actualOAuthNetwork: false, exchangeCalls, spaceIds: [populated.id, empty.id] })); return
    }
    // Let real ConsoleAuth create state+nonce, replacing only its outgoing OAuth Location.
    if (url.pathname === '/console/auth/start' && req.method === 'GET') {
      const original = res.writeHead.bind(res)
      res.writeHead = ((status: number, headers: Record<string, string | number | string[]> = {}) => {
        if (status === 303 && typeof headers.location === 'string') {
          const external = new URL(headers.location), state = external.searchParams.get('state')
          if (external.origin !== 'https://accounts.feishu.cn' || !state) throw new Error('Unexpected OAuth redirect')
          return original(status, { ...headers, location: `/preview/identity?state=${encodeURIComponent(state)}` })
        }
        return original(status, headers)
      }) as typeof res.writeHead
    }
    if (!await router(req, res)) { res.writeHead(404); res.end('Not found') }
  })().catch(() => { if (!res.headersSent) res.writeHead(500); res.end('Synthetic preview failed') })
})
server.on('error', () => { console.error('Preview could not bind its loopback port; no existing service was stopped.'); registry.close(); process.exitCode = 1 })
server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ url: `${base}/preview`, console: `${base}/console`, fixture: 'synthetic-memorydb-real-console-auth-router', pid: process.pid, spaces: [populated.title, empty.title] })))
const close = () => { server.closeAllConnections(); server.close(() => { registry.close(); process.exit(0) }) }
process.once('SIGINT', close); process.once('SIGTERM', close)
