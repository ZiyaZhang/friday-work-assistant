import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { FridayClient } from './transport.js'
import { createDesktopFetch } from './network.js'
import { LocalRunner } from './local-runner.js'

export const name = 'friday-personal'
export const inject = ['connection']

export async function invoke(client, path, input = {}, local) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || JSON.stringify(input).length > 64_000) throw new Error('操作格式无效。')
  if (path === 'status') return client.status()
  if (path === 'pair') return client.pair(input.url, input.label)
  if (path === 'pair/status') return client.finishPair()
  if (path === 'forget') return client.forgetExpired()
  if (path === 'request') return client.request(input.requestId, input.command)
  if (path.startsWith('local/')) {
    if (!local) throw new Error('当前 DSH 未启用本机执行服务，请刷新或检查插件状态。')
    if (path === 'local/metadata') return local.metadata()
    if (path === 'local/start') return local.start(input)
    if (path === 'local/stop') return local.stop(input.id)
  }
  throw new Error('入口不存在。')
}
const safeError = error => error instanceof Error && /^[\u3000-\u9fff]/.test(error.message) && error.message.length < 160 ? error.message : 'Friday 暂时不可用，请稍后再试。'

export function apply(ctx) {
  // A profile has its own device connection. Model tools and the browser never receive this storage path or its keys.
  const profile = createHash('sha256').update(String(ctx.baseUrl ?? process.cwd())).digest('hex').slice(0, 20)
  const client = new FridayClient({ directory: join(homedir(), '.dsh', 'friday', profile), fetch: createDesktopFetch() })
  let local
  ctx.inject(['sessionController', 'agents', 'agentDefaultModel'], context => {
    const runner = new LocalRunner({ client, sessions: context.sessionController, agents: context.agents,
      selection: () => context.agentDefaultModel.currentSelection(), watch: handler => context.on('session/event', handler) })
    local = runner
    context.effect(() => () => { runner.close(); if (local === runner) local = undefined }, 'Friday: local execution')
  })
  registerRoutes(ctx, client, () => local)
  ctx.effect(() => () => client.close(), 'Friday: device lifetime')
}
export function registerRoutes(ctx, client, local = () => undefined) {
  // The desktop shell forwards the shared /api prefix to its authenticated
  // Host. Connection owns both its trust fence and route lifetime.
  for (const path of ['status', 'pair', 'pair/status', 'forget', 'request', 'local/metadata', 'local/start', 'local/stop']) ctx.connection.fetch.register({
    path: '/api/friday/' + path, methods: path === 'status' ? ['GET'] : ['POST'], requestBody: 'buffered',
    fetch: async request => {
      try {
        if (request.method !== 'GET' && !request.headers.get('content-type')?.startsWith('application/json')) throw new Error('请刷新后重试。')
        const input = request.method === 'GET' ? {} : await request.json()
        return Response.json(await invoke(client, path, input, local()), { headers: { 'cache-control': 'no-store' } })
      } catch (error) { return Response.json({ error: safeError(error) }, { status: 400, headers: { 'cache-control': 'no-store' } }) }
    },
  })
}
