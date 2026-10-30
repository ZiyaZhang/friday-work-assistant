import { describe, expect, it } from 'vitest'
import { GROUP_SCOPES, PROACTIVE_SCOPES } from '../src/internal/tokens.js'
import { parseContent, replaceMentionKeys } from '../src/feishu/content.js'
import { inboundFromEvent, inboundToHistory, parseCommand, parseMention, threadKeyCandidates, type InboundMessage } from '../src/feishu/mention.js'
import { CARD_BODY_LIMIT, chunkText, renderPermissionCard, renderTaskCard } from '../src/feishu/cards.js'
import { parseDocRef } from '../src/feishu/client.js'
import { Registry } from '../src/core/registry.js'
import { ChannelMemory } from '../src/core/memory.js'
import { SerialQueue } from '../src/core/queue.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { clampInt, parseTimeSec } from '../src/internal/api.js'
import { applyUpdate } from '../src/core/orchestrator.js'
import { buildTurnPrompt, workspaceInstructions } from '../src/core/prompt.js'
import { RecentSet, normalizeCardAction } from '../src/feishu/ws.js'
import { loadConfig, parseReactions } from '../src/config.js'
import { projectWorkProgress } from '../src/core/work-progress.js'
import { dshEnv } from '../src/index.js'

const BOT = { openId: 'ou_bot', name: 'Friday' }

function inbound(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    eventId: 'ev1',
    messageId: 'om_1',
    chatId: 'oc_1',
    chatType: 'group',
    msgType: 'text',
    text: '@Friday 总结一下',
    senderOpenId: 'ou_alice',
    senderType: 'user',
    mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'Friday' }],
    createTimeMs: 1_700_000_000_000,
    ...over,
  }
}

describe('content', () => {
  it('parses text with mention placeholders', () => {
    expect(parseContent('text', JSON.stringify({ text: '@_user_1 看看这个 @_user_2' }), [
      { key: '@_user_1', name: 'Friday' },
      { key: '@_user_2', name: '陆知行' },
    ])).toBe('@Friday 看看这个 @陆知行')
  })
  it('parses post rich text with links and code', () => {
    const post = { title: '标题', content: [[{ tag: 'text', text: '看 ' }, { tag: 'a', text: '文档', href: 'https://x.feishu.cn/docx/abc' }], [{ tag: 'at', user_name: '小明' }]] }
    expect(parseContent('post', JSON.stringify(post))).toBe('标题\n看 文档(https://x.feishu.cn/docx/abc)\n@小明')
  })
  it('handles localized post shape and file/image', () => {
    expect(parseContent('post', JSON.stringify({ zh_cn: { title: 't', content: [[{ tag: 'text', text: 'hi' }]] } }))).toBe('t\nhi')
    expect(parseContent('file', JSON.stringify({ file_key: 'f', file_name: 'sample-skill.md' }))).toBe('[文件 sample-skill.md]')
    expect(parseContent('image', JSON.stringify({ image_key: 'img_1' }))).toBe('[图片 img_1]')
  })
  it('extracts card text', () => {
    const card = { header: { title: { tag: 'plain_text', content: '新提议' } }, elements: [{ tag: 'markdown', content: '正文' }] }
    expect(parseContent('interactive', JSON.stringify(card))).toBe('[卡片]\n新提议\n正文')
  })
  it('keeps unknown placeholders and raw invalid json', () => {
    expect(replaceMentionKeys('@_user_9 x', [])).toBe('@_user_9 x')
    expect(parseContent('text', 'not json')).toBe('not json')
  })
})

