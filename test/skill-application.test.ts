import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeliveryService, type DeliveryAudience } from '../src/core/delivery.js'
import { Inbox } from '../src/core/inbox.js'
import { PolicyService } from '../src/core/policy.js'
import { SkillApplication, type SkillApplicationDependencies, type SkillRunContext, type SkillRunRef } from '../src/core/skill-application.js'
import { SkillProposals, renderSkillMd, skillReviewParts } from '../src/core/skills.js'
import { Spaces } from '../src/core/space.js'

const dbs: DatabaseSync[] = []
const skill = { name: 'custom-flow', description: 'A repeatable procedure',
  body: '# Procedure\n\nRead the supplied source, verify each relevant claim, preserve evidence and report the actual result with a source link.' }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
function setup(mode: 'safe' | 'auto' | 'deny' = 'safe') {
  const db = new DatabaseSync(':memory:')
  dbs.push(db)
  const spaces = new Spaces(db)
  const policy = new PolicyService(spaces, { mode, admins: ['ou_admin'] })
  const a = spaces.ensure({ kind: 'group', chatId: 'chat-a', openId: 'ou_a' })
  const b = spaces.ensure({ kind: 'group', chatId: 'chat-b', openId: 'ou_b' })
  const dm = spaces.ensure({ kind: 'p2p', chatId: 'chat-dm', openId: 'ou_a' })
  spaces.addMember(a.id, 'ou_member', 'member')
  const skills = new SkillProposals(db)
  const inbox = new Inbox(db)
  let actor: SkillRunContext = { sessionKey: 'session-a', runId: 'run-a', taskId: 1,
    spaceId: a.id, chatId: 'chat-a', chatType: 'group', requesterOpenId: 'ou_a' }
  const ref: SkillRunRef = { sessionKey: actor.sessionKey, runId: actor.runId }
  const state = { active: true, derivedSafe: true, failSend: false, failPatch: false, failStop: false }
  // The production host owns RunAttempts and occurrence stops; this fixture exercises the sync callback transaction.
  db.exec('CREATE TABLE application_test_runs(id TEXT PRIMARY KEY,status TEXT NOT NULL)')
  const sent: { key: string; audience: DeliveryAudience; payload: unknown }[] = []
  const patches: string[] = []
  let beforeContext: (() => Promise<void>) | undefined
  let afterPost: ((key: string) => Promise<void>) | undefined
  const userName = vi.fn(async (_openId: string) => 'Actual owner')
  const resolveRun: SkillApplicationDependencies['resolveRun'] = (requested, operation) => {
    if (!state.active || requested.runId !== actor.runId || requested.sessionKey !== actor.sessionKey ||
      (operation === 'propose' && !state.derivedSafe) || (skills.getRunSkillSet(actor.runId) && !skills.isRunEligible(actor.runId))) return undefined
    return { ...actor }
  }
  const deps: SkillApplicationDependencies = {
    skills, spaces, policy, inbox, resolveRun, userName,
    deliveryFor: (requested) => new DeliveryService(db, { spaces, policy,
      resolveContext: async () => {
        await beforeContext?.()
        const current = resolveRun(requested, 'propose')
        if (!current) return undefined
        return { actorOpenId: current.requesterOpenId,
          audience: current.chatType === 'p2p' ? { kind: 'dm', spaceId: current.spaceId, openId: current.requesterOpenId }
            : { kind: 'group', spaceId: current.spaceId, chatId: current.chatId, replyToMessageId: 'original-anchor' },
          sources: [{ ref: 'trusted-origin', spaceId: current.spaceId, chatId: current.chatId }],
          provenanceComplete: state.derivedSafe, expiresAt: Date.now() + 60_000 }
      },
      send: async ({ key, audience, payload }) => {
        sent.push({ key, audience, payload })
        await afterPost?.(key)
        if (state.failSend) throw new Error('synthetic ACK lost after external POST')
        return { remoteId: `card-${sent.length}` }
      },
    }),
    patchCard: async id => { patches.push(id); if (state.failPatch) throw new Error('synthetic patch ACK lost') },
    stopRuns: (ids) => {
      const stopped: string[] = []
      for (const id of ids) if (db.prepare("UPDATE application_test_runs SET status='cancelled' WHERE id=? AND status='running'").run(id).changes) stopped.push(id)
      if (state.failStop) throw new Error('synthetic durable stop failure')
      return stopped
    },
  }
  const app = new SkillApplication(db, deps)
  const decide = (input: { proposalId: number; decision: 'accept' | 'ignore'; operatorOpenId?: string }) => {
    const proposal = skills.get(input.proposalId)
    return app.decide({ ...input, contentDigest: proposal?.contentDigest ?? undefined, chatId: proposal?.chatId })
  }
  const record = (version = 'one') => skills.propose({ ...skill, description: version,
    spaceId: actor.spaceId, sessionKey: actor.sessionKey, chatId: actor.chatId, chatType: actor.chatType,
    proposerOpenId: actor.requesterOpenId, originRunId: actor.runId, originTaskId: actor.taskId })
  return { db, spaces, policy, a, b, dm, skills, inbox, state, deps, app, decide, ref, userName, sent, patches, record,
    setActor: (value: Partial<SkillRunContext>) => { actor = { ...actor, ...value } },
    setAfterPost: (callback: (key: string) => Promise<void>) => { afterPost = callback },
    setBeforeContext: (callback: () => Promise<void>) => { beforeContext = callback } }
}
afterEach(() => { for (const db of dbs.splice(0)) db.close() })

