/**
 * 点赞账本与解析：@@like 行怎么取、哪些提名宿主不认、名额怎么算。
 */
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { Kudos, KUDOS_SCHEMA, ensureKudosSchema, extractKudos, kudosRejection, looksLikeTrouble, type KudosCandidate } from '../src/core/kudos.js'
import { looksLikeQuestion } from '../src/core/orchestrator.js'
import { loadConfig } from '../src/config.js'

const DAY = 86_400_000
/** 2026-09-24 00:00 +08:00 */
const SHANGHAI_MIDNIGHT = Date.UTC(2026, 8, 23, 16, 0, 0)

function ledger(opts: { maxPerDay?: number; now?: () => number } = {}) {
  const db = new DatabaseSync(':memory:')
  return { db, kudos: new Kudos(db, opts) }
}

function claimInput(messageId: string, chatId = 'oc_a') {
  return { messageId, chatId, spaceId: 'sp_a', senderOpenId: 'ou_alice', emojiType: 'THUMBSUP', reason: '讲清了缓存失效的原因' }
}

describe('extractKudos：@@like 行', () => {
  it('取出合法提名，剩下的正文照旧交给 NOTHING / @@reply', () => {
    const out = extractKudos('@@like om_a1 讲清了根因\nNOTHING')
    expect(out.nominations).toEqual([{ messageId: 'om_a1', reason: '讲清了根因' }])
    expect(out.rest.trim()).toBe('NOTHING')
    expect(out.dropped).toBe(0)
  })

  it('和 @@reply 组合：@@like 在前在后都行，正文里不留协议行', () => {
    const before = extractKudos('@@like om_a1 修好了登录\n@@reply om_q1\n接一下 @张三 的问题：找运维。')
    expect(before.nominations.map((n) => n.messageId)).toEqual(['om_a1'])
    expect(before.rest.trim()).toBe('@@reply om_q1\n接一下 @张三 的问题：找运维。')
    const after = extractKudos('@@reply om_q1\n接一下 @张三 的问题：找运维。\n- @@like om_a1 修好了登录')
    expect(after.nominations.map((n) => n.messageId)).toEqual(['om_a1'])
    expect(after.rest).not.toContain('@@like')
  })

  it('最多 2 条；重复、格式不对的丢弃，而且都不留在正文里', () => {
    const out = extractKudos([
      '@@like om_a1 第一条',
      '@@like om_a1 重复',
      '@@like xx_bad 不是消息 id',
      '@@like om_a2',
      '@@like om_a3 第二条',
      '@@like om_a4 第三条超出',
      'NOTHING',
    ].join('\n'))
    expect(out.nominations).toEqual([{ messageId: 'om_a1', reason: '第一条' }, { messageId: 'om_a3', reason: '第二条' }])
    expect(out.dropped).toBe(4)
    expect(out.rest.trim()).toBe('NOTHING')
  })

  it('只认行首的 @@like；@@likes 这类不是协议行', () => {
    const out = extractKudos('正文里提到 @@like om_a1 不算\n@@likes om_a2 也不算')
    expect(out.nominations).toEqual([])
    expect(out.rest).toBe('正文里提到 @@like om_a1 不算\n@@likes om_a2 也不算')
  })

  it('CRLF 换行也认', () => {
    const out = extractKudos('@@like om_a1 讲清了根因\r\nNOTHING\r\n')
    expect(out.nominations).toEqual([{ messageId: 'om_a1', reason: '讲清了根因' }])
    expect(out.rest.trim()).toBe('NOTHING')
  })

  it('理由截到 200 字', () => {
    const out = extractKudos(`@@like om_a1 ${'很'.repeat(300)}`)
    expect(out.nominations[0]?.reason).toHaveLength(200)
  })
})