describe('mention', () => {
  it('detects bot mention by open_id and strips it', () => {
    const p = parseMention(inbound(), BOT)
    expect(p.mentioned).toBe(true)
    expect(p.body).toBe('总结一下')
    expect(p.command).toBeUndefined()
  })
  it('falls back to name match when bot open_id unknown', () => {
    const p = parseMention(inbound(), { name: 'Friday' })
    expect(p.mentioned).toBe(true)
  })
  it('ignores messages mentioning others only', () => {
    const p = parseMention(inbound({ text: '@陆知行 看看', mentions: [{ key: '@_user_1', openId: 'ou_w', name: '陆知行' }] }), BOT)
    expect(p.mentioned).toBe(false)
    expect(p.body).toBe('@陆知行 看看')
  })
  it('parses commands', () => {
    expect(parseCommand('!restart 重新总结')).toBe('new') // 老名字是别名
    expect(parseCommand('/new')).toBe('new')
    expect(parseCommand('/tasks')).toBe('tasks')
    expect(parseCommand('!status')).toBe('tasks')
    expect(parseCommand('/settings')).toBe('settings')
    expect(parseCommand('/groups')).toBe('groups')
    expect(parseCommand('/responsibilities')).toBe('responsibilities')
    expect(parseCommand('/stop')).toBe('stop')
    expect(parseCommand('!Help')).toBe('help')
    expect(parseCommand('帮我 !stop')).toBeUndefined()
  })
  it('orders thread key candidates', () => {
    expect(threadKeyCandidates(inbound({ threadId: 'omt_1', rootId: 'om_root', parentId: 'om_parent' }))).toEqual(['thread:omt_1', 'msg:om_root', 'msg:om_parent', 'msg:om_1'])
    expect(threadKeyCandidates(inbound())).toEqual(['msg:om_1'])
  })
  it('builds inbound from raw event', () => {
    const msg = inboundFromEvent({
      event_id: 'e',
      sender: { sender_id: { open_id: 'ou_a' }, sender_type: 'user' },
      message: {
        message_id: 'om_x',
        chat_id: 'oc_x',
        chat_type: 'p2p',
        message_type: 'text',
        create_time: '1700000000000',
        content: JSON.stringify({ text: '@_user_1 hi' }),
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Friday' }],
      },
    })
    expect(msg.chatType).toBe('p2p')
    expect(msg.text).toBe('@Friday hi')
    expect(msg.createTimeMs).toBe(1700000000000)
    expect(inboundFromEvent({ message: { create_time: '1700000000' } }).createTimeMs).toBe(1700000000000)
  })
  it('preserves the platform sender tenant and reply attachment through inbound and history conversion', () => {
    const msg = inboundFromEvent({
      event_id: 'synthetic-reply-event',
      sender: { tenant_key: 'actual-tenant', sender_id: { open_id: 'actual-author' }, sender_type: 'user' },
      message: {
        message_id: 'synthetic-reply', chat_id: 'actual-chat', chat_type: 'group', message_type: 'file',
        parent_id: 'actual-question-message', root_id: 'actual-root', thread_id: 'actual-thread', create_time: '1700000000123',
        content: JSON.stringify({ file_key: 'actual-file-key', file_name: 'synthetic-session.jsonl', tenant_key: 'untrusted-content-tenant' }),
      },
    })
    const identityAndAttachment = {
      tenantId: 'actual-tenant', messageId: 'synthetic-reply', senderOpenId: 'actual-author', senderType: 'user',
      parentId: 'actual-question-message', rootId: 'actual-root', threadId: 'actual-thread',
      fileKey: 'actual-file-key', fileName: 'synthetic-session.jsonl', createTimeMs: 1700000000123,
    }
    expect(msg).toMatchObject({ ...identityAndAttachment, chatId: 'actual-chat', chatType: 'group' })
    expect(inboundToHistory(msg, '合成发言人')).toMatchObject({ ...identityAndAttachment, senderName: '合成发言人', text: msg.text })
    expect(inboundFromEvent({ sender: { sender_id: { open_id: 'author-without-tenant' } }, message: {
      content: JSON.stringify({ text: 'synthetic', tenant_key: 'untrusted-content-tenant' }),
    } }).tenantId).toBeUndefined()
  })
})

