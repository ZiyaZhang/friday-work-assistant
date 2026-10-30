import { describe, expect, it } from 'vitest'
import { followupTitle, personTime, routineLineForPerson } from '../src/core/person-text.js'
import type { Routine } from '../src/core/routines.js'

// 2026-09-29 03:05 Beijing time
const NOW = Date.parse('2026-09-28T19:05:00Z')

describe('wording sent straight to a person', () => {
  it('says times the way people do, in Beijing time', () => {
    expect(personTime(Date.parse('2026-09-29T07:00:00Z'), NOW)).toBe('今天 15:00')
    expect(personTime(Date.parse('2026-09-30T07:00:00Z'), NOW)).toBe('明天 15:00')
    expect(personTime(Date.parse('2026-10-01T02:00:00Z'), NOW)).toBe('10月1日（周四）10:00')
  })

  it('keeps only the task from older follow-up names, with no pronoun, time or cut-off tail', () => {
    expect(followupTitle('跟进：到点提醒陆知行：看一下日报的新版式（她 9/29 03:05 要求明天下午 3')).toBe('看一下日报的新版式')
    expect(followupTitle('跟进：到点提醒陆知行：整理桌面（他 17:49 要求 3 分钟后提醒）。直接把这句提醒')).toBe('整理桌面')
    expect(followupTitle('跟进：看 PR #5095 有没有合并')).toBe('看 PR #5095 有没有合并')
    expect(followupTitle('看一下日报的新版式')).toBe('看一下日报的新版式')
  })

  it('writes one plain line per routine: when and what, with no ids, arrows or seconds', () => {
    const base = { id: 9, enabled: true, status: 'active', deliverTo: 'dm', resumeAt: null } as unknown as Routine
    const followup = { ...base, kind: 'followup', name: '跟进：到点提醒陆知行：看一下日报的新版式（她 9/29 03:05 要求明天下午 3',
      schedule: { type: 'once', atMs: Date.parse('2026-10-01T02:00:00Z') }, nextRunAt: Date.parse('2026-10-01T02:00:00Z') } as unknown as Routine
    expect(routineLineForPerson(followup, NOW)).toBe('10月1日（周四）10:00：看一下日报的新版式')
    const digest = { ...base, kind: 'schedule', name: '测试群日报', schedule: { type: 'daily', at: '09:00' },
      nextRunAt: Date.parse('2026-09-29T01:00:00Z') } as unknown as Routine
    const line = routineLineForPerson(digest, NOW)
    expect(line).toBe('测试群日报：每天 09:00，发到私聊，下次 今天 09:00')
    expect(line).not.toMatch(/#\d|→|:\d\d:\d\d/)
  })
})
