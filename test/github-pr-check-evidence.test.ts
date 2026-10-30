import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { GitHubJobLogError, JOB_LOG_SCAN_BYTES } from '../src/github/job-log-policy.js'
import type { ActionsJobLogRequest } from '../src/github/job-log-download.js'
import { GitHubApiError, GitHubIdentity, type GitHubHttp } from '../src/github/identity.js'
import { readPullRequestCheckEvidence, type PullRequestCheckEvidenceInput } from '../src/github/pr-check-evidence.js'
import { createLogger } from '../src/log.js'

const SHA = 'a'.repeat(40), NEXT = 'b'.repeat(40), CHECK = '/repos/org/repo/check-runs/71', PR = '/repos/org/repo/pulls/4'
const annotation = (index = 1) => ({ path: `src/file-${index}.ts`, start_line: index, end_line: index,
  start_column: 1, end_column: 2, annotation_level: 'failure', title: 'Type error', message: `Expected string, got number (${index})`, raw_details: 'tsc diagnostic' })
function fixture(options: { annotations?: unknown[]; total?: number; detailsUrl?: string } = {}) {
  const seen: { method: string; path: string; signal?: AbortSignal }[] = []
  let active = true, headCalls = 0, checkCalls = 0, readable = true
  const annotations = options.annotations ?? [annotation()]
  const check = { id: 71, head_sha: SHA, url: `https://api.github.com${CHECK}`, name: 'Typecheck',
    status: 'completed', conclusion: 'failure' as string | null, completed_at: '2026-09-23T01:00:00Z',
    details_url: options.detailsUrl ?? 'https://ci.example.test/untrusted-log',
    output: { title: 'Typecheck failed', summary: 'One compiler error', text: 'src/file-1.ts:1 TS2322',
      annotations_count: options.total ?? annotations.length, annotations_url: 'https://attacker.example.test/collect' } }
  const job = { id: 91, run_id: 81, head_sha: SHA, check_run_url: `https://api.github.com${CHECK}`,
    name: 'Typecheck job', status: 'completed', conclusion: 'failure' as string | null,
    steps: [{ number: 1, name: 'Checkout', status: 'completed', conclusion: 'success' },
      { number: 2, name: 'Run tsc', status: 'completed', conclusion: 'failure' }] }
  const hooks = { before: undefined as ((path: string) => void) | undefined,
    override: undefined as ((path: string, counts: { head: number; check: number }) => unknown) | undefined,
    log: undefined as (() => void) | undefined }
  const logData = { value: Buffer.from('Typecheck diagnostic from actual job log\n') }, logRequests: ActionsJobLogRequest[] = []
  const cfg = { apiUrl: 'https://api.github.com', mode: 'pat' as const, token: 'synthetic-test-credential',
    allowedRepos: ['org/repo'], writableRepos: [] }
  const http: GitHubHttp = { async readActionsJobLog(input) {
    hooks.log?.(); logRequests.push(input)
    const startByte = input.startByte ?? Math.max(0, logData.value.length - input.maxBytes)
    const data = logData.value.subarray(startByte, startByte + input.maxBytes)
    return { data, startByte, endByte: startByte + data.length, totalBytes: logData.value.length, sha256: createHash('sha256').update(data).digest('hex') }
  }, async request<T>(method: string, path: string, _body?: unknown, _headers?: Record<string, string>, signal?: AbortSignal) {
    seen.push({ method, path, signal })
    hooks.before?.(path)
    if (path === PR) headCalls++
    if (path === CHECK) checkCalls++
    const override = hooks.override?.(path, { head: headCalls, check: checkCalls })
    let data: unknown = override
    if (data === undefined) {
      if (path === PR) data = { head: { sha: SHA } }
      else if (path === CHECK) data = structuredClone(check)
      else if (path.startsWith(`${CHECK}/annotations?`)) {
        const page = Number(new URL(path, 'https://api.github.com').searchParams.get('page'))
        data = annotations.slice((page - 1) * 100, page * 100)
      } else if (path === '/repos/org/repo/actions/jobs/91') data = structuredClone(job)
      else throw new Error(`Unexpected test API path: ${path}`)
    }
    return { status: 200, data: data as T }
  } }
  const github = new GitHubIdentity(cfg, createLogger('check-evidence', 'error'), http)
  const originalAllowed = github.repoAllowed.bind(github)
  github.repoAllowed = repo => readable && originalAllowed(repo)
  const input: PullRequestCheckEvidenceInput = { repo: 'Org/Repo', number: 4, checkRunId: 71,
    assertCurrent() { if (!active) throw new Error('Run stopped') } }
  return { github, input, seen, hooks, check, job, logData, logRequests, read: (over: Partial<PullRequestCheckEvidenceInput> = {}) =>
    readPullRequestCheckEvidence(github, { ...input, ...over }), stop() { active = false }, revoke() { readable = false } }
}

