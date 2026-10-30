/**
 * 提示词：主动巡检加了 @@like 写法和点赞标准，硬规则和工作区交付规则各加一句通讯风格；原有规则一条不少。
 */
import { describe, expect, it } from 'vitest'
import { STYLE_LINE, buildProactivePrompt, workspaceInstructions } from '../src/core/prompt.js'

const STYLE = '少修饰、讲事实；幽默偶尔出现，不用于故障或权限阻塞。'
const base = { botName: 'Friday', chatName: '研发群', chatId: 'oc_group', nowMs: Date.UTC(2026, 8, 24, 2, 0, 0),
  lines: ['[10:00] 张三（open_id=ou_a，message_id=om_1）: 修好了'] }

/** r76 巡检提示词里必须原样保留的规则 */
const KEPT = [
  '硬规则：宁可沉默，一个多余的插嘴比一次沉默更糟；不复述、不总结、不客套、不当和事佬；不跑命令、不改文件、不发私聊；回复不超过 5 行，开头点明回应的是谁的什么问题，例如"接一下 @张三 的问题：…"。',
  '- 决定沉默：整个回复只写 NOTHING。',
  '- 决定回复某条消息：第一行写 @@reply <那条消息的 message_id>，从第二行开始写回复正文（会作为对那条消息的回复发到群里）。',
  '判断的成本是不对称的：**多嘴一次损害的是信任，漏掉一次可以下轮补上**。拿不准就沉默。',
  '2. 消息里出现决定、排期、截止日或承诺，但没有交给 Friday 执行 → 不记待办、不改记忆、不登记反馈，沉默。只有随后明确委托的新任务才可以执行。',
]

describe('主动巡检提示词', () => {
  it('风格句就是设计原文', () => {
    expect(STYLE_LINE).toBe(STYLE)
  })

  it('kudos 为真：有 @@like 写法和点赞标准，硬规则后面接着风格句，原有规则都在', () => {
    const p = buildProactivePrompt({ ...base, kudos: true })
    for (const rule of KEPT) expect(p).toContain(rule)
    expect(p).toContain(`例如"接一下 @张三 的问题：…"。${STYLE}`)
    expect(p).toContain('- 点赞（可选）：在上面任一种写法之后另起一行写 @@like <message_id> <一句理由>，最多 2 行；理由只进记录，不发到群里。')
    expect(p).toContain('[点赞标准]')
    expect(p).toContain('只赞同事明确给出 know-how 或 insight、把 bug 修好了、把功能做完了、给出了确定且有用答案的消息。')
    expect(p).toContain('不赞你自己和其他机器人的消息；不赞报错、求助、抱怨，也不赞还在争论中的消息；不赞已经有你的表情的消息。拿不准就不赞。')
    // 点赞段在消息区之前
    expect(p.indexOf('[点赞标准]')).toBeLessThan(p.indexOf('[消息]'))
  })

  it('信号轮次：点赞标准写明可以针对背景消息，并排在"只处理这些"之后', () => {
    const p = buildProactivePrompt({ ...base, kudos: true, signalBlock: '- 没人接的问题：数仓权限找谁' })
    expect(p).toContain('[触发本轮的事｜只处理这些，别的消息只当背景]')
    expect(p).toContain('点赞可以针对下面消息区里的任何一条（包括背景消息），不限于触发本轮的事')
    expect(p.indexOf('[触发本轮的事')).toBeLessThan(p.indexOf('[点赞标准]'))
    expect(p).toContain('[消息（背景）]')
  })

  it('kudos 为假或不给：没有 @@like，风格句和原有规则照旧', () => {
    for (const p of [buildProactivePrompt(base), buildProactivePrompt({ ...base, kudos: false })]) {
      expect(p).not.toContain('@@like')
      expect(p).not.toContain('点赞')
      for (const rule of KEPT) expect(p).toContain(rule)
      expect(p).toContain(STYLE)
    }
  })
})

describe('工作区交付规则', () => {
  it('回复与交付列表追加风格句；原来"故障和权限阻塞不开玩笑"那条保留', () => {
    for (const executionMode of ['workspace', 'managed'] as const) {
      const text = workspaceInstructions({ botName: 'Friday', hasRepos: false, repoNames: [], executionMode })
      const delivery = text.slice(text.indexOf('## 回复与交付'), text.indexOf('## 代码库'))
      expect(delivery).toContain(`\n- ${STYLE}\n`)
      expect(delivery).toContain('故障和权限阻塞直接说具体事实和解决办法，不开玩笑。')
      expect(delivery).toContain('- 中文、先回答当前问题。')
      expect(text.match(new RegExp(STYLE, 'g'))).toHaveLength(1)
    }
  })
})
