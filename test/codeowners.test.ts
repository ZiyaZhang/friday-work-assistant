/**
 * 开完 PR 该 @ 谁。
 *
 * 他把门禁重新定成了：建 Issue、评论 Issue、开 PR —— 任何群成员都能触发，
 * **并 @ 相应的模块负责人**。这比原来"要群负责人点一次头"好，因为 PR 是提议不是改动：
 * 拦一道只会让事情停在发起人那儿，@ 对人才会让它往前走。
 *
 * 于是"谁是相应的负责人"成了要答对的问题，答案在仓库自己的 CODEOWNERS 里。
 * 那里只有一条语义容易写错，而写错就会 @ 错人：**最后一条匹配的规则生效，不是第一条**。
 * CODEOWNERS 就是这么设计的——粗的写上面，细的写下面覆盖它；
 * 按第一条匹配找，永远只会 @ 到最粗那条上的人。
 */
import { describe, expect, it } from 'vitest'
import { matchesPattern, ownersFor, parseCodeowners } from '../src/github/codeowners.js'

const SAMPLE = `
# 兜底
*                       @lead

# 前端
/web/                   @alice @bob
/web/legacy/            @carol

# 任意层级的测试文件
*.test.ts               @qa

# 这块现在没人管
/vendor/
`

const rules = parseCodeowners(SAMPLE)

describe('读懂 CODEOWNERS', () => {
  it('注释和空行不算规则', () => {
    expect(rules.every((r) => !r.pattern.startsWith('#'))).toBe(true)
    expect(rules).toHaveLength(5)
  })

  it('@ 前缀去掉，团队写法保留斜杠', () => {
    expect(parseCodeowners('/a @org/team @solo')[0]!.owners).toEqual(['org/team', 'solo'])
  })

  it('行尾注释不会被当成 owner', () => {
    expect(parseCodeowners('/a @alice # 她负责')[0]!.owners).toEqual(['alice'])
  })

  it('没有 owner 的一行是"这里没人管"，不是格式错误', () => {
    // 丢掉这行的话，上面那条 `* @lead` 会继续生效，而作者的意思正相反。
    expect(rules.find((r) => r.pattern === '/vendor/')).toEqual({ pattern: '/vendor/', owners: [] })
  })
})

describe('最后一条匹配的赢', () => {
  it('细规则覆盖粗规则', () => {
    expect(ownersFor(rules, ['web/legacy/old.js'])).toEqual(['carol'])
  })

  it('没有更细的规则时用粗的', () => {
    expect(ownersFor(rules, ['web/app.js'])).toEqual(['alice', 'bob'])
  })

  it('什么都不匹配时落到兜底那条', () => {
    expect(ownersFor(rules, ['README.md'])).toEqual(['lead'])
  })

  it('被清空负责人的路径就是没人——不该回退到兜底', () => {
    expect(ownersFor(rules, ['vendor/lib.js'])).toEqual([])
  })

  it('一个 PR 改了几块，几块的负责人都要看见', () => {
    expect(ownersFor(rules, ['web/app.js', 'web/legacy/old.js']).sort()).toEqual(['alice', 'bob', 'carol'])
  })

  it('同一个人被多条规则命中也只 @ 一次', () => {
    expect(ownersFor(rules, ['README.md', 'docs/a.md'])).toEqual(['lead'])
  })
})

describe('路径怎么算匹配', () => {
  it('以 / 开头是从仓库根算起，不是任意层级', () => {
    expect(matchesPattern('/web/', 'web/a.js')).toBe(true)
    expect(matchesPattern('/web/', 'packages/web/a.js')).toBe(false)
  })

  it('不含 / 的模式匹配任意层级', () => {
    expect(matchesPattern('*.test.ts', 'a.test.ts')).toBe(true)
    expect(matchesPattern('*.test.ts', 'src/deep/a.test.ts')).toBe(true)
  })

  it('目录模式连带里面所有东西', () => {
    expect(matchesPattern('/web/', 'web/deep/nested/a.js')).toBe(true)
  })

  it('* 不跨目录，** 才跨', () => {
    expect(matchesPattern('/src/*.ts', 'src/deep/a.ts')).toBe(false)
    expect(matchesPattern('/src/**/*.ts', 'src/deep/a.ts')).toBe(true)
  })

  it('单独一个 * 匹配所有东西', () => {
    expect(matchesPattern('*', 'anything/at/all.txt')).toBe(true)
  })

  it('点号不当成通配符', () => {
    // 正则没转义的话 `a.ts` 会匹配到 `axts`
    expect(matchesPattern('/a.ts', 'axts')).toBe(false)
  })

  it('实际文件也匹配到它所在的目录规则', () => {
    expect(matchesPattern('/web/legacy/', 'web/legacy/old.js')).toBe(true)
  })
})
