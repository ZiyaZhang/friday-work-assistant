import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpRuntime } from '../src/acp/runtime.js'
import { loadConfig } from '../src/config.js'
import { ChannelMemory } from '../src/core/memory.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { RoutineScheduler, RoutineStore, type Routine } from '../src/core/routines.js'
import { UserTokenStore } from '../src/feishu/oauth.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { createFakeAgent } from './helpers/fake-agent.js'
import { asFeishuClient, FakeFeishu } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const NOW = Date.UTC(2026, 8, 19)
const BODY = '合成摘要\n\nSYNTHETIC_ROUTINE_RESULT'
const log = createLogger('routine-delivery', 'error')
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'friday-routine-delivery-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic', FEISHU_APP_SECRET: 'synthetic', FRIDAY_HOME: home, FRIDAY_REFLECT: 'off' } as NodeJS.ProcessEnv)
  mkdirSync(cfg.workspace.root, { recursive: true })
  const path = join(home, 'test.sqlite')
  const registry = new Registry(path)
  const routines = new RoutineStore(registry.db)
  const sp = spaceDeps(registry.db)
  const group = sp.spaces.ensure({ kind: 'group', chatId: 'oc_group', openId: 'ou_alice' })
  const dm = sp.spaces.ensure({ kind: 'p2p', chatId: 'oc_dm', openId: 'ou_alice' })
  const other = sp.spaces.ensure({ kind: 'group', chatId: 'oc_other', openId: 'ou_bob' })
  sp.spaces.addMember(other.id, 'ou_alice', 'member')
  const feishu = new FakeFeishu()
  feishu.nextToken.scope = 'im:chat:readonly im:message.group_msg:get_as_user'
  feishu.members.set('oc_group', new Set(['ou_alice', 'ou_bob']))
  feishu.members.set('oc_other', new Set(['ou_alice', 'ou_bob']))
  const userTokens = new UserTokenStore(registry.db, feishu)
  const { app, state } = createFakeAgent({ script: [{ kind: 'text', text: BODY }] })
  const clock = { now: NOW }
  let orchestrator!: Orchestrator
  const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: app }, onPermission: (req, signal) => orchestrator.handlePermission(req, signal), log })
  const deps = { cfg, registry, routines, ...sp, memory: new ChannelMemory(registry.db), feishu: asFeishuClient(feishu), userTokens,
    runtime, tokens: new TokenIssuer('synthetic'), apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', botOpenId: 'ou_bot', log, now: () => clock.now }
  orchestrator = new Orchestrator(deps)
  cleanup.push(async () => { await runtime.stop(); registry.close(); rmSync(home, { recursive: true, force: true }) })
  const add = (over: Partial<Parameters<RoutineStore['add']>[0]> = {}) => routines.add({
    kind: 'schedule', ownerOpenId: 'ou_alice', spaceId: group.id, chatId: 'oc_group', chatType: 'group', name: '合成日报',
    prompt: '总结本群', schedule: { type: 'interval', everyMinutes: 10 }, now: NOW, ...over,
  })
  const start = (r: Routine) => {
    clock.now = r.nextRunAt
    const claimed = routines.claimDueOccurrence(r.id, r.nextRunAt, clock.now)!
    const routine = routines.startOccurrence(claimed.id, clock.now)!
    const occurrence = routines.getOccurrence(claimed.id)!
    return { routine, occurrence, key: `routine:${r.id}:occurrence:${occurrence.id}:v${occurrence.configVersion}:digest` }
  }
  const sessionKey = () => registry.getSessionByAcpId(state.allPrompts.at(-1)!.sessionId)!.sessionKey
  const records = () => registry.db.prepare('SELECT delivery_key, status, remote_id, audience FROM deliveries').all() as { delivery_key: string; status: string; remote_id: string | null; audience: string }[]
  const command = (text: string, messageId = 'om_manual') => orchestrator.handleMessage({
    eventId: `ev_${messageId}`, messageId, chatId: 'oc_group', chatType: 'group', msgType: 'text', text: `@Friday ${text}`,
    senderOpenId: 'ou_alice', senderType: 'user', mentions: [{ key: '@Friday', openId: 'ou_bot', name: 'Friday' }], createTimeMs: clock.now,
  })
  return { ...sp, cfg, home, path, registry, routines, group, dm, other, feishu, userTokens, runtime, state, clock, deps, orchestrator, add, start, sessionKey, records, command }
}

