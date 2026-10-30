import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ExecutionMaterials, type MaterialContext, type MaterialProvenance } from '../src/core/execution-materials.js'
import { Registry } from '../src/core/registry.js'
import { SourceContexts } from '../src/core/source-context.js'
import type { PollSourceReceipt } from '../src/core/poll-source.js'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).reverse().forEach(close => close()) })
const poll: PollSourceReceipt = { version: 2, pollId: 'poll-a', pollVersion: 'version-a', spaceId: 'space-a', chatId: 'chat-a',
  contentDigest: 'c'.repeat(64), snapshotDigest: 'd'.repeat(64), ballotRevision: 1, state: 'open' }

/** Shared-file behaviour this projection adds on the r78 base (canonical reaches it through recordRetained and ZIP code). */
describe('poll snapshots in r78 source and material records', () => {
  it('keeps one poll receipt regardless of key order, and rejects another chat or an invalid receipt', () => {
    const home = mkdtempSync(join(tmpdir(), 'friday-poll-sources-')), registry = new Registry(join(home, 'db'))
    cleanups.push(() => { registry.close(); rmSync(home, { recursive: true, force: true }) })
    const sources = new SourceContexts(registry), binding = { sessionKey: 'session-a', acpSessionId: 'acp-a', spaceId: 'space-a', chatId: 'chat-a' }
    sources.initialize(binding, ['space:space-a'])
    sources.recordPollSource(binding, poll)
    // Material provenance is stored as canonical JSON, so a consumed receipt comes back with sorted keys.
    const sorted = Object.fromEntries(Object.entries(poll).sort(([a], [b]) => a.localeCompare(b))) as unknown as PollSourceReceipt
    sources.recordRetained(binding, { ...sources.get('session-a')!, pollSources: [sorted] })
    expect(sources.get('session-a')!.pollSources).toEqual([poll])
    expect(() => sources.recordPollSource(binding, { ...poll, chatId: 'chat-b' })).toThrow('投票来源不属于当前执行空间')
    expect(() => sources.recordPollSource(binding, { ...poll, snapshotDigest: 'not-a-digest' })).toThrow('投票来源不属于当前执行空间')
    registry.setKv('delivery-sources:session-a', JSON.stringify({ ...sources.get('session-a'), pollSources: [{ ...poll, version: 1 }] }))
    expect(sources.get('session-a')).toBeUndefined()
  })

  it('refuses a file edit whose new provenance drops a poll snapshot the old version depended on', () => {
    const home = mkdtempSync(join(tmpdir(), 'friday-poll-materials-')), db = new DatabaseSync(join(home, 'db'))
    cleanups.push(() => { db.close(); rmSync(home, { recursive: true, force: true }) })
    const store = new ExecutionMaterials(db, join(home, 'private'), { now: () => 1234 })
    const ctx: MaterialContext = { sessionKey: 'session-a', spaceId: 'space-a', generation: 'acp-a', runId: 'run-a', assertCurrent() {} }
    store.openGeneration(ctx)
    const provenance: MaterialProvenance = { sources: { version: 1, acpSessionId: 'acp-a', spaceId: 'space-a', chatId: 'chat-a',
      memoryScopes: ['space:space-a'], chats: [], external: [], repositories: [], pollSources: [poll] }, memoryRefs: [] }
    const original = store.register(ctx, { operationKey: 'original', name: 'votes.txt', data: Buffer.from('original'), provenance })
    const edit = (operationKey: string, pollSources: PollSourceReceipt[]) => store.edit(ctx, { fileId: original.fileId, expectedDigest: original.digest,
      operationKey, edits: [{ oldText: 'original', newText: 'changed' }], provenance: { ...structuredClone(provenance), sources: { ...structuredClone(provenance.sources), pollSources } } })
    expect(() => edit('drop', [])).toThrow(expect.objectContaining({ code: 'provenance_conflict' }))
    expect(() => edit('replace', [{ ...poll, snapshotDigest: 'e'.repeat(64) }])).toThrow(expect.objectContaining({ code: 'provenance_conflict' }))
    expect(edit('keep', [poll, { ...poll, snapshotDigest: 'e'.repeat(64), ballotRevision: 2 }]).provenance.sources.pollSources).toHaveLength(2)
  })
})
