/**
 * Bug 收敛桶：同一件事一个编号；追问有上限。
 */
import { describe, expect, it } from 'vitest'
import { Bugs, MAX_FOLLOWUP_ASKS } from '../src/core/bugs.js'
import { Registry } from '../src/core/registry.js'
import { DatabaseSync } from 'node:sqlite'

const S = 'sp_1'
function store() {
  return new Bugs(new Registry(':memory:').db)
}

describe('Bug 收敛', () => {
  it('第一条开新桶，带 bucket_id 的归并进去并计数', () => {
    const b = store()
    const a = b.record({ spaceId: S, title: '预览页面显示错位', text: '预览页面好像显示错位了', chatId: 'oc_u' })
    expect(a.isNew).toBe(true)
    expect(a.bucket.count).toBe(1)

    const c = b.record({ spaceId: S, title: '预览页面显示错位', text: '这个页面也是斜的', chatId: 'oc_u', bucketId: a.bucket.id })
    expect(c.isNew).toBe(false)
    expect(c.bucket.id).toBe(a.bucket.id)
    expect(c.bucket.count).toBe(2)
  })

  it('同一条飞书消息记两次不重复计数', () => {
    const b = store()
    const a = b.record({ spaceId: S, title: 'x', text: 'y', chatId: 'oc_u', messageId: 'om_1' })
    const again = b.record({ spaceId: S, title: 'x', text: 'y', chatId: 'oc_u', messageId: 'om_1' })
    expect(again.duplicate).toBe(true)
    expect(b.get(a.bucket.id)?.count).toBe(1)
  })

  it('similar 找得到相近标题，但不会自动合并', () => {
    const b = store()
    b.record({ spaceId: S, title: '预览页面显示错位', text: 'a', chatId: 'oc_u' })
    const cand = b.similar(S, '预览页面显示错位')
    expect(cand).toHaveLength(1)
    // 没传 bucketId → 还是开新桶，合不合由模型决定
    const n = b.record({ spaceId: S, title: '预览页面显示错位', text: 'b', chatId: 'oc_u' })
    expect(n.isNew).toBe(true)
    expect(b.list(S)).toHaveLength(2)
  })

  it('已经修掉的桶不再出现在 similar 候选里', () => {
    const b = store()
    const a = b.record({ spaceId: S, title: '导出失败', text: 'a', chatId: 'oc_u' })
    b.setStatus(a.bucket.id, 'fixed')
    expect(b.similar(S, '导出失败')).toHaveLength(0)
  })

  it('别的空间的桶互不可见', () => {
    const b = store()
    b.record({ spaceId: 'sp_a', title: '导出失败', text: 'a', chatId: 'oc_1' })
    expect(b.similar('sp_b', '导出失败')).toHaveLength(0)
    expect(b.list('sp_b')).toHaveLength(0)
  })

  it('追问三轮就到顶，之后一直是 false', () => {
    const b = store()
    const a = b.record({ spaceId: S, title: 'x', text: 'y', chatId: 'oc_u' })
    for (let i = 1; i <= MAX_FOLLOWUP_ASKS; i += 1) {
      const r = b.tryAsk(a.bucket.id)
      expect(r.allowed).toBe(true)
      expect(r.used).toBe(i)
    }
    const over = b.tryAsk(a.bucket.id)
    expect(over.allowed).toBe(false)
    expect(over.used).toBe(MAX_FOLLOWUP_ASKS)
    // 再调也不会把计数刷上去
    expect(b.tryAsk(a.bucket.id).used).toBe(MAX_FOLLOWUP_ASKS)
  })

  it('预算是先扣再问：问之前就记账，模型忘了记也不会超', () => {
    const b = store()
    const a = b.record({ spaceId: S, title: 'x', text: 'y', chatId: 'oc_u' })
    b.tryAsk(a.bucket.id)
    expect(b.get(a.bucket.id)?.asks).toBe(1)
  })

  it('列表按被提到的次数排', () => {
    const b = store()
    const few = b.record({ spaceId: S, title: '少的', text: 'a', chatId: 'oc_u' })
    const many = b.record({ spaceId: S, title: '多的', text: 'a', chatId: 'oc_u' })
    for (let i = 0; i < 4; i += 1) b.record({ spaceId: S, title: '多的', text: 'x' + i, chatId: 'oc_u', bucketId: many.bucket.id })
    const list = b.list(S)
    expect(list[0]?.id).toBe(many.bucket.id)
    expect(list[1]?.id).toBe(few.bucket.id)
  })

  it('PMO 要的数：开着几个、这段时间新开几个、收到几条', () => {
    const b = store()
    const t0 = Date.parse('2026-09-01T00:00:00Z')
    const old = b.record({ spaceId: S, title: '老的', text: 'a', chatId: 'oc_u', now: t0 })
    b.setStatus(old.bucket.id, 'fixed')
    b.record({ spaceId: S, title: '新的', text: 'a', chatId: 'oc_u', now: t0 + 86400_000 })
    const st = b.stats(S, t0 + 3600_000)
    expect(st.open).toBe(1)
    expect(st.newBuckets).toBe(1)
    expect(st.reports).toBe(1)
  })

  it('链接跟着反馈走，报告里能一键点回产物', () => {
    const b = store()
    const a = b.record({ spaceId: S, title: 'ppt 导不出', text: '导出失败', chatId: 'oc_u', link: 'https://example.com/ppt/1' })
    expect(b.reports(a.bucket.id)[0]?.link).toBe('https://example.com/ppt/1')
  })
})

