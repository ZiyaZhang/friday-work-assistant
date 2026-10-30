/**
 * 跨空间披露那一行。
 *
 * 用户实拍的问题：读到的群解析不出名字时，末尾直接把 `oc_342fe84408c24b16b4f124b93cc45976`
 * 这种原始 chat_id 打给人看——对人没有任何意义，还泄漏内部标识。
 * 披露的目的是让在场的人知道"内容是从哪来的"，解析不出名字时应该说"另 N 个群聊"，
 * 而不是把 ID 贴出来；已经解析出名字的照常给名字。
 */
import { describe, expect, it } from 'vitest'
import { disclosureLine, type CrossSpaceRead } from '../src/core/receipt.js'

const read = (chatId: string, name: string, what = '群聊内容'): CrossSpaceRead => ({ chatId, name, what })

describe('跨空间披露', () => {
  it('没有读别的会话时不披露', () => {
    expect(disclosureLine([], 'oc_self')).toBeUndefined()
    expect(disclosureLine([read('oc_self', '本群')], 'oc_self')).toBeUndefined()
  })

  it('有名字就给名字', () => {
    const line = disclosureLine([read('oc_a', 'DSH产品小分队'), read('oc_b', '数仓对接群')], 'oc_self')
    expect(line).toBe('（本条回答引用了「DSH产品小分队」、「数仓对接群」的内容）')
  })

  it('同一个群被读多次只出现一次', () => {
    const line = disclosureLine([read('oc_a', 'A 群'), read('oc_a', 'A 群', '搜索结果')], 'oc_self')
    expect(line).toBe('（本条回答引用了「A 群」的内容）')
  })

  it('解析不出名字时说"另 N 个群聊"，绝不打出原始 chat_id', () => {
    const line = disclosureLine([
      read('oc_342fe84408c24b16b4f124b93cc45976', 'oc_342fe84408c24b16b4f124b93cc45976'),
      read('oc_0431bf5f06a70dc211967d10d71e35c3', 'oc_0431bf5f06a70dc211967d10d71e35c3'),
    ], 'oc_self')
    expect(line).toBe('（本条回答引用了另外 2 个群聊的内容）')
    expect(line).not.toContain('oc_')
  })

  it('一部分有名字、一部分没有时两者都交代', () => {
    const line = disclosureLine([
      read('oc_a', 'DSH产品小分队'),
      read('oc_a0b68029008c7eea64b9e0355fa17edf', 'oc_a0b68029008c7eea64b9e0355fa17edf'),
    ], 'oc_self')
    expect(line).toBe('（本条回答引用了「DSH产品小分队」和另外 1 个群聊的内容）')
    expect(line).not.toContain('oc_')
  })

  it('名字恰好是别的原始标识形态时同样不外露', () => {
    const line = disclosureLine([read('oc_a', 'om_x100ce337cd1135c6039a547a124aa5c')], 'oc_self')
    expect(line).toBe('（本条回答引用了另外 1 个群聊的内容）')
  })

  it('空名字按未解析处理', () => {
    expect(disclosureLine([read('oc_a', '')], 'oc_self')).toBe('（本条回答引用了另外 1 个群聊的内容）')
  })
})
