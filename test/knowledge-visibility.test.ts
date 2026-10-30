/**
 * 「知道的事」给人看什么。
 *
 * 起因：记忆里混着一次性问答，lesson 里大半是
 * 助手自己的工具限制（「本机 bash 被沙箱拒绝」）。人打开"你知道我什么"看到这些没有意义。
 * 所以这两类还存着、还检索得到，但不占他的视线——而且**要如实说还有多少条没列**，不能假装没有。
 */
import { describe, expect, it } from 'vitest'
import { USER_VISIBLE_NOTE_KINDS, type NoteKind } from '../src/core/memory.js'

describe('知道的事的可见类型', () => {
  it('一次性问答和助手自己的工具笔记不给人看', () => {
    expect(USER_VISIBLE_NOTE_KINDS).not.toContain('qa')
    expect(USER_VISIBLE_NOTE_KINDS).not.toContain('selfnote')
  })

  it('真正属于他的知识都在', () => {
    for (const kind of ['fact', 'decision', 'profile', 'rule', 'lesson', 'todo'] as NoteKind[]) {
      expect(USER_VISIBLE_NOTE_KINDS, kind).toContain(kind)
    }
  })

  it('没有漏掉任何一个类型——新增类型必须显式决定给不给人看', () => {
    const all: NoteKind[] = ['qa', 'fact', 'decision', 'todo', 'profile', 'rule', 'lesson', 'selfnote']
    const hidden = all.filter(k => !USER_VISIBLE_NOTE_KINDS.includes(k))
    expect(hidden.sort()).toEqual(['qa', 'selfnote'])
  })
})