describe('routine final digest delivery', () => {
  it.each(['model-failure', 'digest-denied'] as const)('recovers the file delivery window after %s without replaying it', async (failure) => {
    const t = setup()
    const authState = t.userTokens.begin('ou_alice')
    const token = await t.userTokens.complete({ code: 'synthetic', state: authState, redirectUri: 'local-test', openId: 'ou_alice' })
    t.feishu.userChats.set(token.accessToken, [{ chatId: 'oc_other', name: '合成来源群' }])
    const r = t.add({ kind: 'watch', spaceId: t.dm.id, chatId: 'oc_dm', chatType: 'p2p', deliverTo: 'dm', watchChatIds: ['oc_other'] })
    const firstEnd = NOW + 600_000
    t.clock.now = firstEnd
    t.state.script = [{ kind: 'hook', run: async () => {
      const key = t.sessionKey()
      t.orchestrator.noteCrossSpaceRead(key, { chatId: 'oc_other', name: '合成来源群', what: 'history' })
      t.orchestrator.noteChatHistoryRead(key, { chatId: 'oc_other', startSec: NOW / 1000, endSec: firstEnd / 1000 })
      const actor = t.orchestrator.resolveActorForSession(key)!
      await t.orchestrator.deliverToolResult(key, actor.runId, { kind: 'file', data: Buffer.from('合成窗口报告'), name: 'window.md' })
      if (failure === 'model-failure') throw new Error('synthetic model failure after file ACK')
      t.orchestrator.noteExternalSource(key, { kind: 'document', ref: 'synthetic-unshared-document' })
    } }, { kind: 'text', text: BODY }]
    await expect(t.orchestrator.runRoutine(r, { manualMessageId: `om_${failure}` })).rejects.toThrow()
    expect(t.feishu.of('sendFileToUser')).toHaveLength(1)
    expect(t.routines.get(r.id)!.messageCursorSec).not.toBe(firstEnd / 1000)
    const proofRows = t.registry.db.prepare('SELECT v FROM kv WHERE k LIKE ?').all(`routine-message-window:routine:${r.id}:%`) as { v: string }[]
    const fileReceipt = t.records().find((record) => record.status === 'sent')!
    expect(proofRows.map((row) => JSON.parse(row.v).deliveryKey)).toContain(fileReceipt.delivery_key)

    const restarted = new Orchestrator(t.deps)
    t.clock.now = firstEnd + 600_000
    t.state.script = [{ kind: 'hook', run: () => {
      expect(t.routines.get(r.id)!.messageCursorSec).toBe(firstEnd / 1000)
      restarted.noteChatHistoryRead(t.sessionKey(), { chatId: 'oc_other', startSec: firstEnd / 1000, endSec: t.clock.now / 1000 })
    } }, { kind: 'text', text: 'NOTHING' }]
    expect(await restarted.runRoutine(r, { manualMessageId: 'om_after_restart' })).toBe('skipped')
    expect(t.feishu.of('sendFileToUser')).toHaveLength(1)
    expect(t.routines.get(r.id)!.messageCursorSec).toBe(t.clock.now / 1000)
  })

  it('reads the persisted policy in the chat command for active tasks and pending proposals', async () => {
    const t = setup()
    t.add({ deliveryPolicy: 'every_run' })
    t.add({ source: 'model', name: '合成提案', deliveryPolicy: 'when_nonempty' })
    await t.command('!routines', 'om_list_policy')
    expect(t.feishu.of('replyText')[0]?.payload).toContain('每次发送')
    expect(t.feishu.of('replyText')[0]?.payload).toContain('有内容才发送')
    expect(t.state.allPrompts).toHaveLength(0)
  })

  it.each(['', 'NOTHING', 'nothing。'])('reports empty every_run result %j once and records a failed one-shot', async (body) => {
    const t = setup()
    const r = t.add({ deliveryPolicy: 'every_run', schedule: { type: 'once', atMs: NOW + 60_000 } })
    t.state.script = [{ kind: 'text', text: body }]
    t.clock.now = r.nextRunAt
    const scheduler = new RoutineScheduler({ store: t.routines, log, now: () => t.clock.now,
      run: (routine, occurrence) => t.orchestrator.runRoutine(routine, { occurrence }) })
    expect(await scheduler.tick()).toBe(1)
    expect(await scheduler.tick()).toBe(0)
    expect(t.feishu.sent).toHaveLength(1)
    expect(t.feishu.of('sendToChat')[0]?.payload).toEqual({ text: `「${r.name}」这次没有生成结果，跟我说一声就能重跑一次。` })
    expect(t.routines.listOccurrences(r.id)).toMatchObject([{ status: 'failed', error: '本次未生成可用结果，已发送失败提示' }])
    expect(t.routines.get(r.id)).toMatchObject({ lastStatus: 'failed', failCount: 1, runs: 1, enabled: false, disabledReason: '一次性任务执行失败' })
    expect(t.records()).toMatchObject([{ status: 'sent' }])
    expect(t.feishu.recalled).toEqual([])
    expect(t.feishu.of('patchCard')).toHaveLength(0)
  })

  it('retains the failed result after a sent receipt survives host restart, without running or posting again', async () => {
    const t = setup()
    const r = t.add({ deliveryPolicy: 'every_run' })
    t.state.script = [{ kind: 'text', text: 'NOTHING' }]
    const options = { manualMessageId: 'om_empty_once' }
    await expect(t.orchestrator.runRoutine(r, options)).rejects.toThrow('已发送失败提示')
    const reopened = new Registry(t.path)
    try {
      const restarted = new Orchestrator({ ...t.deps, registry: reopened, routines: new RoutineStore(reopened.db), ...spaceDeps(reopened.db) })
      await expect(restarted.runRoutine(r, options)).rejects.toThrow('已发送失败提示')
    } finally { reopened.close() }
    expect(t.state.allPrompts).toHaveLength(1)
    expect(t.feishu.sent).toHaveLength(1)
  })

  it.each(['short', 'long'] as const)('publishes a successful every_run %s digest with the shared folding rule', async (length) => {
    const t = setup()
    const e = t.start(t.add({ deliveryPolicy: 'every_run' }))
    t.state.script = [{ kind: 'text', text: length === 'short' ? BODY : `合成摘要\n\n${'合成内容'.repeat(200)}` }]
    expect(await t.orchestrator.runRoutine(e.routine, { occurrence: e.occurrence })).toBe('ok')
    expect(t.feishu.sent).toHaveLength(1)
    const payload = t.feishu.of('sendToChat')[0]?.payload as { card: { body: { elements: { tag: string; expanded?: boolean }[] } } }
    // 2026-09-28 版式：短的直接展示（没有折叠面板），长的才折叠成「完整内容」且默认收起。
    const panel = payload.card.body.elements.find((e) => e.tag === 'collapsible_panel')
    if (length === 'short') expect(panel).toBeUndefined()
    else expect(panel?.expanded).toBe(false)
    expect(JSON.stringify(t.state.allPrompts)).toContain('发送约定：每次发送')
  })

  it.each(['policy-change', 'paused', 'cancelled', 'await-change'] as const)('does not send an empty-result fallback after %s', async (change) => {
    const t = setup()
    const e = t.start(t.add({ deliveryPolicy: 'every_run' }))
    t.state.script = [{ kind: 'text', text: 'NOTHING' }, { kind: 'hook', run: () => {
      if (change === 'policy-change') t.routines.update(e.routine.id, { deliveryPolicy: 'when_nonempty' })
      if (change === 'paused') t.routines.setEnabled(e.routine.id, false)
    } }]
    if (change === 'cancelled') {
      const original = t.runtime.prompt.bind(t.runtime)
      vi.spyOn(t.runtime, 'prompt').mockImplementation(async (...args) => ({ ...await original(...args), stopReason: 'cancelled' }))
    }
    if (change === 'await-change') vi.spyOn(t.feishu, 'chatMemberOpenIds').mockImplementation(async () => {
      await Promise.resolve()
      t.routines.update(e.routine.id, { deliveryPolicy: 'when_nonempty' })
      return new Set(['ou_alice'])
    })
    await expect(t.orchestrator.runRoutine(e.routine, { occurrence: e.occurrence })).rejects.toThrow()
    expect(t.feishu.sent).toHaveLength(0)
    expect(t.records()).toHaveLength(0)
  })

  it('does not retry an unknown empty-result notice under the same or a new execution key', async () => {
    const t = setup()
    const r = t.add({ deliveryPolicy: 'every_run' })
    t.state.script = [{ kind: 'text', text: 'NOTHING' }]
    const original = t.feishu.sendToChat.bind(t.feishu)
    const send = vi.spyOn(t.feishu, 'sendToChat').mockImplementation(async (...args) => { await original(...args); throw new Error('synthetic lost ACK') })
    await expect(t.orchestrator.runRoutine(r, { manualMessageId: 'om_empty_lost' })).rejects.toMatchObject({ code: 'unknown' })
    await expect(t.orchestrator.runRoutine(r, { manualMessageId: 'om_empty_lost' })).rejects.toMatchObject({ code: 'unknown' })
    await expect(t.orchestrator.runRoutine(r, { manualMessageId: 'om_empty_new' })).rejects.toMatchObject({ code: 'unknown' })
    expect(send).toHaveBeenCalledTimes(1)
    expect(t.state.allPrompts).toHaveLength(1)
    expect(t.records()).toMatchObject([{ status: 'unknown' }])
  })

  it.each(['interval', 'once'] as const)('uses the scheduler occurrence for one %s digest and preserves once completion', async (kind) => {
    const t = setup()
    const r = t.add({ schedule: kind === 'once' ? { type: 'once', atMs: NOW + 60_000 } : { type: 'interval', everyMinutes: 10 } })
    t.clock.now = r.nextRunAt
    const scheduler = new RoutineScheduler({ store: t.routines, log, now: () => t.clock.now,
      run: (routine, occurrence) => {
        expect(occurrence.status).toBe('running')
        expect(t.routines.currentForExecution(routine.id, occurrence.configVersion, occurrence.id)?.id).toBe(r.id)
        return t.orchestrator.runRoutine(routine, { occurrence })
      },
    })
    expect(await scheduler.tick()).toBe(1)
    expect(await scheduler.tick()).toBe(0)
    expect(t.feishu.sent).toHaveLength(1)
    expect(t.feishu.of('sendToChat')[0]).toMatchObject({ target: 'oc_group' })
    expect(JSON.stringify(t.feishu.sent)).toContain(BODY.split('\n').at(-1))
    expect(t.feishu.of('patchCard')).toHaveLength(0)
    expect(t.feishu.recalled).toEqual([])
    expect(t.feishu.reactionLog).toEqual([])
    const occurrence = t.routines.listOccurrences(r.id)[0]!
    expect(occurrence.status).toBe('ok')
    expect(t.records()).toMatchObject([{ delivery_key: `routine:${r.id}:occurrence:${occurrence.id}:v1:digest`, status: 'sent' }])
    if (kind === 'once') expect(t.routines.get(r.id)).toMatchObject({ enabled: false, disabledReason: '一次性任务已执行', runs: 1 })
  })

  it('binds manual command redelivery to message_id; another explicit message is a new run', async () => {
    const t = setup()
    const r = t.add()
    await t.command(`!routine run ${r.id}`, 'om_command_1')
    await t.command(`!routine run ${r.id}`, 'om_command_1')
    expect(t.state.allPrompts).toHaveLength(1)
    expect(t.feishu.of('sendToChat')).toHaveLength(1)
    expect(t.records()[0]?.delivery_key).toBe(`routine:${r.id}:manual:om_command_1:digest`)
    await t.command(`!routine run ${r.id}`, 'om_command_2')
    expect(t.feishu.of('sendToChat')).toHaveLength(2)
  })

  it('keeps a manual re-run on its own trigger identity: no occurrence row, no collision with the scheduled window', async () => {
    const t = setup()
    const r = t.add()
    t.clock.now = r.nextRunAt
    const scheduler = new RoutineScheduler({ store: t.routines, log, now: () => t.clock.now,
      run: (routine, occurrence) => t.orchestrator.runRoutine(routine, { occurrence }) })
    expect(await scheduler.tick()).toBe(1)
    const occurrence = t.routines.listOccurrences(r.id)[0]!
    expect(occurrence).toMatchObject({ status: 'ok', windowKey: new Date(r.nextRunAt).toISOString() })
    await t.command(`!routine run ${r.id}`, 'om_manual_after_window')
    expect(t.routines.listOccurrences(r.id)).toEqual([occurrence])
    expect(t.records().map((record) => record.delivery_key).sort()).toEqual([
      `routine:${r.id}:manual:om_manual_after_window:digest`, `routine:${r.id}:occurrence:${occurrence.id}:v1:digest`])
    expect(t.feishu.of('sendToChat')).toHaveLength(2)
    // The manual trigger neither counts as a scheduled window nor moves the schedule.
    expect(t.routines.get(r.id)).toMatchObject({ runs: 1, nextRunAt: r.nextRunAt + 600_000 })
  })

  it.each(['nothing', 'paused', 'cancelled'] as const)('keeps once occurrence and disabled reason consistent after %s', async (ending) => {
    const t = setup()
    const r = t.add({ schedule: { type: 'once', atMs: NOW + 60_000 } })
    t.clock.now = r.nextRunAt
    if (ending === 'nothing') t.state.script = [{ kind: 'text', text: 'NOTHING' }]
    if (ending === 'paused') t.state.script = [{ kind: 'text', text: BODY }, { kind: 'hook', run: () => { t.routines.setEnabled(r.id, false) } }]
    if (ending === 'cancelled') {
      const original = t.runtime.prompt.bind(t.runtime)
      vi.spyOn(t.runtime, 'prompt').mockImplementation(async (...args) => ({ ...await original(...args), stopReason: 'cancelled' }))
    }
    const scheduler = new RoutineScheduler({ store: t.routines, log, now: () => t.clock.now,
      run: (routine, occurrence) => t.orchestrator.runRoutine(routine, { occurrence }) })
    expect(await scheduler.tick()).toBe(1)
    expect(await scheduler.tick()).toBe(0)
    expect(t.feishu.sent).toHaveLength(0)
    expect(t.routines.listOccurrences(r.id)).toMatchObject([{ status: ending === 'nothing' ? 'skipped' : ending === 'paused' ? 'cancelled' : 'failed' }])
    expect(t.routines.get(r.id)).toMatchObject({ enabled: false, runs: ending === 'paused' ? 0 : 1,
      disabledReason: ending === 'nothing' ? '一次性任务已执行' : ending === 'paused' ? '手动停用' : '一次性任务执行失败' })
  })

  it('allows an explicit manual run of a paused routine without enabling its schedule', async () => {
    const t = setup()
    const r = t.add()
    t.routines.setEnabled(r.id, false)
    expect(await t.orchestrator.runRoutine(r, { manualMessageId: 'om_manual_paused' })).toBe('ok')
    expect(t.routines.get(r.id)?.enabled).toBe(false)
    expect(t.feishu.of('sendToChat')).toHaveLength(1)
  })

  it('refuses missing or mismatched execution identity before model work', async () => {
    const t = setup()
    const r = t.add()
    await expect(t.orchestrator.runRoutine(r)).rejects.toThrow('message_id')
    const e = t.start(r)
    await expect(t.orchestrator.runRoutine(r, { occurrence: { ...e.occurrence, configVersion: 99 } })).rejects.toThrow('当前执行')
    const other = t.add({ name: '其他职责' })
    await expect(t.orchestrator.runRoutine(other, { occurrence: e.occurrence })).rejects.toThrow('当前执行')
    expect(t.state.allPrompts).toHaveLength(0)
    expect(t.feishu.sent).toHaveLength(0)
  })

  it.each(['pause', 'pause-resume', 'update', 'delete', 'archive', 'rebind', 'remove-role', 'leave-chat'] as const)('does not publish stale results after %s during execution', async (change) => {
    const t = setup()
    const e = t.start(t.add())
    t.state.script = [{ kind: 'text', text: BODY }, { kind: 'hook', run: () => {
      if (change === 'pause' || change === 'pause-resume') t.routines.setEnabled(e.routine.id, false)
      if (change === 'pause-resume') t.routines.setEnabled(e.routine.id, true)
      if (change === 'update') t.routines.update(e.routine.id, { prompt: '新的指令' })
      if (change === 'delete') t.routines.remove(e.routine.id)
      if (change === 'archive') t.spaces.archive(t.group.id)
      if (change === 'rebind') t.spaces.rebind(t.group.id, 'oc_rebound')
      if (change === 'remove-role') t.spaces.removeMember(t.group.id, 'ou_alice')
      if (change === 'leave-chat') t.feishu.members.set('oc_group', new Set())
    } }]
    await expect(t.orchestrator.runRoutine(e.routine, { occurrence: e.occurrence })).rejects.toThrow()
    expect(t.feishu.sent).toHaveLength(0)
    expect(t.records()).toHaveLength(0)
  })

  it('rechecks configuration after the final fresh platform lookup awaits', async () => {
    const t = setup()
    const e = t.start(t.add())
    const membership = vi.spyOn(t.feishu, 'chatMemberOpenIds').mockImplementation(async () => {
      await Promise.resolve()
      t.routines.update(e.routine.id, { name: '新的报告' })
      return new Set(['ou_alice'])
    })
    await expect(t.orchestrator.runRoutine(e.routine, { occurrence: e.occurrence })).rejects.toMatchObject({ code: 'denied' })
    expect(membership).toHaveBeenCalledWith('oc_group', { fresh: true })
    expect(t.feishu.sent).toHaveLength(0)
  })

  it('passes abort to ACP and stops an in-flight routine when its command pauses it', async () => {
    const t = setup()
    const e = t.start(t.add())
    const prompt = vi.spyOn(t.runtime, 'prompt')
    t.state.script = [{ kind: 'text', text: BODY }, { kind: 'hook', run: () => t.command(`!routine off ${e.routine.id}`, 'om_stop').then(() => undefined) }, { kind: 'text', text: '不应继续' }]
    await expect(t.orchestrator.runRoutine(e.routine, { occurrence: e.occurrence })).rejects.toThrow()
    expect(prompt.mock.calls[0]?.[2]?.signal?.aborted).toBe(true)
    expect(t.feishu.of('sendToChat')).toHaveLength(0)
    expect(t.feishu.of('replyText')[0]?.payload).toContain('已停用')
    expect(t.feishu.recalled).toEqual([])
  })

  it.each(['cancelled', 'max_tokens'] as const)('does not send partial body when ACP ends with %s', async (stopReason) => {
    const t = setup()
    const e = t.start(t.add())
    const original = t.runtime.prompt.bind(t.runtime)
    vi.spyOn(t.runtime, 'prompt').mockImplementation(async (...args) => ({ ...await original(...args), stopReason }))
    await expect(t.orchestrator.runRoutine(e.routine, { occurrence: e.occurrence })).rejects.toThrow('模型未正常结束')
    expect(t.feishu.sent).toHaveLength(0)
  })

  it.each(['group', 'own-dm', 'group-to-own-dm'] as const)('enforces the destination for %s and retains personal cross-group reading', async (target) => {
    const t = setup()
    const e = t.start(t.add(target === 'own-dm' ? { spaceId: t.dm.id, chatId: 'oc_dm', chatType: 'p2p', deliverTo: 'dm' }
      : target === 'group-to-own-dm' ? { deliverTo: 'dm' } : {}))
    t.state.script = [{ kind: 'hook', run: () => t.orchestrator.noteCrossSpaceRead(t.sessionKey(), { chatId: 'oc_other', name: '其他合成群', what: 'history' }) }, { kind: 'text', text: BODY }]
    if (target === 'group') {
      await expect(t.orchestrator.runRoutine(e.routine, { occurrence: e.occurrence })).rejects.toMatchObject({ code: 'denied' })
      expect(t.feishu.sent).toHaveLength(0)
    } else {
      expect(await t.orchestrator.runRoutine(e.routine, { occurrence: e.occurrence })).toBe('ok')
      expect(t.feishu.sent).toHaveLength(1)
      expect(t.feishu.of('sendToUser')[0]?.target).toBe('ou_alice')
      expect(JSON.parse(t.records()[0]!.audience)).toMatchObject({ kind: 'dm', openId: 'ou_alice', spaceId: t.dm.id })
    }
  })

  it('does not publish into a different person DM or share an application-readable document into the group', async () => {
    const t = setup()
    const otherRecipient = t.start(t.add({ ownerOpenId: 'ou_bob', runAs: 'ou_alice', deliverTo: 'dm' }))
    await expect(t.orchestrator.runRoutine(otherRecipient.routine, { occurrence: otherRecipient.occurrence })).rejects.toMatchObject({ code: 'denied' })
    const external = t.start(t.add())
    t.state.script = [{ kind: 'hook', run: () => t.orchestrator.noteExternalSource(t.sessionKey(), { kind: 'document', ref: 'synthetic-private-doc' }) }, { kind: 'text', text: BODY }]
    await expect(t.orchestrator.runRoutine(external.routine, { occurrence: external.occurrence })).rejects.toMatchObject({ code: 'denied' })
    expect(t.feishu.sent).toHaveLength(0)
  })

  it('rechecks a watch delegation after its personal chat-list lookup awaits', async () => {
    const t = setup()
    const state = t.userTokens.begin('ou_alice')
    const token = await t.userTokens.complete({ code: 'synthetic', state, redirectUri: 'local-test', openId: 'ou_alice' })
    t.feishu.userChats.set(token.accessToken, [{ chatId: 'oc_other', name: '合成来源群' }])
    const e = t.start(t.add({ kind: 'watch', spaceId: t.dm.id, chatId: 'oc_dm', chatType: 'p2p', deliverTo: 'dm', watchChatIds: ['oc_other'] }))
    t.state.script = [{ kind: 'hook', run: () => {
      t.orchestrator.noteCrossSpaceRead(t.sessionKey(), { chatId: 'oc_other', name: '合成来源群', what: 'history' })
      t.orchestrator.noteChatHistoryRead(t.sessionKey(), { chatId: 'oc_other', startSec: NOW / 1000, endSec: t.clock.now / 1000 })
    } }, { kind: 'text', text: BODY }]
    const chats = vi.spyOn(t.feishu, 'listChatsResult').mockImplementation(async () => {
      await Promise.resolve()
      t.userTokens.disconnect('ou_alice')
      return { items: [{ chatId: 'oc_other', name: '查询开始时仍可见' }], complete: true }
    })
    await expect(t.orchestrator.runRoutine(e.routine, { occurrence: e.occurrence })).rejects.toMatchObject({ code: 'denied' })
    expect(chats).toHaveBeenCalledWith({ userToken: token.accessToken }, expect.objectContaining({ fresh: true, assertCurrent: expect.any(Function) }))
    expect(t.feishu.sent).toHaveLength(0)
  })

  it('does not start the same manual execution concurrently or revive a pre-delivery interruption', async () => {
    const t = setup()
    const r = t.add()
    const options = { manualMessageId: 'om_same_manual_run' }
    let duplicate: unknown
    t.state.script = [{ kind: 'hook', run: async () => {
      duplicate = await t.orchestrator.runRoutine(r, options).catch((err: unknown) => err)
      throw new Error('synthetic interruption before delivery')
    } }]
    await expect(t.orchestrator.runRoutine(r, options)).rejects.toThrow()
    expect(duplicate).toBeInstanceOf(Error)
    expect(String(duplicate)).toContain('不会自动重跑')
    const restarted = new Orchestrator(t.deps)
    await expect(restarted.runRoutine(r, options)).rejects.toThrow('不会自动重跑')
    expect(t.state.allPrompts).toHaveLength(1)
    expect(t.feishu.sent).toHaveLength(0)
  })

  it('keeps lost ACK unknown across a new host instance and never repeats the model or POST', async () => {
    const t = setup()
    const e = t.start(t.add())
    const original = t.feishu.sendToChat.bind(t.feishu)
    const send = vi.spyOn(t.feishu, 'sendToChat').mockImplementation(async (...args) => {
      await original(...args)
      throw new Error('synthetic remote accepted the digest but ACK was lost')
    })
    await expect(t.orchestrator.runRoutine(e.routine, { occurrence: e.occurrence })).rejects.toMatchObject({ code: 'unknown' })
    const reopened = new Registry(t.path)
    try {
      const restarted = new Orchestrator({ ...t.deps, registry: reopened, routines: new RoutineStore(reopened.db), ...spaceDeps(reopened.db) })
      await expect(restarted.runRoutine(e.routine, { occurrence: e.occurrence })).rejects.toMatchObject({ code: 'unknown' })
      expect(reopened.db.prepare('SELECT status FROM deliveries').all()).toEqual([{ status: 'unknown' }])
    } finally { reopened.close() }
    expect(send).toHaveBeenCalledTimes(1)
    expect(t.state.allPrompts).toHaveLength(1)
    expect(t.feishu.sent).toHaveLength(1)
    expect(t.feishu.of('replyText')).toHaveLength(0)
  })

  it('stays silent for NOTHING; an unowned routine can read but cannot invent a publishing identity', async () => {
    const t = setup()
    const orphan = t.add({ ownerOpenId: undefined })
    t.state.script = [{ kind: 'text', text: 'NOTHING' }]
    expect(await t.orchestrator.runRoutine(orphan, { manualMessageId: 'om_readonly_nothing' })).toBe('skipped')
    t.state.script = [{ kind: 'text', text: BODY }]
    await expect(t.orchestrator.runRoutine(orphan, { manualMessageId: 'om_readonly_body' })).rejects.toThrow('无主职责缺少发布身份')
    expect(t.feishu.sent).toHaveLength(0)
    expect(t.records()).toHaveLength(0)
  })
})
