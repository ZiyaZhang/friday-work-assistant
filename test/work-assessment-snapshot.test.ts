import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { assertWorkAssessmentSnapshot, WorkAssessmentSourceBroker, type WorkAssessmentTarget } from '../src/github/work-assessment-snapshot.js'
import type { GitHubIdentity } from '../src/github/identity.js'

const COMMIT = 'a'.repeat(40), TREE = 'b'.repeat(40), SUBTREE = 'c'.repeat(40)
function fixture() {
  let allowed = true, current = true
  const content = Buffer.from('export const answer = 42\n')
  const sha = createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex')
  const rows = new Map<string, unknown>([
    [`/repos/org/repo/git/commits/${COMMIT}`, { sha: COMMIT, tree: { sha: TREE } }],
    [`/repos/org/repo/git/trees/${TREE}`, { sha: TREE, truncated: false, tree: [{ path: 'src', mode: '040000', type: 'tree', sha: SUBTREE }] }],
    [`/repos/org/repo/git/trees/${SUBTREE}`, { sha: SUBTREE, truncated: false, tree: [{ path: 'answer.ts', mode: '100644', type: 'blob', sha, size: content.length }] }],
    [`/repos/org/repo/git/blobs/${sha}`, { sha, encoding: 'base64', size: content.length, content: content.toString('base64') }],
  ])
  const api = vi.fn(async (_method: string, path: string, _body?: unknown, _owner?: string, before?: () => void): Promise<unknown> => {
    before?.()
    if (!rows.has(path)) throw new Error(`unexpected API path ${path}`)
    return structuredClone(rows.get(path))
  })
  const github = { api, repoAllowed: () => allowed } as unknown as Pick<GitHubIdentity, 'api' | 'repoAllowed'>
  const broker = new WorkAssessmentSourceBroker(github)
  const target: WorkAssessmentTarget = { kind: 'file', repo: 'org/repo', commit: COMMIT, path: 'src/answer.ts' }
  const check = () => { if (!current) throw new Error('revoked') }
  const read = (targets: WorkAssessmentTarget[] = [target]) => broker.read({ targets, assertCurrent: check })
  return { content, sha, rows, api, broker, target, read, deny: () => { allowed = false }, stop: () => { current = false } }
}

