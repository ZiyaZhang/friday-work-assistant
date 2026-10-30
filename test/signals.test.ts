import { describe, expect, it } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { BACKOFF_MS, MAX_ALERTS, Signals, fingerprintOf, renderSignals, triggerLine } from '../src/core/signals.js'
import { findResponsibilityConflicts, renderConflicts } from '../src/core/selfcheck.js'

function store(startAt = 1_000_000) {
  let now = startAt
  const s = new Signals(new Registry(':memory:').db, () => now)
  return { s, tick: (ms: number) => (now += ms), at: () => now }
}

describe('Signal 层', () => {
  it('指纹忽略标点和大小写，但换个说法就不是同一件事', () => {
    expect(fingerprintOf('数仓权限找谁申请啊？')).toBe(fingerprintOf('数仓权限找谁申请啊'))
    expect(fingerprintOf('Build FAILED')).toBe(fingerprintOf('build failed!'))
    expect(fingerprintOf('数仓权限找谁申请')).not.toBe(fingerprintOf('数仓权限怎么申请'))
  })

  it('同一件事合并计数而不新建，跨空间不合并', () => {
    const { s } = store()
    const a = s.ingest({ kind: 'unanswered_question', source: 'feishu:oc_1', spaceId: 'sp_1', title: '数仓权限找谁申请？' })
    expect(a.merged).toBe(false)
    const b = s.ingest({ kind: 'unanswered_question', source: 'feishu:oc_1', spaceId: 'sp_1', title: '数仓权限找谁申请' })
    expect(b.merged).toBe(true)
    expect(b.signal.id).toBe(a.signal.id)
    expect(b.signal.count).toBe(2)
    // 别的空间是另一条
    const c = s.ingest({ kind: 'unanswered_question', source: 'feishu:oc_2', spaceId: 'sp_2', title: '数仓权限找谁申请？' })
    expect(c.signal.id).not.toBe(a.signal.id)
    expect(s.elsewhere(c.signal)).toBe(1)
  })

  it('同一件事反复出现会并成一条 duplicate_burst，原信号不再单独升级', () => {
    const { s, tick } = store()
    const src = { kind: 'unanswered_question', source: 'feishu:oc_1', spaceId: 'sp_1', title: '导出又挂了' }
    s.ingest(src)
    s.ingest(src)
    const third = s.ingest(src)
    expect(third.burst).toBeDefined()
    expect(third.burst!.kind).toBe('duplicate_burst')
    expect(third.burst!.title).toContain('出现了 3 次')
    // 原信号收掉了，只剩合并后的那条
    tick(60 * 60_000)
    const due = s.due()
    expect(due.get('sp_1')?.map((x) => x.kind)).toEqual(['duplicate_burst'])
  })

  it('弱证据要熬够时间才到阈值，强证据立即', () => {
    const { s, tick } = store()
    s.ingest({ kind: 'unanswered_question', source: 'feishu:oc_1', spaceId: 'sp_1', title: '谁看一下这个' })
    s.ingest({ kind: 'external_failed', source: 'github:o/r', spaceId: 'sp_1', title: 'CI 挂了' })
    // 刚进来：只有强证据够格
    expect(s.due().get('sp_1')?.map((x) => x.kind)).toEqual(['external_failed'])
    tick(11 * 60_000)
    expect(s.due().get('sp_1')?.map((x) => x.kind).sort()).toEqual(['external_failed', 'unanswered_question'])
  })

  it('退避：1 次立即、之后 60s/5min/30min，第 5 次转成记录不再打扰', () => {
    const { s, tick, at } = store()
    const sig = s.ingest({ kind: 'external_failed', source: 'github:o/r', spaceId: 'sp_1', title: 'CI 挂了' }).signal
    expect(s.due().get('sp_1')).toHaveLength(1)
    s.noteAlerted(sig.id)
    expect(s.due().get('sp_1')).toBeUndefined() // 进了退避期
    tick(BACKOFF_MS[1]!)
    expect(s.due().get('sp_1')).toHaveLength(1)
    s.noteAlerted(sig.id)
    tick(BACKOFF_MS[2]!)
    s.noteAlerted(sig.id)
    tick(BACKOFF_MS[3]!)
    const last = s.noteAlerted(sig.id)
    expect(last?.alerts).toBe(MAX_ALERTS)
    expect(last?.status).toBe('muted') // 不再说话，只留记录
    expect(s.due().get('sp_1')).toBeUndefined()
    expect(at()).toBeGreaterThan(1_000_000)
  })

  it('有人接话了就收掉：同来源、发生在那之前的信号一律 resolve', () => {
    const { s, tick } = store()
    s.ingest({ kind: 'unanswered_question', source: 'feishu:omt_1', spaceId: 'sp_1', title: '这个怎么配' })
    tick(5 * 60_000)
    const cut = 1_000_000 + 5 * 60_000
    const n = s.resolveBySource('sp_1', 'feishu:omt_1', '有人接话了', { beforeMs: cut })
    expect(n).toBe(1)
    tick(30 * 60_000)
    expect(s.due().get('sp_1')).toBeUndefined()
  })

  it('关停按空间或按类型，且不删数据', () => {
    const { s, tick } = store()
    s.ingest({ kind: 'unanswered_question', source: 'feishu:oc_1', spaceId: 'sp_1', title: '问题一' })
    s.ingest({ kind: 'external_failed', source: 'github:o/r', spaceId: 'sp_1', title: 'CI 挂了' })
    tick(11 * 60_000)
    expect(s.due().get('sp_1')).toHaveLength(2)
    s.mute('sp_1', 'unanswered_question', 'ou_alice')
    expect(s.due().get('sp_1')?.map((x) => x.kind)).toEqual(['external_failed'])
    expect(s.mutedKinds('sp_1')).toEqual(['unanswered_question'])
    s.mute('sp_1', '*', 'ou_alice')
    expect(s.due().get('sp_1')).toBeUndefined()
    // 数据还在
    expect(s.open('sp_1')).toHaveLength(2)
    s.unmute('sp_1', '*')
    s.unmute('sp_1', 'unanswered_question')
    expect(s.due().get('sp_1')).toHaveLength(2)
  })

  it('攒着没人管又没再出现的会过期', () => {
    const { s, tick } = store()
    s.ingest({ kind: 'external_failed', source: 'github:o/r', spaceId: 'sp_1', title: 'CI 挂了' })
    tick(23 * 3600_000)
    expect(s.expire()).toBe(0)
    tick(2 * 3600_000)
    expect(s.expire()).toBe(1)
    expect(s.open('sp_1')).toHaveLength(0)
  })

  it('渲染带出处、次数和跨空间计数；发言前缀说清为什么冒出来', () => {
    const { s, tick, at } = store()
    const sig = s.ingest({ kind: 'unanswered_question', source: 'feishu:oc_1', spaceId: 'sp_1', title: '数仓权限找谁申请' }).signal
    s.ingest({ kind: 'unanswered_question', source: 'feishu:oc_1', spaceId: 'sp_1', title: '数仓权限找谁申请？' })
    s.ingest({ kind: 'unanswered_question', source: 'feishu:oc_2', spaceId: 'sp_2', title: '数仓权限找谁申请' })
    const text = renderSignals(s.open('sp_1'), (x) => s.elsewhere(x))
    expect(text).toContain('出现 2 次')
    expect(text).toContain('别的空间也出现过 1 次')
    tick(12 * 60_000)
    const line = triggerLine([s.get(sig.id)!], at())
    expect(line).toContain('数仓权限找谁申请')
    expect(line).toContain('12 分钟没动静')
  })
})

