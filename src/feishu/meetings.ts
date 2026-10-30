/** Application-identity VC bot port. It does not expose speech, recording or invitations. */
import type { Client } from '@larksuiteoapi/node-sdk'
import { isAxiosError } from 'axios'

type BotApi = Pick<Client['vc']['bot'], 'join' | 'leave' | 'events' | 'userActiveMeeting'>
export type MeetingsClient = { vc: { bot: BotApi } }
type AssertCurrent = () => void
export const MEETING_SCOPE = 'vc:meeting.bot.join:write'
export type MeetingFailure = 'configuration' | 'conditions' | 'provider' | 'transport' | 'invalid_response' | 'invalid_request'
export class MeetingProviderError extends Error {
  constructor(readonly reason: MeetingFailure, readonly code?: number) {
    super(({ configuration: '应用尚未取得会议机器人能力，请检查灰度资格、应用权限、发布安装和可访问的数据范围；个人重新授权不能解决。',
      conditions: '平台未允许入会，请核对会议号、会议是否已开始、密码和主持人等候室设置；尚未确认机器人已经参会。',
      provider: '会议平台未确认本次操作，请核对会议状态后再处理。', transport: '会议服务暂时无法连接，已发出的操作结果仍待核对。',
      invalid_response: '会议平台返回的信息不完整，尚不能确认参会或会议内容。', invalid_request: '会议参数无效，未调用会议服务。' })[reason])
    this.name = 'MeetingProviderError'
  }
}
export interface MeetingJoinReceipt { meetingId: string; meetingNumber?: string; title?: string; botParticipantId?: string }
export interface MeetingParticipant { id?: string; name?: string; type?: number }
export interface MeetingEvent {
  id: string; type: string; time?: string
  meeting?: { id: string; title?: string; startedAt?: string; endedAt?: string }
  joined: { participant: MeetingParticipant; time?: string }[]
  left: { participant: MeetingParticipant; reason?: number; time?: string }[]
  transcripts: { speaker: MeetingParticipant; text: string; sentenceId?: string; startMs?: string; endMs?: string }[]
  messages: { author: MeetingParticipant; text: string; messageId?: string; messageType?: number; time?: string }[]
  /** A shared URL is merely event metadata, not permission to fetch its contents. */
  shared: { title?: string; url?: string }[]
}
export interface MeetingEventsPage { events: MeetingEvent[]; hasMore: boolean; nextPageToken?: string }

function identifier(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\x00-\x1f\x7f]/.test(value) }
function optional(value: unknown): string | undefined { return typeof value === 'string' && value ? value : undefined }
function failure(code?: number): MeetingProviderError {
  return new MeetingProviderError(code === 99991672 ? 'configuration' : code === 121003 ? 'conditions' : 'provider', code)
}
function unwrap<T>(response: { code?: number; data?: T }): T {
  if (response.code !== 0) throw failure(response.code)
  if (!response.data || typeof response.data !== 'object') throw new MeetingProviderError('invalid_response')
  return response.data
}
function participant(value: { id?: string; user_name?: string; user_type?: number } | undefined): MeetingParticipant {
  return { ...(optional(value?.id) ? { id: value!.id } : {}), ...(optional(value?.user_name) ? { name: value!.user_name } : {}),
    ...(typeof value?.user_type === 'number' ? { type: value.user_type } : {}) }
}

export class FeishuMeetings {
  constructor(private readonly client: MeetingsClient) {}

  /** Mutation ACK is returned before caller-lifetime revalidation so the host can persist it.
   * Read calls revalidate after await before exposing any provider data. */
  private async call<T>(invoke: () => Promise<T>, assertCurrent: AssertCurrent, mutation = false): Promise<T> {
    assertCurrent()
    let response: T
    try { response = await invoke() }
    catch (error) {
      if (!mutation) assertCurrent()
      if (!isAxiosError(error)) throw error
      const code = error.response?.data?.code
      if (typeof code === 'number') throw failure(code)
      throw new MeetingProviderError('transport')
    }
    if (!mutation) assertCurrent()
    return response
  }