describe('assessment source broker: immutable bounded repository files', () => {
  it('uses only GET commit/tree/blob APIs and returns source hashes at the exact commit', async () => {
    const t = fixture(), result = await t.read()
    expect(result.gaps).toEqual([])
    expect(result.sources[0]).toMatchObject({ text: t.content.toString(), url: `https://github.com/org/repo/blob/${COMMIT}/src/answer.ts` })
    expect(() => assertWorkAssessmentSnapshot(result)).not.toThrow()
    expect(t.api.mock.calls).toHaveLength(4)
    for (const [method, path, body, owner, before] of t.api.mock.calls) {
      expect(method).toBe('GET'); expect(path).toMatch(/^\/repos\/org\/repo\/git\/(commits|trees|blobs)\/[a-f0-9]{40}$/)
      expect(body).toBeUndefined(); expect(owner).toBe('org'); expect(before).toBeTypeOf('function')
    }
  })
  it.each(['../secret', '/etc/passwd', 'src//answer.ts', 'src/./answer.ts', 'src/../secret', 'src\\answer.ts', 'src/answer\0.ts', 'a/'.repeat(21) + 'b'])(
    'rejects non-canonical path %s without any request', async path => {
      const t = fixture()
      await expect(t.read([{ ...t.target, kind: 'file', commit: COMMIT, path }])).rejects.toThrow('invalid_target')
      expect(t.api).not.toHaveBeenCalled()
    })
  it.each(['master', 'main', 'HEAD', 'a'.repeat(7), COMMIT + '?raw=1'])('rejects mutable/non-full ref %s', async commit => {
    const t = fixture()
    await expect(t.read([{ kind: 'file', repo: 'org/repo', commit, path: 'src/answer.ts' }])).rejects.toThrow('invalid_target')
    expect(t.api).not.toHaveBeenCalled()
  })
  it('requires every target in the same currently allowed repository', async () => {
    const t = fixture(); t.deny()
    await expect(t.read()).rejects.toThrow('denied'); expect(t.api).not.toHaveBeenCalled()
    await expect(t.read([t.target, { ...t.target, repo: 'other/repo' }])).rejects.toThrow('invalid_target')
    await expect(t.read([t.target, t.target])).rejects.toThrow('denied')
  })
  it.each(['symlink', 'submodule', 'directory', 'oversize', 'ambiguous', 'truncated'] as const)(
    'rejects %s rather than following filesystem-like indirection', async mode => {
      const t = fixture(), path = `/repos/org/repo/git/trees/${SUBTREE}`
      const tree = t.rows.get(path) as { truncated: boolean; tree: Record<string, unknown>[] }, entry = tree.tree[0]!
      if (mode === 'symlink') entry.mode = '120000'
      if (mode === 'submodule') { entry.type = 'commit'; entry.mode = '160000' }
      if (mode === 'directory') { entry.type = 'tree'; entry.mode = '040000' }
      if (mode === 'oversize') entry.size = 64_001
      if (mode === 'ambiguous') tree.tree.push({ ...entry })
      if (mode === 'truncated') tree.truncated = true
      await expect(t.read()).rejects.toThrow()
      expect(t.api.mock.calls.some(([, path]) => path.includes('/blobs/'))).toBe(false)
    })
  it.each(['sha', 'content', 'encoding', 'size', 'base64'] as const)('rejects inconsistent blob %s', async field => {
    const t = fixture(), blob = t.rows.get(`/repos/org/repo/git/blobs/${t.sha}`) as Record<string, unknown>
    if (field === 'sha') blob.sha = 'd'.repeat(40)
    if (field === 'content') blob.content = Buffer.from('x'.repeat(t.content.length)).toString('base64')
    if (field === 'encoding') blob.encoding = 'utf-8'
    if (field === 'size') blob.size = 1
    if (field === 'base64') blob.content = '!!!!'
    await expect(t.read()).rejects.toThrow()
  })
  it.each(['after_read', 'token_refresh'] as const)('rechecks authority at %s with no downstream reads', async when => {
    const t = fixture(), original = t.api.getMockImplementation()!
    t.api.mockImplementationOnce(async (...args) => {
      if (when === 'token_refresh') { t.stop(); args[4]?.() }
      const value = await original(...args); t.deny(); return value
    })
    await expect(t.read()).rejects.toThrow()
    expect(t.api).toHaveBeenCalledTimes(1)
  })
  it('refuses invalid UTF-8 even when the exact blob hash matches', async () => {
    const t = fixture(), bytes = Buffer.from([0xff, 0xff]), sha = createHash('sha1').update('blob 2\0').update(bytes).digest('hex')
    const tree = t.rows.get(`/repos/org/repo/git/trees/${SUBTREE}`) as { tree: Record<string, unknown>[] }
    Object.assign(tree.tree[0]!, { sha, size: 2 })
    t.rows.set(`/repos/org/repo/git/blobs/${sha}`, { sha, size: 2, encoding: 'base64', content: bytes.toString('base64') })
    await expect(t.read()).rejects.toThrow('unsupported_file')
  })
})

