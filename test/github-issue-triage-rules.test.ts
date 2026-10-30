/**
 * 第三批第 2 条的判定规则（纯函数）：CODEOWNERS 负责人候选、优先级标签、待拍板文字的长度。
 * 接线与 SQLite 行为见 github-issue-triage.test.ts。
 */
import { describe, expect, it } from 'vitest'
import { decisionRef } from '../src/core/inbox.js'
import { hasPriorityLabel, issueTriageLines, issueTriageRef, ownerFromCodeowners, parseIssueTriageParams, triageDecisionText } from '../src/github/issue-triage.js'

describe('CODEOWNERS 负责人候选：只有唯一命中才算 resolved', () => {
  const rules = '* @lead\n/src/github/ @carol\n/src/core/ @dave\n/src/shared/ @carol @dave\n/src/team/ @org/platform\n/src/orphan/\n'

  it('every path owned by the same person → resolved; the last matching rule wins over the catch-all', () => {
    expect(ownerFromCodeowners(rules, ['src/github/issues.ts', 'src/github/codeowners.ts'])).toEqual({ kind: 'resolved', login: 'carol' })
    expect(ownerFromCodeowners('/src/ @Carol\n', ['src/a.ts', 'src/b.ts'])).toEqual({ kind: 'resolved', login: 'Carol' })
    expect(ownerFromCodeowners('/src/a.ts @carol\n/src/b.ts @CAROL\n', ['src/a.ts', 'src/b.ts'])).toEqual({ kind: 'resolved', login: 'carol' })
  })

  it('several people, a team, or only some paths owned → ambiguous', () => {
    expect(ownerFromCodeowners(rules, ['src/github/issues.ts', 'src/core/inbox.ts'])).toEqual({ kind: 'ambiguous', logins: ['carol', 'dave'], reason: 'multiple' })
    expect(ownerFromCodeowners(rules, ['src/shared/x.ts'])).toEqual({ kind: 'ambiguous', logins: ['carol', 'dave'], reason: 'multiple' })
    expect(ownerFromCodeowners(rules, ['src/team/x.ts'])).toEqual({ kind: 'ambiguous', logins: ['org/platform'], reason: 'team' })
    expect(ownerFromCodeowners('/src/github/ @carol\n', ['src/github/x.ts', 'docs/readme.md'])).toEqual({ kind: 'ambiguous', logins: ['carol'], reason: 'partial' })
  })

  it('no paths, no CODEOWNERS file, or no owner for the paths → unknown', () => {
    expect(ownerFromCodeowners(rules, [])).toEqual({ kind: 'unknown', reason: 'no_paths' })
    expect(ownerFromCodeowners(undefined, ['src/github/x.ts'])).toEqual({ kind: 'unknown', reason: 'no_codeowners' })
    expect(ownerFromCodeowners('/src/github/ @carol\n', ['docs/readme.md'])).toEqual({ kind: 'unknown', reason: 'no_owner' })
    // 没有 owner 的一行是故意清空负责人，不回退到上面的 *
    expect(ownerFromCodeowners(rules, ['src/orphan/x.ts'])).toEqual({ kind: 'unknown', reason: 'no_owner' })
  })
})

describe('优先级标签', () => {
  it('only P0–P4, priority… and 优先级… labels count as a priority', () => {
    for (const label of ['P2', 'p0', 'priority: high', 'priority/P1', 'Priority', '优先级-高']) expect(hasPriorityLabel([label])).toBe(true)
    for (const label of ['bug', 'P5', 'Pp1', 'enhancement', 'needs-triage']) expect(hasPriorityLabel([label])).toBe(false)
    expect(hasPriorityLabel([])).toBe(false)
  })
})