describe('SkillApplication', () => {
  it.each([false, true])('patches a decision made before the initial card ACK (patch failure=%s)', async failPatch => {
    const t = setup()
    const gate = deferred<void>(), visible = deferred<void>()
    t.setAfterPost(async key => { if (key === 'skill-proposal:1') { visible.resolve(); await gate.promise } })
    const posting = t.app.propose(t.ref, skill)
    await visible.promise
    const decision = await t.decide({ proposalId: 1, decision: 'accept', operatorOpenId: 'ou_a' })
    expect(decision).toMatchObject({ proposal: { status: 'accepted', cardMessageId: null }, cardStatus: 'not_sent' })
    expect(t.patches).toEqual([])
    t.state.failPatch = failPatch
    gate.resolve()
    expect(await posting).toMatchObject({ proposal: { status: 'accepted', cardMessageId: 'card-2' },
      delivery: { status: 'sent', remoteId: 'card-2' }, cardStatus: failPatch ? 'unknown' : 'updated' })
    expect(t.skills.getBinding(t.a.id, skill.name)?.enabled).toBe(true)
    expect(t.sent).toHaveLength(2)
    expect(t.patches).toEqual(['card-2'])
  })

  it('uses one immutable proposal and one Delivery key for concurrent retries, including an accepted card', async () => {
    const t = setup()
    const results = await Promise.allSettled([t.app.propose(t.ref, skill), t.app.propose(t.ref, skill)])
    expect(results.some(r => r.status === 'fulfilled')).toBe(true)
    expect(t.sent).toHaveLength(2)
    expect(t.sent[1]).toMatchObject({ key: 'skill-proposal:1', audience: { kind: 'group', spaceId: t.a.id, chatId: 'chat-a', replyToMessageId: 'original-anchor' } })
    expect(t.db.prepare('SELECT count(*) AS n FROM skill_proposals').get()?.n).toBe(1)
    expect(t.inbox.pending('ou_a')).toHaveLength(1)
    await t.decide({ proposalId: 1, decision: 'accept', operatorOpenId: 'ou_a' })
    const replay = await t.app.propose(t.ref, skill)
    expect(replay).toMatchObject({ proposal: { id: 1, status: 'accepted', cardMessageId: 'card-2' }, delivery: { replayed: true, status: 'sent' } })
    expect(t.sent).toHaveLength(2)
    expect(t.inbox.pending('ou_a')).toHaveLength(0)
  })

  it('retains unknown delivery and the original proposal across reconstructed applications instead of posting another card', async () => {
    const t = setup()
    t.state.failSend = true
    await expect(t.app.propose(t.ref, skill)).rejects.toMatchObject({ code: 'unknown' })
    t.state.failSend = false
    const restarted = new SkillApplication(t.db, { ...t.deps, skills: new SkillProposals(t.db) })
    await expect(restarted.propose(t.ref, skill)).rejects.toMatchObject({ code: 'unknown' })
    expect(t.sent).toHaveLength(1)
    expect(t.db.prepare('SELECT count(*) AS n FROM skill_proposals').get()?.n).toBe(1)
    expect(t.skills.get(1)?.cardMessageId).toBeNull()
    expect(t.db.prepare('SELECT status,remote_id FROM deliveries').get()).toMatchObject({ status: 'unknown', remote_id: null })
  })

  it('checks the live run again at Delivery resolution and preserves a not-sent proposal without granting future send rights', async () => {
    const t = setup()
    const gate = deferred<void>()
    const entered = deferred<void>()
    t.setBeforeContext(async () => { entered.resolve(); await gate.promise })
    const operation = t.app.propose(t.ref, skill)
    await entered.promise
    t.state.active = false
    gate.resolve()
    await expect(operation).rejects.toMatchObject({ code: 'denied' })
    expect(t.sent).toHaveLength(0)
    expect(t.skills.get(1)?.status).toBe('pending')
    expect(t.db.prepare('SELECT count(*) AS n FROM deliveries').get()?.n).toBe(0)
  })

  it.each(['ou_member', 'ou_b', 'ou_admin', undefined, ''])('does not let %s decide another space proposal even in auto mode', async operatorOpenId => {
    const t = setup('auto')
    const p = t.record()
    await expect(t.decide({ proposalId: p.id, decision: 'accept', operatorOpenId })).rejects.toMatchObject({ code: 'denied' })
    expect(t.skills.get(p.id)?.status).toBe('pending')
    expect(t.userName).not.toHaveBeenCalled()
  })

  it.each(['membership', 'archive', 'rebind'] as const)('rechecks %s after awaiting a user name', async change => {
    const t = setup()
    const p = (await t.app.propose(t.ref, skill)).proposal
    const gate = deferred<string>()
    t.userName.mockImplementationOnce(() => gate.promise)
    const operation = t.decide({ proposalId: p.id, decision: 'accept', operatorOpenId: 'ou_a' })
    if (change === 'membership') t.spaces.removeMember(t.a.id, 'ou_a')
    if (change === 'archive') t.spaces.archive(t.a.id)
    if (change === 'rebind') t.db.prepare('UPDATE space_rooms SET chat_id=? WHERE id=?').run('chat-new', t.a.id)
    gate.resolve('Former owner')
    await expect(operation).rejects.toMatchObject({ code: 'denied' })
    expect(t.skills.get(p.id)?.status).toBe('pending')
    expect(t.skills.getBinding(t.a.id, p.name)).toBeUndefined()
    expect(t.patches).toHaveLength(0)
  })

  it('uses the original Space id, rejecting legacy and archived proposals instead of inferring a new same-chat space', async () => {
    const t = setup()
    const p = t.record()
    t.spaces.archive(t.a.id)
    t.db.prepare('UPDATE space_rooms SET chat_id=? WHERE id=?').run('retired-chat', t.a.id)
    const replacement = t.spaces.ensure({ kind: 'group', chatId: 'chat-a', openId: 'ou_a' })
    expect(replacement.id).not.toBe(t.a.id)
    await expect(t.decide({ proposalId: p.id, decision: 'accept', operatorOpenId: 'ou_a' })).rejects.toMatchObject({ code: 'denied' })
    t.db.prepare('UPDATE skill_proposals SET space_id=NULL WHERE id=?').run(p.id)
    await expect(t.decide({ proposalId: p.id, decision: 'ignore', operatorOpenId: 'ou_a' })).rejects.toMatchObject({ code: 'needs_reconfirmation' })
    expect(t.skills.getBinding(replacement.id, p.name)).toBeUndefined()
  })

  it('keeps the committed decision when card patch ACK is unknown and does not switch back on repeat', async () => {
    const t = setup()
    const p = (await t.app.propose(t.ref, skill)).proposal
    t.state.failPatch = true
    const decided = await t.decide({ proposalId: p.id, decision: 'accept', operatorOpenId: 'ou_a' })
    expect(decided).toMatchObject({ changed: true, cardStatus: 'unknown', proposal: { status: 'accepted', decidedByOpenId: 'ou_a' } })
    const next = (await t.app.propose(t.ref, { ...skill, description: 'version two' })).proposal
    await t.decide({ proposalId: next.id, decision: 'accept', operatorOpenId: 'ou_a' })
    const repeated = await t.decide({ proposalId: p.id, decision: 'ignore', operatorOpenId: 'ou_a' })
    expect(repeated).toMatchObject({ changed: false, proposal: { status: 'accepted' } })
    expect(t.skills.getBinding(t.a.id, p.name)?.proposalId).toBe(next.id)
    expect(t.inbox.pending('ou_a')).toHaveLength(0)
  })

  it('re-reads a competing decision after the name await without overwriting it', async () => {
    const t = setup()
    const p = (await t.app.propose(t.ref, skill)).proposal
    const gate = deferred<string>()
    t.userName.mockImplementationOnce(() => gate.promise)
    const pending = t.decide({ proposalId: p.id, decision: 'accept', operatorOpenId: 'ou_a' })
    const winner = await t.decide({ proposalId: p.id, decision: 'ignore', operatorOpenId: 'ou_a' })
    gate.resolve('Late click')
    expect(winner.changed).toBe(true)
    expect(await pending).toMatchObject({ changed: false, proposal: { status: 'ignored' } })
    expect(t.skills.getBinding(t.a.id, p.name)).toBeUndefined()
  })

  it('limits private proposals to their real owner and respects deployment deny', async () => {
    const t = setup()
    t.setActor({ spaceId: t.dm.id, chatId: 'chat-dm', chatType: 'p2p' })
    const p = t.record()
    await expect(t.decide({ proposalId: p.id, decision: 'accept', operatorOpenId: 'ou_b' })).rejects.toMatchObject({ code: 'denied' })
    expect(await t.decide({ proposalId: p.id, decision: 'ignore', operatorOpenId: 'ou_a' })).toMatchObject({ proposal: { status: 'ignored' }, changed: true })
    const denied = setup('deny')
    const other = denied.record()
    await expect(denied.decide({ proposalId: other.id, decision: 'accept', operatorOpenId: 'ou_a' })).rejects.toMatchObject({ code: 'denied' })
  })

  it('keeps a pure disable available with restricted derived sources, stops pinned controller too, and grants no post-disable tools', async () => {
    const t = setup()
    const p = t.record()
    t.skills.accept(p.id, 'Owner', 'ou_a')
    for (const runId of ['run-a', 'other-worker', 'historical']) {
      t.skills.pinForRun({ runId, spaceId: t.a.id, builtinDigest: 'builtin' })
      t.db.prepare('INSERT INTO application_test_runs VALUES(?,?)').run(runId, runId === 'historical' ? 'completed' : 'running')
    }
    t.state.derivedSafe = false
    await expect(t.app.propose(t.ref, skill)).rejects.toMatchObject({ code: 'denied' })
    const result = t.app.disable(t.ref, { name: p.name, expectedRevision: 1 })
    expect(result).toMatchObject({ changed: true, binding: { spaceId: t.a.id, name: p.name, proposalId: p.id,
      revision: 2, lastDisabledRevision: 2, enabled: false, updatedByOpenId: 'ou_a' }, stoppedRunIds: ['other-worker', 'run-a'] })
    expect(t.skills.isRunEligible('run-a')).toBe(false)
    expect(t.db.prepare('SELECT status FROM application_test_runs WHERE id=?').get('run-a')?.status).toBe('cancelled')
    expect(t.db.prepare('SELECT status FROM application_test_runs WHERE id=?').get('historical')?.status).toBe('completed')
    expect(() => t.app.disable(t.ref, { name: p.name, expectedRevision: 2 })).toThrow(/身份已失效/)
    t.state.derivedSafe = true
    await expect(t.app.propose(t.ref, skill)).rejects.toMatchObject({ code: 'denied' })
    expect(t.sent).toHaveLength(0)
  })

  it('rolls back the disable and earlier durable stops if a later host stop fails', () => {
    const t = setup()
    const p = t.record()
    t.skills.accept(p.id, 'Owner', 'ou_a')
    t.skills.pinForRun({ runId: 'worker', spaceId: t.a.id, builtinDigest: 'builtin' })
    t.db.prepare('INSERT INTO application_test_runs VALUES(?,?)').run('worker', 'running')
    t.state.failStop = true
    expect(() => t.app.disable(t.ref, { name: p.name, expectedRevision: 1 })).toThrow(/durable stop/)
    expect(t.skills.getBinding(t.a.id, p.name)).toMatchObject({ enabled: true, revision: 1, lastDisabledRevision: 0 })
    expect(t.skills.isRunEligible('worker')).toBe(true)
    expect(t.db.prepare('SELECT status FROM application_test_runs').get()?.status).toBe('running')
  })

  it('rejects proposal source changes even if a buggy resolver reuses a run id', async () => {
    const t = setup()
    await t.app.propose(t.ref, skill)
    t.setActor({ spaceId: t.b.id, chatId: 'chat-b', requesterOpenId: 'ou_b' })
    await expect(t.app.propose(t.ref, skill)).rejects.toMatchObject({ code: 'run_mismatch' })
    expect(t.sent).toHaveLength(2)
    expect(t.db.prepare('SELECT count(*) AS n FROM skill_proposals').get()?.n).toBe(1)
  })
})

