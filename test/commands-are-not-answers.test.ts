/**
 * 规则：**命令不是答案。**
 *
 * 用户的原话是"大部分用户不会用 switch command"。真机上他问「你能看到哪些群」，
 * 回的是一张灰卡片写着"私聊发 /connect"——而那张带按钮的授权卡一直就在代码里。
 * 第一次修的时候我是一处一处找的，这不对：找得到的是我碰巧看到的那几处。
 *
 * 所以把它变成一条**机器能查的规则**：
 *
 * > 除了命令表和帮助卡本身，源码里任何要发给人看的字，都不许出现 `/命令`。
 *
 * 做不到的时候有两条出路，都比甩一个命令强：
 * - **有界面就给界面**：缺个人授权 → 把授权卡发过去（卡上就有按钮）；
 * - **没界面就说人话**："跟我说一声就行"——模型那边有对应的工具，人话能走通。
 *
 * 命令保留着，给已经习惯的人用；但它是快捷方式，不是说明书。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { COMMAND_WORDS } from '../src/feishu/mention.js'

const SRC = new URL('../src', import.meta.url).pathname

/**
 * 可以写命令名的地方，只有这三类，而且每一类都有理由：
 * - `mention.ts`：命令表和别名表，命令面本身；
 * - `cards.ts` 的帮助卡：把命令和"人话怎么说"并排列出来，正是为了告诉人不必记命令；
 * - `usage(...)` 包起来的字符串：对方**刚刚自己敲了命令**（敲错了、少了参数），那时候照命令的写法回最短。
 * - `web/console-page.ts`：整页浏览器脚本装在一个模板串里，里面的 `!space` 之类是代码不是给人看的字。
 */
const COMMAND_SURFACE = new Set(['feishu/mention.ts', 'web/console-page.ts'])
const HELP_CARD = /export function renderHelpCard[\s\S]*?\n\}\n/
const MARKED_CALL = /\b(?:usage|commandMenu)\(\s*(`(?:\\.|[^\\`])*`|'(?:\\.|[^\\'])*'|"(?:\\.|[^\\"])*")\s*\)/g

function sources(dir: string, prefix = ''): { rel: string; text: string }[] {
  const out: { rel: string; text: string }[] = []
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...sources(full, `${prefix}${name}/`))
    else if (name.endsWith('.ts') || name.endsWith('.md')) out.push({ rel: `${prefix}${name}`, text: readFileSync(full, 'utf8') })
  }
  return out
}

/** 注释是写给改代码的人看的，不会发给用户；去掉之后再查。 */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/**
 * 只查**字符串字面量**里的内容——发给人的字都在字符串里。
 * 代码本身不算：`!routine` 是取反，`'./space.js'` 是模块路径，`'POST /v1/github/login'` 是路由，
 * 它们谁都不会出现在用户眼前。模板串里的 `${...}` 是代码，也剔掉。
 */
const STRING_LITERAL = /`(?:\\.|[^\\`])*`|'(?:\\.|[^\\'\n])*'|"(?:\\.|[^\\"\n])*"/g
function literals(text: string): string[] {
  return (text.match(STRING_LITERAL) ?? []).map((s) => s.replace(/\$\{[^{}]*\}/g, ' '))
}

// 前面不能是字母数字、`.`、`/`——排除 `/v1/github/...`（前面是 `1`）和 `./space.js`（前面是 `.`）；
// 后面不能再跟 `/` 或 `.ts`——排除 `/wiki/<token>` 这类链接路径。
const COMMAND_RE = new RegExp(`(?<![\\w./])[/!](?:${COMMAND_WORDS.join('|')})\\b(?![/.])`, 'g')

describe('命令不是答案', () => {
  it('除了命令表和帮助卡，发给人的字里不出现 /命令', () => {
    const offenders: string[] = []
    for (const file of sources(SRC)) {
      if (COMMAND_SURFACE.has(file.rel)) continue
      let body = withoutComments(file.text).replace(MARKED_CALL, 'marked()')
      if (file.rel === 'feishu/cards.ts') body = body.replace(HELP_CARD, '')
      for (const literal of literals(body)) {
        const hit = literal.match(COMMAND_RE)
        if (hit) offenders.push(`${file.rel}  ${[...new Set(hit)].join(' ')}  ${literal.replace(/\s+/g, ' ').slice(0, 88)}`)
      }
    }
    expect(offenders, [
      '这些地方把命令当成了答案。改法二选一：',
      '  · 有界面就给界面（缺个人授权 → this.connectCard(openId) 发过去）',
      '  · 没界面就说人话（"跟我说一声就行"），别写命令名',
      ...offenders.map((o) => `  ${o}`),
    ].join('\n')).toEqual([])
  })

  /**
   * 源码扫干净之后，真机上它还是跟人说"发 /groups"——因为那句话不在源码里，在 **skill 文件**里。
   * skill 是直接喂给模型的工作手册：手册里写"让他发 /xxx"，模型就会照做，
   * 而扫描只盯着 src/ 的规则对此一无所知。所以规则必须盖住模型读得到的**所有**材料。
   */
  it('skill 文件里也不许教命令——模型照着手册说话', () => {
    const skills = new URL('../skills', import.meta.url).pathname
    const offenders: string[] = []
    for (const file of sources(skills)) {
      for (const line of file.text.split('\n')) {
        const hit = line.match(COMMAND_RE)
        if (hit) offenders.push(`skills/${file.rel}  ${[...new Set(hit)].join(' ')}  ${line.trim().slice(0, 84)}`)
      }
    }
    expect(offenders, [
      'skill 里写了命令名，模型就会把命令甩给用户。改成：',
      '  · 让网关把能点的卡发过去（授权卡、关注的群聊卡）',
      '  · 或者写"跟我说一声就行"',
      ...offenders.map((o) => `  ${o}`),
    ].join('\n')).toEqual([])
  })

  it('这条规则自己有事实源：命令词从命令表来，不另抄一份', () => {
    expect(COMMAND_WORDS).toContain('connect')
    expect(COMMAND_WORDS).toContain('github')
    expect(COMMAND_WORDS.length).toBeGreaterThan(20)
  })
})