describe('PR failure evidence is scoped to a verified repository check and head', () => {
  it('returns actionable check output and annotation positions through real GitHubIdentity without fetching response URLs', async () => {
    const t = fixture(), result = await t.read()
    expect(result).toMatchObject({ repo: 'org/repo', number: 4, head: SHA, currentHead: SHA, headCurrent: true, checkCurrent: true,
      status: 'ready', check: { id: 71, outcome: 'failed', conclusion: 'failure' },
      output: { title: { text: 'Typecheck failed', truncated: false } },
      annotations: { complete: true, available: true, total: 1, pagesRead: 1,
        items: [{ path: { text: 'src/file-1.ts' }, startLine: 1, endLine: 1, level: 'failure', message: { text: 'Expected string, got number (1)' } }] },
      actions: { status: 'not_mapped' }, coverage: { logsDownloaded: false, textTruncated: false } })
    expect(t.seen.map(call => call.path)).toEqual([PR, CHECK, `${CHECK}/annotations?per_page=100&page=1`, CHECK, PR])
    expect(t.seen.every(call => call.method === 'GET')).toBe(true)
    expect(JSON.stringify(result)).not.toMatch(/synthetic-test-credential|attacker.example/)
  })

  it.each(['id', 'head', 'repo'] as const)('rejects a check with mismatched %s before reading any evidence pages', mismatch => {
    const t = fixture()
    if (mismatch === 'id') t.check.id = 72
    if (mismatch === 'head') t.check.head_sha = NEXT
    if (mismatch === 'repo') t.check.url = 'https://api.github.com/repos/another/repo/check-runs/71'
    return expect(t.read()).rejects.toMatchObject({ code: 'check_mismatch' }).then(() => expect(t.seen).toHaveLength(2))
  })

  it('requires a prior head pin to still be current before fetching the selected check', async () => {
    const t = fixture()
    await expect(t.read({ expectedHead: NEXT })).rejects.toMatchObject({ code: 'head_changed' })
    expect(t.seen.map(call => call.path)).toEqual([PR])
  })

  it('retains old-head evidence only as head_changed when a new commit arrives during the read', async () => {
    const t = fixture()
    t.hooks.override = (path, count) => path === PR && count.head === 2 ? { head: { sha: NEXT } } : undefined
    expect(await t.read()).toMatchObject({ status: 'head_changed', head: SHA, currentHead: NEXT, headCurrent: false })
  })

  it('marks check output and annotation growth during pagination as a changed snapshot', async () => {
    const t = fixture()
    t.hooks.override = (path, count) => path === CHECK && count.check === 2
      ? { ...t.check, output: { ...t.check.output, annotations_count: 2, summary: 'Two errors now' } } : undefined
    expect(await t.read()).toMatchObject({ status: 'check_changed', checkCurrent: false,
      annotations: { complete: false, reason: 'check_changed' } })
  })

  it('reads all annotation pages rather than treating the first hundred as a complete report', async () => {
    const t = fixture({ annotations: Array.from({ length: 101 }, (_, i) => annotation(i + 1)) })
    const result = await t.read()
    expect(result.annotations).toMatchObject({ total: 101, pagesRead: 2, complete: true, nextPage: null })
    expect(result.annotations.items).toHaveLength(101)
    expect(result.annotations.items.at(-1)?.startLine).toBe(101)
  })

  it('reports a bounded page range and supports explicit continuation on the same head/check', async () => {
    const t = fixture({ annotations: Array.from({ length: 101 }, (_, i) => annotation(i + 1)) })
    expect(await t.read({ maxAnnotationPages: 1 })).toMatchObject({ status: 'partial',
      annotations: { complete: false, pagesRead: 1, nextPage: 2, reason: 'page_limit' } })
    const next = await t.read({ expectedHead: SHA, annotationPage: 2 })
    expect(next.annotations).toMatchObject({ complete: false, pagesRead: 1, nextPage: null, reason: 'partial_range' })
    expect(next.annotations.items).toHaveLength(1)
    expect(next.annotations.items[0]?.startLine).toBe(101)
  })

  it('does not call a repeated or short pagination boundary complete', async () => {
    const t = fixture({ annotations: Array.from({ length: 100 }, (_, i) => annotation(i + 1)), total: 200 })
    t.hooks.override = path => path === `${CHECK}/annotations?per_page=100&page=2`
      ? Array.from({ length: 100 }, (_, i) => annotation(i + 1)) : undefined
    expect(await t.read()).toMatchObject({ status: 'partial', annotations: { complete: false, reason: 'inconsistent_page' } })
    const short = fixture({ annotations: [annotation()], total: 2 })
    expect(await short.read()).toMatchObject({ status: 'partial', annotations: { complete: false, reason: 'inconsistent_page' } })
  })

  it('bounds all evidence text and explicitly records truncation without inventing a passing conclusion', async () => {
    const t = fixture({ annotations: Array.from({ length: 101 }, (_, i) => ({ ...annotation(i + 1), message: 'M'.repeat(20_000) })) })
    t.check.output.summary = 'S'.repeat(80_000); t.check.output.text = 'T'.repeat(80_000)
    const result = await t.read()
    expect(result).toMatchObject({ status: 'partial', check: { outcome: 'failed' },
      output: { summary: { totalChars: 80_000, truncated: true }, text: { totalChars: 80_000, truncated: true } },
      annotations: { complete: false, reason: 'text_limit', textTruncated: true }, coverage: { textLimitChars: 64_000, textTruncated: true } })
    expect(result.coverage.returnedChars).toBeLessThanOrEqual(64_000)
    expect(t.seen.some(call => call.path.endsWith('page=2'))).toBe(false)
    expect(JSON.stringify(result).length).toBeLessThan(150_000)
  })

  it.each([['skipped', 'skipped'], ['neutral', 'neutral'], ['success', 'reported_success'], [null, 'unknown']] as const)(
    'does not promote the conclusion %s to all-tests-passed', async (conclusion, expected) => {
      const t = fixture({ annotations: [] }); t.check.conclusion = conclusion
      expect(await t.read()).toMatchObject({ check: { outcome: expected }, annotations: { total: 0, complete: true } })
    })

  it('distinguishes a still-running check from a successful check', async () => {
    const t = fixture({ annotations: [] }); t.check.status = 'in_progress'; t.check.conclusion = null
    expect(await t.read()).toMatchObject({ check: { outcome: 'pending', status: 'in_progress' } })
  })

  it.each([403, 404, 429, 503])('keeps output but marks annotation HTTP %s unavailable', async status => {
    const t = fixture()
    t.hooks.before = path => { if (path.includes('/annotations?')) throw new GitHubApiError(status, 'synthetic API denial') }
    const result = await t.read()
    expect(result).toMatchObject({ status: 'partial', check: { outcome: 'failed' },
      annotations: { available: false, complete: false, items: [], nextPage: 1 } })
    expect(result.annotations.reason).not.toBeUndefined()
    expect(t.seen.at(-1)?.path).toBe(PR)
  })

  it('does not swallow unexpected provider/programming errors as an empty report', async () => {
    const t = fixture(), error = new Error('synthetic unexpected transport failure')
    t.hooks.before = path => { if (path.includes('/annotations?')) throw error }
    await expect(t.read()).rejects.toBe(error)
  })

  it('does not erase a permission failure of the check itself or the final head verification', async () => {
    for (const failAt of [CHECK, 'final-head']) {
      const t = fixture(), denied = new GitHubApiError(403, 'synthetic denial')
      let heads = 0
      t.hooks.before = path => { if (path === PR) heads++; if (path === failAt || failAt === 'final-head' && heads === 2) throw denied }
      await expect(t.read()).rejects.toBe(denied)
    }
  })

  it('honors revocation during the identity token-await before any HTTP request starts', async () => {
    const t = fixture(), token = t.github.token.bind(t.github)
    t.github.token = async (owner, signal) => { const result = await token(owner, signal); t.revoke(); return result }
    await expect(t.read()).rejects.toMatchObject({ code: 'repository_denied' })
    expect(t.seen).toEqual([])
  })

  it('does not expose ready evidence after cancellation while the last head read returns', async () => {
    const t = fixture(), controller = new AbortController()
    let heads = 0
    t.hooks.before = path => { if (path === PR && ++heads === 2) controller.abort(new Error('Late cancellation')) }
    await expect(t.read({ signal: controller.signal })).rejects.toThrow('Late cancellation')
  })

  it.each(['stopped', 'revoked', 'aborted'] as const)('rechecks %s immediately after every provider await', async mode => {
    const t = fixture(), controller = new AbortController()
    t.hooks.before = path => {
      if (!path.includes('/annotations?')) return
      if (mode === 'stopped') t.stop()
      if (mode === 'revoked') t.revoke()
      if (mode === 'aborted') controller.abort(new Error('Request cancelled'))
    }
    await expect(t.read({ signal: controller.signal })).rejects.toThrow(mode === 'stopped' ? 'Run stopped' : mode === 'aborted' ? 'Request cancelled' : 'repository_denied')
    expect(t.seen).toHaveLength(3)
    expect(t.seen.every(call => call.signal === controller.signal)).toBe(true)
  })

  it('maps the exact check/head/run, downloads failed-job logs and rechecks the job', async () => {
    const t = fixture({ detailsUrl: 'https://github.com/Org/Repo/actions/runs/81/job/91' })
    expect(await t.read()).toMatchObject({ actions: { status: 'available', runId: 81, jobId: 91, complete: true,
      logs: { status: 'available', text: 'Typecheck diagnostic from actual job log\n', complete: true }, steps: [{ number: 1, conclusion: 'success' }, { number: 2, name: { text: 'Run tsc' }, conclusion: 'failure' }] } })
    expect(t.seen.filter(call => call.path.includes('/actions/')).map(call => call.path)).toEqual(['/repos/org/repo/actions/jobs/91', '/repos/org/repo/actions/jobs/91'])
  })

  it.each(['https://evil.example/org/repo/actions/runs/81/job/91', 'https://github.com/other/repo/actions/runs/81/job/91',
    'https://github.com/org/repo/actions/runs/81/job/91?redirect=elsewhere', 'https://user:secret@github.com/org/repo/actions/runs/81/job/91'])('does not follow an untrusted Actions locator %s', async detailsUrl => {
    const t = fixture({ detailsUrl })
    expect(await t.read()).toMatchObject({ actions: { status: 'not_mapped' } })
    expect(t.seen.some(call => call.path.includes('/actions/'))).toBe(false)
  })

  it.each(['head', 'run', 'check', 'repo'] as const)('rejects Actions metadata from another %s without mixing its steps into the evidence', async mismatch => {
    const t = fixture({ detailsUrl: 'https://github.com/org/repo/actions/runs/81/job/91' })
    if (mismatch === 'head') t.job.head_sha = NEXT
    if (mismatch === 'run') t.job.run_id = 99
    if (mismatch === 'check') t.job.check_run_url = 'https://api.github.com/repos/org/repo/check-runs/72'
    if (mismatch === 'repo') t.job.check_run_url = 'https://api.github.com/repos/other/repo/check-runs/71'
    expect(await t.read()).toMatchObject({ status: 'partial', actions: { status: 'unavailable', reason: 'job_mismatch' } })
  })

  it('preserves generic failure evidence when Actions-read permission is unavailable', async () => {
    const t = fixture({ detailsUrl: 'https://github.com/org/repo/actions/runs/81/job/91' })
    t.hooks.before = path => { if (path.includes('/actions/')) throw new GitHubApiError(403, 'Actions permission unavailable') }
    expect(await t.read()).toMatchObject({ status: 'partial', annotations: { complete: true },
      actions: { status: 'unavailable', reason: 'permission_denied' } })
  })

  it.each([{ repo: 'org/../repo' }, { repo: 'org/repo?token=bad' }, { number: 0 }, { checkRunId: 0 },
    { maxAnnotationPages: 6 }, { annotationPage: 0 }, { expectedHead: 'main' }])('rejects invalid targets before any request (%j)', async patch => {
    const t = fixture()
    await expect(t.read(patch)).rejects.toMatchObject({ code: 'invalid_input' })
    expect(t.seen).toEqual([])
  })
})


