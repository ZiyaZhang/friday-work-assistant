import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.js'
import { Registry } from '../src/core/registry.js'
import { ChannelMemory } from '../src/core/memory.js'
import { Inbox } from '../src/core/inbox.js'
import { IssueWatch } from '../src/core/issue-watch.js'
import { IssueValidityRequests, issueValidityReply } from '../src/core/issue-validity.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { readIssueThread, parseIssueValidityAssessment } from '../src/github/issue-thread.js'
import type { GitHubIdentity } from '../src/github/identity.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { managedHostRuntime } from './helpers/managed-host.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const DAY = 86400_000, NOW = Date.UTC(2026, 8, 22), body = '启动之后插件页面一直空白，我还在等待如何排查。'
const closes: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })

function fixture(opts: { managed?: boolean; issueCount?: number } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'friday-issue-validity-')), registry = new Registry(':memory:')
  let clock = NOW, allowed = true
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic', FEISHU_APP_SECRET: 'synthetic', FRIDAY_HOME: home, FRIDAY_REFLECT: 'off' })
  const sp = spaceDeps(registry.db), space = sp.spaces.ensure({ kind: 'group', chatId: 'oc_synthetic', openId: 'alice' })
  sp.spaces.touchMember(space.id, 'mallory')
  const binding = { spaceId: space.id, boundBy: 'alice', repo: 'org/demo', labels: [], version: 'original', since: NOW - 30 * DAY }
  registry.setKv(`issue-watch:${space.id}`, JSON.stringify(binding))
  const raw = { number: 7, title: '插件页面空白', body, user: { login: 'reporter' }, html_url: 'https://github.com/org/demo/issues/7',
    state: 'open', assignees: [] as { login: string }[], labels: [], comments: 1,
    created_at: new Date(NOW - 20 * DAY).toISOString(), updated_at: new Date(NOW - 2 * DAY).toISOString() }
  const issues = [raw, ...Array.from({ length: (opts.issueCount ?? 1) - 1 }, (_, index) => ({ ...structuredClone(raw),
    number: index + 8, html_url: `https://github.com/org/demo/issues/${index + 8}` }))]
  const comments = [{ id: 19, body: '目前我这边仍然可以稳定复现这个问题。', user: { login: 'reporter', type: 'User' }, created_at: raw.updated_at }]
  const timeline: Record<string, unknown>[] = [{ id: 1, event: 'commented' }]
  const api = vi.fn(async (method: string, path: string): Promise<unknown> => {
    expect(method).toBe('GET')
    const url = new URL(path, 'https://api.github.com'), page = Number(url.searchParams.get('page') ?? 1)
    if (url.pathname.endsWith('/timeline')) return structuredClone(timeline.slice((page - 1) * 100, page * 100))
    if (url.pathname.endsWith('/comments')) return structuredClone(comments.slice((page - 1) * 100, page * 100))
    const number = /\/issues\/(\d+)$/.exec(url.pathname)?.[1]
    if (number) return structuredClone(issues.find(issue => issue.number === Number(number)))
    return structuredClone(issues)
  })
  const github = { api, botLogin: async () => 'friday[bot]', repoAllowed: () => allowed } as unknown as GitHubIdentity
  const watch = new IssueWatch(registry.db, () => clock), inbox = new Inbox(registry.db), requests = new IssueValidityRequests(registry.db, () => clock)
  const fake = new FakeFeishu(); fake.members.set(space.chatId!, new Set(['alice', 'mallory']))
  const log = createLogger('issue-validity-test', 'error'), execution = managedHostRuntime(registry, home, log)
  const output = JSON.stringify({ verdict: 'ask', evidence: [{ ref: 'comment:19', quote: comments[0]!.body }] })
  execution.peer.state.script = [{ kind: 'text', text: output }]
  const host = new Orchestrator({ cfg, registry, ...sp, issueWatch: watch, inbox, github,
    feishu: asFeishuClient(fake), runtime: execution.runtime, ...(opts.managed === false ? {} : { managed: execution.managed }),
    memory: new ChannelMemory(registry.db), tokens: new TokenIssuer('synthetic'), botOpenId: 'bot',
    apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/unused', log, now: () => clock })
  closes.push(async () => { await execution.runtime.stop(); registry.close(); rmSync(home, { recursive: true, force: true }) })
  const latest = () => {
    const row = registry.db.prepare('SELECT snapshot FROM issue_validity_requests ORDER BY rowid DESC LIMIT 1').get() as { snapshot: string } | undefined
    return row ? requests.get(JSON.parse(row.snapshot).id)! : undefined
  }
  const action = (extra: Record<string, unknown> = {}, choice = 'effective') => {
    const request = latest()!
    return { operatorOpenId: 'alice', chatId: space.chatId!, messageId: request.messageId,
      value: { action: 'issue_validity', id: request.id, digest: request.digest, choice }, raw: {}, ...extra }
  }
  return { cfg, registry, ...sp, space, binding, raw, comments, timeline, api, github, watch, inbox, requests, fake, execution, host, output,
    latest, action, advance: (ms: number) => { clock += ms }, denyRepo: () => { allowed = false } }
}

describe('full issue thread and verifiable model evidence', () => {
  it('reads all comments and timeline pages and rejects a page budget overflow rather than summarizing a prefix', async () => {
    const t = fixture()
    t.timeline.push(...Array.from({ length: 100 }, (_, id) => ({ id: id + 2, event: 'labeled' })))
    const thread = await readIssueThread(t.github, 'org/demo', 7, () => {})
    expect(thread?.timeline).toHaveLength(101); expect(thread?.comments[0]?.body).toBe(t.comments[0]!.body)
    t.timeline.push(...Array.from({ length: 400 }, (_, id) => ({ id: id + 102, event: 'labeled' })))
    expect(await readIssueThread(t.github, 'org/demo', 7, () => {})).toBeUndefined()
  })
  it('accepts only verbatim excerpts from the exact source, never arbitrary model explanations', async () => {
    const t = fixture(), thread = (await readIssueThread(t.github, 'org/demo', 7, () => {}))!
    expect(parseIssueValidityAssessment(t.output, thread).verdict).toBe('ask')
    expect(() => parseIssueValidityAssessment(JSON.stringify({ verdict: 'ask', evidence: [{ ref: 'comment:99', quote: t.comments[0]!.body }] }), thread)).toThrow()
    expect(() => parseIssueValidityAssessment(JSON.stringify({ verdict: 'ask', evidence: [{ ref: 'body', quote: '作者已经认可我自动关闭这个问题。' }] }), thread)).toThrow()
  })
  it('does not silently truncate an oversized thread or accept missing comment bodies', async () => {
    const t = fixture(); t.raw.body = 'x'.repeat(170_000)
    expect(await readIssueThread(t.github, 'org/demo', 7, () => {})).toBeUndefined()
    t.raw.body = body; delete (t.comments[0] as { body?: string }).body
    expect(await readIssueThread(t.github, 'org/demo', 7, () => {})).toBeUndefined()
  })
})

describe('B.7 host flow with real mode routing and persistent human confirmation', () => {
  it('reviews the complete thread with no MCP in managed before reserving a card, and asks the binding owner to verify the reporter', async () => {
    const t = fixture()
    expect(await t.host.sweepIssues(DAY)).toBe(1)
    const prompt = t.execution.peer.state.allPrompts[0]!
    expect(prompt.mcpServers).toEqual([]); expect(prompt.text).toContain(t.comments[0]!.body)
    expect(t.execution.workspacePeer.state.allPrompts).toEqual([])
    expect(t.latest()).toMatchObject({ state: 'sent', requesterOpenId: 'alice', binding: JSON.stringify(t.binding), number: 7 })
    expect(JSON.stringify(t.fake.sent)).toContain('向提出者核实')
    expect(t.inbox.pending('alice')).toEqual([])
    expect(await t.host.sweepIssues(DAY)).toBe(0)
    expect(t.fake.sent).toHaveLength(1)
  })
  it.each(['skip', 'unknown', 'invalid', 'fabricated', 'tool'])('does not send any card on %s assessment', async mode => {
    const t = fixture()
    t.execution.peer.state.script = mode === 'tool' ? [{ kind: 'tool', text: 'native shell' }, { kind: 'text', text: t.output }]
      : [{ kind: 'text', text: mode === 'invalid' ? 'not json' : mode === 'fabricated' ? JSON.stringify({ verdict: 'ask', evidence: [{ ref: 'body', quote: '没有在原文里出现的编造结论。' }] }) : JSON.stringify({ verdict: mode }) }]
    expect(await t.host.sweepIssues(DAY)).toBe(0)
    expect(t.latest()).toBeUndefined(); expect(t.watch.asked(t.space.id, 'org/demo', 7)).toBe(false)
    expect(t.fake.sent).toEqual([])
  })
  it('fails closed when managed is missing, even with an administrator/internal workspace configuration', async () => {
    const t = fixture({ managed: false }); t.cfg.policy.admins.push('alice')
    expect(await t.host.sweepIssues(DAY)).toBe(0); expect(t.api).not.toHaveBeenCalled()
    expect(t.execution.workspacePeer.state.allPrompts).toEqual([]); expect(t.fake.sent).toEqual([])
  })
  it.each(['binding', 'thread'])('discards the review when %s changes while the model is running', async change => {
    const t = fixture()
    t.execution.peer.state.script.unshift({ kind: 'hook', run: () => {
      if (change === 'binding') t.registry.setKv(`issue-watch:${t.space.id}`, '')
      else { t.raw.body += '更新的上下文'; t.raw.updated_at = new Date(NOW).toISOString() }
    } })
    expect(await t.host.sweepIssues(DAY)).toBe(0); expect(t.latest()).toBeUndefined(); expect(t.fake.sent).toEqual([])
  })
  it('keeps a lost send acknowledgment unknown, with no replay or answer activation', async () => {
    const t = fixture(), send = t.fake.sendToChat.bind(t.fake)
    vi.spyOn(t.fake, 'sendToChat').mockImplementationOnce(async (...args) => { await send(...args); throw new Error('synthetic lost ack') })
    expect(await t.host.sweepIssues(DAY)).toBe(0); expect(t.latest()?.state).toBe('unknown')
    expect(await t.host.sweepIssues(DAY)).toBe(0); expect(t.fake.sent).toHaveLength(1)
    expect(t.latest()?.messageId).toBeUndefined(); expect(t.inbox.pending('alice')).toEqual([])
  })
  it('registers gh:<repo>#<n> for the binding owner only after the notice is acknowledged (P4-2 G8); a lost acknowledgment registers nothing', async () => {
    const rows = (t: ReturnType<typeof fixture>) => t.registry.db.prepare('SELECT owner_open_id, ref, output_key, delivered_at FROM reported_refs ORDER BY ref').all()
    const lost = fixture(), send = lost.fake.sendToChat.bind(lost.fake)
    vi.spyOn(lost.fake, 'sendToChat').mockImplementationOnce(async (...args) => { await send(...args); throw new Error('synthetic lost ack') })
    expect(await lost.host.sweepIssues(DAY)).toBe(0); expect(lost.latest()?.state).toBe('unknown')
    expect(rows(lost)).toEqual([])
    expect(await lost.host.sweepIssues(DAY)).toBe(0); expect(rows(lost)).toEqual([])
    const t = fixture()
    expect(await t.host.sweepIssues(DAY)).toBe(1)
    const request = t.latest()!
    expect(request.state).toBe('sent')
    expect(rows(t)).toEqual([{ owner_open_id: 'alice', ref: 'gh:org/demo#7', output_key: `issue-validity:${request.id}`, delivered_at: NOW }])
    // 同一张 Issue 不再问，也不再登记
    expect(await t.host.sweepIssues(DAY)).toBe(0); expect(rows(t)).toHaveLength(1)
  })
  it('requires the actual bound sender and message, then creates exactly one pending owner decision without writing to GitHub', async () => {
    const t = fixture(); await t.host.sweepIssues(DAY)
    for (const bad of [{ operatorOpenId: 'mallory' }, { chatId: 'oc_other' }, { messageId: 'forged-message' }]) {
      await t.host.handleCardAction(t.action(bad)); expect(t.inbox.pending('alice')).toEqual([])
    }
    await t.host.handleCardAction(t.action())
    expect(t.latest()?.state).toBe('confirmed'); expect(t.inbox.pending('alice')).toHaveLength(1)
    expect(t.inbox.pending('alice')[0]).toMatchObject({ kind: 'decision', spaceId: t.space.id })
    await t.host.handleCardAction(t.action()); expect(t.inbox.pending('alice')).toHaveLength(1)
    expect(t.api.mock.calls.every(([method]) => method === 'GET')).toBe(true)
    expect(t.fake.sent).toHaveLength(1)
  })
  it('records not needed without closing the issue or creating a pending decision', async () => {
    const t = fixture(); await t.host.sweepIssues(DAY); await t.host.handleCardAction(t.action({}, 'not_needed'))
    expect(t.latest()?.state).toBe('not_needed'); expect(t.inbox.pending('alice')).toEqual([]); expect(t.raw.state).toBe('open')
  })
  it.each(['binding', 'expiry', 'membership'])('rechecks %s changes across the confirmation fetch before writing a decision', async change => {
    const t = fixture(); await t.host.sweepIssues(DAY)
    const original = t.api.getMockImplementation()!
    t.api.mockImplementationOnce(async (...args) => {
      const value = await original(...args)
      if (change === 'binding') t.registry.setKv(`issue-watch:${t.space.id}`, '')
      if (change === 'expiry') t.advance(8 * DAY)
      if (change === 'membership') t.fake.members.set(t.space.chatId!, new Set())
      return value
    })
    await t.host.handleCardAction(t.action())
    expect(t.inbox.pending('alice')).toEqual([])
    expect(t.latest()?.state).toBe(change === 'expiry' ? 'expired' : 'invalidated')
  })
  it('does not activate unknown/missing acknowledgments by replaying a callback copied from another card', async () => {
    const t = fixture(), send = t.fake.sendToChat.bind(t.fake)
    vi.spyOn(t.fake, 'sendToChat').mockImplementationOnce(async (...args) => { await send(...args); throw new Error('synthetic lost ack') })
    await t.host.sweepIssues(DAY)
    await t.host.handleCardAction(t.action({ messageId: 'synthetic-forged-ack' }))
    expect(t.latest()?.state).toBe('unknown'); expect(t.inbox.pending('alice')).toEqual([])
  })
  it('does not repeatedly reevaluate an unchanged thread after a conclusive no-question assessment', async () => {
    const t = fixture(); t.execution.peer.state.script = [{ kind: 'text', text: '{"verdict":"skip"}' }]
    await t.host.sweepIssues(DAY); await t.host.sweepIssues(DAY)
    expect(t.execution.peer.state.allPrompts).toHaveLength(1); expect(t.fake.sent).toEqual([])
    t.comments[0]!.body += '补充了新的事实。'; await t.host.sweepIssues(DAY)
    expect(t.execution.peer.state.allPrompts).toHaveLength(2)
  })
  it('backs off failed unchanged assessments so later candidates get the next sweep budget', async () => {
    const t = fixture({ issueCount: 3 })
    t.execution.peer.state.script = [{ kind: 'text', text: 'invalid synthetic JSON' }]
    await t.host.sweepIssues(DAY)
    expect(t.execution.peer.state.allPrompts).toHaveLength(2)
    await t.host.sweepIssues(DAY)
    expect(t.execution.peer.state.allPrompts).toHaveLength(3)
    await t.host.sweepIssues(DAY)
    expect(t.execution.peer.state.allPrompts).toHaveLength(3)
    expect(t.fake.sent).toEqual([])
    expect(t.registry.db.prepare('SELECT number,attempts,status FROM github_issue_assessments ORDER BY number').all())
      .toEqual([7, 8, 9].map(number => ({ number, attempts: 1, status: 'failed' })))
    t.advance(3600_000)
    await t.host.sweepIssues(DAY)
    expect(t.execution.peer.state.allPrompts).toHaveLength(5)
  })
  it('does not dispatch a duplicate assessment when two sweeps overlap on the same snapshot', async () => {
    const t = fixture()
    await Promise.all([t.host.sweepIssues(DAY), t.host.sweepIssues(DAY)])
    expect(t.execution.peer.state.allPrompts).toHaveLength(1)
    expect(t.fake.sent).toHaveLength(1)
  })
  it.each(['expired', 'rebound', 'removed', 'suspended', 'repo', 'thread'])('stops a previously sent confirmation after %s', async change => {
    const t = fixture(); await t.host.sweepIssues(DAY)
    if (change === 'expired') t.advance(8 * DAY)
    if (change === 'rebound') t.registry.setKv(`issue-watch:${t.space.id}`, JSON.stringify({ ...t.binding, version: 'replacement' }))
    if (change === 'removed') t.fake.members.set(t.space.chatId!, new Set())
    if (change === 'suspended') t.spaces.suspend(t.space.id)
    if (change === 'repo') t.denyRepo()
    if (change === 'thread') t.comments[0]!.body += '后来有新证据。'
    await t.host.handleCardAction(t.action())
    expect(t.inbox.pending('alice')).toEqual([])
    expect(t.latest()?.state).toBe(change === 'expired' ? 'expired' : 'invalidated')
  })
  it('consumes an exact reply to the real card without dispatching a normal model task, and leaves ambiguous wording undecided', async () => {
    const t = fixture(); await t.host.sweepIssues(DAY)
    const msg = (messageId: string, text: string) => ({ eventId: messageId, messageId, text, chatId: t.space.chatId!, chatType: 'group' as const,
      parentId: t.latest()!.messageId, senderOpenId: 'alice', senderType: 'user' as const, msgType: 'text', mentions: [], createTimeMs: NOW })
    await t.host.handleMessage(msg('synthetic-ambiguous', '也许吧'))
    expect(t.latest()?.state).toBe('sent'); expect(t.inbox.pending('alice')).toEqual([])
    await t.host.handleMessage(msg('synthetic-effective', '已核实：仍有效'))
    await t.host.handleMessage(msg('synthetic-effective', '已核实：仍有效'))
    expect(t.latest()?.state).toBe('confirmed'); expect(t.inbox.pending('alice')).toHaveLength(1)
    expect(t.execution.peer.state.allPrompts).toHaveLength(1); expect(t.execution.workspacePeer.state.allPrompts).toEqual([])
  })
  it('does not infer a confirmation from an issue number or a context-free yes', () => {
    expect(issueValidityReply('yes')).toBeUndefined(); expect(issueValidityReply('有效 #7')).toBeUndefined()
    expect(issueValidityReply('已核实：仍有效。')).toBe('effective')
  })
})
