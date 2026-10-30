import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpRuntime } from '../src/acp/runtime.js'
import { loadConfig } from '../src/config.js'
import { ChannelMemory } from '../src/core/memory.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { RoutineStore } from '../src/core/routines.js'
import { WikiDocs } from '../src/core/wiki.js'
import { UserTokenStore, USER_SCOPE_TIERS } from '../src/feishu/oauth.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { createFakeAgent } from './helpers/fake-agent.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
async function setup(deliverTo: 'chat' | 'dm' = 'chat') {
  const home = mkdtempSync(join(tmpdir(), 'friday-archive-safety-')), cfg = loadConfig({ FEISHU_APP_ID: 'synthetic', FEISHU_APP_SECRET: 'synthetic',
    FRIDAY_HOME: home, FRIDAY_REFLECT: 'off', FRIDAY_PROMPT_TIMEOUT_MS: '5000' })
  mkdirSync(cfg.workspace.root, { recursive: true })
  const databasePath = join(home, 'test.db'), registry = new Registry(databasePath), sp = spaceDeps(registry.db), memory = new ChannelMemory(registry.db)
  const group = sp.spaces.ensure({ kind: 'group', chatId: 'oc_group', openId: 'ou_alice' })
  sp.spaces.ensure({ kind: 'p2p', chatId: 'oc_dm', openId: 'ou_alice' })
  const fake = Object.assign(new FakeFeishu(), { prependToDocument: vi.fn(async () => {}) })
  const feishu = asFeishuClient(fake), userTokens = new UserTokenStore(registry.db, fake)
  fake.members.set('oc_group', new Set(['ou_alice']))
  fake.nextToken.scope = [...USER_SCOPE_TIERS.core, ...USER_SCOPE_TIERS.watch].join(' ')
  const token = await userTokens.complete({ code: 'synthetic', openId: 'ou_alice', redirectUri: 'https://callback.invalid' })
  fake.userChats.set(token.accessToken, [{ chatId: 'oc_group', name: 'Synthetic group' }])
  const routines = new RoutineStore(registry.db), wiki = new WikiDocs(registry.db), log = createLogger('archive-safety', 'error')
  const agent = createFakeAgent({ script: [{ kind: 'text', text: '合成摘要\n\nSYNTHETIC_ARCHIVE_BODY' }] })
  const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: agent.app }, log, onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) })
  const host = new Orchestrator({ cfg, registry, ...sp, memory, routines, wiki, userTokens, feishu, runtime, tokens: new TokenIssuer('synthetic'),
    apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', botOpenId: 'ou_bot', log })
  const routine = routines.add({ kind: 'schedule', ownerOpenId: 'ou_alice', spaceId: group.id, chatId: group.chatId!, chatType: 'group',
    name: 'Synthetic archive', prompt: '总结本群', schedule: { type: 'interval', everyMinutes: 10 }, deliveryPolicy: 'every_run', deliverTo, now: Date.now() })
  registry.setKv(`routine-archive:${routine.id}`, 'doc')
  let serial = 0
  const run = () => host.runRoutine(routines.get(routine.id)!, { manualMessageId: `manual-${++serial}` })
  const pending: Promise<unknown>[] = [], release: (() => void)[] = []
  cleanup.push(async () => { release.forEach(fn => fn()); await Promise.allSettled(pending); await runtime.stop(); registry.close(); rmSync(home, { recursive: true, force: true }) })
  return { host, registry, databasePath, group, routines, routine, wiki, fake, userTokens, agent, run, pending, release }
}

describe('routine archive publication uses the same audience and source lease as the digest', () => {
  it('keeps a group-origin DM archive owned by the recipient without granting group access', async () => {
    const t = await setup('dm')
    const create = vi.spyOn(t.fake, 'createDocument')
    expect(await t.run()).toBe('ok')
    expect(t.fake.createdDocs).toHaveLength(1)
    expect(create.mock.calls[0]?.[1]).toEqual({ userToken: t.userTokens.get('ou_alice')!.accessToken })
    expect(t.fake.grants).toEqual([])
    expect(t.fake.of('sendToChat')).toHaveLength(0)
    expect(t.fake.of('sendToUser')).toHaveLength(1)
    expect(JSON.parse(t.registry.getKv(`routine-archive-audience:${t.routine.id}:${t.group.id}`)!)).toMatchObject({ accessibilityConfirmed: true })
    expect(JSON.stringify(t.fake.sent)).toContain(t.fake.createdDocs[0]!.documentId)
  })
  it('rejects an unreadable source before creating or sharing a document', async () => {
    const t = await setup()
    t.agent.state.script = [{ kind: 'hook', run: () => {
      const session = t.registry.getSessionByAcpId(t.agent.state.allPrompts.at(-1)!.sessionId)!
      t.host.noteExternalSource(session.sessionKey, { kind: 'document', ref: 'private-source' })
    } }, { kind: 'text', text: 'MUST_NOT_PUBLISH' }]
    await expect(t.run()).rejects.toThrow()
    expect(t.fake.createdDocs).toHaveLength(0); expect(t.fake.grants).toHaveLength(0)
  })
  it.each(['token', 'create'] as const)('stops archive mutation after a pause during %s await', async phase => {
    const t = await setup(), entered = deferred(), finish = deferred(); t.release.push(finish.resolve)
    if (phase === 'token') vi.spyOn(t.userTokens, 'accessTokenFor').mockImplementation(async () => { entered.resolve(); await finish.promise; return 'SYNTHETIC_USER' })
    else {
      const original = t.fake.createDocument.bind(t.fake)
      vi.spyOn(t.fake, 'createDocument').mockImplementation(async (...args) => { const doc = await original(...args); entered.resolve(); await finish.promise; return doc })
    }
    const result = t.run(); t.pending.push(result); const rejected = expect(result).rejects.toThrow()
    await entered.promise
    t.routines.setEnabled(t.routine.id, false)
    finish.resolve(); await rejected
    expect(t.fake.createdDocs).toHaveLength(phase === 'token' ? 0 : 1)
    expect(t.fake.grants).toHaveLength(0)
    if (phase === 'create') expect(t.wiki.get(t.group.id, `journal:${t.routine.id}`)?.documentId).toBe(t.fake.createdDocs[0]!.documentId)
  })
  it('does not use a changed user grant after waiting for the archive token', async () => {
    const t = await setup('dm'), entered = deferred(), finish = deferred(); t.release.push(finish.resolve)
    vi.spyOn(t.userTokens, 'accessTokenFor').mockImplementation(async () => { entered.resolve(); await finish.promise; return 'OLD_USER_TOKEN' })
    const result = t.run(); t.pending.push(result); const rejected = expect(result).rejects.toThrow()
    await entered.promise; t.userTokens.disconnect('ou_alice'); finish.resolve(); await rejected
    expect(t.fake.createdDocs).toHaveLength(0); expect(t.fake.grants).toHaveLength(0)
  })
  it('does not append to an old journal without host evidence of its audience; the ordinary digest continues', async () => {
    const t = await setup()
    t.wiki.remember({ spaceId: t.group.id, kind: `journal:${t.routine.id}`, documentId: 'existing', url: 'https://docs.invalid/existing', title: 'Legacy journal' })
    const prepend = vi.spyOn(t.fake, 'prependToDocument')
    expect(await t.run()).toBe('ok')
    expect(t.fake.createdDocs).toHaveLength(0); expect(prepend).not.toHaveBeenCalled(); expect(t.fake.grants).toHaveLength(0)
    expect(JSON.stringify(t.fake.sent)).toContain('SYNTHETIC_ARCHIVE_BODY')
    expect(JSON.stringify(t.fake.sent)).not.toContain('docs.invalid/existing')
  })
  it('does not append group-visible journal content after the destination changes to DM', async () => {
    const t = await setup()
    expect(await t.run()).toBe('ok')
    // Simulate an existing saved destination change; configuration updates invalidate old executions.
    t.registry.db.prepare("UPDATE routines SET deliver_to = 'dm', config_version = config_version + 1 WHERE id = ?").run(t.routine.id)
    const prepend = vi.spyOn(t.fake, 'prependToDocument')
    expect(await t.run()).toBe('ok')
    expect(t.fake.createdDocs).toHaveLength(1); expect(prepend).not.toHaveBeenCalled()
    expect(t.fake.grants).toHaveLength(1)
  })
  it('an unknown creation result blocks blind creation on the next occurrence while normal delivery remains available', async () => {
    const t = await setup(), original = t.fake.createDocument.bind(t.fake)
    vi.spyOn(t.fake, 'createDocument').mockImplementation(async (...args) => { await original(...args); throw new Error('synthetic ACK lost') })
    expect(await t.run()).toBe('ok'); expect(await t.run()).toBe('ok')
    expect(t.fake.createdDocs).toHaveLength(1)
    expect(t.fake.of('sendToChat')).toHaveLength(2)
    expect(t.wiki.get(t.group.id, `journal:${t.routine.id}`)).toBeUndefined()
  })
  it('does not recreate after the real returned-create receipt commits but local document identity persistence fails', async () => {
    const t = await setup()
    const remember = vi.spyOn(t.wiki, 'remember').mockImplementationOnce(() => {
      // This is the actual ACK -> local identity crash window, not a fabricated ledger row.
      expect(t.registry.db.prepare("SELECT state FROM run_api_calls WHERE route='HOST /documents/create'").all())
        .toEqual([{ state: 'returned' }])
      throw new Error('synthetic identity persistence failure after remote ACK')
    })
    expect(await t.run()).toBe('ok')
    const reopened = new Registry(t.databasePath)
    try {
      expect(new WikiDocs(reopened.db).get(t.group.id, `journal:${t.routine.id}`)).toBeUndefined()
      expect(reopened.db.prepare("SELECT state FROM run_api_calls WHERE route='HOST /documents/create'").all())
        .toEqual([{ state: 'returned' }])
    } finally { reopened.close() }
    remember.mockRestore()
    expect(await t.run()).toBe('ok')
    expect(t.fake.createdDocs).toHaveLength(1)
    expect(t.fake.grants).toEqual([])
    expect(t.fake.of('sendToChat')).toHaveLength(2)
    expect(JSON.stringify(t.fake.sent)).not.toContain(t.fake.createdDocs[0]!.documentId)
  })
  it.each(['rejected', 'ack_lost'] as const)('a %s group share keeps the full digest and is never treated as accessible on later runs', async failure => {
    const t = await setup(), original = t.fake.grantDocAccess.bind(t.fake)
    const share = vi.spyOn(t.fake, 'grantDocAccess').mockImplementation(async (...args) => {
      if (failure === 'ack_lost') await original(...args)
      throw new Error('synthetic share acknowledgement unavailable')
    })
    expect(await t.run()).toBe('ok'); expect(await t.run()).toBe('ok')
    expect(t.fake.createdDocs).toHaveLength(1)
    expect(share).toHaveBeenCalledTimes(1)
    expect(t.fake.prependToDocument).not.toHaveBeenCalled()
    expect(t.registry.db.prepare("SELECT state FROM run_api_calls WHERE route='HOST /documents/grant'").all()).toEqual([{ state: 'failed' }])
    expect(JSON.parse(t.registry.getKv(`routine-archive-audience:${t.routine.id}:${t.group.id}`)!)).toMatchObject({ accessibilityConfirmed: false })
    expect(t.fake.of('sendToChat')).toHaveLength(2)
    expect(JSON.stringify(t.fake.sent).match(/SYNTHETIC_ARCHIVE_BODY/g)).toHaveLength(2)
    expect(JSON.stringify(t.fake.sent)).not.toContain(t.fake.createdDocs[0]!.documentId)
  })
  it('requires a share acknowledgement when the DM archive was created with the application identity', async () => {
    const t = await setup('dm')
    vi.spyOn(t.userTokens, 'accessTokenFor').mockResolvedValue(undefined)
    expect(await t.run()).toBe('ok')
    expect(t.fake.grants).toEqual([expect.objectContaining({ member: { openId: 'ou_alice' }, perm: 'full_access' })])
    expect(JSON.parse(t.registry.getKv(`routine-archive-audience:${t.routine.id}:${t.group.id}`)!)).toMatchObject({ accessibilityConfirmed: true })
  })
  it('reuses a group journal only after confirmed sharing', async () => {
    const t = await setup()
    expect(await t.run()).toBe('ok'); expect(await t.run()).toBe('ok')
    expect(t.fake.createdDocs).toHaveLength(1)
    expect(t.fake.grants).toEqual([expect.objectContaining({ member: { chatId: 'oc_group' }, perm: 'edit' })])
    expect(t.fake.prependToDocument).toHaveBeenCalledTimes(1)
    expect(JSON.parse(t.registry.getKv(`routine-archive-audience:${t.routine.id}:${t.group.id}`)!)).toMatchObject({ accessibilityConfirmed: true })
  })
})