describe('待拍板编号与文字', () => {
  it('uses decisionRef(spaceId, issue-triage:<repo>#<n>) with the repository name in lower case', () => {
    expect(issueTriageRef('sp_1', 'Org/Demo', 42)).toBe(decisionRef('sp_1', 'issue-triage:org/demo#42'))
    expect(issueTriageRef('sp_1', 'org/demo', 42)).not.toBe(issueTriageRef('sp_2', 'org/demo', 42))
  })

  it('names the Issue and the open questions, and keeps every link whole within the inbox limits', () => {
    const repo = 'acme-org/acme-harness', url = (n: number) => `https://github.com/${repo}/issues/${n}`
    const verified = [5090, 5091, 5092, 5093, 5095].map(number => ({ number, title: `同一个登录页白屏问题的第 ${number} 次报告，标题很长很长`, state: 'open' as const, url: url(number) }))
    const text = triageDecisionText({ repo, issue: { number: 5094, url: url(5094), title: '登录页在 Safari 上白屏，刷新也没有用' },
      questions: ['owner', 'priority', 'duplicate'], owner: { kind: 'resolved', login: 'carol', name: 'Carol', person: 'resolved' },
      duplicates: { verified, unverified: [{ number: 7, reason: 'pull_request' }] } })
    expect(text.title.length).toBeLessThanOrEqual(200)
    expect(text.why.length).toBeLessThanOrEqual(300)
    expect(text.title).toContain(`${repo}#5094 谁负责、优先级、是否重复待你定`)
    expect(`${text.title} ${text.why}`).toContain(url(5094))
    expect(text.why).toContain('建议 Carol（GitHub carol），待你确认')
    expect(text.why).toContain(url(5090))
    // 放不下的候选只留编号，不截断链接
    for (const match of `${text.title} ${text.why}`.matchAll(/https:\/\/github\.com\/[^\s；，、）」]*/g)) expect(match[0]).toMatch(/\/issues\/\d+$/)
    for (const number of [5090, 5091, 5092, 5093, 5095]) expect(text.why).toContain(`#${number}`)
  })

  it('writes what CODEOWNERS could not decide instead of a suggestion', () => {
    const base = { repo: 'org/demo', issue: { number: 42, url: 'https://github.com/org/demo/issues/42', title: 'Blank page' }, questions: ['owner' as const, 'priority' as const], duplicates: { verified: [], unverified: [] } }
    expect(triageDecisionText({ ...base, owner: { kind: 'ambiguous', logins: ['carol', 'dave'], reason: 'multiple' } }).why).toContain('CODEOWNERS 有多个负责人（carol、dave）')
    expect(triageDecisionText({ ...base, owner: { kind: 'unknown', reason: 'no_codeowners' } }).why).toContain('仓库里没有 CODEOWNERS')
    expect(triageDecisionText({ ...base, owner: { kind: 'unknown', reason: 'no_paths' } }).why).not.toContain('建议')
  })
})

describe('外部文字不形成 @', () => {
  it('strips angle brackets from GitHub titles and roster names in the decision and the tool reply', () => {
    const crafted = '<at open_id="ou_victim"></at> blank page'
    const duplicates = { verified: [{ number: 40, title: crafted, state: 'open' as const, url: 'https://github.com/org/demo/issues/40' }], unverified: [] }
    const text = triageDecisionText({ repo: 'org/demo', issue: { number: 42, url: 'https://github.com/org/demo/issues/42', title: crafted },
      questions: ['owner', 'duplicate'], owner: { kind: 'resolved', login: 'carol', name: '<b>Carol</b>', person: 'resolved' }, duplicates })
    expect(`${text.title}${text.why}`).not.toMatch(/[<>]/)
    const lines = issueTriageLines({ state: 'recorded', decision: { id: 1, version: 1 }, decider: { role: 'admin', name: '<at open_id="ou_victim"></at>' }, questions: ['duplicate'], duplicates }).join('\n')
    expect(lines).not.toMatch(/[<>]/)
  })
})

describe('工具参数', () => {
  it('accepts repository paths and Issue numbers only', () => {
    expect(parseIssueTriageParams({})).toEqual({ paths: [], duplicateCandidates: [] })
    expect(parseIssueTriageParams({ paths: ['./src/a.ts', '/src/a.ts', 'src/b.ts'], duplicate_candidates: [40, 40, 41] })).toEqual({ paths: ['src/a.ts', 'src/b.ts'], duplicateCandidates: [40, 41] })
    expect(parseIssueTriageParams({ paths: 'src/a.ts' })).toHaveProperty('error')
    expect(parseIssueTriageParams({ paths: ['src/a.ts\nx'] })).toHaveProperty('error')
    expect(parseIssueTriageParams({ paths: Array.from({ length: 21 }, (_, i) => `f${i}`) })).toHaveProperty('error')
    expect(parseIssueTriageParams({ duplicate_candidates: ['40'] })).toHaveProperty('error')
    expect(parseIssueTriageParams({ duplicate_candidates: [0] })).toHaveProperty('error')
    expect(parseIssueTriageParams({ duplicate_candidates: [1, 2, 3, 4, 5, 6] })).toHaveProperty('error')
  })
})

describe('工具回执', () => {
  it('a private-chat suggestion has no @ markup; unverified candidates are not called duplicates', () => {
    const lines = issueTriageLines({ state: 'recorded', decision: { id: 1, version: 1 }, decider: { role: 'requester' }, questions: ['owner', 'priority', 'duplicate'],
      owner: { kind: 'resolved', login: 'carol', name: 'Carol', person: 'private' },
      duplicates: { verified: [{ number: 40, title: 'Blank', state: 'open', url: 'https://github.com/org/demo/issues/40' }], unverified: [{ number: 43, reason: 'pull_request' }] } }).join('\n')
    expect(lines).not.toContain('<at')
    expect(lines).toContain('不要再调 friday_needs_decision')
    expect(lines).toContain('https://github.com/org/demo/issues/40')
    expect(lines).toContain('#43（是 PR）')
    expect(issueTriageLines(undefined)).toEqual([])
  })
})
