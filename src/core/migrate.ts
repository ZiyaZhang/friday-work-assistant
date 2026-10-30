/**
 * 一次性数据迁移：把旧的作用域串搬到 Space 对象上。
 *
 * 历史包袱：
 *   - 群记忆/待办的作用域是 `chat:<chat_id>`  → `space:<space_id>`（空间与 chat 解耦，之后换绑不丢）
 *   - 私聊记忆/待办的作用域是 `user:<open_id>` → `space:sp_dm_<open_id>`
 *   - 老的"空间"（其实是联盟）作用域是 `space:<名字>` → `circle:<名字>`
 *
 * 顺序很重要：先把老的 `space:<名字>` 改成 `circle:<名字>`，腾出 `space:` 前缀，再把 chat/user 搬进来。
 * 迁移只跑一次，记在 schema_migrations 表里；跑到一半崩了下次会重跑（每步都是幂等的）。
 */
import type { DatabaseSync } from 'node:sqlite'
import { spaceScope, type Spaces } from './space.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
`

const SCOPED_TABLES = ['memory_notes', 'todos'] as const

export interface MigrationReport {
  circles: number
  chats: number
  users: number
  rows: number
}

export function applied(db: DatabaseSync, name: string): boolean {
  db.exec(SCHEMA)
  return Boolean(db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(name))
}

function mark(db: DatabaseSync, name: string): void {
  db.prepare('INSERT OR REPLACE INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(name, Date.now())
}

/** 表存在吗（老库可能还没建某些表）。 */
function hasTable(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`).get(name))
}

function distinctScopes(db: DatabaseSync, prefix: string): string[] {
  const out = new Set<string>()
  for (const table of SCOPED_TABLES) {
    if (!hasTable(db, table)) continue
    const rows = db.prepare(`SELECT DISTINCT scope FROM ${table} WHERE scope LIKE ?`).all(`${prefix}%`) as { scope: string }[]
    for (const r of rows) out.add(r.scope)
  }
  return [...out]
}

function rename(db: DatabaseSync, from: string, to: string): number {
  let n = 0
  for (const table of SCOPED_TABLES) {
    if (!hasTable(db, table)) continue
    n += Number(db.prepare(`UPDATE ${table} SET scope = ? WHERE scope = ?`).run(to, from).changes)
  }
  return n
}

/**
 * 把旧作用域搬到空间上。`spaces` 用来按 chat_id 找／建空间；
 * 私聊空间 id 直接由 open_id 推出来，不需要建（用到时 ensure 会补）。
 */
export function migrateScopesToSpaces(db: DatabaseSync, spaces: Spaces, log?: { info: (msg: string, data?: Record<string, unknown>) => void }): MigrationReport {
  const NAME = '2026-09-space-scopes'
  const report: MigrationReport = { circles: 0, chats: 0, users: 0, rows: 0 }
  if (applied(db, NAME)) return report

  // ① 老的 space:<名字>（联盟）→ circle:<名字>。空间 id 一律是 sp_ 开头，据此区分。
  for (const scope of distinctScopes(db, 'space:')) {
    const name = scope.slice('space:'.length)
    if (name.startsWith('sp_')) continue // 已经是新空间作用域
    report.rows += rename(db, scope, `circle:${name}`)
    report.circles++
  }

  // ② chat:<chat_id> → space:<space_id>（没有空间就按这个 chat 建一个群空间）
  for (const scope of distinctScopes(db, 'chat:')) {
    const chatId = scope.slice('chat:'.length)
    if (!chatId) continue
    const space = spaces.ensure({ kind: 'group', chatId })
    report.rows += rename(db, scope, spaceScope(space.id))
    report.chats++
  }

  // ③ user:<open_id> → space:sp_dm_<open_id>（私聊空间，本人即负责人）
  for (const scope of distinctScopes(db, 'user:')) {
    const openId = scope.slice('user:'.length)
    if (!openId || openId === 'unknown') continue
    const id = spaces.dm(openId).id
    report.rows += rename(db, scope, spaceScope(id))
    report.users++
  }

  mark(db, NAME)
  if (report.rows) log?.info('migrated legacy scopes to spaces', { ...report })
  return report
}
