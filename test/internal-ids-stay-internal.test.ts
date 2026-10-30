/**
 * 只存在于我们自己库里的标识，不要摆给人看。
 *
 * 这条规则是被撞出来两次的。
 *
 * 第一次：跨空间披露那一行解析不出群名时，直接打 `oc_342fe84408c24b16b4f124b93cc45976`。
 * 他的原话是「这种乱码的东西对用户有啥意义吗」，并且当场说了
 * 「你不能靠枚举 肯定还有类似的情况 写清楚规则而不是硬编码」。
 *
 * 第二次就是那个"类似的情况"：Friday 回「已给你建好：定时任务 **#4**「项目群日报」」，
 * 他问「#4 用户看不懂是啥」。我第一次只修了披露那一处，没把规则立起来，所以又漏了一处。
 *
 * 规则是**人在任何界面上能不能看到这个编号**：
 * - 看不到的（待办 / 记忆 / 定时任务的编号，oc_ / ou_ / om_ 原始 ID）→ 是给模型调工具的句柄，不对人说；
 * - 看得到的（GitHub 的 `仓库#123`）→ 照常说，那本来就是 GitHub 上显示的样子。
 *
 * 编号不能从工具回执里删掉——模型后面要靠它调下一个工具。所以是**换个写法**：
 * `[todo:5]` 一眼就是机器标记，不会被顺手抄进给人的回答里。
 *
 * 这组用例扫的是工具回执的模板本身，新加的工具会自动被管住，不用谁记得。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SERVER = readFileSync(join(import.meta.dirname, '..', 'src', 'mcp', 'server.ts'), 'utf8')
const PROMPT = readFileSync(join(import.meta.dirname, '..', 'src', 'core', 'prompt.ts'), 'utf8')

/** 回执模板里形如 `#${...}` 的插值，连同它前面那一小段上下文。 */
function hashInterpolations(): { snippet: string; expr: string }[] {
  const out: { snippet: string; expr: string }[] = []
  const re = /#\$\{([^}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(SERVER))) {
    out.push({ snippet: SERVER.slice(Math.max(0, m.index - 60), m.index + m[0].length), expr: m[1]! })
  }
  return out
}

describe('规则本身要在系统提示里', () => {
  it('说清楚哪些编号不对人说', () => {
    expect(PROMPT).toContain('只存在于我们自己库里的标识')
    expect(PROMPT).toContain('oc_ / ou_ / om_')
  })

  it('也说清楚**例外**——不然模型会连 GitHub 编号一起藏起来', () => {
    // 规则只说"别说编号"会矫枉过正：PR #4399 是人在 GitHub 上看得见的，藏了反而难用。
    expect(PROMPT).toContain('人自己看得见的编号照常说')
    expect(PROMPT).toContain('GitHub')
  })

  it('讲清楚编号为什么还留在回执里', () => {
    expect(PROMPT).toContain('是给你调下一个工具用的句柄')
  })
})

describe('工具回执里不给模型一句带内部编号的人话', () => {
  it('凡是 #${...} 插值，插的都得是 GitHub 的编号', () => {
    // GitHub 的写法是 `${repo}#${number}` / `PR #${r.number}`——那些是人看得见的。
    // 其余任何 `#${...id}` 都是我们自己库里的编号，会被模型当人话抄走。
    const offenders = hashInterpolations()
      .filter(({ expr }) => !/\bnumber\b/.test(expr))
      .filter(({ snippet }) => !/repo|issue|PR|pull/i.test(snippet))
    expect(offenders.map((o) => o.snippet.replace(/\s+/g, ' ').trim())).toEqual([])
  })

  it('内部编号统一走 handle()，而且长得像机器标记', () => {
    // 不钉死 kind 有哪几种——那个列表本来就会随新工具变长，钉住它只会让人改测试而不是想规则。
    expect(SERVER).toMatch(/function handle\(kind: '[a-z]+'( \| '[a-z]+')*, id: number \| string\): string/)
    expect(SERVER).toMatch(/return `\s*\[\$\{kind\}:\$\{id\}\]`/)
  })

  it('建东西的那几条回执用名字指代，不用编号', () => {
    // 这几条最容易被照抄——他看到的那句 "#4" 就是从 friday_routine_add 的回执来的。
    for (const line of ['已登记定时任务「${r.routine.name}」', '已开始关注「${r.routine.name}」', '已提出职责提案「${args.name}」']) {
      expect(SERVER).toContain(line)
    }
  })
})

describe('原始 ID 归原始 ID', () => {
  /**
   * 这里**不**扫 chat_id / message_id / open_id。它们在工具回执里是模型下一步要用的句柄
   * （`friday_chat_history` 要 chat_id、@ 人要 open_id），删了模型就没法干活；
   * 而且回执本来就是用中文写给**模型**看的，"含中文就是人话"这个判据根本不成立——
   * 我第一版就是这么写的，扫出 7 条全是误报。
   *
   * 「不要把这些说给人」是模型的事，靠系统提示那条规则管；
   * 真正能在代码里守住的，是**给人的那一行**——比如跨空间披露，见 disclosure-line.test.ts。
   */
  it('披露那一行仍然由它自己的用例守着', () => {
    const disclosure = readFileSync(join(import.meta.dirname, 'disclosure-line.test.ts'), 'utf8')
    expect(disclosure).toContain('绝不打出原始 chat_id')
  })
})