describe('桶的出口：升级成 issue', () => {
  it('关到 issue 之后状态推到 triaging，链接记在桶上', () => {
    const b = new Bugs(new Registry(':memory:').db)
    const { bucket } = b.record({ spaceId: 'sp_1', chatId: 'oc_1', title: 'cmd /c del 能删仓库外文件', text: '试了一下，是真的' })
    expect(bucket.status).toBe('open')
    expect(bucket.issueUrl).toBeNull()

    const linked = b.linkIssue(bucket.id, 'https://github.com/acme-org/acme-harness/issues/4581', '待 Windows 环境验证')
    expect(linked?.issueUrl).toBe('https://github.com/acme-org/acme-harness/issues/4581')
    expect(linked?.status).toBe('triaging')
    expect(linked?.note).toContain('Windows')
  })

  it('已经修好的桶再关 issue，不把状态倒回 triaging', () => {
    const b = new Bugs(new Registry(':memory:').db)
    const { bucket } = b.record({ spaceId: 'sp_1', chatId: 'oc_1', title: 'x', text: 'y' })
    b.setStatus(bucket.id, 'fixed')
    const linked = b.linkIssue(bucket.id, 'https://example.com/issues/1')
    expect(linked?.status).toBe('fixed')
  })
})

describe('建单前案件阶段', () => {
  it('等待信息明确记录缺口，重建服务保留；分析和建单是不同阶段', () => {
    const db = new Registry(':memory:').db
    const b = new Bugs(db)
    const { bucket } = b.record({ spaceId: S, chatId: 'chat', title: '界面卡住', text: '点发送后无响应', now: 100 })
    expect(bucket).toMatchObject({ intakePhase: 'new', missingInfo: [], intakeUpdatedAt: 100 })
    expect(() => b.setIntake({ bucketId: bucket.id, spaceId: S, phase: 'awaiting_info' })).toThrow('缺少什么')
    b.setIntake({ bucketId: bucket.id, spaceId: S, phase: 'awaiting_info', missingInfo: ['版本', '用户导出日志', '版本'], now: 200 })
    expect(new Bugs(db).get(bucket.id)).toMatchObject({ intakePhase: 'awaiting_info', missingInfo: ['版本', '用户导出日志'], status: 'open', intakeUpdatedAt: 200, lastSeenAt: 100 })
    expect(() => b.setIntake({ bucketId: bucket.id, spaceId: S, phase: 'ready' })).toThrow('缺失')
    b.setIntake({ bucketId: bucket.id, spaceId: S, phase: 'ready', missingInfo: [] })
    b.setIntake({ bucketId: bucket.id, spaceId: S, phase: 'diagnosing' })
    expect(b.setIntake({ bucketId: bucket.id, spaceId: S, phase: 'triaged' })).toMatchObject({ intakePhase: 'triaged', issueUrl: null, status: 'triaging' })
    expect(() => b.setIntake({ bucketId: bucket.id, spaceId: S, phase: 'linked_issue' })).toThrow('先关联')
  })

  it('关联后只保存链接，不再允许本地 fixed 或 cancelled 冒充 GitHub 状态', () => {
    const b = store()
    const { bucket } = b.record({ spaceId: S, chatId: 'chat', title: '问题', text: '待补日志' })
    b.setIntake({ bucketId: bucket.id, spaceId: S, phase: 'awaiting_info', missingInfo: ['日志'] })
    const issueUrl = 'https://github.com/example/repo/issues/123'
    expect(b.linkIssue(bucket.id, issueUrl)).toMatchObject({ issueUrl, intakePhase: 'linked_issue', missingInfo: ['日志'] })
    expect(() => b.setStatus(bucket.id, 'fixed')).toThrow('GitHub')
    expect(() => b.setIntake({ bucketId: bucket.id, spaceId: S, phase: 'cancelled' })).toThrow('GitHub')
    expect(() => b.linkIssue(bucket.id, 'https://github.com/example/repo/issues/456')).toThrow('改绑')
    expect(b.setIntake({ bucketId: bucket.id, spaceId: S, phase: 'linked_issue', note: '已转交，日志仍缺' })).toMatchObject({ intakePhase: 'linked_issue', note: '已转交，日志仍缺' })
  })

  it('存量四态按保守规则迁移，已有 issue 优先，重复初始化不重置新阶段', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE bug_buckets (id INTEGER PRIMARY KEY AUTOINCREMENT, space_id TEXT, title TEXT NOT NULL, status TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0, asks INTEGER NOT NULL DEFAULT 0, note TEXT, issue_url TEXT, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL);
      INSERT INTO bug_buckets (space_id,title,status,issue_url,first_seen_at,last_seen_at) VALUES
      ('sp_1','a','open',NULL,1,2), ('sp_1','b','triaging',NULL,1,3), ('sp_1','c','fixed',NULL,1,4),
      ('sp_1','d','wontfix',NULL,1,5), ('sp_1','e','fixed','https://github.com/example/repo/issues/1',1,6)`)
    const b = new Bugs(db)
    expect([1, 2, 3, 4, 5].map((id) => b.get(id)?.intakePhase)).toEqual(['new', 'diagnosing', 'resolved_without_issue', 'cancelled', 'linked_issue'])
    expect(b.get(5)).toMatchObject({ intakeUpdatedAt: 6, status: 'fixed' })
    b.setIntake({ bucketId: 1, spaceId: S, phase: 'awaiting_info', missingInfo: ['版本'] })
    expect(new Bugs(db).get(1)?.intakePhase).toBe('awaiting_info')
  })

  it('无 issue_url 的旧库也能迁移，不丢原始反馈', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE bug_buckets (id INTEGER PRIMARY KEY AUTOINCREMENT, space_id TEXT, title TEXT NOT NULL, status TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0, asks INTEGER NOT NULL DEFAULT 0, note TEXT, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL);
      INSERT INTO bug_buckets (space_id,title,status,first_seen_at,last_seen_at) VALUES ('sp_1','历史问题','open',1,2)`)
    const b = new Bugs(db)
    expect(b.get(1)).toMatchObject({ title: '历史问题', issueUrl: null, intakePhase: 'new' })
    b.record({ spaceId: S, bucketId: 1, chatId: 'chat', title: '续报', text: '仍存在' })
    expect(b.reports(1)[0]?.text).toBe('仍存在')
  })
})

