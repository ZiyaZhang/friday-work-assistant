import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Todos } from '../src/core/todos.js'
import { parseTodoProvenance, type TodoMessageMetadata, type TodoProvenance } from '../src/core/todo-provenance.js'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
function database() {
  const db = new DatabaseSync(':memory:')
  cleanups.push(() => db.close())
  return { db, todos: new Todos(db) }
}
function message(overrides: Partial<TodoMessageMetadata> = {}): TodoMessageMetadata {
  return { messageId: 'original-request', chatId: 'original-dm', chatType: 'p2p', senderOpenId: 'alice',
    msgType: 'text', createTimeMs: 1000, link: { status: 'unavailable' }, ...overrides }
}
function provenance(): TodoProvenance {
  return { version: 1, originRunId: 'original-run', taskId: 97, workKey: 'original-work', request: message(),
    selectedInputs: [{ ref: 'selected-material', taskId: 95, message: message({ messageId: 'forward-container', msgType: 'merge_forward',
      createTimeMs: 900, link: { status: 'available', url: 'https://verified-message.example/synthetic-container' } }) }],
    attachments: [{ fileId: 'managed-file', version: 1, containerMessageId: 'forward-container', resourceMessageId: 'forward-child',
      contentDigest: 'a'.repeat(64), name: '问题报告.pdf', link: { status: 'available', url: 'https://verified-message.example/synthetic-container' } }],
    contextSnapshot: { version: 1, acpSessionId: 'private-acp', spaceId: 'dm-alice', chatId: 'original-dm', memoryScopes: [],
      chats: [], repositories: [], external: [], messageSources: [], personalMemoryComplete: true } }
}
const input = { scope: 'space:dm-alice', title: '跟进这个问题', detail: '保留原始详情', createdBy: 'alice', sessionKey: 'actual-session' }