describe('cards', () => {
  it('renders the host result projection even while the legacy Task phase is done', () => {
    const progress = projectWorkProgress({ task: { status: 'done', stopReason: 'max_tokens' },
      run: { state: 'completed', stopReason: 'max_tokens', result: { version: 1, termination: 'max_tokens', outcome: 'partial', reason: 'model_limit' } } })
    const card = JSON.stringify(renderTaskCard({ title: '请求', phase: 'done', body: '已查实的部分', tools: [], progress }))
    expect(card).toContain('尚未完成')
    expect(card).toContain('这轮输出被截断')
    expect(card).not.toContain('工作已完成')
  })
  it('renders task card with status, tools and body', () => {
    const card = renderTaskCard({ title: '总结一下', phase: 'working', statusLine: '正在：读取话题', tools: [{ id: '1', title: '读取话题', status: 'completed' }], body: '结论' })
    const json = JSON.stringify(card)
    expect(json).toContain('正在：读取话题')
    expect(json).not.toContain('⏳ 正在')
    expect(json).toContain('✅ 读取话题')
    expect(json).toContain('结论')
    expect(card.header).toBeUndefined()
    expect((card.config as { update_multi: boolean }).update_multi).toBe(true)
    const done = JSON.stringify(renderTaskCard({ title: 't', phase: 'done', tools: [], body: '你好' }))
    expect(done).not.toContain('⏳')
    expect(done).not.toContain('过程')
    const failed = JSON.stringify(renderTaskCard({ title: 't', phase: 'failed', tools: [], body: '', error: 'boom' }))
    expect(failed).toContain('出错：boom')
  })
  it('truncates long body and marks it', () => {
    const card = renderTaskCard({ title: 't', phase: 'done', tools: [], body: 'x'.repeat(CARD_BODY_LIMIT + 100) })
    expect(JSON.stringify(card)).toContain('已截断')
  })
  it('permission card carries request id and decision', () => {
    const c = renderPermissionCard({ requestId: 'r1', toolTitle: 'bash', kind: 'execute', detail: 'rm -rf build', expiresInMinutes: 10 })
    expect(JSON.stringify(c)).toContain('"request_id":"r1"')
    expect(JSON.stringify(renderPermissionCard({ requestId: 'r1', toolTitle: 'bash', expiresInMinutes: 10 }, 'deny'))).toContain('已拒绝')
    const cancelled = JSON.stringify(renderPermissionCard({ requestId: 'r1', toolTitle: 'bash', expiresInMinutes: 10 }, 'cancelled'))
    expect(cancelled).toContain('确认已取消')
    expect(cancelled).not.toContain('无人确认')
    expect(cancelled).not.toContain('"request_id"')
  })
  it('escalation card shows the command, the model reason and who may approve', () => {
    const c = renderPermissionCard({
      requestId: 'r2',
      toolTitle: 'bash',
      category: 'execute',
      detail: 'grep -rn "session" repos/dsh/src | head',
      description: 'Search session code',
      escalation: { mode: 'danger-full-access', justification: 'sandbox backend unavailable on this host' },
      note: '本机没有沙箱后端',
      approverName: '张三',
      expiresInMinutes: 10,
    })
    const s = JSON.stringify(c)
    expect(s).toContain('执行命令')
    expect(s).toContain('grep -rn')
    expect(s).toContain('danger-full-access')
    expect(s).toContain('sandbox backend unavailable')
    expect(s).toContain('Search session code')
    expect(s).toContain('由 张三 确认')
    expect(s).toContain('本机没有沙箱后端')
    const edit = JSON.stringify(renderPermissionCard({ requestId: 'r3', toolTitle: 'write', category: 'edit', detail: '/etc/hosts', expiresInMinutes: 5 }))
    expect(edit).toContain('修改')
    expect(edit).toContain('/etc/hosts')
  })
  it('tool rows show the command detail inline', () => {
    const card = renderTaskCard({ title: 't', phase: 'working', tools: [{ id: '1', title: 'bash', status: 'in_progress', detail: 'ls -la `x`' }], body: '' })
    const s = JSON.stringify(card)
    expect(s).toContain('⏳ bash · `ls -la ＇x＇`')
  })
  it('chunks text on line boundaries', () => {
    const chunks = chunkText('a'.repeat(50) + '\n' + 'b'.repeat(50), 60)
    expect(chunks).toEqual(['a'.repeat(50), 'b'.repeat(50)])
  })
})

describe('doc refs', () => {
  it('parses docx and wiki links', () => {
    expect(parseDocRef('看 https://acme.feishu.cn/docx/AbCdEf123 这个')).toEqual({ kind: 'docx', token: 'AbCdEf123' })
    expect(parseDocRef('https://acme.feishu.cn/wiki/WikiTok?from=x')).toEqual({ kind: 'wiki', token: 'WikiTok' })
    expect(parseDocRef('nope')).toBeUndefined()
  })
})

