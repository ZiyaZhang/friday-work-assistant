/**
 * 包 B §0–§4、§7 宿主接线：提案卡片带版本、点卡走 RoutineApplication.decideProposal、提案修改走 RoutineApplication.update
 * 并刷新卡片、作废定时走 RoutineApplication.expireProposals、空间停用后结清授权指针。平台一侧是假飞书。
 * 用户已定：提案只接受用户刚看到的 configVersion；卡片 v 严格转数；双击幂等；显式停止各走领域关闭。
 */
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AcpRuntime } from '../src/acp/runtime.js'
import { loadConfig } from '../src/config.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { AUTH_EXPIRED, RoutineStore } from '../src/core/routines.js'
import { Todos } from '../src/core/todos.js'
import { Inbox } from '../src/core/inbox.js'
import { proposalPointerTitle } from '../src/core/routine-application.js'
import { createInternalApi, type InternalApiDeps } from '../src/internal/api.js'
import { GROUP_SCOPES, TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { createFakeAgent } from './helpers/fake-agent.js'
import { FakeFeishu, asFeishuClient, cardText } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const log = createLogger('test', 'error')

function setup(options: { updateRoutine?: (deps: { routines: RoutineStore; orchestrator: Orchestrator }) => InternalApiDeps['updateRoutine'] | undefined } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'friday-proposal-card-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 'b', FRIDAY_HOME: home, FRIDAY_PROMPT_TIMEOUT_MS: '5000', FRIDAY_REFLECT: 'off' } as NodeJS.ProcessEnv)
  mkdirSync(cfg.workspace.root, { recursive: true })
  const registry = new Registry(':memory:')
  const memory = new ChannelMemory(registry.db), messageCache = new MessageCache(registry.db), todos = new Todos(registry.db)
  const routines = new RoutineStore(registry.db), inbox = new Inbox(registry.db)
  const feishu = new FakeFeishu()
  feishu.members.set('oc_g', new Set(['ou_alice', 'ou_bob']))
  const messages = new MessageService(asFeishuClient(feishu), messageCache, log)
  const sp = spaceDeps(registry.db)
  const group = sp.spaces.ensure({ kind: 'group', chatId: 'oc_g', openId: 'ou_alice' })
  sp.spaces.addMember(group.id, 'ou_bob', 'member')
  const tokens = new TokenIssuer('s')
  let orchestrator!: Orchestrator
  const updateRoutine = options.updateRoutine ? options.updateRoutine({ routines, get orchestrator() { return orchestrator } })
    : (id: number, patch: Parameters<NonNullable<InternalApiDeps['updateRoutine']>>[1], opts: { expectedConfigVersion?: number }) => orchestrator.updateRoutine(id, patch, opts)
  const api = createInternalApi({ feishu: asFeishuClient(feishu), memory, registry, messages, messageCache, todos, routines, inbox, ...sp, tokens, log, maxHistoryPerCall: 50,
    resolveActorForSession: key => key === 'msg:1' ? { requesterOpenId: 'ou_alice', runId: 'fixture:msg:1', stage: 'task' } : orchestrator.resolveActorForSession(key),
    canPersistDerivedState: () => true,
    ...(updateRoutine ? { updateRoutine } : {}),
    refreshProposalCard: id => orchestrator.refreshProposalCard(id) })
  const { app } = createFakeAgent()
  const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: app }, onPermission: (req, signal) => orchestrator.handlePermission(req, signal), log })
  orchestrator = new Orchestrator({ cfg, feishu: asFeishuClient(feishu), runtime, registry, memory, messages, routines, inbox, ...sp, tokens,
    apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', botOpenId: 'ou_bot', log })
  const cap = { sessionKey: 'msg:1', runId: 'fixture:msg:1', spaceId: group.id, chatId: 'oc_g', chatType: 'group' as const, requesterOpenId: 'ou_alice', scopes: [...GROUP_SCOPES], exp: 0 }
  const propose = async (name = '每周五整理项目风险', prompt = '把本周群里提到的项目风险整理成清单') =>
    (await api.routes['POST /v1/responsibility/propose']!(cap, { name, reason: '最近三周每周五都有人问风险', prompt, schedule: { type: 'daily', at: '17:00', days: [5] } })) as { id: number }
  const update = (body: Record<string, unknown>) => api.routes['POST /v1/routine/update']!(cap, body) as Promise<Record<string, unknown>>
  const click = (id: number, decision: 'accept' | 'ignore', v: unknown, extra: { operatorOpenId?: string; messageId?: string; chatId?: string } = {}) =>
    orchestrator.handleCardAction({ value: { action: 'resp', id, decision, ...(v === undefined ? {} : { v }) }, operatorOpenId: extra.operatorOpenId ?? 'ou_alice',
      chatId: extra.chatId ?? 'oc_g', messageId: extra.messageId ?? routines.get(id)?.cardMessageId ?? undefined, raw: {} }) as Promise<{ toast: { type: string; content: string }; card?: { type: string; data: Record<string, unknown> } }>
  const buttonVersions = (payload: unknown) => [...JSON.stringify(payload).matchAll(/"action":"resp","id":\d+,"decision":"(?:accept|ignore)","v":(\d+)/g)].map(m => Number(m[1]))
  const snapshot = () => ({ routines: registry.db.prepare('SELECT * FROM routines ORDER BY id').all(), inbox: registry.db.prepare('SELECT * FROM inbox_items ORDER BY id').all() })
  return { registry, routines, inbox, feishu, orchestrator, api, sp, group, cap, propose, update, click, buttonVersions, snapshot }
}

describe('responsibility proposal cards carry the version the person saw', () => {
  it('rejects the old card after an edit, refreshes it, and accepts the edited content only from the new card', async () => {
    const t = setup()
    const { id } = await t.propose()
    const v0 = t.routines.configVersion(id)!
    expect(t.buttonVersions(t.feishu.sent.at(-1)?.payload)).toEqual([v0, v0])
    const pointer = t.inbox.find('responsibility', id, 'ou_alice')!
    expect(pointer.title).toBe(proposalPointerTitle(t.routines.get(id)!))

    const edited = await t.update({ id, prompt: '把本周群里提到的项目风险整理成清单，并标出负责人', name: '每周五整理项目风险与负责人' })
    const v1 = t.routines.configVersion(id)!
    expect(v1).toBeGreaterThan(v0)
    expect(edited).toMatchObject({ ok: true, proposal: { card: 'refreshed' } })
    const refreshed = t.feishu.of('patchCard').at(-1)!
    expect(refreshed.target).toBe(t.routines.get(id)!.cardMessageId)
    expect(t.buttonVersions(refreshed.payload)).toEqual([v1, v1])
    expect(cardText(refreshed.payload as Record<string, unknown>)).toContain('并标出负责人')
    expect(t.inbox.get(pointer.id)?.title).toBe(proposalPointerTitle(t.routines.get(id)!))
    expect(t.inbox.get(pointer.id)?.title).toContain('每周五整理项目风险与负责人')

    const before = t.snapshot()
    const stale = await t.click(id, 'accept', v0)
    expect(stale.toast).toEqual({ type: 'info', content: '提案内容已更新，请看清新内容后再点' })
    expect(t.snapshot()).toEqual(before)
    expect(t.buttonVersions(t.feishu.of('patchCard').at(-1)!.payload)).toEqual([v1, v1])
    // 被点的旧卡在回调响应里换成新内容和新版本的按钮，与 patch 的卡相同
    expect(stale.card?.type).toBe('raw')
    expect(t.buttonVersions(stale.card?.data)).toEqual([v1, v1])
    expect(cardText(stale.card?.data)).toContain('并标出负责人')
    expect(stale.card?.data).toEqual(t.feishu.of('patchCard').at(-1)!.payload)

    const decided = await t.click(id, 'accept', v1)
    expect(decided.toast.type).toBe('success')
    expect(t.routines.get(id)).toMatchObject({ status: 'active', runAs: 'ou_alice', decidedBy: 'ou_alice', prompt: '把本周群里提到的项目风险整理成清单，并标出负责人' })
    expect(t.inbox.get(pointer.id)).toMatchObject({ resolution: 'domain', resolvedBy: 'ou_alice', resolutionNote: 'accepted' })
    expect(cardText(t.feishu.of('patchCard').at(-1)!.payload as Record<string, unknown>)).toContain('已接受')
    expect(decided.card?.data).toMatchObject({ header: { title: { content: '已接受' }, template: 'green' } })
    expect(t.buttonVersions(decided.card?.data)).toEqual([])
    expect(decided.card?.data).toEqual(t.feishu.of('patchCard').at(-1)!.payload)

    const accepted = t.snapshot()
    const repeated = await t.click(id, 'accept', v1)
    expect(repeated.toast).toEqual({ type: 'info', content: '这条提案已经处理过了' })
    const opposite = await t.click(id, 'ignore', v1)
    expect(opposite.toast).toEqual({ type: 'info', content: '这条提案已经处理过了：已被接受，没有改动' })
    expect(t.snapshot()).toEqual(accepted)
    // 再点（already_accepted / conflict）：响应里仍是已接受的卡，卡片不回退
    expect(repeated.card?.data).toEqual(decided.card?.data)
    expect(opposite.card?.data).toEqual(decided.card?.data)
  })

  it.each([undefined, '1.0', ' 1', 'abc', 1.5, -1, null])('treats card version %j as an old card: refresh only, then the refreshed card works', async v => {
    const t = setup()
    const { id } = await t.propose()
    const version = t.routines.configVersion(id)!
    const before = t.snapshot()
    const stale = await t.click(id, 'accept', v)
    expect(stale.toast).toEqual({ type: 'info', content: '提案内容已更新，请看清新内容后再点' })
    expect(t.snapshot()).toEqual(before)
    expect(t.buttonVersions(t.feishu.of('patchCard').at(-1)!.payload)).toEqual([version, version])
    expect(t.buttonVersions(stale.card?.data)).toEqual([version, version])
    // 回调里的 v 可能是字符串：严格的整数字符串照样认
    const ignored = await t.click(id, 'ignore', String(version))
    expect(ignored.toast).toEqual({ type: 'success', content: '已忽略' })
    expect(t.routines.get(id)?.status).toBe('ignored')
    expect(ignored.card?.data).toMatchObject({ header: { title: { content: '已忽略' }, template: 'grey' } })
    expect(t.buttonVersions(ignored.card?.data)).toEqual([])
    // 再点（already_ignored / conflict）：响应里仍是已忽略的卡
    const repeated = await t.click(id, 'ignore', String(version))
    expect(repeated.toast).toEqual({ type: 'info', content: '这条提案已经处理过了' })
    const opposite = await t.click(id, 'accept', String(version))
    expect(opposite.toast).toEqual({ type: 'info', content: '这条提案已经处理过了：已被忽略，没有改动' })
    expect(repeated.card?.data).toEqual(ignored.card?.data)
    expect(opposite.card?.data).toEqual(ignored.card?.data)
  })

  it('refuses a copied card in the same chat and a click from another chat, without touching the proposal', async () => {
    const t = setup()
    const { id } = await t.propose()
    const version = t.routines.configVersion(id)!
    const before = t.snapshot()
    const copied = await t.click(id, 'accept', version, { messageId: 'om_copied_card' })
    expect(copied.toast).toEqual({ type: 'error', content: '请在这条提案原来的卡片上处理' })
    const elsewhere = await t.click(id, 'accept', version, { chatId: 'oc_other' })
    expect(elsewhere.toast).toEqual({ type: 'error', content: '只能在提案所在的会话里处理' })
    const member = await t.click(id, 'accept', version, { operatorOpenId: 'ou_bob' })
    expect(member.toast).toEqual({ type: 'error', content: '只有本空间负责人能决定提议' })
    expect(t.snapshot()).toEqual(before)
    expect(t.feishu.of('patchCard')).toHaveLength(0)
    // 拒绝时响应不带卡，被点的卡保持原样
    for (const result of [copied, elsewhere, member]) expect(result).not.toHaveProperty('card')
  })

  it('never decides a routine that was not a proposal', async () => {
    const t = setup()
    const own = t.routines.add({ kind: 'schedule', ownerOpenId: 'ou_alice', spaceId: t.group.id, chatId: 'oc_g', chatType: 'group', name: '日报', prompt: '总结', schedule: { type: 'daily', at: '19:00' } })
    const before = t.snapshot()
    const result = await t.click(own.id, 'ignore', t.routines.configVersion(own.id))
    expect(result.toast).toEqual({ type: 'error', content: '找不到这条提案' })
    expect(result).not.toHaveProperty('card')
    expect(t.snapshot()).toEqual(before)
  })
})

describe('editing a proposal', () => {
  it('refuses a result archive while the proposal waits, and allows it after acceptance', async () => {
    const t = setup()
    const { id } = await t.propose()
    const before = t.snapshot()
    await expect(t.update({ id, archive: 'doc' })).rejects.toThrow('提案还没接受，接受后再设置结果存放位置')
    await expect(t.update({ id, archive: 'doc', prompt: '顺带改指令' })).rejects.toThrow('提案还没接受，接受后再设置结果存放位置')
    expect(t.snapshot()).toEqual(before)
    expect(t.registry.getKv(`routine-archive:${id}`)).toBeUndefined()
    expect((await t.click(id, 'accept', t.routines.configVersion(id))).toast.type).toBe('success')
    expect(await t.update({ id, archive: 'doc' })).toMatchObject({ ok: true, archive: 'doc' })
    expect(t.registry.getKv(`routine-archive:${id}`)).toBe('doc')
  })

  it('returns 409 without writing when the routine changed between reading and writing', async () => {
    let conflict = true
    const t = setup({ updateRoutine: host => (id, patch, options) => {
      // 模拟入口读到版本之后、写入之前别处已改过这条职责
      if (conflict) { conflict = false; host.routines.update(id, { name: '别处刚改过的名字' }) }
      return host.orchestrator.updateRoutine(id, patch, options)
    } })
    const { id } = await t.propose()
    await expect(t.update({ id, prompt: '入口读到旧版本后的修改' })).rejects.toMatchObject({ status: 409, message: '这条职责已修改，请刷新后重试' })
    expect(t.routines.get(id)).toMatchObject({ name: '别处刚改过的名字', prompt: '把本周群里提到的项目风险整理成清单' })
  })

  it('fails closed when the host did not wire the shared update operation', async () => {
    const t = setup({ updateRoutine: () => undefined })
    const { id } = await t.propose()
    const before = t.snapshot()
    await expect(t.update({ id, prompt: '不应写入' })).rejects.toMatchObject({ status: 503 })
    expect(t.snapshot()).toEqual(before)
  })
})

describe('expiry', () => {
  it('the sweep expires the proposal, settles its pointer in the same step and then patches the card', async () => {
    const t = setup()
    const { id } = await t.propose()
    const pointer = t.inbox.find('responsibility', id, 'ou_alice')!
    t.registry.db.prepare('UPDATE routines SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, id)
    expect(await t.orchestrator.expireProposals()).toBe(1)
    expect(t.routines.get(id)?.status).toBe('expired')
    expect(t.inbox.get(pointer.id)).toMatchObject({ resolution: 'domain', resolutionNote: 'expired' })
    const card = t.feishu.of('patchCard').at(-1)!.payload
    expect(cardText(card as Record<string, unknown>)).toContain('作废')
    expect(t.buttonVersions(card)).toEqual([])
    expect(await t.orchestrator.expireProposals()).toBe(0)
    const late = await t.click(id, 'accept', t.routines.configVersion(id))
    expect(late.toast).toEqual({ type: 'info', content: '这条提案已经过期作废了' })
    expect(late.card?.data).toMatchObject({ header: { title: { content: '已作废' }, template: 'grey' } })
    expect(t.buttonVersions(late.card?.data)).toEqual([])
  })

  it('a click after 72 hours but before the sweep expires the proposal instead of accepting it', async () => {
    const t = setup()
    const { id } = await t.propose()
    const pointer = t.inbox.find('responsibility', id, 'ou_alice')!
    t.registry.db.prepare('UPDATE routines SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, id)
    const late = await t.click(id, 'accept', t.routines.configVersion(id))
    expect(late.toast).toEqual({ type: 'info', content: '这条提案已经过期作废了' })
    expect(t.routines.get(id)).toMatchObject({ status: 'expired', runAs: null, decidedBy: null })
    expect(t.inbox.get(pointer.id)).toMatchObject({ resolution: 'domain', resolutionNote: 'expired' })
    expect(cardText(t.feishu.of('patchCard').at(-1)!.payload as Record<string, unknown>)).toContain('作废')
    expect(late.card?.data).toEqual(t.feishu.of('patchCard').at(-1)!.payload)
    expect(t.buttonVersions(late.card?.data)).toEqual([])
  })
})

describe('stopping a space', () => {
  it('settles the owner’s authorization reminder and makes a card sent before the stop stale', async () => {
    const t = setup()
    const watch = t.routines.add({ kind: 'watch', ownerOpenId: 'ou_alice', spaceId: t.group.id, chatId: 'oc_g', chatType: 'group', name: '盯发布', prompt: '发布阻塞',
      schedule: { type: 'daily', at: '09:00' }, watchChatIds: ['oc_g'] })
    t.routines.suspendForExpiredAuth('ou_alice')
    expect(t.routines.get(watch.id)?.disabledReason).toBe(AUTH_EXPIRED)
    const auth = t.inbox.add({ ownerOpenId: 'ou_alice', kind: 'auth', refId: watch.id, title: '1 个盯群停了' })
    const { id } = await t.propose()
    const shown = t.routines.configVersion(id)!
    await t.orchestrator.handleChatLifecycle({ kind: 'bot_removed', chatId: 'oc_g', raw: {} })
    expect(t.inbox.get(auth.id)).toMatchObject({ resolution: 'domain', resolutionNote: 'no_longer_waiting' })
    expect(t.routines.get(id)?.status).toBe('proposed')
    expect(t.routines.configVersion(id)).toBe(shown + 1)
    t.sp.spaces.resume('oc_g')
    expect((await t.click(id, 'accept', shown)).toast).toEqual({ type: 'info', content: '提案内容已更新，请看清新内容后再点' })
    expect(t.routines.get(id)?.status).toBe('proposed')
    expect((await t.click(id, 'accept', shown + 1)).toast.type).toBe('success')
  })
})
