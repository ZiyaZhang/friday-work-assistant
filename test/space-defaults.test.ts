import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Spaces, type SpaceConfig } from '../src/core/space.js'

const databases: DatabaseSync[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })

function setup() {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  return { db, spaces: new Spaces(db) }
}

const localRules: SpaceConfig = {
  proactive: { enabled: true, quietMs: 100, minMessages: 1, maxPerHour: 20, dormantAfter: 2, criteria: '仅属于原群的规则', hours: { from: 8, to: 20 } },
  notes: ['SYNTHETIC_PRIVATE_GROUP_NOTE'], repos: true, projectRepos: ['synthetic/private'],
  models: { main: 'group-main', heavy: 'group-heavy', probe: 'group-probe' },
  reflect: true, digestEveryMs: 1, progressCardDelayMs: 0,
}

describe('personal defaults are explicit presentation preferences', () => {
  it('filters legacy saved rules on read and when creating a different group or personal space', () => {
    const { db, spaces } = setup()
    const old = { brevity: 'short', ack: 'none', ...localRules, futurePermission: { enabled: true } }
    db.prepare('INSERT INTO user_defaults (open_id, config, updated_at) VALUES (?, ?, ?)').run('alice', JSON.stringify(old), 1)
    expect(spaces.defaultsFor('alice')).toEqual({ brevity: 'short', ack: 'none' })
    expect(spaces.ensure({ kind: 'group', chatId: 'new-group', openId: 'alice' }).config).toEqual({ brevity: 'short', ack: 'none' })
    expect(spaces.ensure({ kind: 'p2p', chatId: 'alice-dm', openId: 'alice' }).config).toEqual({ brevity: 'short', ack: 'none' })
  })

  it('stores only brevity and ack, including none and legacy card feedback', () => {
    const { db, spaces } = setup()
    for (const ack of ['none', 'card', 'react'] as const) {
      spaces.rememberDefaults('alice', { ...localRules, brevity: 'detailed', ack })
      const saved = db.prepare('SELECT config FROM user_defaults WHERE open_id = ?').get('alice') as { config: string }
      expect(JSON.parse(saved.config)).toEqual({ brevity: 'detailed', ack })
    }
  })

  it('does not copy another space owner preferences when the operator only changes a group rule', () => {
    const { spaces } = setup()
    spaces.rememberDefaults('alice', { brevity: 'short', ack: 'none' })
    const group = spaces.ensure({ kind: 'group', chatId: 'bob-group', openId: 'bob' })
    spaces.patchConfig(group.id, { brevity: 'detailed', ack: 'react', ...localRules }, 'bob')
    spaces.patchConfig(group.id, { proactive: { quietMs: 500 }, notes: ['新群规则'] }, 'alice')
    expect(spaces.defaultsFor('alice')).toEqual({ brevity: 'short', ack: 'none' })
    expect(spaces.get(group.id)?.config).toMatchObject({ brevity: 'detailed', ack: 'react', proactive: { enabled: true, quietMs: 500 }, notes: ['新群规则'] })
    expect(spaces.ensure({ kind: 'group', chatId: 'alice-next', openId: 'alice' }).config).toEqual({ brevity: 'short', ack: 'none' })
  })

  it('merges only the explicitly edited personal field and keeps existing spaces unchanged', () => {
    const { spaces } = setup()
    spaces.rememberDefaults('alice', { brevity: 'short', ack: 'none' })
    const old = spaces.ensure({ kind: 'group', chatId: 'old', openId: 'alice' })
    const another = spaces.ensure({ kind: 'group', chatId: 'another', openId: 'bob' })
    spaces.patchConfig(another.id, { ack: 'react', ...localRules })
    spaces.patchConfig(another.id, { brevity: 'detailed' }, 'alice')
    expect(spaces.defaultsFor('alice')).toEqual({ brevity: 'detailed', ack: 'none' })
    expect(spaces.get(old.id)?.config).toEqual({ brevity: 'short', ack: 'none' })
    expect(spaces.get(another.id)?.config).toMatchObject({ ...localRules, brevity: 'detailed', ack: 'react' })
    expect(spaces.defaultsFor('bob')).toEqual({})
  })

  it('does not inherit any model tier even when that is the only changed setting', () => {
    const { spaces } = setup()
    const group = spaces.ensure({ kind: 'group', chatId: 'source', openId: 'alice' })
    spaces.patchConfig(group.id, { models: localRules.models }, 'alice')
    expect(spaces.get(group.id)?.config.models).toEqual(localRules.models)
    expect(spaces.defaultsFor('alice')).toEqual({})
    expect(spaces.ensure({ kind: 'group', chatId: 'destination', openId: 'alice' }).config).toEqual({})
  })

  it('scrubs old stored rules on the next write without losing valid personal preferences', () => {
    const { db, spaces } = setup()
    db.prepare('INSERT INTO user_defaults (open_id, config, updated_at) VALUES (?, ?, ?)').run('alice', JSON.stringify({ ack: 'none', ...localRules }), 1)
    spaces.rememberDefaults('alice', { brevity: 'short' })
    const saved = db.prepare('SELECT config FROM user_defaults WHERE open_id = ?').get('alice') as { config: string }
    expect(JSON.parse(saved.config)).toEqual({ ack: 'none', brevity: 'short' })
  })

  it.each(['null', '[]', '"text"', '{"brevity":true,"ack":{"permission":"auto"}}', '{broken'])('does not promote malformed legacy defaults: %s', (config) => {
    const { db, spaces } = setup()
    db.prepare('INSERT INTO user_defaults (open_id, config, updated_at) VALUES (?, ?, ?)').run('alice', config, 1)
    expect(spaces.defaultsFor('alice')).toEqual({})
  })
})