describe('registry', () => {
  it('creates, resolves via alias, repoints on restart, tracks tasks', () => {
    const r = new Registry(':memory:')
    const s = r.createSession({ sessionKey: 'msg:om_1', chatId: 'oc', chatType: 'group', cwd: '/w', requesterOpenId: 'ou_a', rootMessageId: 'om_1' })
    expect(r.resolveSession(['msg:om_1'])?.sessionKey).toBe('msg:om_1')
    r.updateSession('msg:om_1', { threadId: 'omt_9', acpSessionId: 'acp-1' })
    expect(r.resolveSession(['thread:omt_9'])?.acpSessionId).toBe('acp-1')
    expect(r.getSessionByAcpId('acp-1')?.sessionKey).toBe('msg:om_1')
    const t = r.createTask({ sessionKey: s.sessionKey, messageId: 'om_1', prompt: 'hi' })
    expect(r.runningTask('msg:om_1')?.id).toBe(t.id)
    r.updateTask(t.id, { status: 'done', stopReason: 'end_turn' })
    expect(r.runningTask('msg:om_1')).toBeUndefined()
    r.createSession({ sessionKey: 'msg:om_2', chatId: 'oc', chatType: 'group', cwd: '/w' })
    r.archiveAndRepoint('msg:om_1', 'msg:om_2')
    expect(r.resolveSession(['thread:omt_9'])?.sessionKey).toBe('msg:om_2')
    expect(r.getSession('msg:om_1')?.status).toBe('archived')
    r.createTask({ sessionKey: 'msg:om_2', messageId: 'om_3', prompt: 'x' })
    expect(r.failStaleTasks('restart')).toBe(1)
    r.close()
  })
})

describe('memory', () => {
  it('stores and searches CJK notes with trigram + LIKE fallback', () => {
    const r = new Registry(':memory:')
    const m = new ChannelMemory(r.db)
    m.add({ scope: 'chat:oc', kind: 'fact', title: '数仓权限对接人是陆知行', body: '8/4 申请过 Data Mind 和 Insight 分析师权限' })
    m.add({ scope: 'chat:oc', kind: 'qa', title: 'chatty-cli 是什么', body: '线上 Kimi 主站本体的 CLI 形态' })
    m.add({ scope: 'chat:other', kind: 'fact', title: '别的群的事', body: '不该被搜到 陆知行' })
    expect(m.search('chat:oc', '陆知行').map((n) => n.title)).toEqual(['数仓权限对接人是陆知行'])
    expect(m.search('chat:oc', '权限').length).toBe(1) // 2 字走 LIKE
    expect(m.search('chat:oc', '').length).toBe(2)
    expect(m.search('chat:oc', 'chatty')[0]?.title).toBe('chatty-cli 是什么')
    expect(m.renderForPrompt('chat:oc', 'chatty')).toBe('') // 候选 QA 可查历史，但不自动回流
    expect(m.renderForPrompt('chat:oc', '完全无关的词汇zzz')).toBe('')
    expect(m.count('chat:oc')).toBe(2)
    r.close()
  })
  it('rules are always injected, and can be removed within their scope only', () => {
    const r = new Registry(':memory:')
    const m = new ChannelMemory(r.db)
    const rule = m.add({ scope: 'user:ou_a', kind: 'rule', title: '回复一律不超过 100 字', body: '回复一律不超过 100 字' })
    m.confirm(rule.id, 'user:ou_a', { by: 'ou_a', messageId: 'confirm-rule' })
    m.add({ scope: 'user:ou_a', kind: 'fact', title: '张三负责数仓', body: '张三负责数仓对接' })
    const block = m.renderForPrompt('user:ou_a', '完全无关的词汇zzz')
    expect(block).toContain('常驻要求')
    expect(block).toContain('回复一律不超过 100 字')
    expect(block).not.toContain('频道笔记')
    const both = m.renderForPrompt('user:ou_a', '数仓')
    expect(both).toContain('常驻要求')
    expect(both).toContain('张三负责数仓')
    expect(m.rules('user:ou_a')).toHaveLength(1)
    expect(m.remove(rule.id, 'user:ou_b')).toBe(false) // 别的作用域删不掉
    expect(m.remove(rule.id, 'user:ou_a')).toBe(true)
    expect(m.renderForPrompt('user:ou_a', 'zzz')).toBe('')
    r.close()
  })
})

