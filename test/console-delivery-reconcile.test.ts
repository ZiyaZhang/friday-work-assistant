import { describe, expect, it, vi } from 'vitest'
import { ConsoleAuth } from '../src/web/console-auth.js'
import { ConsoleCommands } from '../src/core/console-commands.js'
import { ConsoleOperations, ConsoleOperationError } from '../src/core/console-operations.js'
import { ConsoleQueries } from '../src/core/console-queries.js'
import { DeliveryReconciliation } from '../src/core/delivery-reconciliation.js'
import { DeliveryError, DeliveryService, type DeliveryContext } from '../src/core/delivery.js'
import { taskDeliveryContextRef } from '../src/core/execution-keys.js'
import { HumanSpaceAccess } from '../src/core/human-space-access.js'
import { ChannelMemory } from '../src/core/memory.js'
import { Registry } from '../src/core/registry.js'
import { RoutineStore } from '../src/core/routines.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { SkillProposals } from '../src/core/skills.js'
import { SpaceApplication } from '../src/core/space-application.js'
import { TodoApplication } from '../src/core/todo-application.js'
import { Todos } from '../src/core/todos.js'
import { asFeishuClient, FakeFeishu, historyMsg } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const NOW = 1_800_000_000_000
const BOT = 'ou_bot'

/** Console commands and queries called directly; the HTTP router has its own integration suite. */
function fixture() {
  const registry = new Registry(':memory:'), db = registry.db, sp = spaceDeps(db)
  new RunAttempts(db)
  const group = sp.spaces.ensure({ kind: 'group', chatId: 'group', openId: 'alice' })
  sp.spaces.addMember(group.id, 'bob', 'member')
  const other = sp.spaces.ensure({ kind: 'group', chatId: 'other', openId: 'carol' })
  const fake = new FakeFeishu(), feishu = asFeishuClient(fake)
  fake.members.set('group', new Set(['alice', 'bob'])); fake.members.set('other', new Set(['carol']))
  const auth = new ConsoleAuth({ db, appId: 'app', domain: 'feishu', baseUrl: 'https://console.test', tenantKeys: ['tenant'],
    provider: { exchangeCode: async () => ({ accessToken: 'synthetic' }), whoAmI: async () => ({ openId: 'alice', tenantKey: 'tenant' }) } })
  const login = (openId: string) => auth.sessions.create({ appId: 'app', tenantKey: 'tenant', openId, name: openId }).actor
  const access = new HumanSpaceAccess({ ...sp, feishu, assertActor: actor => auth.assertCurrent(actor) })
  let clock = NOW
  let sendFails = false
  const context: DeliveryContext = { actorOpenId: 'alice', audience: { kind: 'group', spaceId: group.id, chatId: 'group' },
    sources: [{ ref: 'trusted-group', spaceId: group.id, chatId: 'group' }], provenanceComplete: true, expiresAt: NOW + 60_000 }
  const service = new DeliveryService(db, { ...sp, now: () => clock, resolveContext: async () => context,
    send: async () => { if (sendFails) throw new Error('synthetic lost acknowledgement'); return { remoteId: 'om_sent' } } })
  registry.createSession({ sessionKey: 'group-thread', chatId: 'group', chatType: 'group', requesterOpenId: 'alice', cwd: '/synthetic' })
  const task = registry.createTaskOnce({ sessionKey: 'group-thread', messageId: 'om_request', requesterOpenId: 'alice', prompt: 'synthetic request' }).task
  registry.updateTask(task.id, { status: 'done', finishedAt: NOW })
  const seed = async (outcome: 'sent' | 'unknown', part = 0) => {
    sendFails = outcome === 'unknown'
    const key = `task:${task.id}:final:${part}`
    await service.deliver({ key, contextRef: taskDeliveryContextRef(task.id, 'group-thread'), payload: { text: 'FINAL_TEXT' } })
      .catch(error => { if (!(error instanceof DeliveryError) || error.code !== 'unknown') throw error })
    sendFails = false
    return key
  }
  const reconciliation = new DeliveryReconciliation(db, { ...sp, feishu, botOpenId: BOT, now: () => clock })
  const operations = new ConsoleOperations(db, { sessions: auth.sessions, now: () => clock })
  const commands = new ConsoleCommands({ access, operations, spaces: sp.spaces, routines: new RoutineStore(db), todos: new Todos(db),
    spaceApplication: new SpaceApplication({ db, spaces: sp.spaces }), todoApplication: new TodoApplication({ db, todos: new Todos(db) }),
    reconciliation, persistRoutineControl: () => { throw new Error('not used') },
    assertHumanRunTarget: () => { throw new Error('not used') }, persistHumanRunStop: () => { throw new Error('not used') },
    assertHumanWorkTarget: () => { throw new Error('not used') }, persistHumanWorkCancel: () => { throw new Error('not used') },
    persistHumanWorkResume: () => { throw new Error('not used') } })
  const queries = new ConsoleQueries({ access, registry, memory: new ChannelMemory(db), todos: new Todos(db), routines: new RoutineStore(db),
    skills: new SkillProposals(db, new Set()), defaults: { brevity: 'normal', reflect: false } })
  const executions = async (actor = login('alice'), spaceId = group.id) => {
    const result = await queries.read(actor, spaceId, 'executions')
    return (result.body.data as { items: { id: number; deliveries: Record<string, unknown>[] }[] }).items
  }
  const command = (key: string, requestId = 'reconcile_request_0001') => ({ operation: 'delivery.reconcile', requestId, key })
  return { db, group, other, fake, auth, login, service, seed, commands, executions, command, task, advance: (ms: number) => { clock += ms } }
}

