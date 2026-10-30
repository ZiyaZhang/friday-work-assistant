/**
 * 待办按证据判断是否已完成（2026-09-23 用户定）：
 * - 直接标完成只认两种：平台状态（待办里写了链接的 GitHub Issue 关闭为完成 / PR 已合并；飞书任务已勾由原生同步负责），
 *   以及本人在这条待办原消息的话题里说做完了；
 * - 别人说的、说法有歧义的、只完成一部分的，只列出来请本人确认；
 * - 标过完成又被本人改回来的，同一条证据不再用。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { TodoCompletionEvidence, completionStatement, type CompletionSubject, type GitHubItemState, type ThreadMessage } from '../src/core/todo-completion-evidence.js'
import type { TodoMessageMetadata } from '../src/core/todo-provenance.js'

const NOW = 1_800_000_000_000
const MIN = 60_000
const dbs: DatabaseSync[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close() })

/** 和 todo-provenance 里真实入站元数据同形：群里的话题消息带 thread_id，普通回复链带 root_id。 */
function source(patch: Partial<TodoMessageMetadata> = {}): TodoMessageMetadata {
  return { messageId: 'om_request_1', chatId: 'oc_product', chatType: 'group', senderOpenId: 'ou_alice', msgType: 'text',
    createTimeMs: NOW, threadId: 'omt_plugin_install', link: { status: 'unavailable' }, ...patch }
}

function subject(patch: Partial<CompletionSubject> = {}): CompletionSubject {
  return { id: 1, title: '改插件系统的安装流程', detail: null, ownerOpenId: 'ou_alice', createdAt: NOW, source: source(), ...patch }
}

function reply(patch: Partial<ThreadMessage> & { text: string }): ThreadMessage {
  return { messageId: `om_reply_${Math.random().toString(36).slice(2, 8)}`, chatId: 'oc_product', senderOpenId: 'ou_alice',
    createTimeMs: NOW + 30 * MIN, threadId: 'omt_plugin_install', rootId: 'om_request_1', parentId: 'om_request_1', ...patch }
}

function setup(messages: ThreadMessage[] = [], opts: { readable?: (chatId: string, openId: string) => boolean; github?: Record<string, GitHubItemState> } = {}) {
  const db = new DatabaseSync(':memory:')
  dbs.push(db)
  const githubReads: string[] = []
  const evidence = new TodoCompletionEvidence(db, {
    // 与接口文档里 MessageCache.thread 的查询一致：同一根消息下的回复，或同一话题里的消息
    threadMessages: (anchor, sinceMs) => messages.filter(m => m.chatId === anchor.chatId && m.createTimeMs > sinceMs &&
      (m.rootId === anchor.rootMessageId || (anchor.threadId !== undefined && m.threadId === anchor.threadId))),
    canRead: opts.readable ?? (() => true),
    readGitHub: async ref => {
      const key = `${ref.owner}/${ref.repo}#${ref.number}`
      githubReads.push(key)
      return opts.github?.[key] ?? { status: 'unavailable', reason: 'not configured' }
    },
  })
  return { db, evidence, githubReads }
}