describe('queue', () => {
  it('serializes per key and runs keys in parallel', async () => {
    const q = new SerialQueue()
    const order: string[] = []
    const p1 = q.run('a', async () => {
      await new Promise((r) => setTimeout(r, 30))
      order.push('a1')
    })
    const p2 = q.run('a', async () => {
      order.push('a2')
    })
    const p3 = q.run('b', async () => {
      order.push('b1')
    })
    expect(q.pending('a')).toBe(2)
    await Promise.all([p1, p2, p3])
    expect(order).toEqual(['b1', 'a1', 'a2'])
    expect(q.pending('a')).toBe(0)
  })
  it('continues after a failed task', async () => {
    const q = new SerialQueue()
    await expect(q.run('k', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    await expect(q.run('k', async () => 'ok')).resolves.toBe('ok')
  })
})

describe('tokens', () => {
  it('issues, verifies, rejects tampering and expiry', () => {
    const t = new TokenIssuer('secret')
    const tok = t.issue({ sessionKey: 's', chatId: 'c', chatType: 'group', requesterOpenId: 'u', scopes: ['chat:read'] }, 60)
    const cap = t.verify(tok)
    expect(cap?.chatId).toBe('c')
    expect(cap?.scopes).toEqual(['chat:read'])
    expect(t.verify(tok.slice(0, -2) + 'zz')).toBeUndefined()
    expect(new TokenIssuer('other').verify(tok)).toBeUndefined()
    expect(t.verify(t.issue({ sessionKey: 's', chatId: 'c', chatType: 'group', scopes: [] }, -10))).toBeUndefined()
  })
})

describe('api helpers', () => {
  it('clamps ints and parses times', () => {
    expect(clampInt('900', 1, 500, 200)).toBe(500)
    expect(clampInt(undefined, 1, 500, 200)).toBe(200)
    expect(parseTimeSec('2026-09-17T00:00:00Z')).toBe(Date.UTC(2026, 8, 17) / 1000)
    expect(parseTimeSec(1700000000000)).toBe(1700000000)
    expect(parseTimeSec('1700000000')).toBe(1700000000)
    expect(() => parseTimeSec('garbage')).toThrow()
  })
})

describe('applyUpdate', () => {
  it('folds ACP updates into card state', () => {
    const state = { title: 't', phase: 'thinking' as const, tools: [], body: '' }
    const s = state as unknown as Parameters<typeof applyUpdate>[0]
    applyUpdate(s, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } })
    expect(s.statusLine).toBe('思考中…')
    applyUpdate(s, { sessionUpdate: 'tool_call', toolCallId: 'c1', title: '读取话题', kind: 'read', status: 'in_progress' })
    applyUpdate(s, { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed' })
    applyUpdate(s, { sessionUpdate: 'tool_call_update', toolCallId: 'c2', title: '未先声明的工具', status: 'failed' })
    applyUpdate(s, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '结论' } })
    applyUpdate(s, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '。' } })
    expect(s.tools.map((t) => `${t.title}:${t.status}`)).toEqual(['读取话题:completed', '未先声明的工具:failed'])
    expect(s.body).toBe('结论。')
    expect(s.phase).toBe('working')
  })
})

describe('prompt', () => {
  it('includes context header, memory and prior messages on first turn only', () => {
    const base = { botName: 'Friday', chatName: 'g', chatId: 'oc', chatType: 'group' as const, sessionKey: 'msg:1', requesterName: 'A', nowMs: 0, body: '总结' }
    const first = buildTurnPrompt({ ...base, isFirstTurn: true, memoryBlock: '[频道笔记] x', priorThreadMessages: [{ messageId: 'm', createTimeMs: 0, msgType: 'text', senderName: 'B', senderType: 'user', text: '之前说的' }] })
    expect(first).toContain('新会话')
    expect(first).toContain('[频道笔记] x')
    expect(first).toContain('B: 之前说的')
    const later = buildTurnPrompt({ ...base, isFirstTurn: false })
    expect(later).toContain('追问')
    expect(later).not.toContain('已有的消息')
  })

  it('workspace instructions carry the hard rules and the terse reply style', () => {
    const text = workspaceInstructions({ botName: 'Friday', hasRepos: true, repoNames: ['deepseek-harness'] })
    expect(text).toContain('绝不编造工具结果')
    expect(text).toContain('结论先行')
    expect(text).toContain('100 字')
    expect(text).toContain('repos/deepseek-harness')
    expect(workspaceInstructions({ botName: 'F', hasRepos: false, repoNames: [] })).toContain('没有挂载代码库')
  })
})

