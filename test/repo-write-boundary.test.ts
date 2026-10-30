/**
 * 读的仓库和能写的仓库，不是同一张名单。
 *
 * 他的原话：「这个你还是要分清读和写！写只有别人要求你提 PR 才写；读可以随便读回答问题。」
 *
 * 之前两件事共用 `FRIDAY_GITHUB_REPOS`，意思就成了"凡是能读的都能写"。
 * 生产里那张表同时有 `acme-org/acme-harness`（别人真在用的代码库）
 * 和一个沙箱仓库——**真实仓库因此一直是可写的**，只是没人触发过而已。
 *
 * 后果不对等才是要分开的理由：读错了顶多答偏；写会在别人的仓库里留下痕迹，
 * 而且署的是 Friday 自己的 GitHub 身份。
 *
 * 这里不测"拦住写"——写本来就不拦（PR 是提议不是改动）。测的是**写得进哪里**。
 */
import { describe, expect, it } from 'vitest'
import { loadGitHubConfig, GitHubIdentity } from '../src/github/identity.js'

const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => log } as never

function identity(over: Record<string, string> = {}) {
  const cfg = loadGitHubConfig({ GITHUB_TOKEN: 't', ...over } as NodeJS.ProcessEnv)!
  return new GitHubIdentity(cfg, log)
}

const REAL = 'acme-org/acme-harness'
const SANDBOX = 'ZhixingLu/dsh-visualizer-benchmark'

describe('两张名单', () => {
  it('配了写名单之后，读得到的不一定写得进去', () => {
    const g = identity({ FRIDAY_GITHUB_REPOS: `${REAL},${SANDBOX}`, FRIDAY_GITHUB_WRITE_REPOS: SANDBOX })
    expect(g.repoAllowed(REAL)).toBe(true)      // 读它回答问题：可以
    expect(g.repoWritable(REAL)).toBe(false)    // 往它写：不行
    expect(g.repoWritable(SANDBOX)).toBe(true)
  })

  it('两个都在写名单里时两个都能写——这正是现在要的配置', () => {
    // 他说 PR 之后开在 deepseek-harness 里，所以它该进写名单；
    // 重点是这件事要**显式写出来**，而不是因为它恰好在读名单里就顺带获得。
    const g = identity({ FRIDAY_GITHUB_REPOS: `${REAL},${SANDBOX}`, FRIDAY_GITHUB_WRITE_REPOS: `${REAL},${SANDBOX}` })
    expect(g.repoWritable(REAL)).toBe(true)
    expect(g.repoWritable(SANDBOX)).toBe(true)
  })

  it('不在读名单里的，读写都不行', () => {
    const g = identity({ FRIDAY_GITHUB_REPOS: SANDBOX, FRIDAY_GITHUB_WRITE_REPOS: SANDBOX })
    expect(g.repoAllowed('someone/else')).toBe(false)
    expect(g.repoWritable('someone/else')).toBe(false)
  })

  it('大小写不敏感——GitHub 的仓库名本来就不区分', () => {
    const g = identity({ FRIDAY_GITHUB_REPOS: SANDBOX, FRIDAY_GITHUB_WRITE_REPOS: SANDBOX })
    expect(g.repoWritable(SANDBOX.toUpperCase())).toBe(true)
  })
})

describe('没配写名单时默认禁写', () => {
  it('读名单不授予写权限', () => {
    const g = identity({ FRIDAY_GITHUB_REPOS: `${REAL},${SANDBOX}` })
    expect(g.repoAllowed(REAL)).toBe(true)
    expect(g.repoWritable(REAL)).toBe(false)
    expect(g.repoWritable(SANDBOX)).toBe(false)
  })

  it('两张名单都空时保持读取行为，但禁止写入', () => {
    const g = identity()
    expect(g.repoAllowed('any/repo')).toBe(true)
    expect(g.repoWritable('any/repo')).toBe(false)
  })

  it('显式留空同样禁写', () => {
    const g = identity({ FRIDAY_GITHUB_REPOS: SANDBOX, FRIDAY_GITHUB_WRITE_REPOS: '  ' })
    expect(g.repoWritable(SANDBOX)).toBe(false)
    expect(g.repoWritable(REAL)).toBe(false)
  })

  it('写名单不能扩大读取范围', () => {
    const g = identity({ FRIDAY_GITHUB_REPOS: SANDBOX, FRIDAY_GITHUB_WRITE_REPOS: `${REAL},${SANDBOX}` })
    expect(g.repoAllowed(REAL)).toBe(false)
    expect(g.repoWritable(REAL)).toBe(false)
    expect(g.repoWritable(SANDBOX)).toBe(true)
  })
})

describe('名单怎么解析', () => {
  it('逗号和空白都能分隔', () => {
    const g = identity({ FRIDAY_GITHUB_WRITE_REPOS: `${REAL}, ${SANDBOX}` })
    expect(g.repoWritable(REAL)).toBe(true)
    expect(g.repoWritable(SANDBOX)).toBe(true)
  })
})
