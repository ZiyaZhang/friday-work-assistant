import { describe, expect, it } from 'vitest'
import { categorizeTool, describeRawInput, summarizeTool } from '../src/core/permissions.js'
import { applyUpdate } from '../src/core/orchestrator.js'
import type { TaskCardState } from '../src/feishu/cards.js'

describe('permissions: tool categorization', () => {
  it('classifies by dsh tool name before ACP kind (dsh reports everything as other)', () => {
    expect(categorizeTool('bash', 'other')).toBe('execute')
    expect(categorizeTool('write', 'other')).toBe('edit')
    expect(categorizeTool('edit', 'other')).toBe('edit')
    expect(categorizeTool('read', 'other')).toBe('read')
    expect(categorizeTool('feishu_read_thread', 'other')).toBe('other')
    expect(categorizeTool('grep', undefined)).toBe('read')
    expect(categorizeTool('something', 'execute')).toBe('execute')
    expect(categorizeTool('something', 'search')).toBe('read')
    expect(categorizeTool(undefined, null)).toBe('other')
  })

  it('picks the most telling field of rawInput', () => {
    expect(describeRawInput({ command: 'ls -la', description: 'List files' })).toBe('ls -la')
    expect(describeRawInput({ file_path: '/tmp/x.md', content: 'hello' })).toBe('/tmp/x.md')
    expect(describeRawInput('plain')).toBe('plain')
    expect(describeRawInput(['git', 'status'])).toBe('git status')
    expect(describeRawInput({ foo: 1 })).toBe('{"foo":1}')
    expect(describeRawInput({})).toBeUndefined()
    expect(describeRawInput(undefined)).toBeUndefined()
  })

  it('extracts the sandbox escalation fields', () => {
    const s = summarizeTool({
      title: 'bash',
      kind: 'other',
      rawInput: { command: 'cat ~/.friday/.env', description: 'Read env file', sandbox_permissions: 'danger-full-access', justification: 'no sandbox backend on this host' },
    })
    expect(s).toEqual({
      category: 'execute',
      detail: 'cat ~/.friday/.env',
      description: 'Read env file',
      escalation: { mode: 'danger-full-access', justification: 'no sandbox backend on this host' },
    })
    expect(summarizeTool({ title: 'bash', rawInput: { command: 'ls' } }).escalation).toBeUndefined()
  })
})