describe('the owner saying it is done in the original thread', () => {
  it('is definite and cites the message, without copying its text', async () => {
    const said = reply({ text: '@Friday 插件安装流程已经改好了，PR 也合了' })
    const t = setup([said])
    const [result] = await t.evidence.assess('ou_alice', [subject()])
    expect(result).toMatchObject({ todoId: 1, verdict: 'definite',
      evidence: [{ kind: 'thread_statement', messageId: said.messageId, chatId: 'oc_product', byOwner: true, at: said.createTimeMs, done: true }] })
    expect(JSON.stringify(result)).not.toContain('插件安装流程已经改好了')
    expect(result.receipt).toContain('原话题')
  })

  it('also counts in a plain reply chain without a thread', async () => {
    const said = reply({ text: '做完了', threadId: undefined, rootId: 'om_request_1' })
    const t = setup([said])
    const [result] = await t.evidence.assess('ou_alice', [subject({ source: source({ threadId: undefined }) })])
    expect(result.verdict).toBe('definite')
  })

  it('someone else saying it is done is only a suggestion', async () => {
    const t = setup([reply({ senderOpenId: 'ou_bob', text: '知行这个已经搞定了' })])
    const [result] = await t.evidence.assess('ou_alice', [subject()])
    expect(result).toMatchObject({ verdict: 'probable', evidence: [{ kind: 'thread_statement', byOwner: false, done: true }] })
  })

  it.each([
    '做完了吗？', '还没做完', '快做完了', '差不多搞定了', '我明天搞定', '完成了一半', '初稿写完了吗', 'not done yet', 'almost done',
  ])('“%s” is not a completion statement', async text => {
    const t = setup([reply({ text })])
    const [result] = await t.evidence.assess('ou_alice', [subject()])
    expect(result).toMatchObject({ verdict: 'none', evidence: [] })
  })

  it('ignores statements made before the Todo existed, and in other threads or chats', async () => {
    const t = setup([
      reply({ text: '做完了', createTimeMs: NOW - MIN }),
      reply({ text: '做完了', threadId: 'omt_other_topic', rootId: 'om_other_root', parentId: 'om_other_root' }),
      reply({ text: '做完了', chatId: 'oc_elsewhere' }),
    ])
    const [result] = await t.evidence.assess('ou_alice', [subject()])
    expect(result.verdict).toBe('none')
  })

  it('does not use a group the owner can no longer read', async () => {
    const t = setup([reply({ text: '做完了' })], { readable: () => false })
    const [result] = await t.evidence.assess('ou_alice', [subject()])
    expect(result.verdict).toBe('none')
  })

  it('is ambiguous when two of the owner’s open Todos came from the same thread before the statement', async () => {
    const said = reply({ text: '都搞定了', createTimeMs: NOW + 2 * 60 * MIN })
    const t = setup([said])
    const results = await t.evidence.assess('ou_alice', [
      subject({ id: 1 }),
      subject({ id: 2, title: '更新插件文档', createdAt: NOW + 10 * MIN, source: source({ messageId: 'om_request_2', rootId: 'om_request_1', createTimeMs: NOW + 10 * MIN }) }),
    ])
    expect(results.map(r => [r.todoId, r.verdict])).toEqual([[1, 'probable'], [2, 'probable']])
  })

  it('a statement made before the second Todo existed can only mean the first one', async () => {
    const said = reply({ text: '做完了', createTimeMs: NOW + 5 * MIN })
    const t = setup([said])
    const results = await t.evidence.assess('ou_alice', [
      subject({ id: 1 }),
      subject({ id: 2, title: '更新插件文档', createdAt: NOW + 10 * MIN, source: source({ messageId: 'om_request_2', rootId: 'om_request_1', createTimeMs: NOW + 10 * MIN }) }),
    ])
    expect(results.map(r => [r.todoId, r.verdict])).toEqual([[1, 'definite'], [2, 'none']])
  })

  it('a Todo recorded from the root message before the thread existed shares the thread with one recorded inside it', async () => {
    // 飞书话题：根消息记待办时还没有 thread_id；之后话题里的消息都带 thread_id 和 root_id = 根消息
    const said = reply({ text: '都搞定了', createTimeMs: NOW + 2 * 60 * MIN, threadId: 'omt_created_later', rootId: 'om_root' })
    const t = setup([said])
    const results = await t.evidence.assess('ou_alice', [
      subject({ id: 1, source: source({ messageId: 'om_root', threadId: undefined }) }),
      subject({ id: 2, title: '更新插件文档', createdAt: NOW + 10 * MIN,
        source: source({ messageId: 'om_in_thread', threadId: 'omt_created_later', rootId: 'om_root', createTimeMs: NOW + 10 * MIN }) }),
    ])
    expect(results.map(r => [r.todoId, r.verdict])).toEqual([[1, 'probable'], [2, 'probable']])
  })

  it('a Todo recorded without a source message has no thread evidence', async () => {
    const t = setup([reply({ text: '做完了' })])
    const [result] = await t.evidence.assess('ou_alice', [subject({ source: null })])
    expect(result.verdict).toBe('none')
  })
})

