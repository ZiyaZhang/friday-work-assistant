import { describe, expect, it, vi } from 'vitest'
import { AxiosError } from 'axios'
import { FeishuMeetings, type MeetingsClient } from '../src/feishu/meetings.js'

type Api = MeetingsClient['vc']['bot']
function fixture() {
  const api = { join: vi.fn<Api['join']>().mockResolvedValue({ code: 0, data: { meeting: { id: 'meeting-1', meeting_no: '123456789', topic: 'Synthetic review' }, join_user: { id: 'bot' } } }),
    leave: vi.fn<Api['leave']>().mockResolvedValue({ code: 0, data: { leave_user: { id: 'bot' } } }),
    userActiveMeeting: vi.fn<Api['userActiveMeeting']>().mockResolvedValue({ code: 0, data: { meetings: [] } }),
    events: vi.fn<Api['events']>().mockResolvedValue({ code: 0, data: { events: [], has_more: false } }) }
  return { api, meetings: new FeishuMeetings({ vc: { bot: api } }) }
}
describe('application-identity meeting SDK adapter', () => {
  it('calls only the real silent join/leave endpoints and preserves the platform identity without claiming attendance', async () => {
    const t = fixture()
    expect(await t.meetings.join('123456789', () => {})).toEqual({ meetingId: 'meeting-1', meetingNumber: '123456789', title: 'Synthetic review', botParticipantId: 'bot' })
    expect(t.api.join).toHaveBeenCalledWith({ data: { join_type: 1, join_identify: { meeting_no: '123456789' } } })
    expect(await t.meetings.leave('meeting-1', () => {})).toEqual({ participantId: 'bot' })
    expect(t.api.leave).toHaveBeenCalledWith({ data: { meeting_id: 'meeting-1' } })
    await t.meetings.activeForUser('alice', () => {})
    expect(t.api.userActiveMeeting).toHaveBeenCalledWith({ params: { user_id: 'alice', user_id_type: 'open_id' } })
  })
  it('projects actual SDK event fields and continuation without fetching shared URLs or treating missing transcription as text', async () => {
    const t = fixture()
    t.api.events.mockResolvedValueOnce({ code: 0, data: { has_more: true, page_token: 'next', events: [{ event_id: 'event-a',
      payload: { activity_event_type: 'transcript_received', meeting: { id: 'meeting-1', start_time: '100' },
        transcript_received_items: [{ speaker: { id: 'speaker', user_name: 'Synthetic name' }, text: 'Known fact', sentence_id: 'sentence-1', start_time_ms: '1000' }],
        magic_share_started_items: [{ share_doc: { title: 'Shared document', url: 'https://example.com/private-link' } }] } }] } })
    const result = await t.meetings.events('meeting-1', { pageToken: 'previous', assertCurrent: () => {} })
    expect(t.api.events).toHaveBeenCalledWith({ params: { meeting_id: 'meeting-1', page_size: 100, user_id_type: 'open_id', page_token: 'previous' } })
    expect(result).toMatchObject({ hasMore: true, nextPageToken: 'next', events: [{ id: 'event-a', type: 'transcript_received',
      transcripts: [{ text: 'Known fact', speaker: { id: 'speaker', name: 'Synthetic name' }, sentenceId: 'sentence-1' }], shared: [{ title: 'Shared document' }] }] })
    t.api.events.mockResolvedValueOnce({ code: 0, data: { has_more: false, events: [{ event_id: 'event-b', event_type: 'transcript_received', payload: { transcript_received_items: [{}] } }] } })
    await expect(t.meetings.events('meeting-1', { assertCurrent: () => {} })).rejects.toMatchObject({ reason: 'invalid_response' })
  })
  it.each([99991672, 121003, 123456])('reports provider code %s without leaking arbitrary error text or prescribing personal OAuth', async code => {
    const t = fixture()
    t.api.join.mockResolvedValueOnce({ code, msg: 'PRIVATE_PASSWORD_CANARY' })
    const error = await t.meetings.join('123456789', () => {}).catch(error => error)
    expect(error.code).toBe(code)
    expect(error.reason).toBe(code === 99991672 ? 'configuration' : code === 121003 ? 'conditions' : 'provider')
    expect(error.message).not.toContain('PRIVATE_PASSWORD_CANARY')
  })
  it('keeps unknown programming/host failures and validates actual I/O failures separately', async () => {
    const t = fixture(), bug = new TypeError('programmer fault')
    t.api.events.mockRejectedValueOnce(bug)
    await expect(t.meetings.events('meeting-1', { assertCurrent: () => {} })).rejects.toBe(bug)
    t.api.join.mockRejectedValueOnce(new AxiosError('PRIVATE_HEADERS_CANARY', 'ETIMEDOUT'))
    await expect(t.meetings.join('123456789', () => {})).rejects.toMatchObject({ reason: 'transport' })
  })
  it('preserves mutation ACK for the host after cancellation but refuses late read results', async () => {
    const t = fixture(); let current = true
    const guard = () => { if (!current) throw new Error('host stopped') }
    t.api.join.mockImplementationOnce(async () => { current = false; return { code: 0, data: { meeting: { id: 'meeting-1' } } } })
    expect(await t.meetings.join('123456789', guard)).toEqual({ meetingId: 'meeting-1' })
    current = true
    t.api.events.mockImplementationOnce(async () => { current = false; return { code: 0, data: { events: [], has_more: false } } })
    await expect(t.meetings.events('meeting-1', { assertCurrent: guard })).rejects.toThrow('host stopped')
  })
  it('rejects a wrong meeting, missing cursor and incomplete mutation ACK', async () => {
    const t = fixture()
    await expect(t.meetings.join('meeting-1', () => {})).rejects.toMatchObject({ reason: 'invalid_request' })
    expect(t.api.join).not.toHaveBeenCalled()
    t.api.join.mockResolvedValueOnce({ code: 0, data: {} })
    await expect(t.meetings.join('123456789', () => {})).rejects.toMatchObject({ reason: 'invalid_response' })
    t.api.events.mockResolvedValueOnce({ code: 0, data: { events: [], has_more: true } })
    await expect(t.meetings.events('meeting-1', { assertCurrent: () => {} })).rejects.toMatchObject({ reason: 'invalid_response' })
    t.api.events.mockResolvedValueOnce({ code: 0, data: { has_more: false, events: [{ event_id: 'wrong', event_type: 'participant_joined', payload: { meeting: { id: 'foreign' } } }] } })
    await expect(t.meetings.events('meeting-1', { assertCurrent: () => {} })).rejects.toMatchObject({ reason: 'invalid_response' })
  })
})