describe('案件消息锚点', () => {
  it('幂等保存准确讨论，可补齐但不能改写已有 thread/root/parent', () => {
    const b = store()
    const { bucket } = b.record({ spaceId: S, chatId: 'chat', title: '卡住', text: '报告' })
    const input = { bucketId: bucket.id, spaceId: S, tenantId: 'tenant', appId: 'app', chatId: 'chat', messageId: 'msg' }
    const first = b.addAnchor(input)
    expect(b.addAnchor({ ...input, threadId: 'thread', rootId: 'root', parentId: 'parent' })).toMatchObject({ id: first.id, threadId: 'thread', rootId: 'root', parentId: 'parent' })
    expect(b.addAnchor(input).threadId).toBe('thread')
    expect(b.anchors(bucket.id, S)).toHaveLength(1)
    expect(() => b.addAnchor({ ...input, threadId: 'other' })).toThrow('不能改绑')
    expect(b.anchors(bucket.id, S)[0]?.threadId).toBe('thread')
  })

  it('相同 message/thread 不能跨 tenant/app/chat/space 匹配；同一锚点多案返回全部', () => {
    const b = store()
    const a = b.record({ spaceId: S, chatId: 'chat', title: '发送卡住', text: '报告两种症状' }).bucket
    const c = b.record({ spaceId: S, chatId: 'chat', title: '画面闪烁', text: '同一条原话' }).bucket
    const ids = { tenantId: 'tenant', appId: 'app', chatId: 'chat', messageId: 'msg', threadId: 'thread' }
    for (const bucket of [a, c]) b.addAnchor({ ...ids, bucketId: bucket.id, spaceId: S })
    const query = { spaceId: S, tenantId: 'tenant', appId: 'app', chatId: 'chat', threadId: 'thread' }
    expect(b.findByAnchor(query).map((x) => x.id)).toEqual([a.id, c.id])
    for (const key of ['spaceId', 'tenantId', 'appId', 'chatId', 'threadId'] as const) expect(b.findByAnchor({ ...query, [key]: 'other' })).toEqual([])
    expect(b.findByAnchor({ ...query, threadId: undefined, messageId: 'msg' })).toHaveLength(2)
    expect(() => b.findByAnchor({ ...query, messageId: 'msg' })).toThrow('其中之一')
  })
})

