import { SkillApplication } from '../src/core/skill-application.js'
import { DeliveryService } from '../src/core/delivery.js'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
import { SkillProposals, renderSkillMd } from '../src/core/skills.js'
import { Todos } from '../src/core/todos.js'
import { createInternalApi } from '../src/internal/api.js'
import { ALL_SCOPES, GROUP_SCOPES, TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { createFakeAgent } from './helpers/fake-agent.js'
import { FakeFeishu, asFeishuClient, cardText } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const log = createLogger('test', 'error')
const BODY = '# 翻群找旧资料\n\n1. 先 feishu_find_files 按发言人和文件名筛\n2. 再 feishu_get_message_file 下载\n3. 读文件后给出带背景的清单\n\n注意：分片拉取避开 500 条截断。'

async function setup(policy: { mode?: 'safe' | 'auto' | 'deny'; admins?: string[] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'friday-skills-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 'b', FRIDAY_HOME: home, FRIDAY_PROMPT_TIMEOUT_MS: '5000' } as NodeJS.ProcessEnv)
  mkdirSync(cfg.workspace.root, { recursive: true })
  const registry = new Registry(':memory:')
  const memory = new ChannelMemory(registry.db)
  const messageCache = new MessageCache(registry.db)
  const todos = new Todos(registry.db)
  const skillsDir = join(home, 'dsh', 'skills')
  const skills = new SkillProposals(registry.db, new Set(['feishu-history-dig']))
  const feishu = new FakeFeishu()
  feishu.names.set('ou_alice', '张三')
  const messages = new MessageService(asFeishuClient(feishu), messageCache, log)
  const tokens = new TokenIssuer('s')
  const sp = spaceDeps(registry.db, policy)
  const groupSpace = sp.spaces.ensure({ kind: 'group', chatId: 'oc_g', openId: 'ou_alice' })
  sp.spaces.addMember(groupSpace.id, 'ou_bob', 'member')
  sp.spaces.ensure({ kind: 'group', chatId: 'oc_other', openId: 'ou_other_owner' })
  const dmSpace = sp.spaces.ensure({ kind: 'p2p', chatId: 'oc_dm', openId: 'ou_alice' })

  const { app } = createFakeAgent()
  let orchestrator!: Orchestrator
  const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: app }, onPermission: (req, signal) => orchestrator.handlePermission(req, signal), log })
  orchestrator = new Orchestrator({ cfg, feishu: asFeishuClient(feishu), runtime, registry, memory, messages, skills, ...sp, tokens, apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', botOpenId: 'ou_bot', log })
  // 一个群会话（有话题根消息）和一个私聊会话
  const cwd = join(cfg.workspace.root, 'chats', 'oc_g')
  mkdirSync(join(cwd, 'downloads'), { recursive: true })
  registry.createSession({ sessionKey: 'msg:om_root', chatId: 'oc_g', chatType: 'group', cwd, requesterOpenId: 'ou_alice', rootMessageId: 'om_root' })
  const dmCwd = join(cfg.workspace.root, 'dm', 'ou_alice')
  mkdirSync(dmCwd, { recursive: true })
  registry.createSession({ sessionKey: 'dm:ou_alice', chatId: 'oc_dm', chatType: 'p2p', cwd: dmCwd, requesterOpenId: 'ou_alice' })
  const groupCap = { sessionKey: 'msg:om_root', chatId: 'oc_g', chatType: 'group' as const, requesterOpenId: 'ou_alice', cwd, scopes: [...GROUP_SCOPES], exp: 0, spaceId: groupSpace.id, runId: 'group-run', originRunId: 'group-run' }
  const dmCap = { sessionKey: 'dm:ou_alice', chatId: 'oc_dm', chatType: 'p2p' as const, requesterOpenId: 'ou_alice', cwd: dmCwd, scopes: [...ALL_SCOPES], exp: 0, spaceId: dmSpace.id, runId: 'dm-run', originRunId: 'dm-run' }
  const application = new SkillApplication(registry.db, { skills, ...sp, userName: id => feishu.userName(id), stopRuns: () => [],
    resolveRun: ref => {
      const cap = [groupCap, dmCap].find(c => c.runId === ref.runId && c.sessionKey === ref.sessionKey)
      return cap ? { ...ref, ...cap } : undefined
    },
    deliveryFor: (_ref, proposal) => new DeliveryService(registry.db, { ...sp,
      resolveContext: async () => ({ actorOpenId: proposal.proposerOpenId!, provenanceComplete: true, expiresAt: Date.now() + 60_000,
        sources: [{ ref: `proposal:${proposal.id}`, spaceId: proposal.spaceId!, chatId: proposal.chatId }],
        audience: proposal.chatType === 'p2p' ? { kind: 'dm', spaceId: proposal.spaceId!, openId: proposal.proposerOpenId! }
          : { kind: 'group', spaceId: proposal.spaceId!, chatId: proposal.chatId, replyToMessageId: 'om_root' } }),
      send: async ({ audience, payload }) => ({ remoteId: audience.kind === 'dm' ? await feishu.sendToUser(audience.openId, payload)
        : 'text' in payload ? (await feishu.replyText(audience.replyToMessageId!, payload.text, false)).messageId
          : (await feishu.replyCard(audience.replyToMessageId!, 'card' in payload ? payload.card : {}, false)).messageId }),
    }) })
  const api = createInternalApi({ feishu: asFeishuClient(feishu), memory, registry, messages, messageCache, todos, skills, ...sp, tokens, log, maxHistoryPerCall: 50,
    proposeSkill: (sessionKey, runId, input) => application.propose({ sessionKey, runId }, input) })
  const decide = (id: number, decision: 'accept' | 'ignore', operatorOpenId?: string) => {
    const p = skills.get(id)!
    return orchestrator.handleCardAction({ value: { action: 'skill', id, decision, contentDigest: p.contentDigest },
      operatorOpenId, chatId: p.chatId, messageId: p.cardMessageId ?? undefined, raw: {} })
  }
  return { cfg, feishu, skills, skillsDir, orchestrator, api, decide, groupCap, dmCap, cwd, dmCwd, ...sp, groupSpace, dmSpace }
}

describe('skill proposals', () => {
  it.each([
    ['true', 'Triage: preserve # links and "quotes"'],
    ['null', '# leading comment is part of the description'],
    ['123', 'false'],
    ['valid-name', ' 多行\n含冒号: 值\\路径 '],
  ])('installs %s with string metadata that cannot become YAML types or comments', async (name, description) => {
    const t = await setup()
    const result = await t.api.routes['POST /v1/skill/propose']!(t.dmCap, { name, description, body: BODY }) as { id: number }
    await t.decide(result.id, 'accept', 'ou_alice')
    const installed = renderSkillMd(t.skills.get(result.id)!)
    expect(existsSync(join(t.skillsDir, name, 'SKILL.md'))).toBe(false)
    // Generated scalars deliberately use JSON's double-quoted subset of YAML, so no implicit typing is possible.
    const [, nameLine, descriptionLine] = installed.split('\n')
    expect(JSON.parse(nameLine!.slice('name: '.length))).toBe(name)
    expect(JSON.parse(descriptionLine!.slice('description: '.length))).toBe(description.replace(/\s+/g, ' ').trim())
    expect(installed.slice(installed.indexOf('\n---\n') + 5).trim()).toBe(BODY)
    expect(t.skills.get(result.id)?.status).toBe('accepted')
  })

  it('renders SKILL.md with frontmatter and validates names', () => {
    expect(renderSkillMd({ name: 'x-y', description: ' 多行\n描述 ', body: 'body\n' })).toBe('---\nname: "x-y"\ndescription: "多行 描述"\n---\n\nbody\n')
    const s = new SkillProposals(new Registry(':memory:').db, new Set(['builtin']))
    expect(s.validate({ name: 'Bad Name', description: 'd'.repeat(20), body: BODY })).toMatch(/skill 名/)
    expect(s.validate({ name: 'builtin', description: 'd'.repeat(20), body: BODY })).toMatch(/内置/)
    expect(s.validate({ name: 'ok-name', description: 'd'.repeat(20), body: 'short' })).toMatch(/80/)
    expect(s.validate({ name: 'ok-name', description: 'd'.repeat(20), body: BODY })).toBeUndefined()
    for (const name of ['trailing-', 'two--hyphens', '-leading', 'a'.repeat(50)]) {
      expect(s.validate({ name, description: 'valid description', body: BODY })).toMatch(/skill 名/)
    }
    for (const name of ['true', 'null', '123', 'a'.repeat(49)]) {
      expect(s.validate({ name, description: 'valid description', body: BODY })).toBeUndefined()
    }
  })

  it('proposes via the API, posts a card in the topic, installs on accept, and ignores the second click', async () => {
    const t = await setup()
    const r = (await t.api.routes['POST /v1/skill/propose']!(t.groupCap, { name: 'feishu-group-history-dig', description: '翻飞书群/私聊历史找旧资料的标准流程', body: BODY })) as { id: number }
    const card = t.feishu.of('replyCard')[0]
    expect(card?.target).toBe('om_root')
    expect(cardText(card?.payload as Record<string, unknown>)).toContain('新提议')
    expect(JSON.stringify(card?.payload)).toContain('feishu-group-history-dig')
    expect(existsSync(join(t.skillsDir, 'feishu-group-history-dig', 'SKILL.md'))).toBe(false)

    const res = await t.decide(r.id, 'accept', 'ou_alice')
    expect(JSON.stringify(res)).toContain('已为本空间启用')
    const file = renderSkillMd(t.skills.get(r.id)!)
    expect(t.skills.isInstalled(t.groupSpace.id, 'feishu-group-history-dig')).toBe(true)
    expect(file.startsWith('---\nname: "feishu-group-history-dig"\n')).toBe(true)
    expect(file).toContain('分片拉取')
    expect(t.skills.get(r.id)?.status).toBe('accepted')
    // 卡片原地更新为已接受
    const patched = t.feishu.of('patchCard').at(-1)
    expect(cardText(patched?.payload as Record<string, unknown>)).toContain('已接受')
    // 回调响应里是已接受的卡：绿色标题、没有按钮、带版本；SkillApplication 的 patch 仍调用一次，内容与响应相同
    const decided = (res as { card?: { type: string; data: Record<string, unknown> } }).card
    expect(decided).toMatchObject({ type: 'raw', data: { header: { title: { content: '已接受' }, template: 'green' } } })
    expect(JSON.stringify(decided?.data)).not.toContain('"tag":"button"')
    expect(cardText(decided?.data)).toContain(`版本：\`${t.skills.get(r.id)!.contentDigest!.slice(0, 12)}\``)
    expect(t.feishu.of('patchCard')).toHaveLength(1)
    expect(patched?.payload).toEqual(decided?.data)
    // 再点一次
    const again = await t.decide(r.id, 'ignore', 'ou_alice')
    expect(JSON.stringify(again)).toContain('已经处理过了')
    // 已处理过：响应里仍是已接受的卡，不回到带按钮的样子；不再 patch
    expect((again as { card?: { data: Record<string, unknown> } }).card?.data).toEqual(decided?.data)
    expect(t.feishu.of('patchCard')).toHaveLength(1)
    // 内置 skill 不能被覆盖
    await expect(t.api.routes['POST /v1/skill/propose']!(t.groupCap, { name: 'feishu-history-dig', description: '覆盖内置的尝试 xxxxxx', body: BODY })).rejects.toThrow(/内置/)
  })

  it('private proposals can only be decided by the proposer; ignore does not install', async () => {
    const t = await setup()
    const r = (await t.api.routes['POST /v1/skill/propose']!(t.dmCap, { name: 'my-private-flow', description: '私聊里沉淀的流程，只有本人能决定', body: BODY })) as { id: number }
    expect(t.feishu.of('sendToUser')).toHaveLength(2)
    const other = await t.decide(r.id, 'accept', 'ou_bob')
    expect(JSON.stringify(other)).toContain('只有本人')
    expect(other).not.toHaveProperty('card')
    const mine = await t.decide(r.id, 'ignore', 'ou_alice')
    expect(JSON.stringify(mine)).toContain('已忽略')
    expect(mine).toMatchObject({ card: { type: 'raw', data: { header: { title: { content: '已忽略' }, template: 'grey' } } } })
    expect(JSON.stringify((mine as { card?: unknown }).card)).not.toContain('"tag":"button"')
    expect(existsSync(join(t.skillsDir, 'my-private-flow'))).toBe(false)
    expect(t.skills.get(r.id)?.status).toBe('ignored')
  })

  describe.each(['accept', 'ignore'] as const)('skill card %s authorization', (decision) => {
    it.each([
      ['ordinary member', 'ou_bob'],
      ['owner of another space', 'ou_other_owner'],
      ['unknown operator', undefined],
      ['empty operator', ''],
      ['blank operator', '   '],
    ] as const)('rejects a group card from %s without installing or changing the card', async (_label, operatorOpenId) => {
      const t = await setup({ mode: 'auto', admins: ['ou_other_owner'] })
      const p = t.skills.propose({ name: 'group-boundary', description: 'group skill', body: BODY, ...t.groupCap })
      t.skills.setCard(p.id, 'om_group_card')

      const result = await t.decide(p.id, decision, operatorOpenId)

      expect(result).toMatchObject({ toast: { type: 'error' } })
      expect(result).not.toHaveProperty('card')
      expect(t.skills.get(p.id)).toMatchObject({ status: 'pending', decidedBy: null, installedPath: null })
      expect(existsSync(join(t.skillsDir, p.name, 'SKILL.md'))).toBe(false)
      expect(t.feishu.of('patchCard')).toHaveLength(0)
      expect(t.feishu.calls.userName).toBe(0)
    })

    it.each(['group', 'p2p'] as const)('allows the real %s owner', async (chatType) => {
      const t = await setup()
      const cap = chatType === 'group' ? t.groupCap : t.dmCap
      const p = await t.api.routes['POST /v1/skill/propose']!(cap, { name: 'allowed-skill', description: 'owned skill', body: BODY }) as { id: number; name: string }

      const result = await t.decide(p.id, decision, 'ou_alice')

      expect(result).toMatchObject({ toast: { type: 'success' } })
      expect(t.skills.get(p.id)).toMatchObject({ status: decision === 'accept' ? 'accepted' : 'ignored', decidedBy: '张三' })
      expect(t.skills.isInstalled(cap.spaceId, p.name)).toBe(decision === 'accept')
      expect(existsSync(join(t.skillsDir, p.name, 'SKILL.md'))).toBe(false)
      expect(t.feishu.of('patchCard')).toHaveLength(1)
      expect(result).toMatchObject({ card: { type: 'raw', data: { header: { title: { content: decision === 'accept' ? '已接受' : '已忽略' }, template: decision === 'accept' ? 'green' : 'grey' } } } })
      expect(JSON.stringify((result as { card?: unknown }).card)).not.toContain('"tag":"button"')
      expect(t.feishu.of('patchCard')[0]?.payload).toEqual((result as { card?: { data: unknown } }).card?.data)
    })

    it.each(['ou_bob', undefined, ''] as const)('rejects a DM card without its real owner: %s', async (operatorOpenId) => {
      const t = await setup({ mode: 'auto', admins: ['ou_bob'] })
      const p = t.skills.propose({ name: 'private-boundary', description: 'private skill', body: BODY, ...t.dmCap, proposerOpenId: 'ou_alice' })

      const result = await t.decide(p.id, decision, operatorOpenId)

      expect(result).toMatchObject({ toast: { type: 'error' } })
      expect(result).not.toHaveProperty('card')
      expect(t.skills.get(p.id)?.status).toBe('pending')
      expect(existsSync(join(t.skillsDir, p.name))).toBe(false)
    })

    it('rejects a DM proposal without a recorded owner instead of using the session requester', async () => {
      const t = await setup()
      const p = t.skills.propose({ name: 'ownerless-private', description: 'missing owner', body: BODY, ...t.dmCap })

      const result = await t.decide(p.id, decision, 'ou_alice')

      expect(result).toMatchObject({ toast: { type: 'error' } })
      expect(result).not.toHaveProperty('card')
      expect(t.skills.get(p.id)?.status).toBe('pending')
      expect(existsSync(join(t.skillsDir, p.name))).toBe(false)
    })

    it.each(['archived', 'rebound', 'revoked', 'deployment-deny'] as const)('rejects the original group owner when authorization is %s', async (state) => {
      const t = await setup({ mode: state === 'deployment-deny' ? 'deny' : 'safe' })
      const p = t.skills.propose({ name: 'stale-group', description: 'stale group', body: BODY, ...t.groupCap })
      if (state === 'archived') t.spaces.archive(t.groupSpace.id)
      if (state === 'rebound') t.spaces.rebind(t.groupSpace.id, 'oc_new')
      if (state === 'revoked') t.spaces.removeMember(t.groupSpace.id, 'ou_alice')

      const result = await t.decide(p.id, decision, 'ou_alice')

      expect(result).toMatchObject({ toast: { type: 'error' } })
      expect(result).not.toHaveProperty('card')
      expect(t.skills.get(p.id)?.status).toBe('pending')
      expect(existsSync(join(t.skillsDir, p.name))).toBe(false)
    })

    it('rechecks the owner after the asynchronous display-name lookup', async () => {
      const t = await setup()
      const p = await t.api.routes['POST /v1/skill/propose']!(t.groupCap, { name: 'revoked-during-lookup', description: 'revocation race', body: BODY }) as { id: number; name: string }
      t.feishu.userName = async () => {
        t.spaces.removeMember(t.groupSpace.id, 'ou_alice')
        return '张三'
      }

      const result = await t.decide(p.id, decision, 'ou_alice')

      expect(result).toMatchObject({ toast: { type: 'error' } })
      expect(result).not.toHaveProperty('card')
      expect(t.skills.get(p.id)?.status).toBe('pending')
      expect(existsSync(join(t.skillsDir, p.name))).toBe(false)
    })
  })
})

describe('send file back', () => {
  it('refuses file delivery without a current host callback and still rejects invalid paths', async () => {
    const t = await setup()
    writeFileSync(join(t.cwd, 'downloads', '12345678-sample-skill.md'), '# sample')
    await expect(t.api.routes['POST /v1/file/send']!(t.groupCap, { path: 'downloads/12345678-sample-skill.md', note: '合成附言' })).rejects.toMatchObject({ status: 503 })
    await expect(t.api.routes['POST /v1/file/send']!(t.groupCap, { path: '../../../etc/passwd' })).rejects.toThrow(/工作区|不存在/)
    await expect(t.api.routes['POST /v1/file/send']!(t.groupCap, { path: 'downloads/nope.md' })).rejects.toThrow(/不存在/)
    writeFileSync(join(t.dmCwd, 'out.md'), '# out')
    await expect(t.api.routes['POST /v1/file/send']!(t.dmCap, { path: 'out.md', file_name: '总结.md' })).rejects.toMatchObject({ status: 503 })
    expect(t.feishu.uploads).toEqual([])
    expect(t.feishu.sent).toEqual([])
  })
})
