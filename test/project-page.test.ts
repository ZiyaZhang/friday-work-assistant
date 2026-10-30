import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import type { ProjectItem, ProjectRepoStatus, ProjectView } from '../src/github/project-view.js'
import { renderProjectPage } from '../src/web/project-page.js'

const T = Date.parse('2026-09-19T00:00:00Z')
function repo(name = 'org/a', patch: Partial<ProjectRepoStatus> = {}): ProjectRepoStatus {
  return { repo: name, snapshotId: 'sync-1', syncAt: T, lastCompleteSyncAt: T, stale: false,
    coverage: { complete: true, issues: { complete: true, pages: 1, items: 1, invalidItems: 0, duplicates: 0, reason: 'complete' }, pullRequests: { complete: true, pages: 1, items: 0, invalidItems: 0, duplicates: 0, reason: 'complete' } }, ...patch }
}
function item(number: number, patch: Partial<ProjectItem> = {}): ProjectItem {
  return { id: `org/a#${number}`, repo: 'org/a', number, kind: 'issue', title: `Issue ${number}`, state: 'open', stateReason: null,
    assignees: ['Alice'], url: `https://github.com/org/a/issues/${number}`, createdAt: T - 86400_000, updatedAt: T, closedAt: null, mergedAt: null, draft: null,
    createdToClosedMs: null, createdToMergedMs: null, syncAt: T, stale: false, coverage: { issueObservedAt: T, pullObservedAt: null, mergeStateKnown: false }, ...patch }
}
function view(items = [item(1)], repositories = [repo()]): ProjectView {
  return { items, repositories, coverageComplete: repositories.every((x) => x.coverage.complete), stale: repositories.some((x) => x.stale) || items.some((x) => x.stale) }
}

