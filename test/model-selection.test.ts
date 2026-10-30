import { afterEach, describe, expect, it } from 'vitest'
import { AcpRuntime, textBlock } from '../src/acp/runtime.js'
import { ModelApplication, modelSelectionTag, parseModelPolicy } from '../src/core/model-selection.js'
import { Registry } from '../src/core/registry.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { RunModels } from '../src/core/run-models.js'
import { Spaces } from '../src/core/space.js'
import { createLogger } from '../src/log.js'
import { choiceA, choiceB, deferred, modelAgent } from './helpers/model-agent.js'

const closes: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })
async function setup() {
  const registry = new Registry(':memory:'), attempts = new RunAttempts(registry.db), runs = new RunModels(registry.db), spaces = new Spaces(registry.db)
  const space = spaces.ensure({ kind: 'group', chatId: 'group', openId: 'alice' })
  const peer = modelAgent(), runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: peer.app }, maxConcurrent: 1,
    onPermission: async () => ({ outcome: { outcome: 'cancelled' } }), log: createLogger('model-selection-test', 'error') })
  const policy = parseModelPolicy({ FRIDAY_ACP_MODEL_PROVIDER: 'provider', FRIDAY_ACP_MODEL: 'a',
    FRIDAY_ALLOWED_MODELS: JSON.stringify(['a', 'b'].map(modelId => ({ providerId: 'provider', modelId, accountRef: 'deployment' }))) })
  const models = new ModelApplication({ runtime, spaces, runs, policy: () => policy })
  closes.push(async () => { await runtime.stop(); registry.close() })
  let serial = 0
  const begin = async (resumeId?: string) => {
    await runtime.start()
    const acpSessionId = resumeId ?? await runtime.newSession('/synthetic/model', []), sessionKey = `run-${++serial}`
    if (resumeId) expect(await runtime.resumeSession(resumeId, '/synthetic/model', [])).toBe(true)
    registry.createSession({ sessionKey, chatId: 'group', chatType: 'group', cwd: '/synthetic/model', requesterOpenId: 'alice' })
    const run = attempts.begin({ sessionKey, workKey: sessionKey, triggerKey: sessionKey, stage: 'task', now: Date.now() })!
    attempts.bindRuntime(run.id, acpSessionId)
    return { run, acpSessionId, assertCurrent: () => { if (!attempts.isCurrent(run.id) || spaces.get(space.id)?.status !== 'active') throw new Error('stopped') } }
  }
  const select = async (value: string | null) => {
    const catalog = await models.catalog(space.id, () => {})
    return models.select(space.id, { value, generation: catalog.generation, expectedTag: catalog.tag })
  }
  return { registry, attempts, runs, spaces, space, runtime, policy, models, peer, begin, select }
}