describe('failed-job logs remain within the original check/head/source lease', () => {
  const mapped = { detailsUrl: 'https://github.com/org/repo/actions/runs/81/job/91' }
  it('returns partial and an honest cause when Actions logs are not accessible', async () => {
    const t = fixture(mapped); t.hooks.log = () => { throw new GitHubJobLogError('permission_denied') }
    expect(await t.read()).toMatchObject({ status: 'partial', actions: { status: 'available', complete: false,
      logs: { status: 'unavailable', reason: 'permission_denied' } }, coverage: { logsDownloaded: false } })
  })
  it('discards bytes when the job no longer belongs to the pinned run after download', async () => {
    const t = fixture(mapped); t.hooks.log = () => { t.job.run_id = 999 }
    expect(await t.read()).toMatchObject({ status: 'partial', actions: { logs: { status: 'unavailable', reason: 'job_changed' } }, coverage: { logsDownloaded: false } })
  })
  it('does not expose downloaded text after authority changes at the I/O boundary', async () => {
    const t = fixture(mapped); t.hooks.log = () => t.stop()
    await expect(t.read()).rejects.toThrow('Run stopped')
  })
  it('does not mix an in-progress rerun with the old completed log', async () => {
    const t = fixture(mapped); t.hooks.log = () => { t.job.status = 'in_progress'; t.job.conclusion = null }
    expect(await t.read()).toMatchObject({ status: 'partial', actions: { logs: { status: 'unavailable', reason: 'job_changed' } } })
  })
  it('does not download a mapped success job unless the caller asks for a window', async () => {
    const t = fixture(mapped); t.job.conclusion = 'success'; t.check.conclusion = 'success'
    let calls = 0; t.hooks.log = () => { calls++ }
    expect(await t.read()).toMatchObject({ actions: { logs: { status: 'not_requested' } } }); expect(calls).toBe(0)
    expect(await t.read({ logStartByte: 0 })).toMatchObject({ actions: { logs: { status: 'available' } } }); expect(calls).toBe(1)
  })
  it.each([{ logStartByte: -1 }, { logStartByte: 0.5 }, { logMaxBytes: 65537 }, { logMaxBytes: 0 }, { logMaxLines: 501 }])('rejects invalid log window %j before provider I/O', async patch => {
    const t = fixture(mapped); await expect(t.read(patch)).rejects.toMatchObject({ code: 'invalid_input' }); expect(t.seen).toEqual([])
  })
})