describe('证据只存本案引用', () => {
  it('Session ID/反馈回执不证明收到日志；新增引用不自动推进诊断阶段', () => {
    const b = store()
    const { bucket } = b.record({ spaceId: S, chatId: 'chat', title: '卡住', text: '已发 feedback' })
    b.setIntake({ bucketId: bucket.id, spaceId: S, phase: 'awaiting_info', missingInfo: ['用户导出日志'] })
    const input = { bucketId: bucket.id, spaceId: S, kind: 'feedback_receipt' as const, sourceRef: 'feedback:session-123/seq-9' }
    expect(() => b.addEvidence({ ...input, coverage: { state: 'complete' } })).toThrow('不证明')
    const ref = b.addEvidence({ ...input, coverage: { state: 'unknown', note: '用户仅提供反馈编号，日志未接收' } })
    expect(ref).toMatchObject({ accessScope: 'case', digest: null, coverage: { state: 'unknown' } })
    expect(b.get(bucket.id)).toMatchObject({ intakePhase: 'awaiting_info', missingInfo: ['用户导出日志'] })
    expect(b.evidence(bucket.id, S)[0]).toMatchObject({ id: ref.id, expired: false })
  })

  it('证据快照幂等，不能更换摘要/范围或延长期限；到期显式标记，不冒充没有证据', () => {
    const db = new Registry(':memory:').db
    const b = new Bugs(db)
    const { bucket } = b.record({ spaceId: S, chatId: 'chat', title: '卡住', text: '报告' })
    const input = { bucketId: bucket.id, spaceId: S, kind: 'user_export' as const, sourceRef: 'case-upload:abc', digest: 'ab'.repeat(32), coverage: { state: 'partial' as const, note: '用户提供的单次导出，不含子会话' }, expiresAt: 300, now: 100 }
    const first = b.addEvidence(input)
    expect(b.addEvidence({ ...input, now: 200 }).id).toBe(first.id)
    expect(() => b.addEvidence({ ...input, digest: 'cd'.repeat(32) })).toThrow('不能覆盖')
    expect(() => b.addEvidence({ ...input, expiresAt: 400 })).toThrow('不能覆盖')
    expect(() => b.addEvidence({ ...input, coverage: { state: 'complete', note: '改称完整' } })).toThrow('不能覆盖')
    expect(new Bugs(db).evidence(bucket.id, S, 299)).toHaveLength(1)
    expect(b.evidence(bucket.id, S, 299)[0]?.expired).toBe(false)
    expect(b.evidence(bucket.id, S, 300)[0]?.expired).toBe(true)
    expect(() => b.addEvidence({ ...input, sourceRef: 'case-upload:other', expiresAt: 100 })).toThrow('过期时间')
  })

  it('跨案不复制证据/锚点，未知case与其他space统一拒绝；摘要与引用字段需有效', () => {
    const b = store()
    const { bucket } = b.record({ spaceId: S, chatId: 'chat', title: '卡住', text: '报告' })
    const anchor = { bucketId: bucket.id, spaceId: 'other', tenantId: 'tenant', appId: 'app', chatId: 'chat', messageId: 'msg' }
    const evidence = { bucketId: bucket.id, spaceId: 'other', kind: 'code' as const, sourceRef: 'git:repo@commit/file.ts#L1', coverage: { state: 'partial' as const } }
    for (const spaceId of ['other', null]) {
      expect(() => b.setIntake({ bucketId: bucket.id, spaceId, phase: 'diagnosing' })).toThrow('当前空间')
      expect(() => b.addAnchor({ ...anchor, spaceId })).toThrow('当前空间')
      expect(() => b.addEvidence({ ...evidence, spaceId })).toThrow('当前空间')
      expect(() => b.anchors(bucket.id, spaceId)).toThrow('当前空间')
      expect(() => b.evidence(bucket.id, spaceId)).toThrow('当前空间')
    }
    expect(() => b.addEvidence({ ...evidence, spaceId: S, digest: 'not-sha' })).toThrow('SHA-256')
    expect(() => b.addAnchor({ ...anchor, spaceId: S, tenantId: '' })).toThrow('非空')
    expect(() => b.evidence(999, S)).toThrow('当前空间')
    expect(b.anchors(bucket.id, S)).toEqual([])
    expect(b.evidence(bucket.id, S)).toEqual([])
  })
})

