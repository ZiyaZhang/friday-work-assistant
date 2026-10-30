import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Registry } from '../src/core/registry.js'
import type { InboundMessage } from '../src/feishu/mention.js'

const cleanup: (() => void)[] = []
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn() })
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'friday-task-receipt-'))
  cleanup.push(() => rmSync(home, { recursive: true, force: true }))
  const path = join(home, 'registry.db')
  let registry = new Registry(path)
  cleanup.push(() => registry.close())
  return { path, get registry() { return registry }, reopen() { registry.close(); registry = new Registry(path) } }
}
const input = { sessionKey: 'chat:one', messageId: 'om_real_message', requesterOpenId: 'ou_a', prompt: 'Fix this' }
const count = (registry: Registry, table: 'tasks' | 'task_receipts' | 'task_amendments') => Number(registry.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n)

describe('persistent inbound task receipts', () => {
  it('identifies an assistant input by exact sender, chat, receipt and human dispatch, not a matching title or card', () => {
    const f = fixture(), task = f.registry.createTaskOnce(input).task
    const source = { messageId: input.messageId, chatId: 'oc_one', senderOpenId: input.requesterOpenId }
    expect(f.registry.isAssistantInput(source)).toBe(false)
    f.registry.dispatches.save(task.id, { ...source, senderType: 'user', chatType: 'group', text: '继续修这个 PR', mentions: [] } as unknown as InboundMessage)
    expect(f.registry.isAssistantInput(source)).toBe(true)
    expect(f.registry.isAssistantInput({ ...source, senderOpenId: 'ou_b' })).toBe(false)
    expect(f.registry.isAssistantInput({ ...source, chatId: 'oc_other' })).toBe(false)
    f.registry.updateTask(task.id, { cardMessageId: 'om_card' })
    expect(f.registry.isAssistantInput({ ...source, messageId: 'om_card' })).toBe(false)
    f.reopen()
    expect(f.registry.isAssistantInput(source)).toBe(true)
  })
  it('returns the original task on duplicate delivery even after restart and session routing changes', () => {
    const f = fixture()
    const first = f.registry.createTaskOnce(input)
    expect(first.created).toBe(true)
    f.registry.updateTask(first.task.id, { status: 'running' })
    f.reopen()
    const retry = f.registry.createTaskOnce({ ...input, sessionKey: 'chat:after-restart', prompt: 'same message, richer attachment rendering' })
    expect(retry.created).toBe(false)
    expect(retry.task).toMatchObject({ id: first.task.id, sessionKey: input.sessionKey, prompt: input.prompt, status: 'running' })
    expect(count(f.registry, 'tasks')).toBe(1)
    expect(count(f.registry, 'task_receipts')).toBe(1)
  })

  it('returns exactly one created result for concurrent calls through two DB connections', async () => {
    const f = fixture()
    const other = new Registry(f.path)
    cleanup.push(() => other.close())
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => Promise.resolve().then(() => (i % 2 ? f.registry : other).createTaskOnce(input))))
    expect(results.filter((r) => r.created)).toHaveLength(1)
    expect(new Set(results.map((r) => r.task.id)).size).toBe(1)
    expect(count(f.registry, 'tasks')).toBe(1)
    expect(count(f.registry, 'task_receipts')).toBe(1)
  })

  it('atomically rolls back a new task when receipt persistence fails, and can retry', () => {
    const f = fixture()
    f.registry.db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON task_receipts BEGIN SELECT RAISE(ABORT, 'disk write failed'); END")
    expect(() => f.registry.createTaskOnce(input)).toThrow('disk write failed')
    expect(count(f.registry, 'tasks')).toBe(0)
    expect(count(f.registry, 'task_receipts')).toBe(0)
    f.registry.db.exec('DROP TRIGGER reject_receipt')
    expect(f.registry.createTaskOnce(input).created).toBe(true)
    expect(count(f.registry, 'tasks')).toBe(1)
  })

  it('participates in an outer transaction without committing the caller work', () => {
    const f = fixture()
    f.registry.db.exec('BEGIN')
    f.registry.setKv('outer-test', 'pending')
    f.registry.createTaskOnce(input)
    f.registry.db.exec('ROLLBACK')
    expect(f.registry.getKv('outer-test')).toBeUndefined()
    expect(count(f.registry, 'tasks')).toBe(0)
    expect(count(f.registry, 'task_receipts')).toBe(0)
  })

  it('migrates an old duplicate history without deleting or rewriting any task', () => {
    const f = fixture()
    const first = f.registry.createTask(input)
    f.registry.updateTask(first.id, { status: 'done' })
    const duplicate = f.registry.createTask({ ...input, prompt: 'historical duplicate' })
    f.registry.updateTask(duplicate.id, { status: 'failed', error: 'historical interruption' })
    f.registry.createTask({ ...input, messageId: '', prompt: 'legacy DM followup' })
    f.registry.db.exec('DROP TABLE task_receipts') // simulate pre-receipt database
    f.reopen()
    expect(count(f.registry, 'tasks')).toBe(3)
    expect(count(f.registry, 'task_receipts')).toBe(1)
    const seen = f.registry.createTaskOnce(input)
    expect(seen.created).toBe(false)
    expect(seen.task.id).toBe(first.id)
    expect(f.registry.getTask(duplicate.id)).toMatchObject({ status: 'failed', prompt: 'historical duplicate', error: 'historical interruption' })
    f.reopen()
    expect(count(f.registry, 'tasks')).toBe(3)
    expect(f.registry.createTaskOnce(input).task.id).toBe(first.id)
  })

  it('does not suppress distinct followups that reuse a root message or have no message', () => {
    const f = fixture()
    const inbound = f.registry.createTaskOnce(input).task
    const followup = f.registry.createTask({ ...input, prompt: 'followup one' })
    const followupAgain = f.registry.createTask({ ...input, prompt: 'followup two' })
    const dmFollowup = f.registry.createTask({ ...input, messageId: '', prompt: 'DM followup' })
    expect(new Set([inbound.id, followup.id, followupAgain.id, dmFollowup.id]).size).toBe(4)
    expect(f.registry.createTaskOnce(input).created).toBe(false)
    // Explicit stable system trigger keys can be idempotent without colliding with inbound receipt.
    const occurrence = f.registry.createTaskOnce({ ...input, prompt: 'routine occurrence' }, 'routine:42:occurrence:100')
    expect(occurrence.created).toBe(true)
    expect(f.registry.createTaskOnce({ ...input, prompt: 'routine occurrence' }, 'routine:42:occurrence:100').created).toBe(false)
    expect(f.registry.createTaskOnce({ ...input, prompt: 'next occurrence' }, 'routine:42:occurrence:200').created).toBe(true)
  })

  it('does not replay failed or cancelled historical work on transport redelivery', () => {
    const f = fixture()
    const failed = f.registry.createTaskOnce(input).task
    f.registry.failStaleTasks('process restarted; execution interrupted')
    expect(f.registry.createTaskOnce(input)).toMatchObject({ created: false, task: { id: failed.id, status: 'failed' } })
    const cancelled = f.registry.createTaskOnce({ ...input, messageId: 'om_cancelled' }).task
    f.registry.updateTask(cancelled.id, { status: 'cancelled' })
    expect(f.registry.createTaskOnce({ ...input, messageId: 'om_cancelled' })).toMatchObject({ created: false, task: { status: 'cancelled' } })
    expect(f.registry.createTaskOnce({ ...input, messageId: 'om_explicit_new_request' }).created).toBe(true)
  })

  it('rejects empty keys and collisions with a different message, preserving the original receipt', () => {
    const f = fixture()
    expect(() => f.registry.createTaskOnce({ ...input, messageId: '' })).toThrow('不能为空')
    const first = f.registry.createTaskOnce(input, 'explicit-trigger')
    expect(() => f.registry.createTaskOnce({ ...input, messageId: 'om_other' }, 'explicit-trigger')).toThrow('已绑定其他消息')
    expect(f.registry.createTaskOnce(input, 'explicit-trigger')).toMatchObject({ created: false, task: { id: first.task.id } })
    expect(count(f.registry, 'tasks')).toBe(1)
  })

  it('preserves the original A B C amendment text and binding across database reopen', () => {
    const f = fixture()
    const first = f.registry.createTaskOnce({ ...input, prompt: 'A: inspect all three risks and retain source links' }).task
    const second = f.registry.createTaskOnce({ ...input, messageId: 'om_amend_b', prompt: 'B: only mobile',
      amendsTaskId: first.id, replaceQueued: true }).task
    const third = f.registry.createTaskOnce({ ...input, messageId: 'om_amend_c', prompt: 'C: order by priority',
      amendsTaskId: second.id, replaceQueued: true }).task
    f.reopen()
    const chain = f.registry.listAmendedTasks(third.id)
    expect(chain.map((task) => ({ id: task.id, prompt: task.prompt }))).toEqual([
      { id: first.id, prompt: first.prompt }, { id: second.id, prompt: second.prompt },
    ])
    expect(f.registry.getTask(third.id)).toMatchObject({ prompt: third.prompt, status: 'queued' })
    for (const prior of chain) expect(prior).toMatchObject({ status: 'cancelled', stopReason: 'steered', startedAt: null })
    expect(f.registry.taskForMessage(first.messageId)?.id).toBe(first.id)
    expect(f.registry.taskForMessage(second.messageId)?.id).toBe(second.id)
    expect(f.registry.taskForMessage(third.messageId)?.id).toBe(third.id)
    expect(count(f.registry, 'tasks')).toBe(3)
    expect(count(f.registry, 'task_amendments')).toBe(2)
  })

  it.each(['system-parent', 'different-requester', 'different-session', 'missing-requester'] as const)(
    'rejects an amendment with %s without creating or cancelling work', (boundary) => {
      const f = fixture()
      const inbound = f.registry.createTaskOnce(input).task
      const parent = boundary === 'system-parent'
        ? f.registry.createTaskOnce({ ...input, prompt: 'system followup using the real root message' }, 'routine:7:occurrence:10').task
        : inbound
      f.reopen()
      const child = { ...input, messageId: 'om_invalid_amend', prompt: 'new supplement', amendsTaskId: parent.id, replaceQueued: true,
        ...(boundary === 'different-requester' ? { requesterOpenId: 'ou_b' } : {}),
        ...(boundary === 'different-session' ? { sessionKey: 'chat:another' } : {}),
        ...(boundary === 'missing-requester' ? { requesterOpenId: undefined } : {}),
      }
      const before = { tasks: count(f.registry, 'tasks'), receipts: count(f.registry, 'task_receipts') }
      expect(() => f.registry.createTaskOnce(child)).toThrow('本人发起的真实请求')
      expect(f.registry.getTask(parent.id)).toEqual(parent)
      expect(f.registry.taskForMessage(child.messageId)).toBeUndefined()
      expect(count(f.registry, 'tasks')).toBe(before.tasks)
      expect(count(f.registry, 'task_receipts')).toBe(before.receipts)
      expect(count(f.registry, 'task_amendments')).toBe(0)
    },
  )

  it.each(['tasks', 'task_amendments'] as const)('rolls back a failed %s insert without cancelling the queued predecessor', (table) => {
    const f = fixture()
    const first = f.registry.createTaskOnce(input).task
    const next = { ...input, messageId: 'om_amend_retry', prompt: 'specific supplement', amendsTaskId: first.id, replaceQueued: true }
    f.registry.db.exec(`CREATE TRIGGER reject_amend_write BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'synthetic amendment storage failure'); END`)
    expect(() => f.registry.createTaskOnce(next)).toThrow('synthetic amendment storage failure')
    expect(f.registry.getTask(first.id)).toEqual(first)
    expect(f.registry.taskForMessage(next.messageId)).toBeUndefined()
    expect(count(f.registry, 'tasks')).toBe(1)
    expect(count(f.registry, 'task_receipts')).toBe(1)
    expect(count(f.registry, 'task_amendments')).toBe(0)
    f.registry.db.exec('DROP TRIGGER reject_amend_write')
    const retry = f.registry.createTaskOnce(next)
    expect(retry.created).toBe(true)
    expect(f.registry.listAmendedTasks(retry.task.id).map((task) => task.id)).toEqual([first.id])
    expect(f.registry.getTask(first.id)).toMatchObject({ status: 'cancelled', stopReason: 'steered' })
  })

  it('rolls back the new task and amendment if the predecessor is no longer queued', () => {
    const f = fixture()
    const first = f.registry.createTaskOnce(input).task
    f.registry.updateTask(first.id, { status: 'running' })
    const next = { ...input, messageId: 'om_amend_stale', amendsTaskId: first.id, replaceQueued: true }
    expect(() => f.registry.createTaskOnce(next)).toThrow('已不在排队')
    expect(f.registry.getTask(first.id)).toMatchObject({ status: 'running', stopReason: null })
    expect(f.registry.taskForMessage(next.messageId)).toBeUndefined()
    expect(count(f.registry, 'tasks')).toBe(1)
    expect(count(f.registry, 'task_receipts')).toBe(1)
    expect(count(f.registry, 'task_amendments')).toBe(0)
  })

  it('does not rebind a duplicate amendment or cancel a different queued predecessor', () => {
    const f = fixture()
    const first = f.registry.createTaskOnce(input).task
    const amendmentInput = { ...input, messageId: 'om_amend_duplicate', prompt: 'first accepted supplement', amendsTaskId: first.id, replaceQueued: true }
    const second = f.registry.createTaskOnce(amendmentInput).task
    const unrelated = f.registry.createTaskOnce({ ...input, messageId: 'om_unrelated_task', prompt: 'unrelated request' }).task
    f.reopen()
    const duplicate = f.registry.createTaskOnce({ ...amendmentInput, prompt: 'changed duplicate text', amendsTaskId: unrelated.id })
    expect(duplicate).toMatchObject({ created: false, task: { id: second.id, prompt: second.prompt } })
    expect(f.registry.listAmendedTasks(second.id).map((task) => task.id)).toEqual([first.id])
    expect(f.registry.getTask(unrelated.id)).toEqual(unrelated)
    expect(count(f.registry, 'tasks')).toBe(3)
    expect(count(f.registry, 'task_receipts')).toBe(3)
    expect(count(f.registry, 'task_amendments')).toBe(1)
  })
})