describe('host-owned Todo creation provenance', () => {
  it('stores the original request, chosen container and admitted attachment with the Todo in one INSERT', () => {
    const { db, todos } = database(), origin = provenance()
    // Audit sources are cumulative inputs, not asserted citations in the public display.
    origin.contextSnapshot.external.push({ kind: 'web', ref: 'https://private.example/?access=synthetic-secret', access: 'link' })
    const todo = todos.add({ ...input, source: '用户提供的材料', provenance: origin })
    expect(todos.getProvenance(todo.id)).toEqual(origin)
    expect(todo.origin).toEqual({ request: { kind: 'request', label: '原请求', suppliedAt: 1000, link: { status: 'unavailable' } },
      selectedInputs: [{ kind: 'forward', label: '转发材料', suppliedAt: 900,
        link: { status: 'available', url: 'https://verified-message.example/synthetic-container' } }],
      attachments: [{ kind: 'attachment', label: '附件已接收：问题报告.pdf',
        link: { status: 'available', url: 'https://verified-message.example/synthetic-container' } }] })
    expect(todo.source).toBe('用户提供的材料')
    const publicJson = JSON.stringify(todos.list(input.scope))
    for (const privateValue of ['original-run', 'original-work', 'original-request', 'forward-child', 'private-acp',
      'selected-material', 'managed-file', 'synthetic-secret', 'contextSnapshot', 'provenance_json']) expect(publicJson).not.toContain(privateValue)
    const row = db.prepare('SELECT title,source,provenance_json FROM todos WHERE id=?').get(todo.id)!
    expect(row.title).toBe(input.title)
    expect(JSON.parse(String(row.provenance_json))).toEqual(origin)
  })

  it('preserves creation evidence across amendment, confirmation, completion and reopen', () => {
    const { db, todos } = database(), todo = todos.add({ ...input, confirmed: false, provenance: provenance() })
    const before = db.prepare('SELECT provenance_json FROM todos WHERE id=?').get(todo.id)
    todos.update(todo.id, input.scope, { title: '补充后的问题', detail: '用户后来补充了日志' })
    todos.confirm(todo.id, input.scope)
    todos.done(todo.id, input.scope)
    todos.transition(todo.id, input.scope, 'open', { by: 'alice' })
    expect(db.prepare('SELECT provenance_json FROM todos WHERE id=?').get(todo.id)).toEqual(before)
    expect(todos.get(todo.id)).toMatchObject({ title: '补充后的问题', detail: '用户后来补充了日志', origin: todo.origin })
  })

  it('does not leave a content-only Todo when provenance is invalid or its INSERT fails', () => {
    const { db, todos } = database(), invalid = provenance()
    invalid.request!.chatId = 'another-chat'
    expect(() => todos.add({ ...input, provenance: invalid })).toThrow('待办来源记录不完整或不匹配')
    expect(todos.list(input.scope)).toEqual([])
    db.exec(`CREATE TRIGGER reject_provenance BEFORE INSERT ON todos WHEN NEW.provenance_json IS NOT NULL
      BEGIN SELECT RAISE(ABORT,'simulated atomic INSERT failure'); END`)
    expect(() => todos.add({ ...input, provenance: provenance() })).toThrow('simulated atomic INSERT failure')
    expect(todos.list(input.scope)).toEqual([])
  })

  it('joins the existing caller transaction instead of committing the source separately', () => {
    const { db, todos } = database()
    db.exec('BEGIN')
    const todo = todos.add({ ...input, provenance: provenance() })
    expect(todos.getProvenance(todo.id)).not.toBeNull()
    db.exec('ROLLBACK')
    expect(todos.get(todo.id)).toBeUndefined()
    expect(todos.getProvenance(todo.id)).toBeNull()
  })

  it('keeps the compact envelope free of bodies and resource keys and does not retain mutable references', () => {
    const { todos } = database(), origin = provenance()
    Object.assign(origin.request!, { text: 'private body', fileKey: 'private-file-key', accessToken: 'synthetic-token' })
    const todo = todos.add({ ...input, provenance: origin })
    origin.request!.messageId = 'later-message'
    origin.contextSnapshot.memoryScopes.push('later-scope')
    const saved = todos.getProvenance(todo.id)!
    const json = JSON.stringify(saved)
    for (const excluded of ['private body', 'private-file-key', 'synthetic-token', 'later-message', 'later-scope']) expect(json).not.toContain(excluded)
    saved.request!.messageId = 'mutated-read'
    todo.origin!.request!.label = 'mutated-display'
    expect(todos.getProvenance(todo.id)!.request!.messageId).toBe('original-request')
    expect(todos.get(todo.id)!.origin!.request!.label).toBe('原请求')
  })

  it('reports unavailable links without synthesizing URLs from source IDs or descriptions', () => {
    const { todos } = database(), origin = provenance()
    origin.selectedInputs[0]!.message.link = { status: 'unavailable' }
    origin.attachments![0]!.link = { status: 'unavailable' }
    const todo = todos.add({ ...input, detail: '模型声称出处在 https://unverified.example', provenance: origin })
    expect(JSON.stringify(todo.origin)).not.toContain('https:')
    expect(JSON.stringify(todo.origin)).not.toContain('已读取')
    expect(todo.origin!.attachments[0]!.link).toEqual({ status: 'unavailable' })
  })

  it.each(['javascript:alert(1)', 'http://verified-message.example/plain', 'https://user:password@verified-message.example/', 'not a URL'])(
    'rejects unsafe link transport %s before writing', url => {
      const { todos } = database(), origin = provenance()
      origin.request!.link = { status: 'available', url }
      expect(() => todos.add({ ...input, provenance: origin })).toThrow('待办来源记录不完整或不匹配')
      expect(todos.list(input.scope)).toEqual([])
    })

  it.each(['identity', 'chat', 'repeated-reference', 'unbound-attachment', 'missing-request'])(
    'rejects inconsistent host metadata: %s', mismatch => {
      const { todos } = database(), origin = provenance()
      if (mismatch === 'identity') origin.selectedInputs[0]!.message.senderOpenId = 'bob'
      if (mismatch === 'chat') origin.selectedInputs[0]!.message.chatId = 'foreign-group'
      if (mismatch === 'repeated-reference') origin.selectedInputs.push(structuredClone(origin.selectedInputs[0]!))
      if (mismatch === 'unbound-attachment') origin.attachments![0]!.containerMessageId = 'unknown-container'
      if (mismatch === 'missing-request') origin.request = null
      expect(() => todos.add({ ...input, provenance: origin })).toThrow('待办来源记录不完整或不匹配')
      expect(todos.list(input.scope)).toEqual([])
    })

  it('preserves truthful background evidence without inventing an inbound request', () => {
    const { todos } = database(), origin = provenance()
    origin.taskId = null; origin.request = null; origin.selectedInputs = []; origin.attachments = []
    const todo = todos.add({ ...input, source: '常驻职责', provenance: origin })
    expect(todo).toMatchObject({ source: '常驻职责', origin: { request: null, selectedInputs: [], attachments: [] } })
    expect(todos.getProvenance(todo.id)!.originRunId).toBe('original-run')
  })

  it('keeps missing, malformed and future provenance unknown without breaking existing content', () => {
    const { db, todos } = database(), old = todos.add(input)
    expect(old.origin).toBeNull()
    expect(todos.getProvenance(old.id)).toBeNull()
    for (const bad of ['{', JSON.stringify({ version: 9 }), JSON.stringify({ ...provenance(), selectedInputs: null })]) {
      db.prepare('UPDATE todos SET provenance_json=? WHERE id=?').run(bad, old.id)
      expect(todos.get(old.id)).toMatchObject({ title: input.title, detail: input.detail, origin: null, source: null })
      expect(todos.getProvenance(old.id)).toBeNull()
      expect(parseTodoProvenance(bad)).toBeNull()
    }
  })

  it('migrates an old database additively and reopens the exact new source from disk', () => {
    const directory = mkdtempSync(join(tmpdir(), 'friday-todo-provenance-'))
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
    const path = join(directory, 'friday.db'), old = new DatabaseSync(path)
    old.exec(`CREATE TABLE todos(id INTEGER PRIMARY KEY AUTOINCREMENT,scope TEXT NOT NULL,title TEXT NOT NULL,
      detail TEXT,due_ms INTEGER,owner TEXT,status TEXT NOT NULL DEFAULT 'open',created_by TEXT,session_key TEXT,
      source TEXT,created_at INTEGER NOT NULL,done_at INTEGER);
      INSERT INTO todos(scope,title,source,created_at) VALUES ('legacy','原来的待办','原来的标签',1)`)
    const first = new Todos(old)
    expect(first.get(1)).toMatchObject({ title: '原来的待办', source: '原来的标签', origin: null })
    const created = first.add({ ...input, provenance: provenance() })
    old.close()
    const fresh = new DatabaseSync(path); cleanups.push(() => fresh.close())
    const reopened = new Todos(fresh)
    expect(reopened.get(created.id)).toEqual(created)
    expect(reopened.getProvenance(created.id)).toEqual(provenance())
    expect(fresh.prepare('SELECT provenance_json FROM todos WHERE id=1').get()).toEqual({ provenance_json: null })
    expect((fresh.prepare('PRAGMA table_info(todos)').all() as { name: string }[]).filter(column => column.name === 'provenance_json')).toHaveLength(1)
  })
})