describe('read-only project HTML', () => {
  it('starts from projects and provides named repo/assignee/state filters, source times and GitHub links', () => {
    const html = renderProjectPage(view())
    expect(html).toContain('<html lang="zh-CN">')
    expect(html).toContain('<h1>项目进展</h1>')
    expect(html).toContain('全部项目')
    expect(html).toContain('id="repo-filter"')
    expect(html).toContain('id="assignee-filter"')
    expect(html).toContain('<option value="__unassigned__">未指派</option>')
    expect(html).toContain('id="state-filter"')
    expect(html).toContain('2026-09-19 00:00 UTC')
    expect(html).toContain('href="https://github.com/org/a/issues/1"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('不代表个人投入或工时')
    expect(html).toContain('name="viewport"')
    expect(html).toContain('@media(max-width:720px)')
  })

  it('makes incomplete pagination and stale records visible instead of rendering a false empty project', () => {
    const incomplete = repo('org/a', { stale: true, syncAt: T + 1000 })
    incomplete.coverage.complete = false
    incomplete.coverage.issues = { ...incomplete.coverage.issues, complete: false, reason: 'page_limit' }
    const html = renderProjectPage(view([item(9, { stale: true })], [incomplete]))
    expect(html).toContain('覆盖不全')
    expect(html).toContain('达到分页上限')
    expect(html).toContain('不能据此判断没有其他事项')
    expect(html).toContain('上次完整同步')
    expect(html).toContain('需更新')
    expect(html).toContain('<details class="coverage" open>')
    const empty = renderProjectPage(view([], [repo('org/a', { syncAt: null, lastCompleteSyncAt: null, stale: true, coverage: { ...incomplete.coverage } })]))
    expect(empty).toContain('尚未同步')
    expect(empty).toContain('不能判断项目为空')
  })

  it('distinguishes merge facts, closed duration and unknown merge information without estimating effort', () => {
    const html = renderProjectPage(view([
      item(1, { kind: 'pr', url: 'https://github.com/org/a/pull/1', state: 'closed', mergedAt: T, closedAt: T, createdToMergedMs: 90000_000, createdToClosedMs: 90000_000, coverage: { issueObservedAt: T, pullObservedAt: T, mergeStateKnown: true } }),
      item(2, { state: 'closed', closedAt: T, createdToClosedMs: 3600_000, assignees: [] }),
      item(3, { kind: 'pr', url: 'https://github.com/org/a/pull/3', state: 'closed' }),
    ]))
    expect(html).toContain('1 天 1 小时')
    expect(html).toContain('创建至合并')
    expect(html).toContain('创建至关闭')
    expect(html).toContain('合并信息未核实')
    expect(html).toContain('未指派')
    expect(html.match(/data-merged="true"/g)).toHaveLength(1)
  })

  it.each(['issue', 'pr'] as const)('keeps a closed %s closed when its closing time is unknown', (kind) => {
    const html = renderProjectPage(view([item(1, {
      kind, state: 'closed', closedAt: null,
      url: `https://github.com/org/a/${kind === 'pr' ? 'pull' : 'issues'}/1`,
    })]))
    expect(html).toContain('<span class="badge closed">已关闭</span>')
    expect(html).toContain('<strong>—</strong><small>关闭时间未知</small>')
    expect(html).not.toContain('尚未关闭')
    expect(html).not.toContain('<small>创建至关闭</small>')
  })

  it('uses the known merge time for a merged PR even when its closing time is missing', () => {
    const html = renderProjectPage(view([item(1, {
      kind: 'pr', url: 'https://github.com/org/a/pull/1', state: 'closed', closedAt: null,
      mergedAt: T, createdToMergedMs: 86400_000,
      coverage: { issueObservedAt: T, pullObservedAt: T, mergeStateKnown: true },
    })]))
    expect(html).toContain('<span class="badge merged">已合并</span>')
    expect(html).toContain('<strong>1 天</strong><small>创建至合并</small>')
    expect(html).not.toContain('尚未关闭')
    expect(html).not.toContain('关闭时间未知')
  })

  it('escapes all source text and attribute values, with no user-controlled script or external asset', () => {
    const attack = '</script><img src=x onerror="alert(1)">' + "' &"
    const html = renderProjectPage(view([item(1, { title: attack, assignees: [attack] })], [repo()]))
    expect(html).not.toContain(attack)
    expect(html).not.toContain('<img ')
    expect(html).toContain('&lt;/script&gt;&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&#39; &amp;')
    expect(html.match(/<script>/g)).toHaveLength(1)
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=/)
    expect(html).toContain("connect-src 'none'")
    const injectedRepo = 'org/a" onmouseover="bad'
    const repoHtml = renderProjectPage(view([], [repo(injectedRepo)]))
    expect(repoHtml).not.toContain('data-repo="org/a" onmouseover=')
  })

  it.each(['javascript:alert(1)', 'data:text/html,evil', 'http://github.com/org/a/issues/1', 'https://evil.test/org/a/issues/1', 'https://user:secret@github.com/org/a/issues/1', 'https://github.com/org/b/issues/1', 'https://github.com:444/org/a/issues/1'])(
    'rejects an unsafe or wrong issue URL: %s', (url) => {
      const html = renderProjectPage(view([item(1, { url })]))
      expect(html).toContain('链接未通过验证')
      expect(html).not.toContain('href=')
    },
  )

  it('allows an explicitly configured enterprise hostname and strips query/fragment data', () => {
    const html = renderProjectPage(view([item(1, { url: 'https://git.example.test/org/a/issues/1?token=SECRET#payload' })]), { allowedGitHubHosts: ['git.example.test'] })
    expect(html).toContain('href="https://git.example.test/org/a/issues/1"')
    expect(html).not.toContain('SECRET')
    expect(html).not.toContain('#payload')
  })

  it('never renders rows outside the already-authorized project set and has a useful no-project state', () => {
    const html = renderProjectPage(view([item(1), item(2, { repo: 'secret/repo', title: 'PRIVATE_SENTINEL' })]))
    expect(html).not.toContain('PRIVATE_SENTINEL')
    expect(renderProjectPage(view([], []))).toContain('尚未选择可查看的项目')
  })
})