describe('kudosRejection：宿主不认的提名', () => {
  const base: KudosCandidate = { messageId: 'om_a1', msgType: 'text', senderType: 'user', senderOpenId: 'ou_alice', text: '修好了：缓存键漏了租户，已经合并' }
  const ctx = { botOpenId: 'ou_bot', isQuestion: looksLikeQuestion, hasFridayReaction: (id: string) => id === 'om_task' }

  it('本轮人类 text/post 消息、没有 Friday 表情 → 可以赞', () => {
    expect(kudosRejection(base, ctx)).toBeUndefined()
    expect(kudosRejection({ ...base, msgType: 'post' }, ctx)).toBeUndefined()
  })

  it('不在本轮集合、非文本、机器人、自己、提问、没解决的报错、已有 Friday 表情', () => {
    expect(kudosRejection(undefined, ctx)).toBe('not_in_round')
    expect(kudosRejection({ ...base, msgType: 'image' }, ctx)).toBe('not_text')
    expect(kudosRejection({ ...base, senderType: 'app' }, ctx)).toBe('not_human')
    expect(kudosRejection({ ...base, senderOpenId: undefined }, ctx)).toBe('not_human')
    expect(kudosRejection({ ...base, senderOpenId: 'ou_bot' }, ctx)).toBe('self')
    expect(kudosRejection({ ...base, text: '这个接口怎么调？' }, ctx)).toBe('question')
    expect(kudosRejection({ ...base, text: '部署又挂了，还是 500' }, ctx)).toBe('trouble')
    expect(kudosRejection({ ...base, messageId: 'om_task' }, ctx)).toBe('already_reacted')
  })

  it('looksLikeTrouble：报错、求助算；说了已解决的不算；help 按整词匹配', () => {
    for (const t of ['构建失败了', '还是报错', 'Error: cannot find module x', '求助，线上起不来', 'request timed out']) expect(looksLikeTrouble(t)).toBe(true)
    for (const t of ['修好了，之前的报错是缓存导致的', '失败原因找到了，已解决', 'fixed: the timeout came from DNS', '这个总结很 helpful', '功能做完了，文档在群公告']) expect(looksLikeTrouble(t)).toBe(false)
  })
})

describe('Kudos 账本', () => {
  it('建表带索引；重复建表不报错', () => {
    const { db } = ledger()
    ensureKudosSchema(db)
    db.exec(KUDOS_SCHEMA)
    const cols = (db.prepare('PRAGMA table_info(message_kudos)').all() as { name: string; pk: number }[])
    expect(cols.map((c) => c.name)).toEqual(['message_id', 'chat_id', 'space_id', 'sender_open_id', 'emoji_type', 'reaction_id', 'reason', 'created_at', 'removed_at'])
    expect(cols.find((c) => c.pk === 1)?.name).toBe('message_id')
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'message_kudos' AND name = 'idx_message_kudos_chat_created'").get()
    expect(idx).toBeDefined()
  })

  it('同一条消息只占一次名额', () => {
    const { kudos } = ledger({ now: () => SHANGHAI_MIDNIGHT + 3600_000 })
    expect(kudos.claim(claimInput('om_a1'))).toBe('claimed')
    expect(kudos.claim(claimInput('om_a1'))).toBe('duplicate')
    expect(kudos.countToday('oc_a')).toBe(1)
  })

  it('每群每天上限；群与群互不影响', () => {
    const { kudos } = ledger({ maxPerDay: 2, now: () => SHANGHAI_MIDNIGHT + 3600_000 })
    expect(kudos.claim(claimInput('om_a1'))).toBe('claimed')
    expect(kudos.claim(claimInput('om_a2'))).toBe('claimed')
    expect(kudos.claim(claimInput('om_a3'))).toBe('daily_limit')
    expect(kudos.remainingToday('oc_a')).toBe(0)
    expect(kudos.claim(claimInput('om_b1', 'oc_b'))).toBe('claimed')
    expect(kudos.remainingToday('oc_b')).toBe(1)
  })

  it('自然日按 Asia/Shanghai 划分：北京时间零点后名额恢复', () => {
    let now = SHANGHAI_MIDNIGHT - 60_000 // 北京时间 23:59
    const { kudos } = ledger({ maxPerDay: 1, now: () => now })
    expect(kudos.dayStart()).toBe(SHANGHAI_MIDNIGHT - DAY)
    expect(kudos.claim(claimInput('om_a1'))).toBe('claimed')
    expect(kudos.claim(claimInput('om_a2'))).toBe('daily_limit')
    now = SHANGHAI_MIDNIGHT + 60_000 // 北京时间 00:01（UTC 仍是前一天 16:01）
    expect(kudos.dayStart()).toBe(SHANGHAI_MIDNIGHT)
    expect(kudos.claim(claimInput('om_a2'))).toBe('claimed')
  })

  it('上限为 0 时不占名额', () => {
    const { kudos } = ledger({ maxPerDay: 0 })
    expect(kudos.claim(claimInput('om_a1'))).toBe('disabled')
    expect(kudos.has('om_a1')).toBe(false)
  })

  it('贴上后记 reaction_id；撤掉后记 removed_at，行保留、名额不退', () => {
    const now = SHANGHAI_MIDNIGHT + 3600_000
    const { kudos } = ledger({ maxPerDay: 1, now: () => now })
    kudos.claim(claimInput('om_a1'))
    expect(kudos.get('om_a1')?.reactionId).toBeNull()
    kudos.settle('om_a1', 'rx_1')
    kudos.settle('om_a1', 'rx_2') // 已经有了不覆盖
    expect(kudos.get('om_a1')).toMatchObject({ reactionId: 'rx_1', removedAt: null, reason: '讲清了缓存失效的原因', spaceId: 'sp_a', senderOpenId: 'ou_alice', emojiType: 'THUMBSUP' })
    expect(kudos.markRemoved('om_a1')).toBe(true)
    expect(kudos.markRemoved('om_a1')).toBe(false)
    expect(kudos.get('om_a1')?.removedAt).toBe(now)
    expect(kudos.claim(claimInput('om_a1'))).toBe('duplicate')
    expect(kudos.remainingToday('oc_a')).toBe(0)
  })
})

