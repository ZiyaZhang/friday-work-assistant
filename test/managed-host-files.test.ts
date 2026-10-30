import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { SourceContexts } from '../src/core/source-context.js'
import { Todos } from '../src/core/todos.js'
import type { PublicMaterial } from '../src/core/execution-material-application.js'
import { UserTokenStore } from '../src/feishu/oauth.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import { createInternalApi } from '../src/internal/api.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { buildServer } from '../src/mcp/server.js'
import { managedHostRuntime } from './helpers/managed-host.js'
import { asFeishuClient, FakeFeishu, historyMsg } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'
import * as web from '../src/core/web-fetch.js'
import type { IngressClassificationInput, IngressDecision } from '../src/acp/ingress-classifier.js'

const closes: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks() })
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
class Feishu extends FakeFeishu {
  beforeDownload?: (dest: string) => Promise<void>
  override async downloadMessageResource(messageId: string, fileKey: string, type: 'file' | 'image', dest: string) {
    await this.beforeDownload?.(dest)
    return super.downloadMessageResource(messageId, fileKey, type, dest)
  }
}

/** Real host, ACP SDK, mode binding, signed HTTP/MCP, stores and Delivery; only model/platform are synthetic. */
async function fixture(mode: 'managed' | 'workspace' = 'managed', classifyFollowup: boolean | ((input: IngressClassificationInput) => Promise<IngressDecision>) = false) {
  const home = mkdtempSync(join(tmpdir(), 'friday-managed-host-files-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'app-synthetic', FEISHU_APP_SECRET: 'synthetic', FRIDAY_HOME: home,
    FRIDAY_REFLECT: 'off', FRIDAY_PROMPT_TIMEOUT_MS: '5000', FRIDAY_DEFAULT_EXECUTION: mode })
  mkdirSync(cfg.workspace.root, { recursive: true })
  const registry = new Registry(':memory:'), memory = new ChannelMemory(registry.db), attempts = new RunAttempts(registry.db)
  const sources = new SourceContexts(registry), sp = spaceDeps(registry.db)
  const group = sp.spaces.ensure({ kind: 'group', chatId: 'oc_group', openId: 'ou_owner' })
  const fake = new Feishu(); fake.members.set('oc_group', new Set(['ou_owner'])); fake.chats = [{ chatId: 'oc_group', name: '测试群' }]
  const feishu = asFeishuClient(fake), cache = new MessageCache(registry.db), log = createLogger('managed-host-files', 'error')
  const userTokens = new UserTokenStore(registry.db, { exchangeCode: async () => { throw new Error('No OAuth in group fixture') },
    refresh: async () => { throw new Error('No OAuth in group fixture') } })
  const execution = managedHostRuntime(registry, home, log), { runtime, managed } = execution
  const peer = mode === 'managed' ? execution.peer : execution.workspacePeer
  const messages = new MessageService(feishu, cache, log), todos = new Todos(registry.db), tokens = new TokenIssuer('synthetic-only')
  const host = new Orchestrator({ cfg, registry, ...sp, memory, todos, feishu, userTokens, runtime, managed, messages, tokens,
    ...(classifyFollowup ? { ingressClassifier: { classify: typeof classifyFollowup === 'function' ? classifyFollowup : async (input: IngressClassificationInput) => input.message.replyToRef
      ? { kind: 'amend' as const, targetRef: input.message.replyToRef } : { kind: 'new_work' as const } } } : {}),
    apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', botOpenId: 'ou_bot', log })
  closes.push(async () => { await runtime.stop(); registry.close(); rmSync(home, { recursive: true, force: true }) })
  const api = createInternalApi({ registry, ...sp, memory, messageCache: cache, messages, todos, feishu, userTokens,
    appId: cfg.feishu.appId, tokens, log, maxHistoryPerCall: 20,
    materials: host.materials,
    isManagedRun: runId => host.isManagedRun(runId),
    registerExecutionFile: (runId, file, guard) => host.registerExecutionFile(runId, file, guard),
    resolveActorForSession: key => host.resolveActorForSession(key), allowedRoutesForSession: key => host.allowedRoutesForSession(key),
    canPersistDerivedState: key => host.canPersistDerivedState(key),
    onCrossSpaceRead: (key, read) => host.noteCrossSpaceRead(key, read),
    onMessageRead: (key, runId, receipt) => host.noteMessageRead(key, runId, receipt),
    authorizePublicWebRequest: (cap, url) => host.authorizePublicWebRequest(cap, url),
    onExternalSourceRead: (key, source) => host.noteExternalSource(key, source),
    deliverToolResult: (key, runId, input) => host.deliverToolResult(key, runId, input),
  })
  await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
  closes.push(async () => { api.server.closeAllConnections(); await new Promise<void>(resolve => api.server.close(() => resolve())) })
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
  const current = () => {
    const prompt = peer.state.allPrompts.at(-1)!, session = registry.getSessionByAcpId(prompt.sessionId)!
    const servers = prompt.mcpServers as { env: { name: string; value: string }[] }[]
    return { session, token: servers[0]!.env.find(entry => entry.name === 'FRIDAY_CAP_TOKEN')!.value }
  }
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${base}/v1/${path}`, { method: 'POST', headers: { authorization: `Bearer ${current().token}`,
      'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  }
  const call = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const server = buildServer({ apiUrl: base, token: current().token }), client = new Client({ name: 'host-files-test', version: '0' })
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a)
    try {
      const result = await client.callTool({ name, arguments: args })
      const text = (result.content as { type: string; text?: string }[]).map(item => item.text ?? '').join('\n')
      if (result.isError) throw new Error(`${name}: ${text}`)
      return JSON.parse(text) as T
    } finally { await client.close(); await server.close() }
  }
  let serial = 0
  const message = (text: string, extra: Partial<InboundMessage> = {}): InboundMessage => {
    const messageId = `host-files-${++serial}`
    return { eventId: messageId, messageId, chatId: 'oc_group', chatType: 'group', senderOpenId: 'ou_owner', senderType: 'user',
      tenantId: 'tenant-synthetic', msgType: 'text', text, mentions: [{ key: '@bot', openId: 'ou_bot', name: 'Friday' }],
      createTimeMs: Date.now(), threadId: 'omt_group', ...extra }
  }
  const fileCount = () => registry.db.prepare('SELECT COUNT(*) AS n FROM execution_material_files').get()!.n
  return { home, cfg, registry, memory, attempts, sources, group, fake, peer, host, managed, execution, current, post, call, message, fileCount }
}
const pin = (file: PublicMaterial) => ({ fileId: file.fileId, expectedDigest: file.digest })

describe('managed files through actual Orchestrator and protocol ports', () => {
  it('registers post images with original post provenance before ACP and exposes no native image paths', async () => {
    const t = await fixture(), inbound = t.message('比较这两张图', { msgType: 'post', imageKey: 'post-a', imageKeys: ['post-a', 'post-b'] })
    let files: PublicMaterial[] = []
    t.peer.state.script = [{ kind: 'hook', run: async () => {
      files = (await t.call<{ files: PublicMaterial[] }>('friday_list_files', {})).files
      expect(files).toHaveLength(2)
      for (const file of files) expect(await t.call('friday_read_file', pin(file))).toMatchObject({ text: expect.stringContaining('post-') })
    } }, { kind: 'text', text: '图已接收，本轮合成夹具不是可解码图像。' }]
    await t.host.handleMessage(inbound)
    expect(t.registry.taskForMessage(inbound.messageId)?.status).toBe('done')
    const prompt = t.peer.state.allPrompts[0]!.text
    for (const file of files) expect(prompt).toContain(file.fileId)
    expect(prompt).not.toMatch(/read_image|friday-inbound-/)
    expect(t.fake.downloads.map(item => [item.messageId, item.fileKey])).toEqual([[inbound.messageId, 'post-a'], [inbound.messageId, 'post-b']])
    const source = t.sources.get(t.current().session.sessionKey)
    expect(source?.inboundMaterials).toMatchObject([{ messageId: inbound.messageId, actorOpenId: inbound.senderOpenId }])
    expect(readdirSync(join(t.current().session.cwd, 'downloads'))).toEqual([])
  })

  it('reads a forwarded attachment through a managed handle without reading the original chat', async () => {
    const t = await fixture(), inbound = t.message('[合并转发消息]', { msgType: 'merge_forward' })
    t.fake.messages.set(inbound.messageId, historyMsg({ ...inbound }))
    t.fake.forwarded.set(inbound.messageId, [historyMsg({ messageId: 'source-child', msgType: 'file', text: '[文件 调查.txt]',
      chatId: 'oc_original_no_access', fileKey: 'forwarded-evidence', fileName: '调查.txt', senderOpenId: 'ou_reporter' })])
    t.peer.state.script = [{ kind: 'hook', run: async () => {
      const files = (await t.call<{ files: PublicMaterial[] }>('friday_list_files', {})).files
      expect(files).toHaveLength(1)
      expect(await t.call('friday_read_file', pin(files[0]!))).toMatchObject({ name: '调查.txt', text: 'fake content of forwarded-evidence' })
    } }, { kind: 'text', text: '已读附件。' }]
    await t.host.handleMessage(inbound)
    expect(t.registry.taskForMessage(inbound.messageId)?.status).toBe('done')
    expect(t.fake.downloads).toMatchObject([{ messageId: 'source-child', fileKey: 'forwarded-evidence' }])
    expect(t.sources.get(t.current().session.sessionKey)?.chats).toEqual([])
    expect(t.peer.state.allPrompts[0]!.text).toContain('ou_reporter')
  })

  it('reacquires a selected earlier file for a new task using its original receipt and actual platform bytes', async () => {
    const t = await fixture('managed', async input => ({ kind: 'new_work', contextRefs: input.materials?.slice(0, 1).map(item => item.ref) }))
    const source = t.message('先收下这个原文附件', { msgType: 'file', fileKey: 'source-file', fileName: '原文.txt' })
    let original: PublicMaterial | undefined, selected: PublicMaterial | undefined
    t.peer.state.script = [{ kind: 'hook', run: async () => {
      original = (await t.call<{ files: PublicMaterial[] }>('friday_list_files', {})).files[0]
    } }, { kind: 'text', text: '已收到。' }]
    await t.host.handleMessage(source)
    t.peer.state.script = [{ kind: 'hook', run: async () => {
      selected = (await t.call<{ files: PublicMaterial[] }>('friday_list_files', {})).files[0]
      expect(await t.call('friday_read_file', pin(selected!))).toMatchObject({ text: 'fake content of source-file' })
    } }, { kind: 'text', text: '已基于所选附件整理。' }]
    const next = t.message('把刚才那份材料整理成跟进事项')
    await t.host.handleMessage(next)
    expect(t.registry.taskForMessage(next.messageId)?.status).toBe('done')
    expect(t.registry.taskForMessage(next.messageId)?.sessionKey).not.toBe(t.registry.taskForMessage(source.messageId)?.sessionKey)
    expect(selected?.fileId).not.toBe(original?.fileId)
    expect(selected?.digest).toBe(original?.digest)
    expect(t.fake.downloads.map(item => item.messageId)).toEqual([source.messageId, source.messageId])
    expect(t.sources.get(t.current().session.sessionKey)?.inboundMaterials).toMatchObject([{ messageId: source.messageId }])
  })

  it('keeps a link-bound page usable in current Run files, then rebuilds instead of reusing that link grant in a later Run', async () => {
    const t = await fixture('managed', true), url = 'https://example.com/opaque?capability=synthetic'
    const actual = web.fetchPublicUrl
    vi.spyOn(web, 'fetchPublicUrl').mockImplementation((raw, options) => actual(raw, { ...options,
      resolve: async () => [{ address: '93.184.216.34' }],
      request: async () => ({ status: 200, headers: { 'content-type': 'text/plain' }, body: 'LINK_BOUND_PAGE' }),
    }))
    const inbound = t.message(`请读取这个链接并存成文件发回来：${url}`), observed: Record<string, unknown> = {}
    t.peer.state.script = [{ kind: 'hook', run: async () => {
      observed.page = await t.post('web/fetch', { url })
      const file = await t.call<PublicMaterial>('friday_write_file', { name: 'page.txt', text: 'LINK_BOUND_PAGE' }); observed.file = file
      observed.read = await t.call('friday_read_file', pin(file))
      observed.sent = await t.call('friday_send_material', pin(file)).catch(error => ({ error: String(error) }))
    } }]
    await t.host.handleMessage(inbound)
    expect(observed.page).toMatchObject({ status: 200, body: { text: 'LINK_BOUND_PAGE' } })
    expect(observed.read).toMatchObject({ text: 'LINK_BOUND_PAGE' })
    expect(observed.sent).toMatchObject({ status: 'sent' })
    expect(t.fake.of('replyFile')).toHaveLength(1)
    const first = t.current().session, oldManifest = t.sources.get(first.sessionKey)!
    expect(oldManifest.external).toMatchObject([{ kind: 'web', access: 'link', linkGrant: { requestUrl: url } }])
    t.peer.state.script = [{ kind: 'hook', run: async () => {
      observed.nextList = await t.call('friday_list_files', {})
      observed.nextFetch = await t.post('web/fetch', { url })
    } }, { kind: 'text', text: '请重新提供需要读取的完整链接。' }]
    const next = t.message('继续处理', { parentId: inbound.messageId })
    await t.host.handleMessage(next)
    expect(t.registry.taskForMessage(next.messageId)).toMatchObject({ sessionKey: first.sessionKey, status: 'done' })
    expect(t.current().session.acpSessionId).not.toBe(first.acpSessionId)
    expect(t.peer.state.resumed).not.toContain(first.acpSessionId)
    expect(observed.nextList).toMatchObject({ files: [] })
    expect(observed.nextFetch).toMatchObject({ status: 403 })
    expect(t.sources.get(first.sessionKey)?.external).toEqual([])
    expect(t.fake.of('replyFile')).toHaveLength(1)
  })

  it('registers the natural inbound attachment before ACP, then reads/searches/writes/edits/delivers actual bytes once through MCP', async () => {
    const t = await fixture(), inbound = t.message('请看附件，整理成一份简短说明发回来。', { msgType: 'file', fileKey: 'input-source', fileName: '记录.txt' })
    const observed: Record<string, unknown> = {}
    t.peer.state.script = [{ kind: 'hook', run: async () => {
      const list = await t.call<{ files: PublicMaterial[] }>('friday_list_files', {}); observed.list = list
      observed.read = await t.call('friday_read_file', pin(list.files[0]!))
      observed.search = await t.call('friday_search_files', { files: [pin(list.files[0]!)], query: 'input-source' })
      const written = await t.call<PublicMaterial>('friday_write_file', { name: '说明.txt', text: '来源：附件。\n结论：待确认。' }); observed.written = written
      observed.retry = await t.call('friday_write_file', { name: '说明.txt', text: '来源：附件。\n结论：待确认。' })
      const edited = await t.call<PublicMaterial>('friday_edit_file', { ...pin(written), edits: [{ oldText: '待确认', newText: '尚不能定性' }] }); observed.edited = edited
      observed.editedRead = await t.call('friday_read_file', pin(edited))
      observed.sent = await t.call('friday_send_material', pin(edited))
      observed.sentAgain = await t.call('friday_send_material', pin(edited))
    } }]
    await t.host.handleMessage(inbound)
    expect(t.registry.taskForMessage(inbound.messageId)).toMatchObject({ status: 'done', stopReason: 'end_turn' })
    expect(observed.read).toMatchObject({ name: '记录.txt', text: 'fake content of input-source' })
    expect(observed.search).toMatchObject({ total: 1 })
    expect(observed.retry).toEqual(observed.written)
    expect(observed.editedRead).toMatchObject({ text: '来源：附件。\n结论：尚不能定性。', version: 2 })
    expect(observed.sent).toMatchObject({ status: 'sent', messageId: expect.any(String) })
    expect(observed.sentAgain).toMatchObject({ status: 'sent', replayed: true })
    expect(t.fake.uploads).toMatchObject([{ name: '说明.txt', path: Buffer.from('来源：附件。\n结论：尚不能定性。') }])
    expect(t.fake.of('replyFile')).toHaveLength(1)
    expect(t.registry.db.prepare('SELECT status,remote_id FROM deliveries WHERE delivery_key LIKE ?').all('%:tool:%'))
      .toMatchObject([{ status: 'sent', remote_id: expect.any(String) }])
    expect(t.fileCount()).toBe(2)
    const session = t.current().session, prompt = t.peer.state.allPrompts[0]!.text
    expect(prompt).toContain((observed.list as { files: PublicMaterial[] }).files[0]!.fileId)
    expect(prompt).toContain('尚未解析或查看内容')
    expect(prompt).not.toContain(t.fake.downloads[0]!.dest)
    expect(readdirSync(join(session.cwd, 'downloads'))).toEqual([])
    expect(t.peer.state.sessions.get(session.acpSessionId!)!.cwd).not.toBe(session.cwd)
    expect(existsSync(t.fake.downloads[0]!.dest)).toBe(false)
    expect(t.execution.workspacePeer.state.allPrompts).toEqual([])
  })

  it('stopping while the inbound download awaits admits zero materials and never prompts the old worker', async () => {
    const t = await fixture(), entered = deferred(), release = deferred()
    const inbound = t.message('读一下附件。', { msgType: 'file', fileKey: 'held', fileName: 'held.txt' })
    t.fake.beforeDownload = async () => { entered.resolve(); await release.promise }
    const pending = t.host.handleMessage(inbound); await entered.promise
    await t.host.handleMessage(t.message('/stop', { parentId: inbound.messageId }))
    release.resolve(); await pending
    expect(t.fileCount()).toBe(0)
    expect(t.peer.state.allPrompts).toEqual([])
    expect(t.registry.taskForMessage(inbound.messageId)).toMatchObject({ status: 'cancelled', stopReason: 'user_requested' })
    expect(t.fake.of('replyFile')).toEqual([])
    expect(t.fake.reactionsOn(inbound.messageId)).not.toContain('OnIt')
    expect(existsSync(t.fake.downloads[0]!.dest)).toBe(false)
  })

  it('message/file imports an authorized historical attachment as a handle and managed file/send cannot use a host path', async () => {
    const t = await fixture(), source = historyMsg({ messageId: 'historical-file', chatId: 'oc_group', tenantId: 'tenant-synthetic',
      msgType: 'file', fileKey: 'historical-key', fileName: '历史.txt', text: '历史附件' })
    t.fake.messages.set(source.messageId, source)
    const observed: Record<string, unknown> = {}
    t.peer.state.script = [{ kind: 'hook', run: async () => {
      const response = await t.post('message/file', { message_id: source.messageId }); observed.imported = response
      if (response.status !== 200) return
      observed.retry = await t.post('message/file', { message_id: source.messageId })
      observed.read = await t.call('friday_read_file', pin(response.body as unknown as PublicMaterial))
      observed.pathDenied = await t.post('file/send', { path: 'downloads/history.txt' })
    } }, { kind: 'text', text: '已读取附件文字。' }]
    await t.host.handleMessage(t.message('把之前发过的附件找出来看一下。'))
    expect(observed.imported).toMatchObject({ status: 200, body: { name: '历史.txt', fileId: expect.any(String), digest: expect.stringMatching(/^[0-9a-f]{64}$/), size: 30 } })
    expect(observed.retry).toEqual(observed.imported)
    expect(observed.read).toMatchObject({ text: 'fake content of historical-key' })
    expect(observed.pathDenied).toMatchObject({ status: 400 })
    expect(JSON.stringify(observed.imported)).not.toContain(t.home)
    expect((observed.imported as { body: object }).body).not.toHaveProperty('path')
    expect(t.fileCount()).toBe(1)
    // This app-identity group read has no user lease; preserve its real source
    // snapshot without inventing a verified personal-memory message reference.
    const snapshot = t.sources.get(t.current().session.sessionKey)!
    expect(snapshot).toMatchObject({ chatId: 'oc_group', spaceId: t.group.id, messageSources: [], personalMemoryComplete: false })
    const metadata = t.registry.db.prepare('SELECT provenance_json FROM execution_material_versions').get()!
    expect(JSON.parse(String(metadata.provenance_json)).sources).toEqual(snapshot)
    expect(readdirSync(join(t.current().session.cwd, 'downloads'))).toEqual([])
    expect(t.fake.downloads.every(item => !existsSync(item.dest))).toBe(true)
  })

  it('workspace mode keeps native attachment paths and the existing host-mediated file sending behavior', async () => {
    const t = await fixture('workspace'), inbound = t.message('请检查附件并把它发回来。', { msgType: 'file', fileKey: 'native-input', fileName: 'native.txt' })
    let sent: Awaited<ReturnType<typeof t.post>> | undefined
    t.peer.state.script = [{ kind: 'hook', run: async () => {
      const prompt = t.peer.state.allPrompts.at(-1)!.text, rel = prompt.match(/downloads\/[a-f0-9]+\/files\/native\.txt/)?.[0]
      if (!rel) throw new Error('Native attachment path not present')
      sent = await t.post('file/send', { path: rel })
    } }]
    await t.host.handleMessage(inbound)
    expect(sent).toMatchObject({ status: 200, body: { ok: true, file_name: 'native.txt' } })
    expect(t.registry.taskForMessage(inbound.messageId)).toMatchObject({ status: 'done' })
    expect(t.fileCount()).toBe(0)
    const cwd = t.current().session.cwd
    expect(readdirSync(join(cwd, 'downloads'))).toHaveLength(1)
    expect(t.peer.state.sessions.get(t.current().session.acpSessionId!)!.cwd).toBe(cwd)
    expect(t.fake.of('replyFile')).toHaveLength(1)
    expect(t.fake.uploads[0]!.path).toEqual(Buffer.from('fake content of native-input'))
    expect(t.execution.peer.state.allPrompts).toEqual([])
  })
})
