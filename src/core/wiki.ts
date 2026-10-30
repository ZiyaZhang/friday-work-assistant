/**
 * 个人 Wiki：把一个人（或一个空间）沉淀下来的记忆、事项、决定，整理成**一篇会自己更新的飞书文档**。
 * 按索引、事件主线和人物/项目组织内容，每次重建正文。
 *
 * 两条硬规则：
 * 1. **正文只来自库里的条目**。模型只决定分组、排序和每组一句话；条目的标题、时间、编号都由网关从库里取，
 *    模型引用了不存在的编号直接丢掉——这样 wiki 不会长出没人说过的事。
 * 2. **链接不变**：文档建一次，之后每次重写正文（rewriteDocument），人可以把它收藏 / 钉在群里。
 */
import type { DatabaseSync } from 'node:sqlite'
import { ChannelMemory, fmtDate, type MemoryNote } from './memory.js'
import { KIND_LABEL, type Todo, type Todos } from './todos.js'

/** 'index' 是空间 wiki；'journal:<routineId>' 是一条定时任务的长期归档（日报这类每天一期的东西）。 */
export type WikiKind = 'index' | `journal:${number}`

export interface WikiDoc {
  spaceId: string
  kind: WikiKind
  documentId: string
  url: string
  title: string
  createdAt: number
  updatedAt: number
  revisions: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wiki_docs (
  space_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  document_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revisions INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (space_id, kind)
);
`

export class WikiDocs {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = () => Date.now(),
  ) {
    db.exec(SCHEMA)
  }

  get(spaceId: string, kind: WikiKind = 'index'): WikiDoc | undefined {
    const r = this.db.prepare('SELECT * FROM wiki_docs WHERE space_id = ? AND kind = ?').get(spaceId, kind) as Record<string, unknown> | undefined
    return r
      ? {
          spaceId: String(r.space_id),
          kind: 'index',
          documentId: String(r.document_id),
          url: String(r.url),
          title: String(r.title),
          createdAt: Number(r.created_at),
          updatedAt: Number(r.updated_at),
          revisions: Number(r.revisions),
        }
      : undefined
  }

  remember(input: { spaceId: string; kind?: WikiKind; documentId: string; url: string; title: string }): WikiDoc {
    const now = this.now()
    const kind = input.kind ?? 'index'
    this.db
      .prepare(`INSERT INTO wiki_docs (space_id, kind, document_id, url, title, created_at, updated_at, revisions) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
                ON CONFLICT(space_id, kind) DO UPDATE SET document_id = excluded.document_id, url = excluded.url, title = excluded.title, updated_at = excluded.updated_at, revisions = wiki_docs.revisions + 1`)
      .run(input.spaceId, kind, input.documentId, input.url, input.title, now, now)
    return this.get(input.spaceId, kind) as WikiDoc
  }

  /** 只更新时间戳与版本号（文档没换，正文重写了一遍）。 */
  touch(spaceId: string, kind: WikiKind = 'index'): WikiDoc | undefined {
    this.db.prepare('UPDATE wiki_docs SET updated_at = ?, revisions = revisions + 1 WHERE space_id = ? AND kind = ?').run(this.now(), spaceId, kind)
    return this.get(spaceId, kind)
  }

  forget(spaceId: string, kind: WikiKind = 'index'): boolean {
    return Number(this.db.prepare('DELETE FROM wiki_docs WHERE space_id = ? AND kind = ?').run(spaceId, kind).changes) > 0
  }
}

// ---------------------------------------------------------------- 素材与分组

/** 进 wiki 的素材：已确认的记忆 + 事项。都带编号，模型只能引用这些编号。 */
export interface WikiMaterial {
  rules: MemoryNote[]
  notes: MemoryNote[]
  openTodos: Todo[]
  doneTodos: Todo[]
}

export function collectMaterial(deps: { memory: ChannelMemory; todos?: Todos }, scopes: string[], nowMs: number): WikiMaterial {
  const notes = deps.memory.recent(scopes, 200).filter((n) => n.status === 'confirmed')
  return {
    rules: notes.filter((n) => n.kind === 'rule'),
    notes: notes.filter((n) => n.kind !== 'rule'),
    openTodos: deps.todos?.list(scopes, { status: 'open', limit: 60 }) ?? [],
    doneTodos: deps.todos?.completedBetween(scopes, nowMs - 60 * 86_400_000, nowMs, 60) ?? [],
  }
}

/** 模型给出的一个分组。`refs` 里的编号会先和素材对一遍，对不上的丢掉。 */
export interface WikiGroup {
  type: '项目' | '人物' | '主线'
  name: string
  summary: string
  noteIds: number[]
  todoIds: number[]
}

const GROUP_RE = /^##\s*(项目|人物|主线)\s*[|｜]\s*(.+)$/

/**
 * 解析模型输出的分组块，并**只保留库里真实存在的编号**。
 * 格式（见 prompt）：`## 项目 | 名字` / `- 记忆 #12` / `- 事项 #7` / `一句话：…`
 */
export function parseGroups(text: string, material: WikiMaterial): WikiGroup[] {
  const noteIds = new Set([...material.notes, ...material.rules].map((n) => n.id))
  const todoIds = new Set([...material.openTodos, ...material.doneTodos].map((t) => t.id))
  const groups: WikiGroup[] = []
  let current: WikiGroup | undefined
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const head = GROUP_RE.exec(line)
    if (head) {
      current = { type: head[1] as WikiGroup['type'], name: head[2]!.trim().slice(0, 60), summary: '', noteIds: [], todoIds: [] }
      groups.push(current)
      continue
    }
    if (!current) continue
    const one = /^一句话[：:]\s*(.+)$/.exec(line)
    if (one) {
      current.summary = one[1]!.trim().slice(0, 200)
      continue
    }
    const ref = /^[-*]\s*(记忆|事项)?\s*#(\d+)/.exec(line)
    if (ref) {
      const id = Number(ref[2])
      const kind = ref[1]
      if ((!kind || kind === '记忆') && noteIds.has(id) && !current.noteIds.includes(id)) current.noteIds.push(id)
      else if ((!kind || kind === '事项') && todoIds.has(id) && !current.todoIds.includes(id)) current.todoIds.push(id)
    }
  }
  return groups.filter((g) => g.name && (g.noteIds.length || g.todoIds.length))
}

