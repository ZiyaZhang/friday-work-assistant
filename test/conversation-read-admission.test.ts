import { AxiosError } from 'axios'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { SourceContexts, type SourceContext } from '../src/core/source-context.js'
import { DeliveryContextResolver, type DeliveryExecution } from '../src/core/delivery-context.js'
import { ExecutionSourceAccess, type ExecutionSourceActor } from '../src/core/execution-source-access.js'
import { PersonalMemoryAccess } from '../src/core/personal-memory-access.js'
import { UserMessageReadAccess } from '../src/core/user-message-read-lease.js'
import { ChatReadScope } from '../src/core/chat-read-scope.js'
import { captureChatDirectory, captureMessageFile, captureMessageRead, MessageSourceBindings,
  type MessageReadContext, type MessageReadReceipt } from '../src/core/message-read-context.js'
import { UserTokenStore, type TokenExchange } from '../src/feishu/oauth.js'
import { FeishuApiError, type AsUser, type CalendarEvent, type HistoryMessage } from '../src/feishu/client.js'
import { historyMsg } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const registries: Registry[] = []
afterEach(() => { for (const registry of registries.splice(0)) registry.close() })
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}

const coreScope = 'im:chat:readonly im:message:readonly im:message.p2p_msg:get_as_user search:message'