  async join(meetingNumber: string, assertCurrent: AssertCurrent, password?: string): Promise<MeetingJoinReceipt> {
    if (!/^\d{9}$/.test(meetingNumber) || password !== undefined && (!password || password.length > 256)) throw new MeetingProviderError('invalid_request')
    const data = unwrap(await this.call(() => this.client.vc.bot.join({ data: {
      join_type: 1, join_identify: { meeting_no: meetingNumber }, ...(password ? { password } : {}),
    } }), assertCurrent, true))
    if (!identifier(data.meeting?.id) || data.meeting?.meeting_no !== undefined && data.meeting.meeting_no !== meetingNumber) throw new MeetingProviderError('invalid_response')
    return { meetingId: data.meeting.id, ...(optional(data.meeting.meeting_no) ? { meetingNumber: data.meeting.meeting_no } : {}),
      ...(optional(data.meeting.topic) ? { title: data.meeting.topic } : {}),
      ...(identifier(data.join_user?.id) ? { botParticipantId: data.join_user.id } : {}) }
  }

  async leave(meetingId: string, assertCurrent: AssertCurrent): Promise<{ participantId: string }> {
    if (!identifier(meetingId)) throw new MeetingProviderError('invalid_request')
    const data = unwrap(await this.call(() => this.client.vc.bot.leave({ data: { meeting_id: meetingId } }), assertCurrent, true))
    if (!identifier(data.leave_user?.id)) throw new MeetingProviderError('invalid_response')
    return { participantId: data.leave_user.id }
  }

  async activeForUser(openId: string, assertCurrent: AssertCurrent): Promise<{ meetingId: string; meetingNumber?: string; title?: string }[]> {
    if (!identifier(openId)) throw new MeetingProviderError('invalid_request')
    const data = unwrap(await this.call(() => this.client.vc.bot.userActiveMeeting({ params: { user_id: openId, user_id_type: 'open_id' } }), assertCurrent))
    if (!Array.isArray(data.meetings)) throw new MeetingProviderError('invalid_response')
    return data.meetings.map(meeting => {
      if (!identifier(meeting.meeting_id)) throw new MeetingProviderError('invalid_response')
      return { meetingId: meeting.meeting_id, ...(optional(meeting.meeting_no) ? { meetingNumber: meeting.meeting_no } : {}),
        ...(optional(meeting.meeting_title) ? { title: meeting.meeting_title } : {}) }
    })
  }

  async events(meetingId: string, options: { pageToken?: string; assertCurrent: AssertCurrent }): Promise<MeetingEventsPage> {
    if (!identifier(meetingId) || options.pageToken !== undefined && (!identifier(options.pageToken) || options.pageToken.length > 2048)) throw new MeetingProviderError('invalid_request')
    const data = unwrap(await this.call(() => this.client.vc.bot.events({ params: { meeting_id: meetingId, page_size: 100,
      user_id_type: 'open_id', ...(options.pageToken ? { page_token: options.pageToken } : {}) } }), options.assertCurrent))
    if (!Array.isArray(data.events) || typeof data.has_more !== 'boolean' || data.has_more && !identifier(data.page_token)) throw new MeetingProviderError('invalid_response')
    const events: MeetingEvent[] = data.events.map(event => {
      const p = event.payload, type = event.event_type || p?.activity_event_type
      if (!identifier(event.event_id) || !identifier(type) || p?.meeting?.id !== undefined && p.meeting.id !== meetingId) throw new MeetingProviderError('invalid_response')
      return { id: event.event_id, type, ...(optional(event.event_time) ? { time: event.event_time } : {}),
        ...(p?.meeting?.id ? { meeting: { id: p.meeting.id, title: optional(p.meeting.topic), startedAt: optional(p.meeting.start_time), endedAt: optional(p.meeting.end_time) } } : {}),
        joined: (p?.participant_joined_items ?? []).map(item => ({ participant: participant(item.participant), time: optional(item.join_time) })),
        left: (p?.participant_left_items ?? []).map(item => ({ participant: participant(item.participant), reason: item.leave_reason, time: optional(item.leave_time) })),
        transcripts: (p?.transcript_received_items ?? []).map(item => {
          if (typeof item.text !== 'string') throw new MeetingProviderError('invalid_response')
          return { speaker: participant(item.speaker), text: item.text, sentenceId: optional(item.sentence_id), startMs: optional(item.start_time_ms), endMs: optional(item.end_time_ms) }
        }),
        messages: (p?.chat_received_items ?? []).map(item => ({ author: participant(item.operator), text: item.content ?? '',
          messageId: optional(item.message_id), messageType: item.message_type, time: optional(item.send_time) })),
        shared: [...(p?.magic_share_started_items ?? []), ...(p?.document_context_changed_items ?? [])].map(item => ({
          title: optional(item.share_doc?.title), url: optional(item.share_doc?.url),
        })),
      }
    })
    return { events, hasMore: data.has_more, ...(optional(data.page_token) ? { nextPageToken: data.page_token } : {}) }
  }
}
