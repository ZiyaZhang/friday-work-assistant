import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AcpRuntime } from '../src/acp/runtime.js'
import { loadConfig } from '../src/config.js'
import { ChannelMemory } from '../src/core/memory.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { RoutineStore } from '../src/core/routines.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { createFakeAgent } from './helpers/fake-agent.js'
import { asFeishuClient, FakeFeishu } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const log = createLogger('test', 'error')

function setup(mode: 'safe' | 'auto' | 'deny' = 'safe') {
  const home = mkdtempSync(join(tmpdir(), 'friday-card-auth-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 'b', FRIDAY_HOME: home, FRIDAY_TRUSTED_USERS: 'ou_trusted', FRIDAY_PERMISSION_TIMEOUT_MS: '2000' } as NodeJS.ProcessEnv)
  const registry = new Registry(':memory:')
  const routines = new RoutineStore(registry.db)
  const sp = spaceDeps(registry.db, { mode, admins: ['ou_trusted', 'ou_other_owner'] })
  const group = sp.spaces.ensure({ kind: 'group', chatId: 'oc_g', openId: 'ou_alice' })
  sp.spaces.addMember(group.id, 'ou_bob', 'member')
  sp.spaces.ensure({ kind: 'group', chatId: 'oc_other', openId: 'ou_other_owner' })
  const dm = sp.spaces.ensure({ kind: 'p2p', chatId: 'oc_dm', openId: 'ou_alice' })
  const feishu = new FakeFeishu()
  const { app } = createFakeAgent()
  const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: app }, onPermission: async () => ({ outcome: { outcome: 'cancelled' } }), log })
  const orchestrator = new Orchestrator({ cfg, registry, routines, ...sp, memory: new ChannelMemory(registry.db), feishu: asFeishuClient(feishu), runtime, tokens: new TokenIssuer('test'), apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', botOpenId: 'ou_bot', log })
  return { cfg, registry, routines, ...sp, feishu, orchestrator, group, dm }
}

async function approval(t: ReturnType<typeof setup>, requesterOpenId?: string) {
  t.registry.createSession({ sessionKey: 'approval', chatId: 'oc_g', chatType: 'group', cwd: t.cfg.workspace.root, requesterOpenId, rootMessageId: 'om_root' })
  const result = t.orchestrator.confirmAction({ sessionKey: 'approval', header: '确认', headline: '执行合成测试操作' })
  for (let tries = 0; tries < 100 && t.orchestrator.pendingPermissionCount() === 0; tries++) await new Promise((resolve) => setTimeout(resolve, 5))
  const card = t.feishu.sent.find((s) => JSON.stringify(s.payload).includes('"action":"perm"'))
  const requestId = JSON.stringify(card?.payload).match(/"request_id":"([^"]+)"/)?.[1]
  expect(requestId).toBeTruthy()
  expect(t.orchestrator.pendingPermissionCount()).toBe(1)
  return { requestId: requestId!, result }
}

describe.each(['allow', 'deny'] as const)('permission card %s authorization', (decision) => {
  it.each([undefined, '', '   ', 'ou_bob', 'ou_other_owner'] as const)('rejects an unauthorized real operator %s without resolving the request', async (operatorOpenId) => {
    const t = setup()
    const request = await approval(t, 'ou_alice')
    const result = await t.orchestrator.handleCardAction({ value: { action: 'perm', request_id: request.requestId, decision, operatorOpenId: 'ou_alice' }, operatorOpenId, raw: {} })
    expect(result).toMatchObject({ toast: { type: 'error' } })
    expect(t.orchestrator.pendingPermissionCount()).toBe(1)
    expect(t.feishu.of('patchCard')).toHaveLength(0)
    await t.orchestrator.handleCardAction({ value: { action: 'perm', request_id: request.requestId, decision: 'deny' }, operatorOpenId: 'ou_alice', raw: {} })
    expect(await request.result).toBe(false)
  })

  it.each(['ou_alice', 'ou_trusted'])('allows the requester or explicitly trusted approver %s', async (operatorOpenId) => {
    const t = setup()
    const request = await approval(t, 'ou_alice')
    const result = await t.orchestrator.handleCardAction({ value: { action: 'perm', request_id: request.requestId, decision }, operatorOpenId, raw: {} })
    expect(result).toMatchObject({ toast: { type: 'success' } })
    expect(await request.result).toBe(decision === 'allow')
    expect(t.orchestrator.pendingPermissionCount()).toBe(0)
  })

  it('does not treat a missing stored requester as permission for any member', async () => {
    const t = setup()
    const request = await approval(t)
    const result = await t.orchestrator.handleCardAction({ value: { action: 'perm', request_id: request.requestId, decision }, operatorOpenId: 'ou_alice', raw: {} })
    expect(result).toMatchObject({ toast: { type: 'error' } })
    expect(t.orchestrator.pendingPermissionCount()).toBe(1)
    await t.orchestrator.handleCardAction({ value: { action: 'perm', request_id: request.requestId, decision }, operatorOpenId: 'ou_trusted', raw: {} })
    expect(await request.result).toBe(decision === 'allow')
  })
})