describe('GitHub links written in the Todo', () => {
  const repo = 'acme-org/acme-harness'
  it('a merged pull request or an issue closed as completed is definite', async () => {
    const t = setup([], { github: { [`${repo}#3812`]: { status: 'read', kind: 'pull', state: 'closed', merged: true, stateReason: null },
      [`${repo}#3790`]: { status: 'read', kind: 'issue', state: 'closed', merged: false, stateReason: 'completed' } } })
    const results = await t.evidence.assess('ou_alice', [
      subject({ id: 1, source: null, detail: `https://github.com/${repo}/pull/3812` }),
      subject({ id: 2, source: null, title: `修复 https://github.com/${repo}/issues/3790` }),
    ])
    expect(results.map(r => r.verdict)).toEqual(['definite', 'definite'])
    expect(results[0].evidence[0]).toMatchObject({ kind: 'github', ref: `${repo}#3812`, done: true, url: `https://github.com/${repo}/pull/3812` })
    expect(results[0].receipt).toContain('已合并')
  })

  it('an issue closed as not planned, a closed unmerged PR or an unreadable link is not completion', async () => {
    const t = setup([], { github: {
      [`${repo}#1`]: { status: 'read', kind: 'issue', state: 'closed', merged: false, stateReason: 'not_planned' },
      [`${repo}#2`]: { status: 'read', kind: 'pull', state: 'closed', merged: false, stateReason: null } } })
    const results = await t.evidence.assess('ou_alice', [
      subject({ id: 1, source: null, detail: `https://github.com/${repo}/issues/1` }),
      subject({ id: 2, source: null, detail: `https://github.com/${repo}/pull/2` }),
      subject({ id: 3, source: null, detail: `https://github.com/${repo}/issues/3` }),
    ])
    expect(results.map(r => r.verdict)).toEqual(['none', 'none', 'none'])
  })

  it('only some of several linked items done, or an issue closed without a reason, is a suggestion', async () => {
    const t = setup([], { github: {
      [`${repo}#10`]: { status: 'read', kind: 'pull', state: 'closed', merged: true, stateReason: null },
      [`${repo}#11`]: { status: 'read', kind: 'pull', state: 'open', merged: false, stateReason: null },
      [`${repo}#12`]: { status: 'read', kind: 'issue', state: 'closed', merged: false, stateReason: null } } })
    const results = await t.evidence.assess('ou_alice', [
      subject({ id: 1, source: null, detail: `https://github.com/${repo}/pull/10 和 https://github.com/${repo}/pull/11` }),
      subject({ id: 2, source: null, detail: `https://github.com/${repo}/issues/12` }),
    ])
    expect(results.map(r => r.verdict)).toEqual(['probable', 'probable'])
  })

  it('reads each linked item once even when it appears twice', async () => {
    const t = setup([], { github: { [`${repo}#5`]: { status: 'read', kind: 'pull', state: 'closed', merged: true, stateReason: null } } })
    await t.evidence.assess('ou_alice', [subject({ source: null, title: `https://github.com/${repo}/pull/5`, detail: `见 https://github.com/${repo}/pull/5` })])
    expect(t.githubReads).toEqual([`${repo}#5`])
  })
})

describe('after the owner reopens an auto-completed Todo', () => {
  it('the same evidence is not used again, but new evidence still counts', async () => {
    const first = reply({ text: '做完了' })
    const messages = [first]
    const t = setup(messages)
    const [before] = await t.evidence.assess('ou_alice', [subject()])
    expect(before.verdict).toBe('definite')
    t.evidence.recordApplied(1, before.evidence.map(e => e.key), NOW + 40 * MIN)
    const [reopened] = await t.evidence.assess('ou_alice', [subject()])
    expect(reopened).toMatchObject({ verdict: 'none', evidence: [] })
    messages.push(reply({ text: '这次真的做完了', createTimeMs: NOW + 90 * MIN }))
    const [later] = await t.evidence.assess('ou_alice', [subject()])
    expect(later.verdict).toBe('definite')
  })

  it('a link already used still counts when deciding whether every linked item is done', async () => {
    const repo = 'acme-org/acme-harness'
    const github: Record<string, GitHubItemState> = { [`${repo}#1`]: { status: 'read', kind: 'issue', state: 'closed', merged: false, stateReason: 'completed' } }
    const t = setup([], { github })
    const [first] = await t.evidence.assess('ou_alice', [subject({ source: null, detail: `https://github.com/${repo}/issues/1` })])
    expect(first.verdict).toBe('definite')
    t.evidence.recordApplied(1, first.evidence.map(e => e.key), NOW)
    // 本人改回未完成；#1 在 GitHub 上也重新打开了；说明里又加了一个已合并的 PR
    github[`${repo}#1`] = { status: 'read', kind: 'issue', state: 'open', merged: false, stateReason: 'reopened' }
    github[`${repo}#2`] = { status: 'read', kind: 'pull', state: 'closed', merged: true, stateReason: null }
    const [later] = await t.evidence.assess('ou_alice', [subject({ source: null, detail: `https://github.com/${repo}/issues/1 https://github.com/${repo}/pull/2` })])
    expect(later).toMatchObject({ verdict: 'probable', evidence: [{ ref: `${repo}#2`, done: true }] })
  })

  it('recording the same evidence twice is harmless', () => {
    const t = setup()
    t.evidence.recordApplied(1, ['message:om_x'], NOW)
    t.evidence.recordApplied(1, ['message:om_x'], NOW + 1)
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM todo_completion_evidence').get()).toEqual({ n: 1 })
  })
})

