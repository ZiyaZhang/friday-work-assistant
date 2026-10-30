import { afterEach, describe, expect, it } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { Spaces } from '../src/core/space.js'
import { SpaceApplication, presentationTag } from '../src/core/space-application.js'
const databases: Registry[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })
function setup() {
  const registry = new Registry(':memory:'); databases.push(registry)
  const spaces = new Spaces(registry.db)
  const space = spaces.ensure({ kind: 'group', chatId: 'group', openId: 'alice' })
  return { registry, spaces, space, app: new SpaceApplication({ db: registry.db, spaces }) }
}
describe('shared presentation preferences', () => {
  it('changes only explicit preferences and preserves per-person inheritance', () => {
    const t = setup(); t.spaces.patchConfig(t.space.id, { notes: ['group only'], repos: true })
    const result = t.app.configurePresentation(t.space.id, { brevity: 'short', ack: 'none' }, { actorOpenId: 'alice', expectedTag: presentationTag(t.space) })
    expect(result.changed).toBe(true); expect(result.space.config).toMatchObject({ brevity: 'short', ack: 'none', notes: ['group only'], repos: true })
    const next = t.spaces.ensure({ kind: 'group', chatId: 'next', openId: 'alice' })
    expect(next.config).toEqual({ brevity: 'short', ack: 'none' })
  })
  it('rejects competing changes, stale binding, archived space, and unsupported settings', () => {
    const t = setup(), tag = presentationTag(t.space)
    t.app.configurePresentation(t.space.id, { brevity: 'short' }, { expectedTag: tag })
    expect(() => t.app.configurePresentation(t.space.id, { ack: 'none' }, { expectedTag: tag })).toThrow('已变化')
    const current = presentationTag(t.spaces.get(t.space.id)!)
    t.spaces.rebind(t.space.id, 'other')
    expect(() => t.app.configurePresentation(t.space.id, { ack: 'none' }, { expectedTag: current })).toThrow('已变化')
    const rebound = presentationTag(t.spaces.get(t.space.id)!)
    t.spaces.suspend(t.space.id)
    expect(() => t.app.configurePresentation(t.space.id, { ack: 'none' }, { expectedTag: rebound })).toThrow('已变化')
    expect(() => t.app.configurePresentation(t.space.id, { models: { main: 'fake' } } as never, { expectedTag: rebound })).toThrow('有效')
  })
  it('rolls back personal defaults if the space write fails', () => {
    const t = setup()
    t.registry.db.exec("CREATE TRIGGER reject_space BEFORE UPDATE ON space_rooms BEGIN SELECT RAISE(ABORT,'injected'); END")
    expect(() => t.app.configurePresentation(t.space.id, { brevity: 'detailed' }, { actorOpenId: 'alice', expectedTag: presentationTag(t.space) })).toThrow('injected')
    expect(t.spaces.get(t.space.id)!.config).toEqual({})
    expect(t.spaces.ensure({ kind: 'group', chatId: 'next', openId: 'alice' }).config).toEqual({})
  })
})