describe.each(['accept', 'ignore'] as const)('responsibility card %s authorization', (decision) => {
  it.each(['group', 'p2p'] as const)('allows only the real %s owner and records the clicked identity', async (chatType) => {
    const t = setup()
    const space = chatType === 'group' ? t.group : t.dm
    // Production proposals intentionally have no owner / runAs before acceptance.
    const r = t.routines.add({ kind: 'schedule', spaceId: space.id, chatId: space.chatId!, chatType, name: '合成提案', prompt: '合成测试', schedule: { type: 'interval', everyMinutes: 10 }, source: 'model' })
    t.routines.setCardMessageId(r.id, 'om_proposal')
    const result = await t.orchestrator.handleCardAction({ value: { action: 'resp', id: r.id, decision, v: t.routines.configVersion(r.id) }, operatorOpenId: 'ou_alice', chatId: space.chatId!, messageId: 'om_proposal', raw: {} })
    expect(result).toMatchObject({ toast: { type: 'success' } })
    expect(t.routines.get(r.id)).toMatchObject({ status: decision === 'accept' ? 'active' : 'ignored', decidedBy: 'ou_alice', runAs: decision === 'accept' ? 'ou_alice' : null })
    expect(t.feishu.of('patchCard')).toHaveLength(1)
    // 回调响应里带按当前行渲染的决定后卡片（飞书按响应更新被点的卡）；patch 仍调用一次作后备，内容与响应相同
    const card = (result as { card?: { type: string; data: Record<string, unknown> } }).card
    expect(card).toMatchObject({ type: 'raw', data: { header: { title: { content: decision === 'accept' ? '已接受' : '已忽略' }, template: decision === 'accept' ? 'green' : 'grey' } } })
    expect(JSON.stringify(card?.data)).not.toContain('"tag":"button"')
    expect(t.feishu.of('patchCard')[0]).toMatchObject({ target: 'om_proposal' })
    expect(t.feishu.of('patchCard')[0]?.payload).toEqual(card?.data)
  })

  it.each(['group', 'p2p'] as const)('rejects members, unrelated owners, trusted admins and missing actors in %s', async (chatType) => {
    const t = setup('auto')
    const space = chatType === 'group' ? t.group : t.dm
    const r = t.routines.add({ kind: 'schedule', spaceId: space.id, chatId: space.chatId!, chatType, name: '合成提案', prompt: '合成测试', schedule: { type: 'interval', everyMinutes: 10 }, source: 'model' })
    t.routines.setCardMessageId(r.id, 'om_proposal')
    for (const operatorOpenId of ['ou_bob', 'ou_other_owner', 'ou_trusted', undefined, '', '   ']) {
      const result = await t.orchestrator.handleCardAction({ value: { action: 'resp', id: r.id, decision, operatorOpenId: 'ou_alice', v: t.routines.configVersion(r.id) }, operatorOpenId, chatId: space.chatId!, messageId: 'om_proposal', raw: {} })
      expect(result).toMatchObject({ toast: { type: 'error' } })
      expect(result).not.toHaveProperty('card')
      expect(t.routines.get(r.id)).toMatchObject({ status: 'proposed', decidedBy: null, runAs: null })
      expect(t.feishu.of('patchCard')).toHaveLength(0)
    }
  })

  it.each(['missing-space', 'wrong-kind', 'archived', 'rebound', 'revoked', 'deployment-deny'] as const)('rejects the original owner when authorization is %s', async (state) => {
    const t = setup(state === 'deployment-deny' ? 'deny' : 'safe')
    const r = t.routines.add({ kind: 'schedule', spaceId: state === 'missing-space' ? undefined : t.group.id, chatId: 'oc_g', chatType: state === 'wrong-kind' ? 'p2p' : 'group', name: '合成提案', prompt: '合成测试', schedule: { type: 'interval', everyMinutes: 10 }, source: 'model' })
    if (state === 'archived') t.spaces.archive(t.group.id)
    if (state === 'rebound') t.spaces.rebind(t.group.id, 'oc_rebound')
    if (state === 'revoked') t.spaces.removeMember(t.group.id, 'ou_alice')
    const result = await t.orchestrator.handleCardAction({ value: { action: 'resp', id: r.id, decision, v: t.routines.configVersion(r.id) }, operatorOpenId: 'ou_alice', chatId: 'oc_g', raw: {} })
    expect(result).toMatchObject({ toast: { type: 'error' } })
    expect(result).not.toHaveProperty('card')
    expect(t.routines.get(r.id)).toMatchObject({ status: 'proposed', decidedBy: null, runAs: null })
    expect(t.feishu.of('patchCard')).toHaveLength(0)
  })
})