describe('PR evidence exposes useful bounded log search through the real identity', () => {
  it('finds middle-log failure text and retains the exact check/head/job chain', async () => {
    const t = fixture({ detailsUrl: 'https://github.com/org/repo/actions/runs/81/job/91' })
    t.logData.value = Buffer.from('test passed\n'.repeat(70_000) + 'ReferenceError: document is not defined\n' + 'coverage detail\n'.repeat(70_000))
    const result = await t.read({ expectedHead: SHA, logQuery: 'ReferenceError', logMaxLines: 7 })
    expect(result).toMatchObject({ status: 'ready', headCurrent: true, checkCurrent: true,
      actions: { complete: true, jobId: 91, logs: { mode: 'search', complete: true, matches: 1, nextStartByte: null } }, coverage: { logsDownloaded: true } })
    if (result.actions.status !== 'available' || result.actions.logs.status !== 'available' || !('windows' in result.actions.logs)) throw new Error('Expected search window')
    expect(result.actions.logs.windows[0]?.text).toContain('ReferenceError: document is not defined')
    expect(t.logRequests[0]).toMatchObject({ repo: 'org/repo', jobId: 91, startByte: 0, maxBytes: JOB_LOG_SCAN_BYTES })
    expect(t.seen.filter(call => call.path.endsWith('/jobs/91'))).toHaveLength(2)
  })
  it('retains partial/no-match coverage when a scan does not reach the end', async () => {
    const t = fixture({ detailsUrl: 'https://github.com/org/repo/actions/runs/81/job/91' })
    t.logData.value = Buffer.from('x'.repeat(JOB_LOG_SCAN_BYTES + 500) + '\nFINDME\n')
    const first = await t.read({ logQuery: 'FINDME' })
    if (first.actions.status !== 'available' || first.actions.logs.status !== 'available' || !('windows' in first.actions.logs)) throw new Error('Expected search window')
    expect(first.status).toBe('partial'); expect(first.actions.logs).toMatchObject({ matches: 0, complete: false, truncated: true })
    const next = await t.read({ logQuery: 'FINDME', logStartByte: first.actions.logs.nextStartByte! })
    expect(next).toMatchObject({ actions: { logs: { matches: 1 } } })
  })
  it.each([{ logQuery: '' }, { logQuery: '   ' }, { logQuery: 'x'.repeat(513) }, { logMaxBytes: 3 }])('rejects invalid window contract %j before network', async patch => {
    const t = fixture(); await expect(t.read(patch)).rejects.toMatchObject({ code: 'invalid_input' }); expect(t.seen).toEqual([])
  })
})