// ---------------------------------------------------------------- 渲染

export interface WikiRenderInput {
  who: string
  botName: string
  nowMs: number
  material: WikiMaterial
  groups: WikiGroup[]
  /** 这份 wiki 取自哪几层（写在末尾，说清边界） */
  scopeLabels: string[]
}

/** 渲染整篇 wiki。分组之外剩下的条目会进"其他"，不会被悄悄丢掉。 */
export function renderWiki(input: WikiRenderInput): { title: string; markdown: string } {
  const { material, groups } = input
  const noteById = new Map([...material.notes, ...material.rules].map((n) => [n.id, n]))
  const todoById = new Map([...material.openTodos, ...material.doneTodos].map((t) => [t.id, t]))
  const used = new Set<string>()
  const title = `${input.who} · 工作 Wiki`
  const lines: string[] = [`# ${title}`, '', `${input.botName} 维护，最后更新 ${fmtDate(input.nowMs)}。内容全部来自这里记下的条目，每次刷新会整篇重写。`, '']

  if (material.rules.length) {
    lines.push('## 常驻要求', '')
    for (const n of material.rules) {
      lines.push(`- ${n.title}${n.body && n.body !== n.title ? ` — ${clip(n.body, 160)}` : ''}`)
      used.add(`n${n.id}`)
    }
    lines.push('')
  }

  const section = (type: WikiGroup['type'], heading: string): void => {
    const mine = groups.filter((g) => g.type === type)
    if (!mine.length) return
    lines.push(`## ${heading}`, '')
    for (const g of mine) {
      lines.push(`### ${g.name}`, '')
      if (g.summary) lines.push(g.summary, '')
      for (const id of g.noteIds) {
        const n = noteById.get(id)
        if (!n || used.has(`n${id}`)) continue
        used.add(`n${id}`)
        lines.push(`- ${n.title}（${fmtDate(n.createdAt)}）`)
      }
      for (const id of g.todoIds) {
        const t = todoById.get(id)
        if (!t || used.has(`t${id}`)) continue
        used.add(`t${id}`)
        lines.push(`- ${todoLine(t)}`)
      }
      lines.push('')
    }
  }

  section('项目', '项目')
  section('人物', '相关的人')
  section('主线', '事件主线')

  const restNotes = material.notes.filter((n) => !used.has(`n${n.id}`))
  const restOpen = material.openTodos.filter((t) => !used.has(`t${t.id}`))
  const restDone = material.doneTodos.filter((t) => !used.has(`t${t.id}`))
  if (restOpen.length) {
    lines.push('## 在跟的事项', '')
    for (const t of restOpen) lines.push(`- ${todoLine(t)}`)
    lines.push('')
  }
  if (restDone.length) {
    lines.push('## 最近完成', '')
    for (const t of restDone.slice(0, 20)) lines.push(`- ${t.title}（${t.doneAt ? fmtDate(t.doneAt) : ''}）`)
    lines.push('')
  }
  if (restNotes.length) {
    lines.push('## 其他记下的事', '')
    for (const n of restNotes.slice(0, 40)) lines.push(`- [${KIND_LABEL_NOTE[n.kind] ?? n.kind}] ${n.title}（${fmtDate(n.createdAt)}）`)
    lines.push('')
  }

  lines.push('## 这份 Wiki 的边界', '')
  lines.push(`- 取自：${input.scopeLabels.join(' + ')}。别的空间的事不会出现在这里。`)
  lines.push(`- 只收**已确认**的条目；${input.botName} 自己推断、还没人确认的不进 Wiki（问一句就能看和确认）。`)
  lines.push(`- 每次整理都会按库里的最新内容整篇重写，所以不要直接在文档里改正文——要改内容跟 ${input.botName} 说一声。`)
  return { title, markdown: lines.join('\n') }
}

