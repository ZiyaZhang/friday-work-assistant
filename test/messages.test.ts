import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { MessageCache, mergeWindows } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Todos } from '../src/core/todos.js'
import { createLogger } from '../src/log.js'
import { FakeFeishu, asFeishuClient, historyMsg } from './helpers/fake-feishu.js'

const log = createLogger('test', 'error')
const H = 3600_000

describe('MessageCache', () => {
  it('upserts, dedupes and fills in names/attachments on conflict', () => {
    const cache = new MessageCache(new DatabaseSync(':memory:'))
    const t = Date.now()
    expect(cache.upsert('oc_1', [historyMsg({ messageId: 'm1', text: 'hello', senderName: '', createTimeMs: t })])).toBe(1)
    cache.upsert('oc_1', [historyMsg({ messageId: 'm1', text: 'hello', senderName: '陆知行', createTimeMs: t, fileKey: 'fk', fileName: 'a.pdf', msgType: 'file' })])
    expect(cache.count('oc_1')).toBe(1)
    const m = cache.get('m1')
    expect(m?.senderName).toBe('陆知行')
    expect(m?.fileName).toBe('a.pdf')
    // 名字不会被空串覆盖回去
    cache.upsert('oc_1', [historyMsg({ messageId: 'm1', text: 'hello', senderName: '', createTimeMs: t })])
    expect(cache.get('m1')?.senderName).toBe('陆知行')
  })

  it('searches Chinese text with trigram FTS and falls back to LIKE for short terms', () => {
    const cache = new MessageCache(new DatabaseSync(':memory:'))
    const t = Date.now()
    cache.upsert('oc_1', [
      historyMsg({ messageId: 'a', text: '月度报表的排期是 8 月 11 日开始，三天', senderName: '李四', createTimeMs: t - 3 * H }),
      historyMsg({ messageId: 'b', text: '今天线上告警了', senderName: '陆知行', createTimeMs: t - 2 * H }),
      historyMsg({ messageId: 'c', text: 'alpine 的 skill 文档我发一下', senderName: '陆知行', createTimeMs: t - H, msgType: 'file', fileKey: 'fk', fileName: 'SKILL.md' }),
    ])
    cache.upsert('oc_2', [historyMsg({ messageId: 'd', text: '月度报表另一个群', senderName: '别人', createTimeMs: t - H })])
    expect(cache.search({ chatIds: ['oc_1'], query: '月度报表' }).map((m) => m.messageId)).toEqual(['a'])
    expect(cache.search({ chatIds: ['oc_1', 'oc_2'], query: '月度报表' }).map((m) => m.messageId)).toEqual(['a', 'd'])
    expect(cache.search({ chatIds: ['oc_1'], query: '告警' }).map((m) => m.messageId)).toEqual(['b']) // 2 字 → LIKE
    expect(cache.search({ chatIds: ['oc_1'], query: 'alpine skill' }).map((m) => m.messageId)).toEqual(['c'])
    expect(cache.search({ chatIds: ['oc_1'], sender: '陆知行' }).map((m) => m.messageId)).toEqual(['b', 'c'])
    expect(cache.search({ chatIds: ['oc_1'], msgType: 'file' }).map((m) => m.messageId)).toEqual(['c'])
    expect(cache.search({ chatIds: ['oc_1'], startMs: t - 2.5 * H }).map((m) => m.messageId)).toEqual(['b', 'c'])
    expect(cache.files(['oc_1'], { nameLike: 'SKILL' }).map((m) => m.messageId)).toEqual(['c'])
    expect(cache.files(['oc_1'], { sender: '马' })).toEqual([])
  })

  it('tracks coverage windows and computes gaps', () => {
    const cache = new MessageCache(new DatabaseSync(':memory:'))
    cache.markCovered('oc_1', 100, 200)
    cache.markCovered('oc_1', 300, 400)
    cache.markCovered('oc_1', 190, 310) // 把两段接起来
    expect(cache.coverage('oc_1')).toEqual([{ startSec: 100, endSec: 400 }])
    expect(cache.missingWindows('oc_1', 50, 450)).toEqual([
      { startSec: 50, endSec: 100 },
      { startSec: 400, endSec: 450 },
    ])
    expect(cache.missingWindows('oc_1', 120, 380)).toEqual([])
    expect(cache.missingWindows('oc_other', 0, 10)).toEqual([{ startSec: 0, endSec: 10 }])
    expect(mergeWindows([{ startSec: 5, endSec: 3 }, { startSec: 1, endSec: 2 }, { startSec: 2, endSec: 4 }])).toEqual([{ startSec: 1, endSec: 4 }])
  })
})