describe('底层反馈空间边界', () => {
  it('record 不能跨空间挂桶、重用消息或通过不存在的 bucketId 偷开新案', () => {
    const b = store()
    const { bucket } = b.record({ spaceId: S, chatId: 'chat', title: 'private', text: '报告', messageId: 'msg' })
    expect(() => b.record({ spaceId: 'other', chatId: 'other-chat', title: 'x', text: 'y', bucketId: bucket.id })).toThrow('当前空间')
    expect(() => b.record({ spaceId: 'other', chatId: 'other-chat', title: 'x', text: 'y', messageId: 'msg' })).toThrow('当前空间')
    expect(() => b.record({ spaceId: S, chatId: 'other-chat', title: 'x', text: 'y', messageId: 'msg' })).toThrow('归属')
    expect(() => b.record({ spaceId: S, chatId: 'chat', title: 'x', text: 'y', bucketId: 999 })).toThrow('当前空间')
    expect(b.get(bucket.id)?.count).toBe(1)
  })

  it('null 是明确空间，不能作为全库通配符；反馈统计不混入其他空间', () => {
    const b = store()
    b.record({ spaceId: S, chatId: 'chat', title: '导出失败', text: '报告', now: 100 })
    b.record({ spaceId: 'other', chatId: 'other', title: '导出失败', text: '其他报告', now: 100 })
    const unbound = b.record({ spaceId: null, chatId: 'unbound', title: '导出失败', text: '未绑定报告', now: 100 }).bucket
    expect(b.list(null).map((x) => x.id)).toEqual([unbound.id])
    expect(b.similar(null, '导出失败').map((x) => x.id)).toEqual([unbound.id])
    expect(b.stats(S, 0)).toMatchObject({ open: 1, newBuckets: 1, reports: 1 })
    expect(b.stats(null, 0)).toMatchObject({ open: 1, newBuckets: 1, reports: 1 })
  })
})