describe('model selection application', () => {
  it('does not activate legacy deployment preferences during upgrade', () => {
    const policy = parseModelPolicy({ FRIDAY_MODEL_PROVIDER: 'legacy-provider', FRIDAY_MODEL: 'legacy-model' })
    expect(policy.defaultRoute).toEqual({ providerId: 'deepseek-official', modelId: 'deepseek-v4-flash', accountRef: 'deployment' })
  })
  it('discovers metadata without tools or prompt and filters unapproved provider routes', async () => {
    const t = await setup(), result = await t.models.catalog(t.space.id, () => {})
    expect(result.choices.map(choice => choice.value)).toEqual([choiceA, choiceB])
    expect(t.peer.state.newCalls).toHaveLength(1); expect(t.peer.state.newCalls[0]?.mcpServers).toEqual([])
    expect(t.peer.state.prompts).toHaveLength(0)
    expect(t.registry.db.prepare('SELECT count(*) n FROM run_attempts').get()?.n).toBe(0)
  })
  it('ignores legacy preferences and verifies the deployment default before admission', async () => {
    const t = await setup(); t.spaces.patchConfig(t.space.id, { models: { main: 'b' } })
    const r = await t.begin(), pin = await t.models.prepare(r.run.id, t.space.id, r.acpSessionId, r.assertCurrent)
    expect(pin).toMatchObject({ selector: choiceA, modelId: 'a', admittedAt: null, usageStatus: 'unavailable' })
    await t.runtime.prompt(r.acpSessionId, [textBlock('看一下代码')], { beforeDispatch: () => t.models.admit(pin) })
    expect(t.peer.state.prompts[0]?.value).toBe(choiceA)
    expect(t.runs.get(r.run.id)?.admittedAt).not.toBeNull()
  })
  it('keeps a pinned Run through wrap-up and applies a changed selection only to the next Run', async () => {
    const t = await setup(), r = await t.begin(), first = await t.models.prepare(r.run.id, t.space.id, r.acpSessionId, r.assertCurrent)
    await t.select(choiceB)
    const wrap = await t.models.prepare(r.run.id, t.space.id, r.acpSessionId, r.assertCurrent)
    expect(wrap).toEqual(first); expect(t.peer.state.setCalls).toHaveLength(1)
    const next = await t.begin(), pin = await t.models.prepare(next.run.id, t.space.id, next.acpSessionId, next.assertCurrent)
    expect(pin.selector).toBe(choiceB)
    const other = t.spaces.ensure({ kind: 'group', chatId: 'other', openId: 'bob' }), third = await t.begin()
    expect((await t.models.prepare(third.run.id, other.id, third.acpSessionId, third.assertCurrent)).selector).toBe(choiceA)
  })
  it('keeps reflection on the deployment route and supports explicit reset without inheriting selection', async () => {
    const t = await setup(); await t.select(choiceB)
    const r = await t.begin()
    expect((await t.models.prepare(r.run.id, t.space.id, r.acpSessionId, r.assertCurrent, true)).selector).toBe(choiceA)
    await t.select(null)
    expect(t.spaces.get(t.space.id)?.config.modelSelection).toBeNull()
  })
  it.each(['rejectSet', 'wrongReadback', 'omitCatalog'] as const)('does not prompt or pin on %s', async key => {
    const t = await setup(); await t.select(choiceB); t.peer.state[key] = true
    const r = await t.begin()
    await expect(t.models.prepare(r.run.id, t.space.id, r.acpSessionId, r.assertCurrent)).rejects.toThrow()
    expect(t.runs.get(r.run.id)).toBeUndefined(); expect(t.peer.state.prompts).toHaveLength(0)
  })
  it.each(['stop', 'archive', 'revoke'] as const)('checks %s after a late successful setter', async change => {
    const t = await setup(), r = await t.begin(), entered = deferred(), release = deferred()
    t.peer.state.onSet = async () => { entered.resolve(); await release.promise }
    const pending = t.models.prepare(r.run.id, t.space.id, r.acpSessionId, r.assertCurrent)
    await entered.promise
    if (change === 'stop') t.attempts.requestStop(r.run.id, 'user_requested')
    if (change === 'archive') t.spaces.archive(t.space.id)
    if (change === 'revoke') t.policy.allowed = []
    release.resolve(); await expect(pending).rejects.toThrow()
    expect(t.runs.get(r.run.id)).toBeUndefined(); expect(t.peer.state.prompts).toHaveLength(0)
  })
  it('checks persisted stop after a Gate wait and does not replay using a fallback', async () => {
    const t = await setup(), r = await t.begin(), pin = await t.models.prepare(r.run.id, t.space.id, r.acpSessionId, r.assertCurrent)
    const blocker = await t.runtime.newSession('/synthetic/blocker'), entered = deferred(), release = deferred(), queued = deferred()
    t.peer.state.onPrompt = async () => { entered.resolve(); await release.promise }
    const occupied = t.runtime.prompt(blocker, [textBlock('hold')]); await entered.promise
    const prompt = t.runtime.prompt(r.acpSessionId, [textBlock('do work')], { onQueued: () => queued.resolve(), beforeDispatch: () => t.models.admit(pin) })
    await queued.promise; t.attempts.requestStop(r.run.id, 'user_requested'); release.resolve()
    await occupied; await expect(prompt).rejects.toThrow()
    expect(t.peer.state.prompts).toHaveLength(1); expect(t.runs.get(r.run.id)?.admittedAt).toBeNull()
  })
  it('rejects stale settings, runtime catalogs and revoked choices', async () => {
    const t = await setup(), catalog = await t.models.catalog(t.space.id, () => {})
    t.models.select(t.space.id, { value: choiceB, expectedTag: catalog.tag, generation: catalog.generation })
    expect(() => t.models.select(t.space.id, { value: choiceA, expectedTag: catalog.tag, generation: catalog.generation })).toThrow('变化')
    await t.runtime.stop(); await t.runtime.start()
    expect(() => t.models.select(t.space.id, { value: choiceB, expectedTag: (awaitedTag(t)), generation: catalog.generation })).toThrow('变化')
    const fresh = await t.models.catalog(t.space.id, () => {}); t.policy.allowed = []
    expect(() => t.models.select(t.space.id, { value: choiceA, expectedTag: fresh.tag, generation: fresh.generation })).toThrow('未提供')
  })
  it('does not silently change a resumed historical route when the space has never selected a model', async () => {
    const t = await setup(); t.peer.state.initialValue = choiceB
    await t.runtime.start()
    const previous = await t.runtime.newSession('/synthetic/model', [])
    await t.runtime.stop()
    const r = await t.begin(previous)
    await expect(t.models.prepare(r.run.id, t.space.id, r.acpSessionId, r.assertCurrent)).rejects.toMatchObject({
      code: 'model_selection_required', message: expect.stringContaining('模型设置'),
    })
    expect(t.peer.state.setCalls).toEqual([])
    expect(t.peer.state.sessions.get(previous)?.value).toBe(choiceB)
    expect(t.peer.state.prompts).toEqual([])
    expect(t.runs.get(r.run.id)).toBeUndefined()
    expect(t.spaces.get(t.space.id)!.config.modelSelection).toBeUndefined()

    const before = modelSelectionTag(t.spaces.get(t.space.id)!)
    const selected = await t.select(null)
    expect(selected.changed).toBe(true); expect(selected.tag).not.toBe(before)
    const pin = await t.models.prepare(r.run.id, t.space.id, r.acpSessionId, r.assertCurrent)
    expect(pin.selector).toBe(choiceA)
    expect(t.peer.state.setCalls).toEqual([{ sessionId: previous, configId: 'model', value: choiceA }])
    expect((await t.select(null))).toEqual({ changed: false, tag: selected.tag })
  })
  it('allows an explicit different-model choice and then explicit default reset on the same resumed conversation', async () => {
    const t = await setup(); t.peer.state.initialValue = choiceB
    const first = await t.begin()
    await t.select(choiceB)
    const selected = await t.models.prepare(first.run.id, t.space.id, first.acpSessionId, first.assertCurrent)
    expect(selected.selector).toBe(choiceB)
    t.attempts.finish(first.run.id, 'completed', Date.now())
    await t.runtime.stop()
    const second = await t.begin(first.acpSessionId)
    await t.select(null)
    const reset = await t.models.prepare(second.run.id, t.space.id, second.acpSessionId, second.assertCurrent)
    expect(reset.selector).toBe(choiceA)
    expect(t.runs.get(first.run.id)!.selector).toBe(choiceB)
  })
  it('rejects an unchosen differing current route even when a new session advertises it, but keeps background default intent explicit', async () => {
    const t = await setup(); t.peer.state.initialValue = choiceB
    const r = await t.begin()
    await expect(t.models.prepare(r.run.id, t.space.id, r.acpSessionId, r.assertCurrent)).rejects.toMatchObject({ code: 'model_selection_required' })
    expect(t.peer.state.setCalls).toEqual([])
    expect((await t.models.prepare(r.run.id, t.space.id, r.acpSessionId, r.assertCurrent, true)).selector).toBe(choiceA)
    expect(t.peer.state.setCalls).toHaveLength(1)
  })
})

function awaitedTag(t: Awaited<ReturnType<typeof setup>>) { return modelSelectionTag(t.spaces.get(t.space.id)!) }