const KIND_LABEL_NOTE: Record<string, string> = { qa: '问答', fact: '事实', decision: '决定', todo: '待办', profile: '画像', rule: '常驻要求', lesson: '经验' }

function todoLine(t: Todo): string {
  const label = t.kind === 'todo' ? '' : `[${KIND_LABEL[t.kind]}] `
  const due = t.dueMs ? `（${fmtDate(t.dueMs)}）` : ''
  const owner = t.owner ? ` · ${t.owner}` : ''
  const state = t.status === 'done' ? ' · 已完成' : t.confirmed ? '' : ' · 待确认'
  return `${label}${t.title}${due}${owner}${state}`
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

/** 让模型分组的提示词。它只做归类，不写事实。 */
export function buildWikiPrompt(input: { botName: string; who: string; material: WikiMaterial }): string {
  const notes = input.material.notes.map((n) => `记忆 #${n.id} [${n.kind}] ${n.title}（${fmtDate(n.createdAt)}）`)
  const todos = [...input.material.openTodos, ...input.material.doneTodos].map((t) => `事项 #${t.id} [${t.kind}] ${t.title}${t.owner ? ` · ${t.owner}` : ''}${t.status === 'done' ? ' · 已完成' : ''}`)
  return [
    `[整理 Wiki｜网关自动发起，不是人在说话]`,
    `你是 ${input.botName}，在给「${input.who}」整理一篇工作 Wiki。下面是库里已确认的条目，**你的任务只是归类和排序**。`,
    `[条目]\n${[...notes, ...todos].join('\n')}`,
    `按下面的格式输出分组，不要写别的：

## 项目 | <项目名>
- 记忆 #12
- 事项 #7
一句话：这个项目现在处在什么状态

## 人物 | <人名>
- 记忆 #3
一句话：这个人负责什么 / 和他有什么约定

## 主线 | <一件事的来龙去脉>
- 记忆 #5
- 记忆 #9
一句话：这条线现在到哪一步了

规则：
- **只能引用上面列出的编号**，一个编号最多出现在一个分组里；没法归类的就别写，网关会自己放进"其他"。
- 分组不超过 10 个，每组的"一句话"只能用上面条目里已有的信息概括，**不要引入任何新事实、不要推测**。
- 分组名用条目里出现过的叫法（项目名、人名），别自己起名。
- 没有值得分组的（条目太少或彼此无关），整个回复只写 NOTHING。
- 不要跑命令、不要读文件、不要调工具、不要发消息。`,
  ].join('\n\n')
}
