import { createHash } from 'node:crypto'
import type { ActionsJobLogBytes } from './job-log-download.js'
import { GitHubJobLogError, JOB_LOG_MAX_BYTES } from './job-log-policy.js'

/** Byte cursors refer to provider bytes, never to a transformed character
 * offset. A default window keeps the last lines; explicit continuation keeps
 * the first lines of the requested range. No guessed error-keyword filtering. */
export function jobLogWindow(input: ActionsJobLogBytes, maxBytes: number, maxLines: number, tail: boolean) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4 || maxBytes > JOB_LOG_MAX_BYTES || !Number.isSafeInteger(maxLines) || maxLines < 1 || maxLines > 500) throw new GitHubJobLogError('invalid_input')
  const data = input.data
  let from = 0, to = data.length
  if (input.startByte > 0) while (from < Math.min(3, data.length) && (data[from]! & 0xc0) === 0x80) from++
  // A range may end inside a UTF-8 scalar. Trim only a valid boundary fragment;
  // invalid interior bytes remain an explicit error, not fabricated UTF-8 text.
  const decode = new TextDecoder('utf-8', { fatal: true })
  let text: string | undefined
  for (let trim = 0; trim <= (input.endByte < input.totalBytes ? 3 : 0) && trim <= data.length - from; trim++) {
    if (trim) {
      const fragment = data.subarray(data.length - trim), first = fragment[0]!
      const scalarBytes = first >= 0xc2 && first <= 0xdf ? 2 : first >= 0xe0 && first <= 0xef ? 3 : first >= 0xf0 && first <= 0xf4 ? 4 : 0
      if (scalarBytes <= trim || fragment.subarray(1).some(byte => (byte & 0xc0) !== 0x80)) continue
    }
    try { text = decode.decode(data.subarray(from, data.length - trim)); to = data.length - trim; break } catch { /* Try a boundary fragment only. */ }
  }
  if (text === undefined || text.includes('\0')) throw new GitHubJobLogError('invalid_response')
  const lineStarts = [from]
  for (let i = from; i < to; i++) if (data[i] === 10 && i + 1 < to) lineStarts.push(i + 1)
  if (lineStarts.length > maxLines) {
    if (tail) from = lineStarts[lineStarts.length - maxLines]!
    else to = lineStarts[maxLines]!
    text = decode.decode(data.subarray(from, to))
  }
  const startByte = input.startByte + from, endByte = input.startByte + to
  const complete = startByte === 0 && endByte === input.totalBytes
  return { status: 'available' as const, text, startByte, endByte, totalBytes: input.totalBytes,
    sha256: createHash('sha256').update(data.subarray(from, to)).digest('hex'),
    lines: text.length ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0,
    maxBytes, maxLines, complete, truncated: !complete,
    previousStartByte: startByte > 0 ? Math.max(0, startByte - maxBytes) : null,
    nextStartByte: endByte < input.totalBytes ? endByte : null,
    boundaryFragment: startByte > 0 || endByte < input.totalBytes,
    note: '字节范围左闭右开；可能从一行中间开始或结束。续读使用 previousStartByte/nextStartByte，同一 PR head 与 job 每次重新核验。' }
}
export type JobLogWindow = ReturnType<typeof jobLogWindow>
