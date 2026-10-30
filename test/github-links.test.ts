import { describe, expect, it } from 'vitest'
import { linkGithubRefs, linkedGithubTitle, rememberGithubRefs, type GithubRefs } from '../src/core/github-links.js'

const seen = (): GithubRefs => {
  const refs: GithubRefs = {}
  rememberGithubRefs(refs, [{ type: 'content', content: { type: 'text', text: JSON.stringify({
    url: 'https://github.com/acme-org/acme-harness/pull/5095', head: 'abc',
    reviews: [{ url: 'https://github.com/acme-org/acme-harness/pull/5095#pullrequestreview-9' }],
  }) } }])
  rememberGithubRefs(refs, 'issue acme-org/acme-harness#5421 [open] 标题  https://github.com/acme-org/acme-harness/issues/5421')
  return refs
}

describe('PR and Issue numbers the run actually read become links', () => {
  it('keeps normal PR title parentheses readable without allowing title text to forge a destination', () => {
    const url = 'https://github.com/example/repo/pull/1'
    expect(linkedGithubTitle('feat(web): improve links', url)).toBe('[feat(web): improve links](' + url + ')')
    expect(linkedGithubTitle('bad](https://evil.test)', url)).not.toContain('bad](https://evil.test)')
  })
  it('remembers addresses from tool results, one per number and repository', () => {
    const refs = seen()
    expect(refs).toEqual({ '5095': 'https://github.com/acme-org/acme-harness/pull/5095',
      '5421': 'https://github.com/acme-org/acme-harness/issues/5421' })
    // The same number in another repository is ambiguous and is no longer linked.
    rememberGithubRefs(refs, 'https://github.com/ZhixingLu/dsh-visualizer-benchmark/issues/5421')
    expect(refs['5421']).toBe('')
    // Anything without a GitHub address changes nothing.
    rememberGithubRefs(refs, { text: 'PR #7 看起来没问题' })
    expect(refs['7']).toBeUndefined()
  })

  it('links the first mention, in the wording the model used, and leaves code, links and bare addresses alone', () => {
    const refs = seen()
    const text = 'PR #5095 还是 open 的 draft，CI 里 `verify-translation-pairing #5095` 挂了；见 https://github.com/acme-org/acme-harness/pull/5095 。' +
      '另外 issue #5421 和 acme-harness#5421 是同一件事；#12 我没查。PR #5095 之后再说。'
    const out = linkGithubRefs(text, refs)
    expect(out).toContain('[PR #5095](https://github.com/acme-org/acme-harness/pull/5095) 还是')
    expect(out).toContain('`verify-translation-pairing #5095`')
    expect(out).toContain('见 https://github.com/acme-org/acme-harness/pull/5095 。')
    expect(out).toContain('[issue #5421](https://github.com/acme-org/acme-harness/issues/5421) 和 acme-harness#5421')
    expect(out).toContain('#12 我没查')
    expect(out).toContain('PR #5095 之后再说')
    expect(out.match(/\]\(https:\/\/github\.com/g)).toHaveLength(2)
  })

  it('links 「仓库#123」 only for the repository the run saw, and nothing when nothing was read', () => {
    const refs = seen()
    expect(linkGithubRefs('acme-harness#5095 已合入', refs)).toBe('[acme-harness#5095](https://github.com/acme-org/acme-harness/pull/5095) 已合入')
    expect(linkGithubRefs('other/repo#5095 已合入', refs)).toBe('other/repo#5095 已合入')
    expect(linkGithubRefs('PR #5095 已合入', {})).toBe('PR #5095 已合入')
    expect(linkGithubRefs('[PR #5095](https://github.com/acme-org/acme-harness/pull/5095) 已合入', refs))
      .toBe('[PR #5095](https://github.com/acme-org/acme-harness/pull/5095) 已合入')
  })

  it('links a bare number in a work list only when its source address is unambiguous', () => {
    const refs = seen()
    expect(linkGithubRefs('先处理 #5095，再看 #12。', refs)).toBe('先处理 [#5095](https://github.com/acme-org/acme-harness/pull/5095)，再看 #12。')
    expect(linkGithubRefs('`#5095` 和 [#5095](https://example.test)\n```\n#5095\n```', refs))
      .toBe('`#5095` 和 [#5095](https://example.test)\n```\n#5095\n```')
    rememberGithubRefs(refs, 'https://github.com/other/repo/pull/5095')
    expect(linkGithubRefs('#5095、PR #5095', refs)).toBe('#5095、PR #5095')
  })
})