describe('职责重复自查', () => {
  const base = { enabled: true, status: 'active', chatId: 'oc_1' }
  it('同群、时间挨着、讲同一批东西 → 报重复', () => {
    const list = findResponsibilityConflicts([
      { ...base, id: 1, name: '自研PPT反馈巡查', prompt: '扫一遍群里的用户反馈，写进反馈表', nextRunAt: 1_000_000 },
      { ...base, id: 2, name: '自研PPT反馈日报', prompt: '汇总今天的用户反馈，写进反馈表并发卡片', nextRunAt: 1_000_000 + 20 * 60_000 },
    ])
    expect(list).toHaveLength(1)
    expect(list[0]!.apartMin).toBe(20)
    expect(renderConflicts(list)).toContain('停掉 #2')
  })

  it('不同群、隔得远、或者内容不像，都不报', () => {
    const far = findResponsibilityConflicts([
      { ...base, id: 1, name: '反馈巡查', prompt: '扫用户反馈', nextRunAt: 1_000_000 },
      { ...base, id: 2, name: '反馈日报', prompt: '汇总用户反馈', nextRunAt: 1_000_000 + 3 * 3600_000 },
    ])
    expect(far).toHaveLength(0)
    const otherChat = findResponsibilityConflicts([
      { ...base, id: 1, name: '反馈巡查', prompt: '扫用户反馈', nextRunAt: 1_000_000 },
      { ...base, id: 2, chatId: 'oc_2', enabled: true, status: 'active', name: '反馈日报', prompt: '汇总用户反馈', nextRunAt: 1_000_000 },
    ])
    expect(otherChat).toHaveLength(0)
    const unrelated = findResponsibilityConflicts([
      { ...base, id: 1, name: '晨会提醒', prompt: '提醒大家开晨会', nextRunAt: 1_000_000 },
      { ...base, id: 2, name: '构建看板', prompt: '同步 CI 状态到看板', nextRunAt: 1_000_000 + 60_000 },
    ])
    expect(unrelated).toHaveLength(0)
  })

  it('停用的和提案中的不算', () => {
    expect(
      findResponsibilityConflicts([
        { ...base, id: 1, name: '反馈巡查', prompt: '扫用户反馈写表', nextRunAt: 1_000_000 },
        { ...base, id: 2, status: 'proposed', name: '反馈日报', prompt: '汇总用户反馈写表', nextRunAt: 1_000_000 + 60_000 },
      ]),
    ).toHaveLength(0)
  })
})