describe('MessageService', () => {
  function setup(): { feishu: FakeFeishu; cache: MessageCache; svc: MessageService; now: number } {
    const feishu = new FakeFeishu()
    const cache = new MessageCache(new DatabaseSync(':memory:'))
    const svc = new MessageService(asFeishuClient(feishu), cache, log, { windowSec: 3600, maxBackfillMessages: 4 })
    const now = Math.floor(Date.now() / 1000) * 1000
    feishu.histories.set(
      'oc_1',
      Array.from({ length: 6 }, (_, i) => historyMsg({ messageId: `m${i}`, text: `消息 ${i}`, createTimeMs: now - (6 - i) * 600_000 })),
    )
    return { feishu, cache, svc, now }
  }

  it('backfills gaps once, then serves from cache', async () => {
    const { feishu, cache, svc, now } = setup()
    const endSec = Math.floor(now / 1000) + 1
    const startSec = endSec - 2 * 3600
    const first = await svc.history('oc_1', startSec, endSec, 10)
    // 回填按时间正序推进：预算 4 条用完时先拿到最早的 4 条，并给出续拉点
    expect(first.items.map((m) => m.text)).toEqual(['消息 0', '消息 1', '消息 2', '消息 3'])
    expect(first.hasMore).toBe(true)
    expect(first.coverageComplete).toBe(false)
    expect(first.nextStartTimeSec).toBeDefined()
    const second = await svc.history('oc_1', startSec, endSec, 10)
    expect(second.coverageComplete).toBe(true)
    expect(second.items.length).toBe(6)
    expect(second.hasMore).toBe(false)
    const calls = feishu.calls.listChatHistory
    const third = await svc.history('oc_1', startSec, endSec, 10)
    expect(third.fetchedFromApi).toBe(0)
    expect(feishu.calls.listChatHistory).toBe(calls)
    expect(cache.missingWindows('oc_1', startSec, endSec)).toEqual([])
  })

  it('pages with limit and resumes at the next message time', async () => {
    const { svc, now } = setup()
    const endSec = Math.floor(now / 1000) + 1
    const startSec = endSec - 2 * 3600
    await svc.history('oc_1', startSec, endSec, 10)
    await svc.history('oc_1', startSec, endSec, 10)
    const page = await svc.history('oc_1', startSec, endSec, 2)
    expect(page.items.map((m) => m.text)).toEqual(['消息 0', '消息 1'])
    expect(page.hasMore).toBe(true)
    const next = await svc.history('oc_1', page.nextStartTimeSec as number, endSec, 2)
    expect(next.items.map((m) => m.text)).toEqual(['消息 2', '消息 3'])
  })

  it('remembers inbound events without touching coverage', () => {
    const { cache, svc } = setup()
    svc.remember('oc_9', historyMsg({ messageId: 'live', text: '刚发的', senderName: '同事' }))
    expect(cache.get('live')?.chatId).toBe('oc_9')
    expect(cache.coverage('oc_9')).toEqual([])
  })

  it('resolves chats by id, exact name, then shortest partial match', () => {
    const cands = [
      { chatId: 'oc_a', name: 'alpine 讨论群' },
      { chatId: 'oc_b', name: 'alpine' },
      { chatId: 'oc_c', name: '数仓对接群' },
    ]
    expect(MessageService.resolveChat('oc_c', cands)?.chatId).toBe('oc_c')
    expect(MessageService.resolveChat('alpine', cands)?.chatId).toBe('oc_b')
    expect(MessageService.resolveChat('讨论', cands)?.chatId).toBe('oc_a')
    expect(MessageService.resolveChat('ALPINE', cands)?.chatId).toBe('oc_b')
    expect(MessageService.resolveChat('不存在', cands)).toBeUndefined()
    expect(MessageService.resolveChat(undefined, cands, cands[2])?.chatId).toBe('oc_c')
  })
})

describe('Todos', () => {
  it('adds, lists, completes within scope, and reports due items', () => {
    const todos = new Todos(new DatabaseSync(':memory:'))
    const now = Date.now()
    const a = todos.add({ scope: 'chat:oc_1', title: '  交付   宽表 ', dueMs: now + H, owner: '陆知行' })
    const b = todos.add({ scope: 'chat:oc_1', title: '无截止' })
    todos.add({ scope: 'chat:oc_2', title: '别的群' })
    expect(a.title).toBe('交付 宽表')
    expect(todos.list('chat:oc_1').map((t) => t.id)).toEqual([a.id, b.id]) // 有截止时间的排前面
    expect(todos.dueWithin('chat:oc_1', 2 * H, now).map((t) => t.id)).toEqual([a.id])
    expect(todos.dueWithin('chat:oc_1', H / 2, now)).toEqual([])
    expect(todos.done(a.id, 'chat:oc_2')).toBeUndefined()
    expect(todos.done(a.id, 'chat:oc_1')?.status).toBe('done')
    expect(todos.done(a.id, 'chat:oc_1')).toBeUndefined() // 已完成的不能再完成
    expect(todos.list('chat:oc_1').map((t) => t.id)).toEqual([b.id])
    expect(todos.list('chat:oc_1', { status: 'all' }).length).toBe(2)
  })
})
