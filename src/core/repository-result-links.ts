/** Presentation of a host-confirmed write receipt. This neither discovers a PR
 * nor grants delivery permission; the caller keeps the receipt on its exact Run
 * and sends the final answer through the ordinary source/audience gate. */
export interface RepositoryResultLink { url: string; label: string }

export function repositoryResultLink(receipt: { repo: string; url?: string }): RepositoryResultLink | undefined {
  if (!receipt.url || !/^[\w.-]+\/[\w.-]+$/.test(receipt.repo)) return undefined
  let url: URL
  try { url = new URL(receipt.url) } catch { return undefined }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search) return undefined
  const match = /^\/([\w.-]+\/[\w.-]+)\/(pull|issues)\/([1-9]\d*)$/.exec(url.pathname)
  if (!match || match[1]!.toLowerCase() !== receipt.repo.toLowerCase()) return undefined
  if (url.hash && !/^#issuecomment-\d+$/.test(url.hash)) return undefined
  return { url: url.href, label: `${receipt.repo} ${match[2] === 'pull' ? 'PR' : 'Issue'} #${match[3]}` }
}

export function withRepositoryResultLinks(answer: string, receipts: Iterable<RepositoryResultLink>): string {
  const links = [...new Map([...receipts].map(link => [link.url, link])).values()]
    .filter(link => !answer.includes(link.url))
  if (!links.length) return answer.trim()
  const confirmed = `已确认 ${links.map(link => `[${link.label}](${link.url})`).join('、')}。`
  return answer.trim() ? `${confirmed}\n${answer.trim()}` : confirmed
}
