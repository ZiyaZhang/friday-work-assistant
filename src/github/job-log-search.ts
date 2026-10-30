import type { ActionsJobLogBytes } from './job-log-download.js'
import { GitHubJobLogError, JOB_LOG_MAX_BYTES } from './job-log-policy.js'
import { jobLogWindow, type JobLogWindow } from './job-log-window.js'

/** Case-sensitive literal search chosen by the caller, with shared output
 * byte/line budgets. No host-selected failure keywords or guessed summary. */
export function searchJobLog(input: ActionsJobLogBytes, query: string, maxBytes: number, maxLines: number) {
  const needle = Buffer.from(query, 'utf8'), data = input.data
  const queryLines = query.split('\n').length
  if (!query.trim() || query.length > 512 || !Number.isSafeInteger(maxBytes) || maxBytes < 4 || maxBytes > JOB_LOG_MAX_BYTES || needle.length > maxBytes ||
    !Number.isSafeInteger(maxLines) || maxLines < 1 || maxLines > 500 || queryLines > maxLines) throw new GitHubJobLogError('invalid_input')
  let from = 0, bytesLeft = maxBytes, linesLeft = maxLines, matches = 0
  const windows: JobLogWindow[] = []
  // A boundary-spanning literal is inspected again by the next request.
  const exhaustedAt = input.endByte < input.totalBytes ? Math.max(input.startByte, input.endByte - needle.length + 1) : input.endByte
  let searchedThroughByte = input.startByte
  const newlineBefore = (offset: number) => offset < 0 ? -1 : data.lastIndexOf(10, offset)
  for (;;) {
    const at = data.indexOf(needle, from)
    if (at < 0) { searchedThroughByte = exhaustedAt; break }
    if (matches >= maxLines || bytesLeft < Math.max(4, needle.length) || linesLeft < 1) { searchedThroughByte = input.startByte + at; break }
    matches++
    const previous = windows.at(-1)
    if (!previous || input.startByte + at + needle.length > previous.endByte) {
      let begin = newlineBefore(at - 1) + 1
      let end = data.indexOf(10, at + needle.length)
      if (end < 0) end = data.length; else end++
      const before = Math.min(3, Math.floor((linesLeft - queryLines) / 2))
      for (let count = 0; count < before && begin > 0; count++) begin = newlineBefore(begin - 2) + 1
      for (let count = 0; count < Math.min(3, linesLeft - before - queryLines) && end < data.length; count++) {
        const next = data.indexOf(10, end); end = next < 0 ? data.length : next + 1
      }
      // Long lines cannot consume unbounded output or hide the actual match at
      // their far end. Keep the match inside the visible byte window.
      begin = Math.max(begin, at + needle.length - bytesLeft, previous ? previous.endByte - input.startByte : 0)
      end = Math.min(end, begin + bytesLeft)
      if (end < at + needle.length) { searchedThroughByte = input.startByte + at; break }
      const window = jobLogWindow({ data: data.subarray(begin, end), startByte: input.startByte + begin,
        endByte: input.startByte + end, totalBytes: input.totalBytes, sha256: '' }, bytesLeft, linesLeft, false)
      if (window.endByte < input.startByte + at + needle.length) { searchedThroughByte = input.startByte + at; break }
      windows.push(window); bytesLeft -= window.endByte - window.startByte; linesLeft -= window.lines
    }
    from = at + 1
    searchedThroughByte = input.startByte + from
  }
  const complete = input.startByte === 0 && searchedThroughByte === input.totalBytes
  return { status: 'available' as const, mode: 'search' as const, query, caseSensitive: true, windows, matches,
    totalBytes: input.totalBytes, downloadedStartByte: input.startByte, downloadedEndByte: input.endByte,
    searchedStartByte: input.startByte, searchedThroughByte, complete, truncated: !complete,
    returnedBytes: maxBytes - bytesLeft, returnedLines: maxLines - linesLeft, maxBytes, maxLines,
    nextStartByte: searchedThroughByte < input.totalBytes ? searchedThroughByte : null,
    note: '字面检索，仅对 searchedStartByte 至 searchedThroughByte 范围作出匹配结论；未扫描区不等于无匹配。用相同 logQuery 和 nextStartByte 继续。匹配窗口是原日志内容，不是故障归因或操作授权。' }
}
export type JobLogSearch = ReturnType<typeof searchJobLog>
