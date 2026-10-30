/**
 * Wording for things sent straight to a person (menus, overviews): no internal ids, tags, arrows or symbols,
 * times in Beijing time the way people say them. Model-facing tool results keep their own, more exact forms.
 */
import { describeSchedule, type Routine } from './routines.js'

const TZ_OFFSET_MS = 8 * 3600_000
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

function local(ms: number): Date { return new Date(ms + TZ_OFFSET_MS) }
function dayKey(ms: number): string { return local(ms).toISOString().slice(0, 10) }

/** 「今天 15:00」「明天 10:00」「10月1日（周四）10:00」 in Beijing time. */
export function personTime(ms: number, now: number = Date.now()): string {
  const d = local(ms), clock = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
  if (dayKey(ms) === dayKey(now)) return `今天 ${clock}`
  if (dayKey(ms) === dayKey(now + 86_400_000)) return `明天 ${clock}`
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日（周${WEEKDAYS[d.getUTCDay()]}）${clock}`
}

/** 「9月29日」 in Beijing time. */
export function personDate(ms: number): string {
  const d = local(ms)
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`
}

/**
 * The thing a follow-up is about, from its stored name. Older names were the first 40 characters of the model's
 * note to itself: 「跟进：到点提醒某某：看一下日报（明天下午 3」. Only the task itself is kept.
 */
export function followupTitle(value: string): string {
  const original = value.replace(/\s+/g, ' ').trim()
  let text = original.replace(/^跟进[:：]\s*/, '').replace(/^(?:到点)?提醒[^：:]{0,20}[:：]\s*/, '')
  text = text.replace(/[（(][^（）()]*要求[^（）()]*[）)]/g, '').replace(/[（(][^（）()]*$/, '')
  text = (text.split(/[。；;]/)[0] ?? '').replace(/[，,、\s]+$/, '').trim()
  return text || original
}

/** One line per routine for a person: when, what, where it goes. Stopped ones are not listed here. */
export function routineLineForPerson(r: Routine, now: number = Date.now()): string {
  if (r.kind === 'followup') return `${personTime(r.nextRunAt, now)}：${followupTitle(r.name)}`
  const where = r.deliverTo === 'dm' ? '发到私聊' : '发到群里'
  const schedule = r.schedule.type === 'once' ? personTime(r.schedule.atMs, now) : describeSchedule(r.schedule)
  const next = r.schedule.type === 'once' ? '' : `，下次 ${personTime(r.nextRunAt, now)}`
  return `${r.name}：${schedule}${r.kind === 'watch' ? '' : `，${where}`}${next}`
}
