import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { connectionFacts, connectionStatusText, describeConnectionRequest } from '../src/feishu/connection-capabilities.js'
import { USER_SCOPE_TIERS, describeGrantedScope, userScopesFor } from '../src/feishu/oauth.js'
import { renderConnectCard, renderChatScopeCard } from '../src/feishu/cards.js'

describe('connection facts separate requested scopes, provider grants and resource access', () => {
  it.each([
    { tiers: [] as const, available: [] },
    { tiers: ['watch'] as const, available: ['group_history'] },
    { tiers: ['calendar'] as const, available: ['calendar'] },
    { tiers: ['minutes'] as const, available: ['minutes'] },
    { tiers: ['watch', 'calendar', 'minutes'] as const, available: ['group_history', 'calendar', 'minutes'] },
  ])('actual grants alone select capabilities: $tiers', ({ tiers, available }) => {
    const actual = userScopesFor(tiers)
    const facts = connectionFacts({ enabled: true, connected: true, grantedScope: actual.join(' '),
      requestedScopes: userScopesFor(['watch', 'calendar', 'minutes']) })
    expect(facts.capabilities.filter(capability => ['group_history', 'calendar', 'minutes'].includes(capability.id) && capability.scopeGranted)
      .map(capability => capability.id)).toEqual(available)
    expect(facts.capabilities.every(capability => capability.resourceAccess === 'not_checked')).toBe(true)
    expect(facts.capabilities.find(capability => capability.id === 'document_write')?.scopeGranted).toBe(true)
    expect(facts.github).toEqual({ authorization: 'independent', identity: 'not_checked', repositoryAccess: 'not_checked' })
    const text = connectionStatusText(facts)
    expect(text).toContain('创建和编辑文档')
    expect(text).toContain('授权范围不代表已读到资料')
    expect(text).toContain('GitHub 身份和仓库权限独立核验')
  })

  it('a requested but ungranted tier and a partial Minutes grant do not become available', () => {
    const granted = [...USER_SCOPE_TIERS.core, USER_SCOPE_TIERS.minutes[0]].join(', ')
    const facts = connectionFacts({ enabled: true, connected: true, grantedScope: granted, requestedScopes: userScopesFor(['minutes', 'calendar']) })
    expect(facts.capabilities.find(capability => capability.id === 'minutes')).toMatchObject({ requested: true, scopeGranted: false })
    expect(facts.capabilities.find(capability => capability.id === 'calendar')).toMatchObject({ requested: true, scopeGranted: false })
    expect(describeGrantedScope(granted)).toContain('尚未授予：读取群聊历史、读取日程、读取会议妙记')
  })

  it.each([false, true])('missing/disabled connection never inherits the requested scopes: enabled=$0', enabled => {
    const facts = connectionFacts({ enabled, connected: false, grantedScope: userScopesFor(['watch']).join(' '), requestedScopes: userScopesFor(['watch', 'calendar', 'minutes']) })
    expect(facts.grantedScopes).toEqual([])
    expect(facts.capabilities.some(capability => capability.scopeGranted)).toBe(false)
  })

  it('even a token with unrelated GitHub-looking scopes proves nothing about GitHub', () => {
    const facts = connectionFacts({ enabled: true, connected: true, grantedScope: `${userScopesFor(['watch', 'calendar', 'minutes']).join(' ')} repo read:org` })
    expect(facts.github).toEqual({ authorization: 'independent', identity: 'not_checked', repositoryAccess: 'not_checked' })
  })

  it('the card labels requested scope separately from current grants, including optional tiers', () => {
    const requested = userScopesFor(['minutes'])
    const text = JSON.stringify(renderConnectCard({ botName: 'Friday', authorizeUrl: 'https://callback.invalid', scopes: requested,
      connected: { name: 'Alice', scope: USER_SCOPE_TIERS.core.join(' ') } }))
    expect(text).toContain('本卡申请：')
    expect(text).toContain('本卡未申请：读取群聊历史、读取日程')
    expect(text).toContain('尚未授予：读取群聊历史、读取日程、读取会议妙记')
    expect(text).toContain('申请不等于已授权')
    expect(describeConnectionRequest(requested)).toContain('GitHub 身份和仓库权限独立核验')
  })

  it('a visible chat list does not claim that every message history is readable', () => {
    const text = JSON.stringify(renderChatScopeCard({ botName: 'Friday', connected: true, readable: [{ chatId: 'chat', name: '研发' }], excluded: [] }))
    expect(text).toContain('实际可读的消息范围以飞书授权为准')
    expect(text).toContain('私聊列出已发现事项的会话')
    expect(text).not.toContain('默认都能读')
  })

  it('deployment example retains core document writes and never requests user-message sending', () => {
    const env = readFileSync(join(import.meta.dirname, '..', '.env.example'), 'utf8')
    const scopeLine = env.split('\n').find(line => line.startsWith('#FRIDAY_USER_SCOPES='))!
    expect(scopeLine.slice(scopeLine.indexOf('=') + 1).split(/\s+/)).toEqual([...USER_SCOPE_TIERS.core])
    expect(scopeLine.split(/\s+/)).not.toContain('im:message')
    expect(env).not.toMatch(/^FRIDAY_OAUTH_REDIRECT_URI=http:\/\/127\.0\.0\.1/m)
  })
})
