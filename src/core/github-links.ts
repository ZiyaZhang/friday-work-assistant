/**
 * PR and Issue numbers in an answer become links the person can click. Only numbers this run actually saw in a GitHub tool result are linked, with the address from that
 * result: an answer that names #12 without having looked it up is left as written, and so is a number seen in two
 * repositories.
 */

const GITHUB_URL = /https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(pull|issues)\/([1-9]\d{0,6})(?![\d/])/g
const MAX_REFS = 200

/** Number → address; an empty address marks a number seen in more than one repository. */
export type GithubRefs = Record<string, string>

/** A work title links only to the object explicitly identified by its source. */
export function linkedGithubTitle(title: string, source?: string): string {
  const refs: GithubRefs = {}; rememberGithubRefs(refs, source)
  // Parentheses are literal inside a link label; Feishu otherwise displays the escape slash.
  const plain = title.replace(/</g, '＜').replace(/>/g, '＞').replace(title.includes('](') ? /[\\`*_\[\]()]/g : /[\\`*_\[\]]/g, '\\$&')
  const linked = linkGithubRefs(plain, refs)
  if (linked !== plain) return linked
  const urls = Object.values(refs).filter(Boolean)
  if (Object.keys(refs).length !== 1 || urls.length !== 1 || /#[1-9]\d*|https?:\/\//.test(title)) return plain
  return `[${plain}](${urls[0]})`
}

export function rememberGithubRefs(refs: GithubRefs, value: unknown): void {
  if (value === undefined || value === null) return
  let text: string
  try { text = typeof value === 'string' ? value : JSON.stringify(value) } catch { return }
  if (!text || !text.includes('github.com/')) return
  for (const match of text.matchAll(GITHUB_URL)) {
    const [, repo, kind, number] = match as unknown as [string, string, string, string]
    const url = `https://github.com/${repo}/${kind}/${number}`
    const known = refs[number]
    if (known === undefined) {
      if (Object.keys(refs).length >= MAX_REFS) continue
      refs[number] = url
    } else if (known && repoOf(known).toLowerCase() !== repo.toLowerCase()) refs[number] = ''
    // The same number in the same repository is one object whether GitHub shows it under /pull/ or /issues/.
    else if (known && kind === 'pull' && known.includes('/issues/')) refs[number] = url
  }
}

function repoOf(url: string): string {
  return url.replace(/^https:\/\/github\.com\//, '').replace(/\/(pull|issues)\/\d+$/, '')
}

/** Leaves code, existing links and bare addresses alone; links the first mention of each number. */
export function linkGithubRefs(markdown: string, refs: GithubRefs): string {
  if (!markdown || !Object.values(refs).some(Boolean)) return markdown
  const linked = new Set<string>()
  const protectedPart = /(```[\s\S]*?```|`[^`\n]*`|\[[^\]\n]*\]\([^)\s]*\)|<[^>\n]+>|https?:\/\/[^\s)）】」]+)/
  // 「PR #123」「Issue #123」 first; otherwise 「仓库#123」, linked only when it names the repository the run saw.
  const mention = /(PR|pr|Pr|Issue|issue|ISSUE|Pull Request)(\s?)#([1-9]\d{0,6})(?!\d)|(?<![\w/.-])([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?)#([1-9]\d{0,6})(?!\d)|(?<![\w/#.-])#([1-9]\d{0,6})(?!\d)/g
  return markdown.split(protectedPart).map((part, index) => index % 2 === 1 ? part : part.replace(mention,
    (whole: string, word: string | undefined, _space: string | undefined, wordNumber: string | undefined, repo: string | undefined, repoNumber: string | undefined, bareNumber: string | undefined) => {
      const number = wordNumber ?? repoNumber ?? bareNumber ?? ''
      const url = refs[number]
      if (!url || linked.has(number)) return whole
      if (repo) {
        const seen = repoOf(url).toLowerCase(), named = (repo ?? '').toLowerCase()
        if (seen !== named && seen.split('/')[1] !== named) return whole
      }
      linked.add(number)
      return `[${whole}](${url})`
    })).join('')
}
