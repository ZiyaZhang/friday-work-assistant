import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AcpRuntime } from '../src/acp/runtime.js'
import { loadConfig } from '../src/config.js'
import { ChannelMemory } from '../src/core/memory.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { createFakeAgent } from './helpers/fake-agent.js'
import { asFeishuClient, FakeFeishu } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const registries: Registry[] = []
afterEach(() => { for (const r of registries.splice(0)) r.close() })
function storage() {
  const registry = new Registry(':memory:')
  registries.push(registry)
  return { registry, memory: new ChannelMemory(registry.db) }
}
const scope = 'space:sp_dm_ou_owner'
const BAD = 'SYNTHETIC_UNVERIFIED_ANSWER'
const CONFIRMED = 'SYNTHETIC_CONFIRMED_ANSWER'
const FACT = 'SYNTHETIC_CANDIDATE_FACT'

describe('automatic memory context excludes unconfirmed answers', () => {
  it.each([
    { path: 'FTS', query: 'topic absentphrase', title: 'topic' },
    { path: 'short-query LIKE', query: '转圈', title: '转圈' },
    { path: 'empty-query recency', query: '', title: 'topic' },
  ])('filters candidate QA before the limit in $path without hiding it from explicit history search', ({ query, title }) => {
    const { registry, memory } = storage()
    const oldAnswers = Array.from({ length: 8 }, () => memory.add({ scope, kind: 'qa', title, body: title,
      source: { generatedBy: 'automatic_qa' } }))
    const fact = memory.add({ scope, kind: 'fact', title, body: title + ' supporting observation'.repeat(30) })
    registry.db.prepare('UPDATE memory_notes SET created_at = 1 WHERE id = ?').run(fact.id)
    const before = registry.db.prepare('SELECT * FROM memory_notes ORDER BY id').all()
    // A post-query filter would leave an empty slot with this history ranking.
    expect(memory.search(scope, query, 1)[0]?.kind).toBe('qa')
    const composed = memory.composeForPrompt(scope, query, 1)
    expect(composed.used.notes.map((n) => n.id)).toEqual([fact.id])
    expect(composed.text).toContain('自动记录未确认')
    expect(memory.search(scope, query, 20).map((n) => n.id)).toEqual(expect.arrayContaining(oldAnswers.map((n) => n.id)))
    expect(registry.db.prepare('SELECT * FROM memory_notes ORDER BY id').all()).toEqual(before)
  })

  it('retains confirmed QA and candidate facts, including legacy candidate QA without a source marker only in history', () => {
    const { memory } = storage()
    const legacy = memory.add({ scope, kind: 'qa', title: 'topic old answer', body: BAD })
    const confirmed = memory.add({ scope, kind: 'qa', title: 'topic reviewed answer', body: CONFIRMED })
    expect(memory.confirm(confirmed.id, scope, { by: 'ou_owner', messageId: 'om_human_confirmation' })).toBe(true)
    const fact = memory.add({ scope, kind: 'fact', title: 'topic observation', body: FACT })

    const composed = memory.composeForPrompt(scope, 'topic')
    expect(composed.text).not.toContain(BAD)
    expect(composed.text).toContain(CONFIRMED)
    expect(composed.text).toContain(FACT)
    expect(composed.used.notes.map((n) => n.id)).toEqual(expect.arrayContaining([confirmed.id, fact.id]))
    expect(memory.search(scope, 'topic').map((n) => n.id)).toContain(legacy.id)
    expect(memory.get(legacy.id)?.status).toBe('candidate')
    expect(memory.get(fact.id)?.status).toBe('candidate')
  })

  it('does not carry a prior candidate answer into the actual ACP prompt after /new', async () => {
    const home = mkdtempSync(join(tmpdir(), 'friday-memory-prompt-'))
    const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic', FEISHU_APP_SECRET: 'synthetic', FRIDAY_HOME: home,
      FRIDAY_REFLECT: 'off' } as NodeJS.ProcessEnv)
    mkdirSync(cfg.workspace.root, { recursive: true })
    const { registry, memory } = storage()
    const sp = spaceDeps(registry.db)
    const space = sp.spaces.ensure({ kind: 'p2p', chatId: 'oc_synthetic_dm', openId: 'ou_owner' })
    const here = `space:${space.id}`
    const old = registry.createSession({ sessionKey: 'dm:ou_owner', chatId: 'oc_synthetic_dm', chatType: 'p2p',
      cwd: cfg.workspace.root, requesterOpenId: 'ou_owner' })
    const bad = memory.add({ scope: here, sessionKey: old.sessionKey, kind: 'qa', title: 'Harness Web old answer', body: BAD,
      source: { generatedBy: 'automatic_qa' } })
    const confirmed = memory.add({ scope: here, kind: 'qa', title: 'Harness Web reviewed answer', body: CONFIRMED })
    expect(memory.confirm(confirmed.id, here, { by: 'ou_owner', messageId: 'om_confirmation' })).toBe(true)
    memory.add({ scope: here, kind: 'fact', title: 'Harness Web observation', body: FACT })
    const { app, state } = createFakeAgent({ script: [{ kind: 'text', text: '合成新答案' }] })
    const log = createLogger('memory-prompt', 'error')
    const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: app }, log })
    const orchestrator = new Orchestrator({ cfg, registry, ...sp, memory, runtime, feishu: asFeishuClient(new FakeFeishu()),
      tokens: new TokenIssuer('synthetic'), apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent/synthetic-mcp.js',
      botOpenId: 'ou_bot', log })
    try {
      await orchestrator.handleMessage({ eventId: 'synthetic-event', messageId: 'om_new', chatId: 'oc_synthetic_dm', chatType: 'p2p',
        msgType: 'text', text: '/new Harness Web 后续问题', senderOpenId: 'ou_owner', senderType: 'user', mentions: [], createTimeMs: Date.now() })
      expect(registry.getSession(old.sessionKey)?.status).toBe('archived')
      expect(state.allPrompts).toHaveLength(1)
      const prompt = state.allPrompts[0]!.text
      expect(prompt).toContain('（新会话）')
      expect(prompt).not.toContain(BAD)
      expect(prompt).toContain(CONFIRMED)
      expect(prompt).toContain(FACT)
      expect(memory.search(here, 'Harness Web').map((n) => n.id)).toContain(bad.id)
    } finally {
      await runtime.stop()
      rmSync(home, { recursive: true, force: true })
    }
  })
})