function issueFixture() {
  const t = fixture()
  const raw = { number: 7, title: '插件页面空白', body: '打开插件页面无法加载列表', user: { login: 'reporter' },
    state: 'open', assignees: [], labels: [], comments: 1,
    created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-20T00:00:00Z' }
  t.rows.set('/repos/org/repo/issues/7', raw)
  t.rows.set('/repos/org/repo/issues/7/comments?per_page=100&page=1', [
    { id: 9, body: '可以稳定复现', user: { login: 'reporter', type: 'User' }, created_at: raw.updated_at },
  ])
  t.rows.set('/repos/org/repo/issues/7/timeline?per_page=100&page=1', [{ event: 'commented', id: 9 }])
  return { ...t, raw, target: { kind: 'issue' as const, repo: 'org/repo', number: 7 },
    read: () => t.read([{ kind: 'issue', repo: 'org/repo', number: 7 }]) }
}

describe('assessment source broker: complete issue/PR snapshots', () => {
  it('retains a complete issue body/comments/timeline and generates canonical links', async () => {
    const t = issueFixture(), result = await t.read()
    expect(result.sources.map(source => source.text).join('\n')).toContain('可以稳定复现')
    expect(result.sources.some(source => source.url.endsWith('#issuecomment-9'))).toBe(true)
    expect(t.api.mock.calls.filter(([, path]) => path === '/repos/org/repo/issues/7')).toHaveLength(2)
    for (const call of t.api.mock.calls) expect(call[4]).toBeTypeOf('function')
  })
  it('does not accept a missing comment or an issue that changes during paging', async () => {
    const t = issueFixture(); t.raw.comments = 2
    await expect(t.read()).rejects.toThrow('incomplete')
    t.raw.comments = 1
    const original = t.api.getMockImplementation()!
    t.api.mockImplementation(async (...args) => {
      const value = await original(...args)
      if (args[1].includes('/comments?')) t.raw.body = '讨论已经变化'
      return value
    })
    await expect(t.read()).rejects.toThrow('incomplete')
  })
  function prFixture() {
    const t = fixture(), base = '/repos/org/repo/pulls/3'
    const raw = { number: 3, title: '修复加载', body: '处理空列表', state: 'open', head: { sha: COMMIT }, base: { sha: TREE },
      comments: 1, review_comments: 1, changed_files: 1, updated_at: '2026-09-20T00:00:00Z' }
    const files: Record<string, unknown>[] = [{ filename: 'src/answer.ts', patch: '@@ -1 +1 @@\n-old\n+new', additions: 1, deletions: 1 }]
    t.rows.set(base, raw)
    t.rows.set(`${base}/files?per_page=100&page=1`, files)
    t.rows.set(`${base}/reviews?per_page=100&page=1`, [{ id: 11, body: '还需要测试', state: 'CHANGES_REQUESTED' }])
    t.rows.set(`${base}/comments?per_page=100&page=1`, [{ id: 12, body: '这里加上边界判断', path: 'src/answer.ts', line: 1 }])
    t.rows.set('/repos/org/repo/issues/3/comments?per_page=100&page=1', [{ id: 13, body: '已有同事在处理' }])
    return { ...t, raw, files, read: () => t.read([{ kind: 'pull_request', repo: 'org/repo', number: 3 }]) }
  }
  it('includes general comments as well as reviews and inline comments for PR assessment', async () => {
    const t = prFixture(), result = await t.read(), content = result.sources.map(source => source.text).join('\n')
    expect(result.gaps).toEqual([])
    for (const text of ['已有同事在处理', '还需要测试', '这里加上边界判断', '-old']) expect(content).toContain(text)
    expect(result.sources.every(source => source.url === 'https://github.com/org/repo/pull/3')).toBe(true)
  })
  it.each(['absent', 'truncated'] as const)('marks %s patch coverage explicitly, not a complete review', async mode => {
    const t = prFixture()
    if (mode === 'absent') delete t.files[0]!.patch
    else t.files[0]!.additions = 3
    expect((await t.read()).gaps).toHaveLength(1)
  })
  it('rejects changed PR metadata and mismatched comment counts', async () => {
    const t = prFixture(); t.raw.comments = 2
    await expect(t.read()).rejects.toThrow('changed')
    t.raw.comments = 1
    const original = t.api.getMockImplementation()!
    t.api.mockImplementation(async (...args) => {
      const result = await original(...args)
      if (args[1].includes('/files?')) t.raw.head.sha = SUBTREE
      return result
    })
    await expect(t.read()).rejects.toThrow('changed')
  })
})
