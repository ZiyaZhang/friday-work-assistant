import { afterEach, describe, expect, it, vi } from 'vitest'
import * as web from '../src/core/web-fetch.js'
import { originalWebUrl } from '../src/core/web-egress.js'
import { SourceContexts } from '../src/core/source-context.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createInternalApi } from '../src/internal/api.js'
import { MessageService } from '../src/core/messages.js'
import { createLogger } from '../src/log.js'
import { acceptanceHost, closeAll } from './acceptance/host.js'

afterEach(closeAll)
const URL = 'https://public.example/release?version=1'
const realFetch = web.fetchPublicUrl

function network(hooks: { dns?: () => void; response?: () => void } = {}) {
  const dns = vi.fn(async () => { hooks.dns?.(); return [{ address: '93.184.216.34' }] })
  const request = vi.fn(async () => { hooks.response?.(); return { status: 200, headers: { 'content-type': 'text/plain' }, body: 'PUBLIC_PAGE' } })
  const fetch = vi.spyOn(web, 'fetchPublicUrl').mockImplementation((url, options) => realFetch(url, { ...options, resolve: dns, request }))
  return { dns, request, fetch }
}

describe('Public web HTTP request authorization with the real host and current Run', () => {
  it('permits only the exact current original URL even after private sources have been read', async () => {
    const t = await acceptanceHost(), n = network()
    const held = await t.hold({ text: `请读取 ${URL}` })
    t.host.noteExternalSource(held.task.sessionKey, { kind: 'document', ref: 'PRIVATE_DOC', access: 'user', personalOpenId: 'alice' })
    t.host.noteCrossSpaceRead(held.task.sessionKey, { chatId: 'other-group', what: 'PRIVATE_SOURCE' })
    for (const changed of [`${URL}&q=PRIVATE_DOC`, 'https://private-source.public.example/', 'https://public.example/PRIVATE_SOURCE']) {
      expect((await t.tool('web/fetch', { url: changed, public: true, user_approved: true })).status).toBe(403)
    }
    expect(n.fetch).not.toHaveBeenCalled()
    const result = await t.tool('web/fetch', { url: `${URL}#not-sent` })
    expect(result).toMatchObject({ status: 200, body: { text: 'PUBLIC_PAGE', final_url: URL } })
    expect(n.request).toHaveBeenCalledOnce()
    expect(n.request.mock.calls[0]).toEqual([URL, expect.objectContaining({ address: '93.184.216.34' })])
    expect(new SourceContexts(t.registry).get(held.task.sessionKey)?.external).toContainEqual({ kind: 'web', ref: URL, access: 'link', runId: held.runId,
      linkGrant: { version: 1, runId: held.runId, acpSessionId: held.session.acpSessionId, spaceId: t.group.id, chatId: t.group.chatId,
        chatType: 'group', actorOpenId: 'alice', messageId: held.msg.messageId, requestUrl: URL, fetchedUrl: URL } })
  })

  it('does not turn a vague follow-up agreement or prior message into a new outbound grant', async () => {
    const t = await acceptanceHost(), n = network()
    const first = await t.run([{ kind: 'text', text: '已看到链接。' }], { text: `读取 ${URL}` })
    await t.hold({ text: '好，同意继续', parentId: first.msg.messageId })
    expect((await t.tool('web/fetch', { url: URL })).status).toBe(403)
    expect(n.fetch).not.toHaveBeenCalled()
  })

  it('does not treat a derived task prompt or a forwarded container as the original human URL', async () => {
    const t = await acceptanceHost(), n = network()
    const held = await t.hold({ text: '分析这个问题' })
    t.registry.db.prepare('UPDATE tasks SET prompt = ? WHERE id = ?').run(`请抓取 ${URL}`, held.task.id)
    expect((await t.tool('web/fetch', { url: URL })).status).toBe(403)
    const dispatch = t.registry.dispatches.get(held.task.id)!
    t.registry.db.prepare('UPDATE task_dispatches SET inbound = ? WHERE task_id = ?')
      .run(JSON.stringify({ ...dispatch.inbound, text: URL, msgType: 'merge_forward' }), held.task.id)
    expect((await t.tool('web/fetch', { url: URL })).status).toBe(403)
    expect(n.fetch).not.toHaveBeenCalled()
  })

  it('fails closed for missing provenance or original inbound, even for a syntactically public URL', async () => {
    const t = await acceptanceHost(), n = network()
    const held = await t.hold({ text: URL })
    t.registry.db.prepare('DELETE FROM task_dispatches WHERE task_id = ?').run(held.task.id)
    expect((await t.tool('web/fetch', { url: URL })).status).toBe(403)
    expect(n.fetch).not.toHaveBeenCalled()
  })

  it('refuses a missing source ledger instead of treating an unknown context as public', async () => {
    const t = await acceptanceHost(), n = network()
    const held = await t.hold({ text: URL })
    t.registry.setKv(`delivery-sources:${held.task.sessionKey}`, 'null')
    expect((await t.tool('web/fetch', { url: URL })).status).toBe(403)
    expect(n.fetch).not.toHaveBeenCalled()
  })

  it.each(['authorization', 'receipt'])('fails closed when the host %s integration is missing', async missing => {
    const t = await acceptanceHost(), n = network()
    await t.hold({ text: URL })
    const tokens = new TokenIssuer('synthetic'), log = createLogger('egress-fixture', 'error')
    const api = createInternalApi({ registry: t.registry, feishu: t.feishu, memory: t.memory, messageCache: t.messageCache,
      messages: new MessageService(t.feishu, t.messageCache, log), todos: t.todos, spaces: t.spaces, policy: t.policy,
      tokens, log, maxHistoryPerCall: 10, resolveActorForSession: key => t.host.resolveActorForSession(key),
      ...(missing === 'authorization' ? {} : { authorizePublicWebRequest: t.host.authorizePublicWebRequest.bind(t.host) }),
      ...(missing === 'receipt' ? {} : { onExternalSourceRead: t.host.noteExternalSource.bind(t.host) }),
    })
    await expect(api.routes['POST /v1/web/fetch']!(tokens.verify(t.currentToken())!, { url: URL })).rejects.toMatchObject({ status: 403 })
    expect(n.fetch).not.toHaveBeenCalled()
  })

  it('preserves scope, identity, space and stale-token gates before DNS', async () => {
    const t = await acceptanceHost(), n = network()
    const held = await t.hold({ text: URL })
    const issuer = new TokenIssuer('synthetic'), cap = issuer.verify(t.currentToken())!
    for (const patch of [{ scopes: [] }, { requesterOpenId: 'bob' }, { runId: 'old-run' }, { spaceId: 'wrong-space' }, { chatId: 'other-chat' }]) {
      expect((await t.tool('web/fetch', { url: URL }, issuer.issue({ ...cap, ...patch }))).status).toBe(403)
    }
    expect(n.fetch).not.toHaveBeenCalled()
    held.release(); await held.result
    expect((await t.tool('web/fetch', { url: URL }, issuer.issue(cap))).status).toBe(403)
  })

  it('rechecks space authorization after DNS and does not send the HTTP request', async () => {
    const t = await acceptanceHost()
    const n = network({ dns: () => { t.spaces.archive(t.group.id) } })
    await t.hold({ text: URL })
    expect((await t.tool('web/fetch', { url: URL })).status).toBe(403)
    expect(n.dns).toHaveBeenCalledOnce(); expect(n.request).not.toHaveBeenCalled()
  })

  it('a human stop during DNS cancels dispatch and produces an authorization failure rather than a network retry', async () => {
    const t = await acceptanceHost(), held = await t.hold({ text: URL })
    const n = network({ dns: () => {
      const stopped = t.host.persistHumanRunStop({ actorOpenId: 'alice', spaceId: t.group.id, runId: held.runId, taskId: held.task.id,
        assertCurrent: () => t.spaces.get(t.group.id)! })
      stopped.afterCommit()
    } })
    expect((await t.tool('web/fetch', { url: URL })).status).toBe(403)
    expect(n.request).not.toHaveBeenCalled()
  })

  it('discards a response when the original inbound changes while the request is in flight', async () => {
    const t = await acceptanceHost()
    const held = await t.hold({ text: URL })
    network({ response: () => { t.registry.db.prepare('DELETE FROM task_dispatches WHERE task_id = ?').run(held.task.id) } })
    const result = await t.tool('web/fetch', { url: URL })
    expect(result.status).toBe(403); expect(JSON.stringify(result.body)).not.toContain('PUBLIC_PAGE')
    expect(new SourceContexts(t.registry).get(held.task.sessionKey)?.external.some(source => source.kind === 'web')).toBe(false)
  })

  it('rechecks after source registration and before the HTTP dispatcher returns JSON', async () => {
    const t = await acceptanceHost(); network()
    await t.hold({ text: URL })
    const original = t.host.noteExternalSource.bind(t.host)
    vi.spyOn(t.host, 'noteExternalSource').mockImplementation((key, source) => {
      original(key, source)
      queueMicrotask(() => t.spaces.archive(t.group.id))
    })
    const result = await t.tool('web/fetch', { url: URL })
    expect(result.status).toBe(403); expect(JSON.stringify(result.body)).not.toContain('PUBLIC_PAGE')
  })

  it('never treats a made-up web/search route as an approved egress path', async () => {
    const t = await acceptanceHost(), n = network()
    await t.hold({ text: URL })
    expect((await t.tool('web/search', { query: 'PRIVATE_SOURCE' })).status).toBe(404)
    expect(n.fetch).not.toHaveBeenCalled()
  })
})