describe('completionStatement', () => {
  it.each(['做完了', '已经搞定了', 'PR 已合并', '已上线', '写好了，发群里了', 'Done.', 'finished', '这次真的做完了', '终于写完了',
    '会议纪要写完了', '@Friday 插件安装流程已经改好了，PR 也合了',
    // 复核补充：常见的真实说法，带表情、飞书表情码、致谢、换行
    '登录功能做完了', '新功能已上线', '新技能写好了', '搞定了👍', '已完成 ✅', '已完成[赞]', '搞定了 谢谢', '做完了\n辛苦大家看一下', 'done 🎉',
    '修好了', '已修复', '问题解决了', '已发布', '搞定！', '做完了，我这就发给你'])('“%s” is a plain completion statement', text => {
    expect(completionStatement(text)).toBe('plain')
  })

  // 审查里复现的误判：应答、条件、将来、撤回、问句、英文子串都不算完成
  it.each(['好的，做完了告诉你', '做完了跟我说一声', '如果做完了就告诉我', '昨天说做完了，其实没有', '✅ 收到', '做完了没', '要做完了',
    'still unfinished', 'the plan was abandoned', 'ping me when done', "I'll let you know once it's finished", 'done?',
    // 复核补充：条件在前、后句带“再 / 就”，反事实，没带问号的问句，自己揽下来的将来时
    '等上线了，我再通知客户', '等合并了，再发版', '等你做完了，我们再对一下', '一旦上线了，就通知大家', '上线了，就通知大家',
    '我以为做完了', '本来做完了', '谁做完了', '是不是做完了', 'is it done', 'Has it been merged', '我来搞定',
    // 第三轮复核：带时间、人称或请求的“搞定”是承诺；英文被动不定式；句中的“等”
    '好，今天搞定', '下午搞定', '周五前搞定', '这周搞定', '这个你搞定', '帮我搞定', '麻烦今天搞定，谢谢',
    'This needs to be fixed', 'to be released', 'must be done', '我们等 PR 合并了，通知客户'])('“%s” is not a completion statement', text => {
    expect(completionStatement(text)).toBe('none')
  })

  // 说了完成，但同一条消息里还有保留：只能请本人确认
  it.each(['改好了，还差测试', '#123 已合并，#124 还在 review', '应该做完了吧', '做完了，不过文档还没更新', 'done, but tests are still failing',
    // 复核补充：主观判断、转述别人、只回一个勾（常见意思是“收到”）
    '我觉得做完了', '理论上做完了', '他那边做完了', '她已经写好了', '其他的都做完了', '✅', '看起来做完了'])('“%s” is a hedged statement', text => {
    expect(completionStatement(text)).toBe('hedged')
  })
})

describe('a hedged statement by the owner', () => {
  it('is only a suggestion', async () => {
    const t = setup([reply({ text: '改好了，还差测试' })])
    const [result] = await t.evidence.assess('ou_alice', [subject()])
    expect(result).toMatchObject({ verdict: 'probable', evidence: [{ kind: 'thread_statement', byOwner: true }] })
  })
})