async function fixture(fullMemoryScope = false) {
  const registry = new Registry(':memory:'); registries.push(registry)
  const { spaces, policy, circles } = spaceDeps(registry.db)
  const dm = spaces.ensure({ kind: 'p2p', chatId: 'oc_dm', openId: 'alice' })
  const groups = ['oc_group_a', 'oc_group_b'].map(chatId => spaces.ensure({ kind: 'group', chatId, openId: 'alice' }))
  const groupDirectory = groups.map(space => ({ chatId: space.chatId!, name: 'synthetic group' }))
  const grant: TokenExchange = { accessToken: 'SYNTHETIC_CORE_TOKEN', expiresIn: 7200,
    scope: coreScope + (fullMemoryScope ? ' im:message.group_msg:get_as_user' : '') }
  const provider = { exchangeCode: vi.fn(async () => grant), refresh: vi.fn(async () => { throw new Error('unexpected refresh') }) }
  const tokens = new UserTokenStore(registry.db, provider)
  const connect = () => tokens.complete({ openId: 'alice', code: 'synthetic', redirectUri: 'https://callback.invalid' })
  await connect()
  const originals = [
    historyMsg({ chatId: 'oc_group_a', messageId: 'om_group_a', text: 'synthetic group A', createTimeMs: 100 }),
    historyMsg({ chatId: 'oc_group_b', messageId: 'om_group_b', text: 'synthetic group B', createTimeMs: 200 }),
    historyMsg({ chatId: 'oc_outside_directory', messageId: 'om_outside_first', text: 'synthetic outside first', createTimeMs: 300 }),
    historyMsg({ chatId: 'oc_outside_directory', messageId: 'om_outside_second', text: 'synthetic outside second', createTimeMs: 400 }),
  ]
  const returned = new Map(originals.map(message => [message.messageId, structuredClone(message)]))
  const feishu = {
    whoAmI: vi.fn(async (_token: string) => ({ openId: 'alice', tenantKey: 'tenant-a' })),
    listChats: vi.fn(async (_as: AsUser = {}, _options?: unknown) => groupDirectory),
    listChatsResult: vi.fn(async (_as: AsUser = {}, _options?: unknown) => ({ items: groupDirectory, complete: true })),
    chatMemberOpenIds: vi.fn(async (_chatId: string, _options?: unknown) => new Set(['alice'])),
    getMessage: vi.fn(async (id: string, _as: AsUser = {}): Promise<HistoryMessage | undefined> => structuredClone(returned.get(id))),
    readDocument: vi.fn(async () => ({ objType: 'docx', title: 'synthetic', content: 'synthetic' })),
    listMyEvents: vi.fn(async () => [] as CalendarEvent[]),
  }
  let live = true
  const assertCurrent = () => { if (!live) throw new Error('SYNTHETIC_RUN_STOPPED') }
  const readScope = new ChatReadScope(registry.db)
  const userReads = new UserMessageReadAccess({ appId: 'app-a', userTokens: tokens, feishu })
  const acquired = await userReads.open('alice', assertCurrent)
  if (acquired.status !== 'available') throw new Error('expected ordinary user identity')
  const lease = acquired.lease
  const sourceBindings = new MessageSourceBindings(spaces, originals.map(message => message.chatId!))
  const read: MessageReadContext = { appId: 'app-a', as: lease.as, user: lease, bindings: sourceBindings,
    assertCurrent: () => { lease.assertCurrent(); sourceBindings.assertCurrent() } }
  const binding = { sessionKey: 'synthetic-session', acpSessionId: 'original-acp', spaceId: dm.id, chatId: dm.chatId! }
  const scopes = ['org', `space:${dm.id}`]
  const sources = new SourceContexts(registry); sources.initialize(binding, scopes)
  const persist = (receipt: MessageReadReceipt) => {
    receipt.assertCurrent()
    sources.recordMessages(binding, receipt.sources, receipt.complete)
    if (receipt.conversationReads) sources.recordConversationReads(binding, receipt.conversationReads)
  }
  const capture = (messages: readonly HistoryMessage[] = originals) => {
    const receipt = captureMessageRead(read, messages, 'partial', chatId => sourceBindings.spaceId(chatId), 500)
    persist(receipt)
    return receipt
  }
  const manifest = () => sources.get(binding.sessionKey)!
  const editManifest = (edit: (source: SourceContext) => void) => {
    const source = manifest(); edit(source)
    registry.setKv(`delivery-sources:${binding.sessionKey}`, JSON.stringify(source))
  }
  const execution: DeliveryExecution = { ...binding, runId: 'original-run', actorOpenId: 'alice', chatType: 'p2p',
    isLive: () => live, isCurrent: () => live, readScopes: () => scopes }
  const resolver = new DeliveryContextResolver({ appId: 'app-a', sources, spaces, feishu, userTokens: tokens, readScope,
    disconnectPersonalConnection: vi.fn(() => false), now: () => Date.now() })
  const deliver = () => resolver.resolveResult(execution, { audience: { kind: 'dm', openId: 'alice', spaceId: dm.id } })
  // Replaying a prior ACP's material is a new Run, not permission to trust its old lease.
  const actor: ExecutionSourceActor = { runId: 'next-run', openId: 'alice', spaceId: dm.id, chatId: dm.chatId!,
    chatType: 'p2p', acpSessionId: binding.acpSessionId, assertCurrent, readScopes: () => scopes }
  const personalMemory = new PersonalMemoryAccess({ appId: 'app-a', spaces, policy, userTokens: tokens, feishu })
  const access = new ExecutionSourceAccess({ appId: 'app-a', spaces, policy, circles, userReads, personalMemory,
    feishu, readScope, repositoryAllowed: () => false })
  const replay = () => access.check(actor, manifest())
  return { registry, spaces, dm, groups, grant, provider, tokens, connect, feishu, originals, returned, lease, read,
    sources, binding, scopes, persist, capture, manifest, editManifest, execution, resolver, deliver, actor, access,
    replay, readScope, stop: () => { live = false } }
}