describe('Original URL matching', () => {
  it.each(['https://example.com/wiki/Transformer_(deep_learning_architecture)',
    'https://example.com/?filter=(open)&report=123', 'https://example.com/?ids[]=1',
    'https://example.com/?fields={name,status}'])('preserves complete legal delimiters in %s and in Markdown wrappers', url => {
    expect(originalWebUrl(`读取 ${url}`, url)).toBe(url)
    expect(originalWebUrl(`读取 [页面](${url})`, url)).toBe(url)
    expect(originalWebUrl(`读取 <${url}>`, url)).toBe(url)
  })

  it('never grants the prefix before a closing delimiter or an appended query field', () => {
    const input = 'https://example.com/?filter=(open)&report=123'
    expect(originalWebUrl(input, 'https://example.com/?filter=(open')).toBeUndefined()
    expect(originalWebUrl(`[页面](${input})`, 'https://example.com/?filter=(open')).toBeUndefined()
    expect(originalWebUrl(input, 'https://example.com/?filter=(open)')).toBeUndefined()
    expect(originalWebUrl('https://example.com/?ids[]=1', 'https://example.com/?ids[')).toBeUndefined()
    expect(originalWebUrl("https://example.com/?filter='open'&report=123", 'https://example.com/?filter=')).toBeUndefined()
    expect(originalWebUrl('https://example.com/，report=123', 'https://example.com/')).toBeUndefined()
    expect(originalWebUrl('https://example.com/"report=123', 'https://example.com/')).toBeUndefined()
    expect(originalWebUrl('https://outer.example/?next=https://example.com/', 'https://example.com/')).toBeUndefined()
  })

  it('preserves query values, escaping and credential denial without substring grants', () => {
    expect(originalWebUrl(`打开 [页面](${URL})`, URL)).toBe(URL)
    expect(originalWebUrl(`${URL}&token=private`, URL)).toBeUndefined()
    expect(originalWebUrl('https://example.com/?q=a%2Fb', 'https://example.com/?q=a/b')).toBeUndefined()
    expect(originalWebUrl('https://alice:password@example.com/', 'https://alice:password@example.com/')).toBeUndefined()
    expect(originalWebUrl('同意', URL)).toBeUndefined()
  })
})
