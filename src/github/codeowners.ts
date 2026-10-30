/**
 * 这几个文件归谁管。
 *
 * 开 PR 不再拦一道确认——PR 是提议不是改动，拦住只会让它停在发起人那儿。
 * 换成把它**送到该看的人手上**：谁是这几个文件的负责人，开完就 @ 谁。
 *
 * 来源用仓库自己的 `CODEOWNERS`：那是这件事唯一有权威的地方，
 * 而且本来就是维护者自己写的，不需要我们再维护一份对照表。
 *
 * 语义上只有一条容易写错，但写错就会 @ 错人：**最后一条匹配的规则生效**，不是第一条。
 * CODEOWNERS 是这么设计的——粗的规则写在上面，细的写在下面覆盖它。
 * 按第一条匹配去找，等于永远只会 @ 到最粗那条上的人。
 */

export interface OwnerRule {
  pattern: string
  owners: string[]
}

/** `@login` / `@org/team` → login；邮箱形式的 owner 留着原样，交给调用方判断认不认得。 */
function normalizeOwner(raw: string): string | undefined {
  const t = raw.trim()
  if (!t) return undefined
  if (t.startsWith('@')) return t.slice(1)
  return t.includes('@') ? t : undefined
}

export function parseCodeowners(text: string): OwnerRule[] {
  const rules: OwnerRule[] = []
  for (const line of text.split('\n')) {
    const body = line.split('#')[0]!.trim()
    if (!body) continue
    const parts = body.split(/\s+/)
    const pattern = parts.shift()
    if (!pattern) continue
    const owners = parts.map(normalizeOwner).filter((o): o is string => Boolean(o))
    // 没有 owner 的一行是**故意清空**这个路径的负责人，不是格式错误；照样记下来，
    // 否则上面那条粗规则会继续生效，而作者的意思恰恰是"这里没人管"。
    rules.push({ pattern, owners })
  }
  return rules
}

/**
 * CODEOWNERS 的路径匹配。gitignore 那一套的子集——够用，而且不引一个库进来。
 *
 * 规则：以 `/` 开头是从仓库根算起；以 `/` 结尾是整个目录；
 * 不含 `/` 的是"任意层级下的这个名字"（`*.js` 匹配所有层级的 .js）。
 */
export function matchesPattern(pattern: string, path: string): boolean {
  let p = pattern
  if (p === '*') return true
  const anchored = p.startsWith('/')
  if (anchored) p = p.slice(1)
  const dirOnly = p.endsWith('/')
  if (dirOnly) p = p.slice(0, -1)

  const rx = (seg: string): string => seg
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '.*')

  // 不含 `/` 也没锚定的模式，匹配任意层级下的同名文件
  const floating = !anchored && !p.includes('/')
  const head = floating ? `(?:.*/)?${rx(p)}` : rx(p)
  const tail = dirOnly || pattern.endsWith('/') ? '(?:/.*)?' : '(?:/.*)?'
  return new RegExp(`^${head}${tail}$`).test(path)
}

/**
 * 这组文件该 @ 谁。
 *
 * 每个文件各自按"最后一条匹配"取 owner，再合并去重——不同文件可能归不同的人，
 * 一个 PR 改了三块，三块的负责人都该看见。
 */
export function ownersFor(rules: readonly OwnerRule[], files: readonly string[]): string[] {
  const out = new Set<string>()
  for (const file of files) {
    const path = file.replace(/^\/+/, '')
    let matched: OwnerRule | undefined
    for (const rule of rules) if (matchesPattern(rule.pattern, path)) matched = rule
    for (const owner of matched?.owners ?? []) out.add(owner)
  }
  return [...out]
}

/** CODEOWNERS 可以放这三个地方之一；GitHub 按这个顺序找第一个存在的。 */
export const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'] as const
