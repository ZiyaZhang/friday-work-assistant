import { describe, expect, it, vi } from 'vitest'
import { withUserAccessToken } from '@larksuiteoapi/node-sdk'
import { FeishuMinutes, MinutesError, type MinutesClient } from '../src/feishu/minutes.js'

type Api = MinutesClient['minutes']['v1']['minute']
const RANGE = { startMs: Date.parse('2026-09-15T00:00:00+08:00'), endMs: Date.parse('2026-09-22T00:00:00+08:00') }
const USER_TOKEN = 'synthetic-user-token'
function fixture() {
  const api = {
    search: vi.fn<Api['search']>().mockResolvedValue({ code: 0, data: { items: [], has_more: false } }),
    get: vi.fn<Api['get']>().mockResolvedValue({ code: 0, data: { minute: { token: 'minute_a' } } }),
    artifacts: vi.fn<Api['artifacts']>().mockResolvedValue({ code: 0, data: {} }),
  }
  return { api, minutes: new FeishuMinutes({ minutes: { v1: { minute: api } } }) }
}

describe('Feishu Minutes personal read client', () => {
  it('uses typed search fields, ISO windows and user identity, preserving search previews', async () => {
    const { api, minutes } = fixture()
    api.search.mockResolvedValueOnce({ code: 0, data: { items: [{ token: 'minute_a', display_info: '<h>release</h> preview', meta_data: { app_link: 'https://example.feishu.cn/minutes/minute_a' } }], total: 1, has_more: false } })
    const result = await minutes.recent(USER_TOKEN, RANGE, 20, { query: 'release' })
    expect(api.search).toHaveBeenCalledWith({ data: { query: 'release', filter: { create_time: {
      start_time: new Date(RANGE.startMs).toISOString(), end_time: new Date(RANGE.endMs).toISOString(),
    } }, sorter: 'create_time_desc' }, params: { page_size: 20, user_id_type: 'open_id' } }, withUserAccessToken(USER_TOKEN))
    expect(result.items).toEqual([{ token: 'minute_a', displayInfo: '<h>release</h> preview', url: 'https://example.feishu.cn/minutes/minute_a' }])
    expect(result.coverage).toEqual({ complete: true, hasMore: false, fetchedPages: 1, returned: 1, total: 1, range: RANGE })
  })

  it('reads further pages until the bounded limit, then returns the real continuation', async () => {
    const { api, minutes } = fixture()
    api.search.mockResolvedValueOnce({ code: 0, data: { items: [{ token: 'minute_a' }], has_more: true, page_token: 'page_2' } })
      .mockResolvedValueOnce({ code: 0, data: { items: [{ token: 'minute_b' }], has_more: true, page_token: 'page_3' } })
    const result = await minutes.recent(USER_TOKEN, RANGE, 2)
    expect(api.search.mock.calls[1]![0]!.params).toEqual({ page_size: 1, page_token: 'page_2', user_id_type: 'open_id' })
    expect(result.items.map(item => item.token)).toEqual(['minute_a', 'minute_b'])
    expect(result.coverage).toMatchObject({ complete: false, hasMore: true, nextPageToken: 'page_3', fetchedPages: 2 })
    const next = await minutes.recent(USER_TOKEN, RANGE, 2, { pageToken: result.coverage.nextPageToken })
    expect(api.search.mock.calls[2]![0]!.params!.page_token).toBe('page_3')
    expect(next.coverage.complete).toBe(true)
  })

  it('deduplicates overlapping search pages without skipping subsequent results', async () => {
    const { api, minutes } = fixture()
    api.search.mockResolvedValueOnce({ code: 0, data: { items: [{ token: 'minute_a' }], has_more: true, page_token: 'page_2' } })
      .mockResolvedValueOnce({ code: 0, data: { items: [{ token: 'minute_a' }, { token: 'minute_b' }], has_more: false } })
    const result = await minutes.recent(USER_TOKEN, RANGE, 3)
    expect(result.items.map(item => item.token)).toEqual(['minute_a', 'minute_b'])
    expect(result.coverage.complete).toBe(true)
  })

  it('keeps provider coverage warnings even when pagination ended', async () => {
    const { api, minutes } = fixture()
    api.search.mockResolvedValueOnce({ code: 0, data: { items: [], has_more: false, notice: '本次搜索结果不全' } })
    expect((await minutes.recent(USER_TOKEN, RANGE)).coverage).toMatchObject({ complete: false, hasMore: false, notice: '本次搜索结果不全' })
  })

  it.each([
    { items: [], has_more: true },
    { items: [{ token: '' }], has_more: false },
    { items: [] },
  ])('rejects malformed search coverage instead of reporting no meetings: %j', async data => {
    const { api, minutes } = fixture()
    api.search.mockResolvedValueOnce({ code: 0, data } as Awaited<ReturnType<Api['search']>>)
    await expect(minutes.recent(USER_TOKEN, RANGE)).rejects.toMatchObject({ reason: 'invalid_response' })
  })

  it('rejects a repeated pagination cursor', async () => {
    const { api, minutes } = fixture()
    api.search.mockResolvedValue({ code: 0, data: { items: [], has_more: true, page_token: 'same' } })
    await expect(minutes.recent(USER_TOKEN, RANGE)).rejects.toMatchObject({ reason: 'invalid_response' })
    expect(api.search).toHaveBeenCalledTimes(2)
  })

  it('bounds empty-but-paginated responses and leaves a continuation', async () => {
    const { api, minutes } = fixture()
    let page = 0
    api.search.mockImplementation(async () => ({ code: 0, data: { items: [], has_more: true, page_token: `page_${++page}` } }))
    expect((await minutes.recent(USER_TOKEN, RANGE)).coverage).toMatchObject({ complete: false, fetchedPages: 10, nextPageToken: 'page_10' })
  })

  it('propagates later page failure rather than returning a false complete window', async () => {
    const { api, minutes } = fixture()
    api.search.mockResolvedValueOnce({ code: 0, data: { items: [{ token: 'minute_a' }], has_more: true, page_token: 'page_2' } })
      .mockRejectedValueOnce(new Error('network failed with synthetic bearer details'))
    await expect(minutes.recent(USER_TOKEN, RANGE)).rejects.toMatchObject({ reason: 'transport' })
  })

  it('checks cancellation after a page before reading or returning its contents', async () => {
    const { api, minutes } = fixture()
    let active = true
    api.search.mockImplementation(async () => {
      active = false
      return { code: 0, data: { items: [{ token: 'minute_a' }], has_more: true, page_token: 'page_2' } }
    })
    await expect(minutes.recent(USER_TOKEN, RANGE, 20, { assertCurrent: () => { if (!active) throw new Error('grant revoked') } })).rejects.toThrow('grant revoked')
    expect(api.search).toHaveBeenCalledTimes(1)
  })

  it('uses provider milliseconds literally and does not invent a meeting start time', async () => {
    const { api, minutes } = fixture()
    api.get.mockResolvedValueOnce({ code: 0, data: { minute: { token: 'minute_a', title: 'Synthetic meeting', url: 'https://example.feishu.cn/minutes/minute_a', create_time: '1669098360477', duration: '314000', owner_id: 'ou_owner', note_id: 'note_a' } } })
    expect(await minutes.brief(USER_TOKEN, 'minute_a')).toEqual({ token: 'minute_a', title: 'Synthetic meeting', url: 'https://example.feishu.cn/minutes/minute_a', createdAtMs: 1669098360477, durationMs: 314000, ownerId: 'ou_owner', noteId: 'note_a' })
    expect(api.get).toHaveBeenCalledWith({ path: { minute_token: 'minute_a' }, params: { user_id_type: 'open_id' } }, withUserAccessToken(USER_TOKEN))
  })

  it('does not accept missing metadata or a response for another minute', async () => {
    const { api, minutes } = fixture()
    api.get.mockResolvedValueOnce({ code: 0, data: {} })
      .mockResolvedValueOnce({ code: 0, data: { minute: { token: 'minute_b' } } })
    await expect(minutes.brief(USER_TOKEN, 'minute_a')).rejects.toMatchObject({ reason: 'invalid_response' })
    await expect(minutes.brief(USER_TOKEN, 'minute_a')).rejects.toMatchObject({ reason: 'invalid_response' })
  })

  it('preserves AI todo identity, assignees and completion alongside summary and chapters', async () => {
    const { api, minutes } = fixture()
    api.artifacts.mockResolvedValueOnce({ code: 0, data: { summary: 'AI summary', minute_todos: [
      { content: 'Alice checks release', assignees: ['ou_alice'], is_done: false, todo_id: 'todo_a', operation: 'add' },
      { content: 'Bob filed report', assignees: ['ou_bob'], is_done: true, todo_id: 'todo_b' },
    ], minute_chapters: [{ title: 'Release', start_ms: '0', stop_ms: '314000', summary_content: 'Decision' }], keywords: ['release'], transcript: 'Not requested; must not expose' } })
    const result = await minutes.artifacts(USER_TOKEN, 'minute_a')
    expect(result).toEqual({ token: 'minute_a', summary: 'AI summary', todos: [
      { content: 'Alice checks release', assignees: ['ou_alice'], isDone: false, todoId: 'todo_a', operation: 'add' },
      { content: 'Bob filed report', assignees: ['ou_bob'], isDone: true, todoId: 'todo_b', operation: undefined },
    ], chapters: [{ title: 'Release', startMs: 0, stopMs: 314000, summary: 'Decision' }], keywords: ['release'], coverage: { summary: 'present', todos: 'present' } })
    expect(result).not.toHaveProperty('transcript')
  })

  it('distinguishes no AI output from an explicitly returned empty todo list', async () => {
    const { api, minutes } = fixture()
    expect((await minutes.artifacts(USER_TOKEN, 'minute_a')).coverage).toEqual({ summary: 'absent', todos: 'absent' })
    api.artifacts.mockResolvedValueOnce({ code: 0, data: { summary: '', minute_todos: [] } })
    expect((await minutes.artifacts(USER_TOKEN, 'minute_a')).coverage).toEqual({ summary: 'present', todos: 'present' })
  })

  it('makes missing scope actionable without echoing provider or transport secrets', async () => {
    const { api, minutes } = fixture()
    api.artifacts.mockResolvedValueOnce({ code: 99991672, msg: 'secret-provider-message' })
    const error = await minutes.artifacts(USER_TOKEN, 'minute_a').catch(error => error)
    expect(error).toBeInstanceOf(MinutesError)
    expect(error.needsScope).toBe(true)
    expect(error.requiredScope).toBe('minutes:minutes.artifacts:read')
    expect(error.message).toContain('补充个人授权')
    expect(error.message).not.toContain('secret-provider-message')
    api.artifacts.mockRejectedValueOnce({ response: { data: { code: 99991672, msg: 'secret-provider-message' } }, config: { headers: { authorization: USER_TOKEN } } })
    await expect(minutes.artifacts(USER_TOKEN, 'minute_a')).rejects.toMatchObject({ reason: 'scope', code: 99991672 })
  })

  it('does not treat resource denial as an OAuth scope problem', async () => {
    const { api, minutes } = fixture()
    api.get.mockResolvedValueOnce({ code: 2091005, msg: 'permission denied' })
    const error = await minutes.brief(USER_TOKEN, 'minute_a').catch(error => error)
    expect(error.needsScope).toBe(false)
    expect(error.message).toContain('本人对这份资料的访问权限')
  })

  it('never calls the SDK without a user token or with invalid query inputs', async () => {
    const { api, minutes } = fixture()
    await expect(minutes.recent('', RANGE)).rejects.toMatchObject({ reason: 'authentication' })
    await expect(minutes.brief('', 'minute_a')).rejects.toMatchObject({ reason: 'authentication' })
    await expect(minutes.artifacts('', 'minute_a')).rejects.toMatchObject({ reason: 'authentication' })
    await expect(minutes.recent(USER_TOKEN, { startMs: 10, endMs: 1 })).rejects.toMatchObject({ reason: 'invalid_request' })
    await expect(minutes.brief(USER_TOKEN, '../other')).rejects.toMatchObject({ reason: 'invalid_request' })
    expect(api.search).not.toHaveBeenCalled()
    expect(api.get).not.toHaveBeenCalled()
    expect(api.artifacts).not.toHaveBeenCalled()
  })
})