describe('改代码要群负责人点头', () => {
  async function askOwnerApproval(t: ReturnType<typeof setup>, requesterOpenId: string) {
    t.registry.createSession({ sessionKey: 'pr', chatId: 'oc_g', chatType: 'group', cwd: t.cfg.workspace.root, requesterOpenId, rootMessageId: 'om_root' })
    const result = t.orchestrator.confirmAction({ sessionKey: 'pr', header: '需要你确认：开 draft PR', headline: 'owner/repo ← fix', approver: 'space_owner' })
    for (let tries = 0; tries < 100 && t.orchestrator.pendingPermissionCount() === 0; tries++) await new Promise((r) => setTimeout(r, 5))
    const card = t.feishu.sent.find((s) => JSON.stringify(s.payload).includes('"action":"perm"'))
    const requestId = JSON.stringify(card?.payload).match(/"request_id":"([^"]+)"/)?.[1]
    return { requestId: requestId!, result, card }
  }

  it('普通成员要开 PR 时，卡片 @ 群负责人，且只有他能点', async () => {
    const t = setup()
    // ou_alice 是把机器人拉进群的人（空间负责人），ou_bob 是普通成员
    const req = await askOwnerApproval(t, 'ou_bob')
    // JSON.stringify 会把引号转义，所以按转义后的形态断言
    expect(JSON.stringify(req.card?.payload)).toContain('<at id=\\"ou_alice\\">')

    // 发起人自己点不动——这正是"改别人的东西要别人点头"的意思
    const bySelf = await t.orchestrator.handleCardAction({ value: { action: 'perm', request_id: req.requestId, decision: 'allow' }, operatorOpenId: 'ou_bob', raw: {} })
    expect(bySelf).toMatchObject({ toast: { type: 'error' } })
    expect(t.orchestrator.pendingPermissionCount()).toBe(1)

    await t.orchestrator.handleCardAction({ value: { action: 'perm', request_id: req.requestId, decision: 'allow' }, operatorOpenId: 'ou_alice', raw: {} })
    expect(await req.result).toBe(true)
  })

  it('发起人本来就是负责人时不折腾他，自己点就行', async () => {
    const t = setup()
    const req = await askOwnerApproval(t, 'ou_alice')
    expect(JSON.stringify(req.card?.payload)).not.toContain('<at id=')
    await t.orchestrator.handleCardAction({ value: { action: 'perm', request_id: req.requestId, decision: 'allow' }, operatorOpenId: 'ou_alice', raw: {} })
    expect(await req.result).toBe(true)
  })

  it('私聊里没有第二个人，照原样发给本人', async () => {
    const t = setup()
    t.registry.createSession({ sessionKey: 'pr-dm', chatId: 'oc_dm', chatType: 'p2p', cwd: t.cfg.workspace.root, requesterOpenId: 'ou_alice' })
    const result = t.orchestrator.confirmAction({ sessionKey: 'pr-dm', header: '确认', headline: '开 PR', approver: 'space_owner' })
    for (let tries = 0; tries < 100 && t.orchestrator.pendingPermissionCount() === 0; tries++) await new Promise((r) => setTimeout(r, 5))
    const card = t.feishu.sent.find((s) => JSON.stringify(s.payload).includes('"action":"perm"'))
    const requestId = JSON.stringify(card?.payload).match(/"request_id":"([^"]+)"/)?.[1]
    expect(JSON.stringify(card?.payload)).not.toContain('<at id=')
    await t.orchestrator.handleCardAction({ value: { action: 'perm', request_id: requestId!, decision: 'allow' }, operatorOpenId: 'ou_alice', raw: {} })
    expect(await result).toBe(true)
  })
})