describe('技能全文审阅与确切版本确认', () => {
  it('长正文逐段完整可见，最后的条款和 Unicode 原样保留；确认卡最后发送且小于 30KB', async () => {
    const t = setup()
    const body = '😀核对来源\n'.repeat(1600) + '\n最后一条：不要跨空间发布。'
    const result = await t.app.propose(t.ref, { ...skill, description: '完整说明'.repeat(100), body })
    const parts = skillReviewParts(result.proposal)
    expect(parts.length).toBeGreaterThan(1)
    const texts = t.sent.slice(0, -1).map(row => (row.payload as { text: string }).text)
    expect(texts).toEqual(parts.map(part => part.text))
    expect(texts.map(text => text.slice(text.indexOf('\n\n') + 2)).join('')).toBe(renderSkillMd(result.proposal))
    expect(texts.at(-1)).toContain('最后一条：不要跨空间发布。')
    const card = t.sent.at(-1)!.payload as { card: Record<string, unknown> }
    expect(JSON.stringify(card)).toContain(result.proposal.contentDigest)
    expect(JSON.stringify(card)).toContain(`完整 SKILL.md 已分 ${parts.length} 段`)
    expect(JSON.stringify(card)).not.toContain('已阅读')
    expect(t.skills.getBinding(t.a.id, skill.name)).toBeUndefined()
    for (const row of t.sent) expect(Buffer.byteLength(JSON.stringify(row.payload))).toBeLessThan(30_000)
    expect(await t.decide({ proposalId: result.proposal.id, decision: 'accept', operatorOpenId: 'ou_a' }))
      .toMatchObject({ changed: true, proposal: { status: 'accepted' } })
    expect(t.skills.getBinding(t.a.id, skill.name)?.enabled).toBe(true)
  })

  it('第二段发送回执不明时不发接受卡，重启重试也不重发正文或越过缺失段', async () => {
    const t = setup()
    t.setAfterPost(async () => { if (t.sent.length === 2) throw new Error('lost ACK') })
    const input = { ...skill, body: '完整正文\n'.repeat(1500) }
    await expect(t.app.propose(t.ref, input)).rejects.toMatchObject({ code: 'unknown' })
    expect(t.sent).toHaveLength(2)
    expect(t.sent.every(row => 'text' in (row.payload as object))).toBe(true)
    await expect(t.decide({ proposalId: 1, decision: 'accept', operatorOpenId: 'ou_a' })).rejects.toMatchObject({ code: 'needs_reconfirmation' })
    const restarted = new SkillApplication(t.db, t.deps)
    await expect(restarted.propose(t.ref, input)).rejects.toMatchObject({ code: 'unknown' })
    expect(t.sent).toHaveLength(2)
    expect(t.skills.getBinding(t.a.id, skill.name)).toBeUndefined()
  })

  it('两段之间来源权限失效，后续正文和确认卡都停止', async () => {
    const t = setup()
    t.setAfterPost(async () => { t.state.derivedSafe = false })
    await expect(t.app.propose(t.ref, { ...skill, body: '分段内容\n'.repeat(1500) })).rejects.toMatchObject({ code: 'denied' })
    expect(t.sent).toHaveLength(1)
    expect(t.skills.get(1)?.status).toBe('pending')
    expect(t.skills.getBinding(t.a.id, skill.name)).toBeUndefined()
  })

  it.each([undefined, 'wrong-digest'])('旧卡或另一正文的 digest=%s 不能启用当前技能', async contentDigest => {
    const t = setup()
    const { proposal } = await t.app.propose(t.ref, skill)
    await expect(t.app.decide({ proposalId: proposal.id, decision: 'accept', operatorOpenId: 'ou_a', chatId: 'chat-a', contentDigest }))
      .rejects.toMatchObject({ code: 'needs_reconfirmation' })
    expect(t.skills.getBinding(t.a.id, skill.name)).toBeUndefined()
  })

  it('同一个人是两个空间的负责人，转发到另一个空间的卡也不能决定原空间技能', async () => {
    const t = setup()
    t.spaces.addMember(t.b.id, 'ou_a', 'owner')
    const { proposal } = await t.app.propose(t.ref, skill)
    await expect(t.app.decide({ proposalId: proposal.id, decision: 'accept', operatorOpenId: 'ou_a', chatId: 'chat-b', contentDigest: proposal.contentDigest! }))
      .rejects.toMatchObject({ code: 'denied' })
    expect(t.skills.getBinding(t.a.id, skill.name)).toBeUndefined()
  })

  it('同一会话里复制出来的卡不能替代已投递的原卡', async () => {
    const t = setup()
    const { proposal } = await t.app.propose(t.ref, skill)
    await expect(t.app.decide({ proposalId: proposal.id, decision: 'accept', operatorOpenId: 'ou_a', chatId: 'chat-a', messageId: 'copied-card', contentDigest: proposal.contentDigest! }))
      .rejects.toMatchObject({ code: 'denied' })
  })

  it('等显示姓名时正文变化，旧确认只能失败，不能安装未展示的尾部', async () => {
    const t = setup()
    const { proposal } = await t.app.propose(t.ref, skill)
    t.userName.mockImplementationOnce(async () => {
      t.db.prepare('UPDATE skill_proposals SET body=body || ? WHERE id=?').run('\n追加的未展示指令', proposal.id)
      return 'Owner'
    })
    await expect(t.decide({ proposalId: proposal.id, decision: 'accept', operatorOpenId: 'ou_a' })).rejects.toMatchObject({ code: 'content_changed' })
    expect(t.skills.get(proposal.id)?.status).toBe('pending')
    expect(t.skills.getBinding(t.a.id, skill.name)).toBeUndefined()
  })

  it('投递账本不是本空间或对应正文时不能作为全文已发送的凭据', async () => {
    const t = setup()
    const { proposal } = await t.app.propose(t.ref, skill)
    const first = skillReviewParts(proposal)[0]!
    t.db.prepare('UPDATE deliveries SET audience=? WHERE delivery_key=?')
      .run(JSON.stringify({ kind: 'group', spaceId: t.b.id, chatId: 'chat-b' }), first.key)
    await expect(t.decide({ proposalId: proposal.id, decision: 'accept', operatorOpenId: 'ou_a' })).rejects.toMatchObject({ code: 'needs_reconfirmation' })
    expect(t.skills.getBinding(t.a.id, skill.name)).toBeUndefined()
  })
})