describe('配置', () => {
  const env = (over: Record<string, string> = {}) => ({ FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 'b', ...over }) as NodeJS.ProcessEnv

  it('默认值：点赞表情 THUMBSUP、每群每天 3 个、新进群默认开主动模式', () => {
    const cfg = loadConfig(env())
    expect(cfg.feishu.emoji.like).toBe('THUMBSUP')
    expect(cfg.kudos.maxPerDay).toBe(3)
    expect(cfg.proactive.defaultOn).toBe(true)
    // 回执表情不受影响
    expect(cfg.feishu.reactions).toEqual(loadConfig(env({ FRIDAY_KUDOS_EMOJI: 'APPLAUSE' })).feishu.reactions)
  })

  it('环境变量', () => {
    const cfg = loadConfig(env({ FRIDAY_KUDOS_EMOJI: ' APPLAUSE ', FRIDAY_KUDOS_MAX_PER_DAY: '0', FRIDAY_PROACTIVE_DEFAULT_ON: 'off' }))
    expect(cfg.feishu.emoji.like).toBe('APPLAUSE')
    expect(cfg.kudos.maxPerDay).toBe(0)
    expect(cfg.proactive.defaultOn).toBe(false)
    for (const v of ['false', '0']) expect(loadConfig(env({ FRIDAY_PROACTIVE_DEFAULT_ON: v })).proactive.defaultOn).toBe(false)
    for (const v of ['on', 'true', '1']) expect(loadConfig(env({ FRIDAY_PROACTIVE_DEFAULT_ON: v })).proactive.defaultOn).toBe(true)
    expect(loadConfig(env({ FRIDAY_KUDOS_EMOJI: '  ' })).feishu.emoji.like).toBe('THUMBSUP')
    // FRIDAY_REACTIONS=off 只关回执，不关点赞
    expect(loadConfig(env({ FRIDAY_REACTIONS: 'off' })).feishu.emoji.like).toBe('THUMBSUP')
  })

  it('写错的值直接报错，不悄悄用默认值', () => {
    expect(() => loadConfig(env({ FRIDAY_PROACTIVE_DEFAULT_ON: 'yes' }))).toThrow('FRIDAY_PROACTIVE_DEFAULT_ON')
    expect(() => loadConfig(env({ FRIDAY_KUDOS_MAX_PER_DAY: '-1' }))).toThrow('FRIDAY_KUDOS_MAX_PER_DAY')
    expect(() => loadConfig(env({ FRIDAY_KUDOS_MAX_PER_DAY: 'many' }))).toThrow('FRIDAY_KUDOS_MAX_PER_DAY')
  })
})