describe('ws helpers', () => {
  it('dedupes recent ids with bounded memory', () => {
    const r = new RecentSet(2)
    expect(r.seen('a')).toBe(false)
    expect(r.seen('a')).toBe(true)
    r.seen('b')
    r.seen('c')
    expect(r.seen('a')).toBe(false)
  })
  it('normalizes card actions', () => {
    const a = normalizeCardAction({ operator: { open_id: 'ou_x' }, context: { open_message_id: 'om_c', open_chat_id: 'oc' }, action: { value: { action: 'perm', request_id: 'r', decision: 'allow' } } })
    expect(a.operatorOpenId).toBe('ou_x')
    expect(a.messageId).toBe('om_c')
    expect(a.value.request_id).toBe('r')
  })
})

describe('config', () => {
  it('loads with defaults and validates enums', () => {
    const cfg = loadConfig({ FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 'b', FRIDAY_HOME: '/tmp/fh', DEEPSEEK_API_KEY: 'k' } as NodeJS.ProcessEnv)
    expect(cfg.dsh.home).toBe('/tmp/fh/dsh')
    expect(cfg.policy.permission).toBe('safe')
    expect(cfg.dsh.env.DEEPSEEK_API_KEY).toBe('k')
    expect(() => loadConfig({ FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 'b', FRIDAY_PERMISSION_POLICY: 'yolo' } as NodeJS.ProcessEnv)).toThrow(/FRIDAY_PERMISSION_POLICY/)
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/FEISHU_APP_ID/)
  })

  it('routes the feishu proxy but keeps dsh off it unless asked', () => {
    const base = { FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 'b', FRIDAY_HOME: '/tmp/fh' }
    const proxy = 'http://u:p%2Bq@ss.example.com:3128'
    // 只给飞书：dsh 环境里没有代理
    const a = loadConfig({ ...base, FRIDAY_FEISHU_PROXY: proxy } as NodeJS.ProcessEnv)
    expect(a.feishu.proxyUrl).toBe(proxy)
    expect(a.dsh.env.HTTPS_PROXY).toBeUndefined()
    // HTTPS_PROXY 兜底给飞书，dsh 依旧不吃
    const b = loadConfig({ ...base, HTTPS_PROXY: proxy } as NodeJS.ProcessEnv)
    expect(b.feishu.proxyUrl).toBe(proxy)
    expect(b.dsh.env.HTTPS_PROXY).toBeUndefined()
    // 显式关闭
    expect(loadConfig({ ...base, HTTPS_PROXY: proxy, FRIDAY_FEISHU_PROXY: 'off' } as NodeJS.ProcessEnv).feishu.proxyUrl).toBeUndefined()
    // FRIDAY_DSH_PROXY=1：dsh 拿到代理，NO_PROXY 含本机、私网段，以及**实际配的**内网端点。
    // 直连清单跟着配置走，不再写死域名——写死过一次 `.deepseek.com`，
    // 结果把公网的 api.deepseek.com 一起排除了，联网搜索永远连不上（见 dsh-proxy-env.test.ts）。
    const c = loadConfig({ ...base, HTTPS_PROXY: proxy, FRIDAY_DSH_PROXY: '1', NO_PROXY: 'foo.internal',
      DEEPSEEK_BASE_URL: 'https://llm-gateway.example.com/anthropic' } as NodeJS.ProcessEnv)
    expect(c.dsh.env.HTTPS_PROXY).toBe(proxy)
    expect(c.dsh.env.NO_PROXY).toContain('llm-gateway.example.com')
    // 按**条目**判，不是按子串——'llm-gateway.example.com' 本身就含 '.deepseek.com'
    expect((c.dsh.env.NO_PROXY ?? '').split(',')).not.toContain('.deepseek.com')
    expect(c.dsh.env.NO_PROXY).toContain('foo.internal')
    expect(c.dsh.env.no_proxy).toBe(c.dsh.env.NO_PROXY)
  })

  it('never leaks gateway secrets into the dsh environment', () => {
    const cfg = loadConfig({ FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 'top-secret', FRIDAY_HOME: '/tmp/fh', DEEPSEEK_API_KEY: 'k', HTTPS_PROXY: 'http://p:1' } as NodeJS.ProcessEnv)
    const env = dshEnv(cfg, { PATH: '/bin', HOME: '/h', FEISHU_APP_SECRET: 'top-secret', FRIDAY_API_SECRET: 's', GITLAB_TOKEN: 'g', HTTPS_PROXY: 'http://p:1', TERM: 'xterm' })
    expect(env.PATH).toBe('/bin')
    expect(env.TERM).toBe('xterm')
    expect(env.DEEPSEEK_API_KEY).toBe('k')
    expect(env.DSH_TELEMETRY_MODE).toBe('OFF')
    expect(env).not.toHaveProperty('FEISHU_APP_SECRET')
    expect(env).not.toHaveProperty('FRIDAY_API_SECRET')
    expect(env).not.toHaveProperty('GITLAB_TOKEN')
    expect(env).not.toHaveProperty('HTTPS_PROXY')
    const proxied = loadConfig({ FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 'b', FRIDAY_HOME: '/tmp/fh', HTTPS_PROXY: 'http://p:1', FRIDAY_DSH_PROXY: '1' } as NodeJS.ProcessEnv)
    expect(dshEnv(proxied, {}).HTTPS_PROXY).toBe('http://p:1')
  })

  it('parses the reaction triple', () => {
    expect(parseReactions(undefined)).toEqual({ ack: 'OnIt', queued: 'Typing', waiting: 'GLANCE', done: 'DONE', partial: 'THINKING', fail: 'CrossMark' })
    expect(parseReactions('off')).toEqual({})
    expect(parseReactions('GLANCE,DONE,')).toEqual({ ack: 'GLANCE', done: 'DONE' })
    expect(parseReactions(',DONE')).toEqual({ done: 'DONE' })
    const cfg = loadConfig({ FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 'b', FRIDAY_HOME: '/tmp/fh', FRIDAY_REACTIONS: 'Get,,ERROR' } as NodeJS.ProcessEnv)
    expect(cfg.feishu.reactions).toEqual({ ack: 'Get', fail: 'ERROR' })
  })

  it('位置写法只认老的三个：加了新状态不能把别人 .env 里的含义挪位', () => {
    // 'GLANCE,DONE,' 在老版本里是 收到=GLANCE、完成=DONE。加状态之后还得是这个意思，
    // 否则"完成"会悄悄变成"排队"，而且不报错。
    expect(parseReactions('GLANCE,DONE,')).toEqual({ ack: 'GLANCE', done: 'DONE' })
    expect(parseReactions('A,B,C,D,E,F')).toEqual({ ack: 'A', done: 'B', fail: 'C' })
  })

  it('按名字写才能设新状态，也不怕数错位置', () => {
    expect(parseReactions('queued=Typing,partial=Thinking')).toEqual({ queued: 'Typing', partial: 'Thinking' })
    // 不认识的状态名直接忽略，不要猜
    expect(parseReactions('nosuch=X,ack=OnIt')).toEqual({ ack: 'OnIt' })
  })
})