describe('project filters execute locally', () => {
  it('combines repo, assignee and state filters, updates counts and empty states, without any network API', () => {
    type MockItem = { dataset: { repo: string; assignees: string; state: string; merged: string }; hidden: boolean }
    const a = { dataset: { repo: 'org/a', assignees: '["alice"]', state: 'open', merged: 'false' }, hidden: false }
    const b = { dataset: { repo: 'org/a', assignees: '["bob"]', state: 'closed', merged: 'true' }, hidden: false }
    const c = { dataset: { repo: 'org/b', assignees: '["alice"]', state: 'closed', merged: 'false' }, hidden: false }
    const unassigned = { dataset: { repo: 'org/b', assignees: '[]', state: 'open', merged: 'false' }, hidden: false }
    const project = (name: string, rows: MockItem[]) => {
      const empty = { hidden: true }
      return { dataset: { repo: name }, hidden: false, empty, querySelectorAll: () => rows, querySelector: () => empty }
    }
    const projects = [project('org/a', [a, b]), project('org/b', [c, unassigned])]
    const control = () => ({ value: '', listener: undefined as (() => void) | undefined, addEventListener(_event: string, fn: () => void) { this.listener = fn } })
    const controls = { 'repo-filter': control(), 'assignee-filter': control(), 'state-filter': control(), 'filtered-count': { textContent: '' } }
    const document = { getElementById: (id: keyof typeof controls) => controls[id], querySelectorAll: () => projects }
    const html = renderProjectPage(view())
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
    expect(script).toBeTruthy()
    expect(script).not.toMatch(/fetch|XMLHttpRequest|WebSocket|location|innerHTML|eval\(/)
    runInNewContext(script!, { document, JSON, Array, Boolean })
    expect(controls['filtered-count'].textContent).toContain('4 条记录')
    controls['repo-filter'].value = 'org/a'
    controls['assignee-filter'].value = 'bob'
    controls['state-filter'].value = 'merged'
    controls['state-filter'].listener!()
    expect([a.hidden, b.hidden, c.hidden]).toEqual([true, false, true])
    expect(projects[1]!.hidden).toBe(true)
    expect(controls['filtered-count'].textContent).toContain('1 条记录')
    controls['state-filter'].value = 'open'
    controls['state-filter'].listener!()
    expect(projects[0]!.empty.hidden).toBe(false)
    expect(controls['filtered-count'].textContent).toContain('0 条记录')
    controls['repo-filter'].value = ''
    controls['assignee-filter'].value = ''
    controls['state-filter'].value = 'closed'
    controls['state-filter'].listener!()
    expect([a.hidden, b.hidden, c.hidden]).toEqual([true, false, false])
    expect(unassigned.hidden).toBe(true)

    // “未指派”只依据实际 assignees 空数组，能和项目/状态同时使用。
    controls['assignee-filter'].value = '__unassigned__'
    controls['repo-filter'].value = 'org/b'
    controls['state-filter'].value = 'open'
    controls['assignee-filter'].listener!()
    expect([a.hidden, b.hidden, c.hidden, unassigned.hidden]).toEqual([true, true, true, false])
    expect(controls['filtered-count'].textContent).toContain('1 条记录')
    expect(projects[1]!.empty.hidden).toBe(true)
    controls['state-filter'].value = 'closed'
    controls['state-filter'].listener!()
    expect(unassigned.hidden).toBe(true)
    expect(projects[1]!.empty.hidden).toBe(false)
    expect(controls['filtered-count'].textContent).toContain('0 条记录')
    controls['repo-filter'].value = ''
    controls['assignee-filter'].value = ''
    controls['state-filter'].value = ''
    controls['repo-filter'].listener!()
    expect([a.hidden, b.hidden, c.hidden, unassigned.hidden]).toEqual([false, false, false, false])
    expect(controls['filtered-count'].textContent).toContain('4 条记录')
  })
})