describe('console delivery reconciliation', () => {
  it('lists unreconciled receipts with their key, then confirms one from the platform and shows the result', async () => {
    const t = fixture(), key = await t.seed('sent')
    let [item] = await t.executions()
    expect(item!.deliveries).toEqual([{ key, status: 'sent', remote_id: 'om_sent', canReconcile: true, reconciliation: null }])
    t.fake.messages.set('om_sent', historyMsg({ messageId: 'om_sent', chatId: 'group', senderType: 'app', senderOpenId: BOT, text: 'FINAL_TEXT' }))
    t.advance(1_000)
    const receipt = await t.commands.execute(t.login('bob'), t.group.id, t.command(key))
    expect(receipt.body).toMatchObject({ appliedResult: { changed: true, state: 'confirmed', result: 'confirmed' }, replayed: false, runtimeCleanup: 'not_required' })
    ;[item] = await t.executions()
    expect(item!.deliveries).toEqual([{ key, status: 'confirmed', remote_id: 'om_sent', canReconcile: false,
      reconciliation: { result: 'confirmed', checkedAt: NOW + 1_000 } }])
    expect(JSON.stringify(t.db.prepare('SELECT * FROM console_operations').all())).not.toContain('FINAL_TEXT')
  })

  it('replays the same request without reading the platform again and records an unresolved outcome as a fact', async () => {
    const t = fixture(), key = await t.seed('unknown')
    t.fake.histories.set('group', [historyMsg({ messageId: 'om_user', chatId: 'group', senderType: 'user', text: 'chatter', createTimeMs: NOW + 1_000 })])
    const history = vi.spyOn(t.fake, 'listChatHistory')
    const alice = t.login('alice')
    const first = await t.commands.execute(alice, t.group.id, t.command(key))
    expect(first.body).toMatchObject({ appliedResult: { changed: false, state: 'unresolved', result: 'remote_absent' }, replayed: false })
    // The same browser session retries the same visible action after a lost reply.
    const again = await t.commands.execute(alice, t.group.id, t.command(key))
    expect(again.body).toMatchObject({ appliedResult: { changed: false, state: 'unresolved', result: 'remote_absent' }, replayed: true })
    expect(history).toHaveBeenCalledTimes(1)
    const [item] = await t.executions()
    expect(item!.deliveries[0]).toMatchObject({ status: 'unknown', canReconcile: true, reconciliation: { result: 'remote_absent' } })
    expect(t.service.get(key)?.error).toBe('verified_absent')
  })

  it('refuses viewers outside the space, keys that belong to another space, and sends still in progress', async () => {
    const t = fixture(), key = await t.seed('sent')
    t.fake.messages.set('om_sent', historyMsg({ messageId: 'om_sent', chatId: 'group', senderType: 'app', senderOpenId: BOT, text: 'FINAL_TEXT' }))
    await expect(t.commands.execute(t.login('carol'), t.group.id, t.command(key))).rejects.toBeInstanceOf(Error)
    await expect(t.commands.execute(t.login('carol'), t.other.id, t.command(key))).rejects.toMatchObject({ status: 404, code: 'resource_not_found' })
    await expect(t.commands.execute(t.login('alice'), t.group.id, t.command('task:999:final:0'))).rejects.toMatchObject({ status: 404, code: 'resource_not_found' })
    t.db.prepare("UPDATE deliveries SET status = 'planned' WHERE delivery_key = ?").run(key)
    await expect(t.commands.execute(t.login('alice'), t.group.id, t.command(key, 'reconcile_request_0002'))).rejects.toMatchObject({ status: 409, code: 'delivery_in_progress' })
    expect(t.service.get(key)?.status).toBe('planned')
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM console_operations').get()?.n).toBe(0)
    await expect(t.commands.execute(t.login('alice'), t.group.id, { operation: 'delivery.reconcile', requestId: 'reconcile_request_0003' }))
      .rejects.toBeInstanceOf(ConsoleOperationError)
  })
})