describe('proxy helpers', () => {
  it('builds a proxied axios instance that unwraps data like the SDK default', async () => {
    const { createProxiedHttp, describeProxy } = await import('../src/feishu/proxy.js')
    const p = createProxiedHttp('http://deepseek:s3cret@ss.example.com:3128')
    expect(describeProxy(p.proxyUrl)).toBe('http://ss.example.com:3128（带认证）')
    const ax = p.httpInstance as unknown as { defaults: { proxy: unknown; httpsAgent: unknown }; interceptors: { response: unknown } }
    expect(ax.defaults.proxy).toBe(false)
    expect(ax.defaults.httpsAgent).toBe(p.agent)
    const unwrap = ax.interceptors.response as { handlers: { fulfilled: (r: unknown) => unknown }[] }
    const handler = unwrap.handlers[0]?.fulfilled as (r: unknown) => unknown
    expect(handler({ config: {}, data: { code: 0 }, headers: {} })).toEqual({ code: 0 })
    expect(handler({ config: { $return_headers: true }, data: 'x', headers: { h: 1 } })).toEqual({ data: 'x', headers: { h: 1 } })
    p.agent.destroy()
  })
})

describe('作用域：工具存在不等于群里能用', () => {
  it('bug 收敛在群会话里必须可用——它的入口就是群里随口一句吐槽', () => {
    expect(GROUP_SCOPES).toContain('bug:read')
    expect(GROUP_SCOPES).toContain('bug:write')
  })

  it('主动巡检只评估，不把观察自动登记成待处理反馈', () => {
    expect(PROACTIVE_SCOPES).not.toContain('bug:record')
    expect(PROACTIVE_SCOPES).not.toContain('bug:write')
  })

})