describe('applyUpdate keeps rawInput details for later permission lookup', () => {
  it('records detail and escalation on tool_call and tool_call_update', () => {
    const state: TaskCardState = { title: 't', phase: 'thinking', tools: [], body: '' }
    applyUpdate(state, { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'bash', kind: 'other', status: 'in_progress', rawInput: { command: 'ls -la', description: 'List' } })
    expect(state.tools[0]).toMatchObject({ id: 'c1', title: 'bash', detail: 'ls -la', status: 'in_progress' })
    expect(state.statusLine).toBe('正在：bash ls -la')
    applyUpdate(state, { sessionUpdate: 'tool_call_update', toolCallId: 'c1', rawInput: { command: 'ls -la', sandbox_permissions: 'danger-full-access', justification: 'need it' } })
    expect(state.tools[0]?.escalation).toEqual({ mode: 'danger-full-access', justification: 'need it' })
    applyUpdate(state, { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed' })
    expect(state.tools[0]?.status).toBe('completed')
    expect(state.tools[0]?.detail).toBe('ls -la')
    // 没见过的 id 也能补一行
    applyUpdate(state, { sessionUpdate: 'tool_call_update', toolCallId: 'c2', title: 'write', status: 'in_progress', rawInput: { file_path: 'notes.md' } })
    expect(state.tools[1]).toMatchObject({ id: 'c2', title: 'write', detail: 'notes.md' })
  })
})

describe('circles（联盟）', () => {
  it('把群结成联盟，同联盟互为 mates，自己不算', async () => {
    const { Circles } = await import('../src/core/circles.js')
    const { Registry } = await import('../src/core/registry.js')
    const c = new Circles(new Registry(':memory:').db)
    expect(Circles.validate('harness')).toBeUndefined()
    expect(Circles.validate('产品-研发_1')).toBeUndefined()
    expect(Circles.validate('bad name')).toBeTruthy()
    c.join('oc_a', 'harness', 'ou_x')
    c.join('oc_b', 'harness')
    c.join('oc_c', 'other')
    expect(c.mates('oc_a')).toEqual(['oc_b'])
    expect(c.mates('oc_c')).toEqual([])
    expect(c.mates('oc_none')).toEqual([])
    c.join('oc_b', 'other') // 换联盟
    expect(c.mates('oc_a')).toEqual([])
    expect(c.members('other').sort()).toEqual(['oc_b', 'oc_c'])
    expect(c.listAll().map((x) => x.circle)).toEqual(['harness', 'other'])
    expect(c.leave('oc_c')).toBe(true)
    expect(c.leave('oc_c')).toBe(false)
  })

  it('老库里的 spaces 表自动搬成 circles', async () => {
    const { Registry } = await import('../src/core/registry.js')
    const { Circles } = await import('../src/core/circles.js')
    const db = new Registry(':memory:').db
    db.exec(`CREATE TABLE spaces (chat_id TEXT PRIMARY KEY, space TEXT NOT NULL, added_by TEXT, added_at INTEGER NOT NULL)`)
    db.prepare('INSERT INTO spaces VALUES (?, ?, ?, ?)').run('oc_a', 'harness', 'ou_x', 1)
    const c = new Circles(db)
    expect(c.circleOf('oc_a')).toBe('harness')
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name='spaces'`).get()).toBeUndefined()
  })
})

describe('spaces（空间）与 policy', () => {
  it('群空间 id 与 chat 解耦，换绑带走配置和成员', async () => {
    const { Registry } = await import('../src/core/registry.js')
    const { Spaces, dmSpaceId, spaceScope } = await import('../src/core/space.js')
    const s = new Spaces(new Registry(':memory:').db)
    const g = s.ensure({ kind: 'group', chatId: 'oc_a', openId: 'ou_owner', title: '小群' })
    expect(g.id).toMatch(/^sp_[0-9a-f]{8}$/)
    expect(s.roleOf(g.id, 'ou_owner')).toBe('owner')
    s.touchMember(g.id, 'ou_bob')
    expect(s.roleOf(g.id, 'ou_bob')).toBe('member')
    s.touchMember(g.id, 'ou_owner') // 说句话不该把负责人降级
    expect(s.roleOf(g.id, 'ou_owner')).toBe('owner')
    s.patchConfig(g.id, { brevity: 'short', proactive: { enabled: true } })
    s.patchConfig(g.id, { proactive: { maxPerHour: 3 } }) // 深合并一层
    s.addNote(g.id, '攒一批再处理')
    // 换绑：同一个空间挪到别的群，id 不变
    const moved = s.rebind(g.id, 'oc_real')
    expect(moved?.id).toBe(g.id)
    expect(s.byChat('oc_real')?.config).toEqual({ brevity: 'short', proactive: { enabled: true, maxPerHour: 3 }, notes: ['攒一批再处理'] })
    expect(s.byChat('oc_a')).toBeUndefined()
    // 目标群已经有空间时不许覆盖
    s.ensure({ kind: 'group', chatId: 'oc_other' })
    expect(() => s.rebind(g.id, 'oc_other')).toThrow()
    // 私聊空间由人决定，换 chat 也是同一个
    const dm = s.ensure({ kind: 'p2p', chatId: 'oc_dm', openId: 'ou_alice' })
    expect(dm.id).toBe(dmSpaceId('ou_alice'))
    expect(s.ensure({ kind: 'p2p', chatId: 'oc_dm2', openId: 'ou_alice' }).id).toBe(dm.id)
    expect(spaceScope(dm.id)).toBe(`space:${dm.id}`)
  })

  it('六类动作按角色判定：成员执行要确认，晋升企业层只有管理员', async () => {
    const { Registry } = await import('../src/core/registry.js')
    const { Spaces } = await import('../src/core/space.js')
    const { PolicyService } = await import('../src/core/policy.js')
    const s = new Spaces(new Registry(':memory:').db)
    const sp = s.ensure({ kind: 'group', chatId: 'oc_a', openId: 'ou_owner' })
    s.touchMember(sp.id, 'ou_bob')
    const p = new PolicyService(s, { admins: ['ou_admin'] })
    const d = (openId: string | undefined, action: Parameters<typeof p.decide>[0]['action'], target?: Parameters<typeof p.decide>[0]['target']) => p.decide({ spaceId: sp.id, openId, action, target }).decision
    expect(p.actorOf(sp.id, 'ou_admin')).toBe('admin')
    expect(p.actorOf(sp.id, 'ou_owner')).toBe('owner')
    expect(p.actorOf(sp.id, 'ou_bob')).toBe('member')
    expect(p.actorOf(sp.id, 'ou_stranger')).toBe('outsider')
    expect(d('ou_bob', 'read')).toBe('allow')
    expect(d('ou_stranger', 'read')).toBe('deny')
    expect(d('ou_bob', 'act')).toBe('ask')
    expect(d('ou_bob', 'act', 'repository-proposal')).toBe('allow')
    expect(d('ou_stranger', 'act', 'repository-proposal')).toBe('deny')
    expect(d('ou_owner', 'act')).toBe('allow')
    expect(d('ou_bob', 'publish', 'here')).toBe('allow')
    expect(d('ou_bob', 'publish', 'cross-space')).toBe('ask')
    expect(d('ou_owner', 'promote', 'circle')).toBe('allow')
    expect(d('ou_owner', 'promote', 'org')).toBe('deny')
    expect(d('ou_admin', 'promote', 'org')).toBe('allow')
    expect(d('ou_bob', 'configure')).toBe('deny')
    expect(d('ou_owner', 'configure')).toBe('allow')
    // 部署级 deny 一票否决，auto 也不放行晋升
    const denied = new PolicyService(s, { admins: ['ou_admin'], mode: 'deny' })
    expect(denied.decide({ spaceId: sp.id, openId: 'ou_admin', action: 'read' }).decision).toBe('deny')
    expect(denied.decide({ spaceId: sp.id, openId: 'ou_bob', action: 'act', target: 'repository-proposal' }).decision).toBe('deny')
    const auto = new PolicyService(s, { admins: [], mode: 'auto' })
    expect(auto.decide({ spaceId: sp.id, openId: 'ou_bob', action: 'act' }).decision).toBe('allow')
    expect(auto.decide({ spaceId: sp.id, openId: 'ou_bob', action: 'promote', target: 'org' }).decision).toBe('deny')
  })

  it('迁移把 chat: / user: / 老 space: 作用域搬到空间上', async () => {
    const { Registry } = await import('../src/core/registry.js')
    const { ChannelMemory } = await import('../src/core/memory.js')
    const { Todos } = await import('../src/core/todos.js')
    const { Spaces, dmSpaceId, spaceScope } = await import('../src/core/space.js')
    const { migrateScopesToSpaces } = await import('../src/core/migrate.js')
    const db = new Registry(':memory:').db
    const memory = new ChannelMemory(db)
    const todos = new Todos(db)
    memory.add({ scope: 'chat:oc_a', kind: 'fact', title: '群里的事', body: 'x' })
    memory.add({ scope: 'user:ou_alice', kind: 'fact', title: '她的事', body: 'x' })
    memory.add({ scope: 'space:harness', kind: 'fact', title: '联盟的事', body: 'x' })
    memory.add({ scope: 'org', kind: 'fact', title: '公司的事', body: 'x' })
    todos.add({ scope: 'chat:oc_a', title: '交周报', createdBy: 'ou_alice' })
    const spaces = new Spaces(db)
    const report = migrateScopesToSpaces(db, spaces)
    expect(report).toMatchObject({ circles: 1, chats: 1, users: 1 })
    const groupId = spaces.byChat('oc_a')!.id
    expect(memory.count(spaceScope(groupId))).toBe(1)
    expect(memory.count(spaceScope(dmSpaceId('ou_alice')))).toBe(1)
    expect(memory.count('circle:harness')).toBe(1)
    expect(memory.count('org')).toBe(1)
    expect(todos.list(spaceScope(groupId), {})).toHaveLength(1)
    // 迁移来的群空间没有负责人，等第一个说话的人接管
    expect(spaces.owners(groupId)).toEqual([])
    // 私聊空间的负责人天然是本人
    expect(spaces.owners(dmSpaceId('ou_alice'))).toEqual(['ou_alice'])
    // 只跑一次
    expect(migrateScopesToSpaces(db, spaces).rows).toBe(0)
  })
})
