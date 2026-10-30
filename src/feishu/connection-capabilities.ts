/** Connection facts describe provider grants, never successful access to a resource. */
const CAPABILITIES = [
  { id: 'chat_list', label: '读取会话列表', scopes: ['im:chat:readonly'] },
  { id: 'message_search', label: '搜索消息', scopes: ['search:message'] },
  { id: 'direct_history', label: '读取单聊历史', scopes: ['im:message.p2p_msg:get_as_user'] },
  { id: 'group_history', label: '读取群聊历史', scopes: ['im:message.group_msg:get_as_user'] },
  { id: 'document_read', label: '读取文档', scopes: ['docx:document:readonly'] },
  { id: 'document_write', label: '创建和编辑文档', scopes: ['docx:document'] },
  { id: 'wiki_read', label: '读取知识库', scopes: ['wiki:wiki:readonly', 'wiki:node:read'] },
  { id: 'attachment_read', label: '读取消息附件', scopes: ['im:resource'] },
  { id: 'calendar', label: '读取日程', scopes: ['calendar:calendar:readonly'] },
  { id: 'minutes', label: '读取会议妙记', scopes: ['minutes:minutes.search:read', 'minutes:minutes.basic:read', 'minutes:minutes.artifacts:read'] },
] as const

export interface ConnectionFacts {
  provider: 'feishu'
  state: 'disabled' | 'not_connected' | 'connected'
  /** Stored provider response; a requested scope is never promoted into this list. */
  grantedScopes: string[]
  requestedScopes: string[]
  capabilities: { id: typeof CAPABILITIES[number]['id']; label: string; scopeGranted: boolean; requested: boolean; resourceAccess: 'not_checked' }[]
  github: { authorization: 'independent'; identity: 'not_checked'; repositoryAccess: 'not_checked' }
}

export interface ConnectionReply {
  text: string
  facts: ConnectionFacts
  delivery: { status: 'sent' | 'not_sent'; messageId?: string }
  next: 'continue_other_work_without_repeating_connection_receipt'
}

function scopes(value: string | readonly string[]): string[] {
  return [...new Set((typeof value === 'string' ? value.split(/[\s,]+/) : value).filter(Boolean))]
}

export function connectionFacts(input: { enabled: boolean; connected: boolean; grantedScope?: string; requestedScopes?: readonly string[] }): ConnectionFacts {
  const grantedScopes = input.enabled && input.connected ? scopes(input.grantedScope ?? '') : []
  const requestedScopes = input.enabled ? scopes(input.requestedScopes ?? []) : []
  return {
    provider: 'feishu', state: !input.enabled ? 'disabled' : input.connected ? 'connected' : 'not_connected', grantedScopes, requestedScopes,
    capabilities: CAPABILITIES.map(capability => ({ id: capability.id, label: capability.label,
      scopeGranted: capability.scopes.every(scope => grantedScopes.includes(scope)),
      requested: capability.scopes.every(scope => requestedScopes.includes(scope)), resourceAccess: 'not_checked' })),
    github: { authorization: 'independent', identity: 'not_checked', repositoryAccess: 'not_checked' },
  }
}

const RESOURCE_BOUNDARY = '具体资料仍须核对你的访问权限、应用配置和停读设置；授权范围不代表已读到资料。'
const GITHUB_BOUNDARY = 'GitHub 身份和仓库权限独立核验，飞书授权不提供“分配给我的 Issue/PR”查询权限。'

function extraMissing(facts: ConnectionFacts, requested = false): string {
  const missing = facts.capabilities.filter(capability => ['group_history', 'calendar', 'minutes'].includes(capability.id)
    && !(requested ? capability.requested : capability.scopeGranted)).map(capability => capability.label)
  return missing.length ? `${requested ? '本卡未申请' : '尚未授予'}：${missing.join('、')}。` : ''
}

/** Shared by callback, settings, connection receipts and cards. No resource access has been probed here. */
export function describeConnectionGrant(scope: string): string {
  const facts = connectionFacts({ enabled: true, connected: true, grantedScope: scope })
  const labels = facts.capabilities.filter(capability => capability.scopeGranted).map(capability => capability.label)
  return (labels.length ? `本次已授予：${labels.join('、')}。` : '尚未确认可用的权限范围。')
    + extraMissing(facts) + RESOURCE_BOUNDARY + GITHUB_BOUNDARY
}

export function describeConnectionRequest(requestedScopes: readonly string[]): string {
  const facts = connectionFacts({ enabled: true, connected: false, requestedScopes })
  const labels = facts.capabilities.filter(capability => capability.requested).map(capability => capability.label)
  return (labels.length ? `本卡申请：${labels.join('、')}。` : '本卡未列出可确认的能力范围。')
    + extraMissing(facts, true) + '申请不等于已授权，以完成后的实际授权回执为准。' + RESOURCE_BOUNDARY + GITHUB_BOUNDARY
}

export function connectionStatusText(facts: ConnectionFacts, cardSent = false): string {
  if (facts.state === 'disabled') return '这个部署没有开启个人授权。'
  if (facts.state === 'connected') return `${cardSent ? '补充授权卡已经发给你了，新增范围尚待你同意。' : ''}已连接飞书账号。${describeConnectionGrant(facts.grantedScopes.join(' '))}`
  return `${cardSent ? '授权卡已经发到这个私聊，点「打开授权页面」即可。' : '尚未连接飞书账号，可以让我发送授权卡。'}尚未完成授权，不能据此认定任何资料可读。${GITHUB_BOUNDARY}`
}