describe('ordinary conversation reads admitted to the same user', () => {
  it('keeps every ordinary message with a core grant and revalidates outside-directory messages for delivery and a later Run', async () => {
    const t = await fixture(), receipt = t.capture()
    expect(t.lease.capture).toEqual({ status: 'denied', reason: 'scope_missing' })
    expect(receipt.sources).toEqual([])
    expect(receipt.complete).toBe(false)
    expect(t.manifest().personalMemoryComplete).toBe(false)
    expect(t.manifest().conversationReads).toMatchObject({ complete: true,
      items: t.originals.map(message => ({ kind: 'message', messageId: message.messageId, chatId: message.chatId })) })
    const delivery = await t.deliver()
    expect(delivery.status).toBe('ready')
    if (delivery.status !== 'ready') throw new Error('expected admitted delivery')
    expect(delivery.context.personalRead?.chatIds).toEqual(expect.arrayContaining(['oc_group_a', 'oc_group_b', 'oc_outside_directory']))
    expect(t.feishu.getMessage.mock.calls).toEqual([
      ['om_outside_first', { userToken: 'SYNTHETIC_CORE_TOKEN' }],
      ['om_outside_second', { userToken: 'SYNTHETIC_CORE_TOKEN' }],
    ])
    t.feishu.getMessage.mockClear()
    const replay = await t.replay()
    expect(replay.status).toBe('allowed'); replay.assertCurrent()
    expect(t.feishu.getMessage.mock.calls.map(call => call[0])).toEqual(['om_outside_first', 'om_outside_second'])
    expect(t.provider.refresh).not.toHaveBeenCalled()
    expect(t.manifest().messageSources).toEqual([])
  })

  it('does not let a fresh receipt certify unknown older inputs from the same chat', async () => {
    for (const prior of ['absent', 'incomplete'] as const) {
      const t = await fixture(); t.capture()
      t.editManifest(source => {
        if (prior === 'absent') delete source.conversationReads
        else source.conversationReads!.complete = false
      })
      t.capture([t.originals[2]!])
      expect(t.manifest().conversationReads?.complete).toBe(false)
      expect(await t.deliver()).toMatchObject({ status: 'blocked', failure: { reason: 'source_unverifiable' } })
      expect(await t.replay()).toMatchObject({ status: 'unavailable', reason: 'source_incomplete' })
      expect(t.feishu.getMessage).not.toHaveBeenCalled()
    }
  })

  it('cannot repair missing older receipts merely because the later same-chat read is in a positive group directory', async () => {
    for (const prior of ['absent', 'incomplete'] as const) {
      const t = await fixture(); t.capture([t.originals[0]!])
      t.editManifest(source => {
        if (prior === 'absent') delete source.conversationReads
        else source.conversationReads!.complete = false
      })
      t.capture([t.originals[0]!])
      expect(t.manifest().conversationReads?.complete).toBe(false)
      expect(await t.deliver()).toMatchObject({ status: 'blocked', failure: { reason: 'source_unverifiable' } })
      expect(await t.replay()).toMatchObject({ status: 'unavailable', reason: 'source_incomplete' })
    }
  })

  it('uses precise message revalidation when group enumeration lacks app scope, without borrowing it for a directory item', async () => {
    const t = await fixture(); t.capture()
    t.feishu.listChatsResult.mockRejectedValue(new FeishuApiError('chat.list', 99991672, 'synthetic missing application scope'))
    expect((await t.deliver()).status).toBe('ready')
    expect(t.feishu.getMessage.mock.calls.map(call => call[0])).toEqual(t.originals.map(message => message.messageId))
    t.feishu.getMessage.mockClear()
    expect((await t.replay()).status).toBe('allowed')
    expect(t.feishu.getMessage.mock.calls.map(call => call[0])).toEqual(t.originals.map(message => message.messageId))
    t.persist(captureChatDirectory(t.read,
      [{ chat_id: 'oc_group_a', name: 'synthetic directory entry', cached_messages: 1 }], 600))
    expect(await t.deliver()).toMatchObject({ status: 'blocked', failure: { reason: 'app_scope_missing' } })
    expect(await t.replay()).toMatchObject({ status: 'unavailable', reason: 'app_scope_missing' })
  })

  it('reuses ordinary inputs after a watch-to-core grant change without promoting or depending on persistent memory', async () => {
    const t = await fixture(true)
    const captured = t.capture([t.originals[0]!])
    expect(captured.sources).toHaveLength(1)
    expect(captured.conversationReads?.items).toHaveLength(1)
    expect(captured.complete).toBe(true)
    const originalMemoryProof = structuredClone(t.manifest().messageSources)
    t.grant.scope = coreScope
    await t.connect()
    expect((await t.deliver()).status).toBe('ready')
    expect((await t.replay()).status).toBe('allowed')
    // Scope reduction does not rewrite the historical observation as a fresh memory grant.
    expect(t.manifest().messageSources).toEqual(originalMemoryProof)
  })

  it('keeps the strict memory gate for an extra same-chat source with a different digest or reference', async () => {
    for (const difference of ['digest', 'reference'] as const) {
      const t = await fixture(true); t.capture([t.originals[0]!])
      t.editManifest(source => {
        const legacy = structuredClone(source.messageSources![0]!)
        if (difference === 'digest') legacy.contentDigest = 'f'.repeat(64)
        else legacy.ref = 'feishu-message:oc_group_a:om_different_legacy_source'
        source.messageSources!.push(legacy)
      })
      t.grant.scope = coreScope
      await t.connect()
      expect(await t.replay()).toMatchObject({ status: 'denied', reason: 'scope_missing' })
    }
  })

  it('checks every outside message and refuses wrong ID, chat, body, or a missing later message', async () => {
    for (const mutation of ['id', 'chat', 'body', 'missing'] as const) {
      const t = await fixture(); t.capture()
      const second = t.returned.get('om_outside_second')!
      if (mutation === 'id') second.messageId = 'om_different'
      if (mutation === 'chat') second.chatId = 'oc_different'
      if (mutation === 'body') second.text = 'synthetic changed content'
      if (mutation === 'missing') t.returned.delete('om_outside_second')
      expect(await t.deliver()).toMatchObject({ status: 'blocked', failure: { reason: 'source_unverifiable' } })
      expect(t.feishu.getMessage.mock.calls.map(call => call[0])).toEqual(['om_outside_first', 'om_outside_second'])
      expect(await t.replay()).toMatchObject({ status: 'unavailable', reason: 'source_unverifiable' })
    }
  })

  it('cannot use a successful message GET as permission for directory entries or downloaded bytes', async () => {
    for (const kind of ['directory', 'file'] as const) {
      const t = await fixture(); t.capture()
      if (kind === 'directory') t.persist(captureChatDirectory(t.read,
        [{ chat_id: 'oc_outside_directory', name: 'synthetic directory', cached_messages: 2 }], 600))
      else t.persist(captureMessageFile(t.read, { ...t.originals[2]!, fileKey: 'synthetic-file-key' }, 'a'.repeat(64), 600))
      expect(await t.deliver()).toMatchObject({ status: 'blocked', failure: { reason: 'source_unverifiable' } })
      expect(await t.replay()).toMatchObject({ status: 'unavailable', reason: 'source_unverifiable' })
      expect(t.feishu.getMessage).not.toHaveBeenCalled()
    }
  })

  it('does not let user receipts erase an application read of the same unregistered conversation', async () => {
    const t = await fixture(); t.capture()
    t.persist(captureMessageRead({ appId: 'app-a', as: {}, assertCurrent() {} }, [t.originals[2]!], 'partial', () => undefined, 600))
    expect(t.manifest().conversationReads?.items.filter(item => item.chatId === 'oc_outside_directory')).toHaveLength(3)
    expect(await t.deliver()).toMatchObject({ status: 'blocked', failure: { reason: 'source_unverifiable' } })
    expect(await t.replay()).toMatchObject({ status: 'unavailable', reason: 'source_binding_unknown' })
    expect(t.feishu.getMessage).not.toHaveBeenCalled()
  })

  it('rejects another reader or authority tenant even when the exact messages remain readable', async () => {
    for (const field of ['openId', 'tenantId'] as const) {
      const t = await fixture(); t.capture()
      t.editManifest(source => {
        const identity = source.conversationReads!.items[2]!.readIdentity
        if (identity.kind !== 'user') throw new Error('expected user receipt')
        identity[field] = 'different-identity'
      })
      expect(await t.deliver()).toMatchObject({ status: 'blocked', failure: { reason: 'identity_mismatch' } })
      expect(await t.replay()).toMatchObject({ status: 'denied', reason: 'source_identity_mismatch' })
      expect(t.feishu.getMessage).not.toHaveBeenCalled()
    }
  })

  it('does not publish personal material into a group or import it into a group Run', async () => {
    const t = await fixture(); t.capture()
    const group = t.groups[0]!
    expect(await t.resolver.resolveResult(t.execution, { audience: { kind: 'group', spaceId: group.id, chatId: group.chatId! } }))
      .toMatchObject({ status: 'blocked', failure: { reason: 'audience_mismatch' } })
    const groupSource = { ...t.manifest(), spaceId: group.id, chatId: group.chatId!, memoryScopes: [] }
    expect(await t.access.check({ ...t.actor, chatType: 'group', spaceId: group.id, chatId: group.chatId! }, groupSource))
      .toMatchObject({ status: 'denied', reason: 'source_identity_mismatch' })
    expect(t.feishu.getMessage).not.toHaveBeenCalled()
  })

  it('does not infer forbidden access from a partial directory; exact messages can still be verified', async () => {
    const t = await fixture(); t.capture()
    t.feishu.listChatsResult.mockResolvedValue({ items: [], complete: false })
    expect((await t.deliver()).status).toBe('ready')
    expect(t.feishu.getMessage.mock.calls.map(call => call[0])).toEqual(t.originals.map(message => message.messageId))
    expect((await t.replay()).status).toBe('allowed')
    t.editManifest(source => { delete source.conversationReads })
    expect(await t.deliver()).toMatchObject({ status: 'blocked', failure: { reason: 'resource_unverified' } })
    expect(await t.replay()).toMatchObject({ status: 'unavailable', reason: 'source_identity_unknown' })
  })

  it('keeps provider transport failure distinct from an actual denial and retains the existing grant', async () => {
    const t = await fixture(); t.capture()
    const before = t.tokens.get('alice')
    t.feishu.getMessage.mockRejectedValue(new AxiosError('synthetic offline', 'ECONNRESET'))
    expect(await t.deliver()).toMatchObject({ status: 'blocked', failure: { reason: 'service_unavailable', next: 'retry' } })
    expect(await t.replay()).toMatchObject({ status: 'unavailable', reason: 'service_unavailable' })
    expect(t.tokens.get('alice')).toEqual(before)
    expect(t.feishu.chatMemberOpenIds).not.toHaveBeenCalled()
    expect(t.provider.refresh).not.toHaveBeenCalled()
  })

  it('does not hide programmer exceptions as provider outages', async () => {
    const t = await fixture(); t.capture()
    t.feishu.getMessage.mockRejectedValue(new Error('synthetic programming fault'))
    await expect(t.deliver()).rejects.toThrow('synthetic programming fault')
    await expect(t.replay()).rejects.toThrow('synthetic programming fault')
  })

  it('refuses delivery when stop, exclusions, grant, or source binding changes during a message GET', async () => {
    for (const change of ['stop', 'exclusion', 'grant', 'binding'] as const) {
      const t = await fixture(); t.capture()
      const entered = deferred(), release = deferred()
      t.feishu.getMessage.mockImplementationOnce(async id => { entered.resolve(); await release.promise; return t.returned.get(id) })
      const pending = t.deliver(); await entered.promise
      if (change === 'stop') t.stop()
      if (change === 'exclusion') t.readScope.exclude('alice', 'oc_outside_directory')
      if (change === 'grant') { t.grant.accessToken = 'SYNTHETIC_REPLACEMENT'; await t.connect() }
      if (change === 'binding') t.spaces.archive(t.groups[0]!.id)
      release.resolve()
      expect((await pending).status).toBe('blocked')
      expect(t.feishu.getMessage).toHaveBeenCalledTimes(1)
    }
  })

  it('does not import prior material after a host, grant, exclusion, or binding changes mid-revalidation', async () => {
    for (const change of ['stop', 'exclusion', 'grant', 'binding'] as const) {
      const t = await fixture(); t.capture()
      const entered = deferred(), release = deferred()
      t.feishu.getMessage.mockImplementationOnce(async id => { entered.resolve(); await release.promise; return t.returned.get(id) })
      const pending = t.replay(); const rejected = expect(pending).rejects.toBeInstanceOf(Error)
      await entered.promise
      if (change === 'stop') t.stop()
      if (change === 'exclusion') t.readScope.exclude('alice', 'oc_outside_directory')
      if (change === 'grant') { t.grant.accessToken = 'SYNTHETIC_REPLACEMENT'; await t.connect() }
      if (change === 'binding') t.spaces.archive(t.groups[0]!.id)
      release.resolve(); await rejected
      expect(t.feishu.getMessage).toHaveBeenCalledTimes(1)
    }
  })
})
