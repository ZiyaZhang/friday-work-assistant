/**
 * 人的身份映射：@ 得对，或者老实说不知道。没有第三档。
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Identities } from '../src/core/identities.js'
import { Registry } from '../src/core/registry.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildServer } from '../src/mcp/server.js'
import { postContent } from '../src/feishu/post.js'

function seeded(extraRows: string[] = []) {
  const db = new Registry(':memory:').db
  const ids = new Identities(db)
  const dir = mkdtempSync(join(tmpdir(), 'ident-'))
  const f = join(dir, 'm.tsv')
  writeFileSync(f, ['# 注释行要跳过', 'mingyuanzhou\t周明远', 'ZhixingLu\t陆知行', 'yizhoufang\t方亦舟', '', '坏行没有制表符', ...extraRows].join('\n'))
  ids.seedFrom(f)
  return ids
}

describe('身份映射', () => {
  it('导入时跳过注释、空行和缺字段的行', () => {
    expect(seeded().count()).toBe(3)
  })

  it('登录名大小写不敏感', () => {
    const ids = seeded()
    expect(ids.byLogin('zhixinglu')?.displayName).toBe('陆知行')
    expect(ids.byLogin('  MINGYUANZHOU ')?.displayName).toBe('周明远')
  })

  it('人在群里 → 可以 @', () => {
    const r = seeded().resolveForChat('mingyuanzhou', [{ name: '周明远', openId: 'ou_cty' }, { name: '陆知行', openId: 'ou_zzy' }])
    expect(r).toEqual({ kind: 'resolved', login: 'mingyuanzhou', name: '周明远', openId: 'ou_cty' })
    expect(Identities.describe(r)).toBe('<at open_id="ou_cty"></at>')
  })

  it('认得这个人、但他不在这个群 → 写名字，不 @', () => {
    const r = seeded().resolveForChat('yizhoufang', [{ name: '陆知行', openId: 'ou_zzy' }])
    expect(r.kind).toBe('name-only')
    expect(Identities.describe(r)).toContain('方亦舟')
    expect(Identities.describe(r)).not.toContain('<at ')
  })

  it('表里没有这个账号 → 照实说不知道，绝不挑一个群里的人顶上', () => {
    const r = seeded().resolveForChat('some-outside-contributor', [{ name: '陆知行', openId: 'ou_zzy' }])
    expect(r).toEqual({ kind: 'unknown', login: 'some-outside-contributor' })
    const said = Identities.describe(r)
    expect(said).toContain('不知道他在飞书里是谁')
    expect(said).not.toContain('<at ')
    expect(said).not.toContain('陆知行')
  })

  it('空群成员列表不会让它退而求其次去 @ 别人', () => {
    const r = seeded().resolveForChat('mingyuanzhou', [])
    expect(r.kind).toBe('name-only')
    expect(Identities.describe(r)).not.toContain('<at ')
  })

  it('群成员读不到时，历史 open_id 不能作为当前群成员证明', () => {
    const ids = seeded()
    ids.rememberOpenId('yizhoufang', 'ou_xtr')
    const r = ids.resolveForChat('yizhoufang', [])
    expect(r).toEqual({ kind: 'name-only', login: 'yizhoufang', name: '方亦舟' })
    expect(Identities.describe(r)).toContain('未能确认')
    expect(Identities.describe(r)).not.toContain('<at ')
  })

  it('跨群缓存不生成 @，当前群同名者也不能顶替原身份', () => {
    const ids = seeded()
    ids.rememberOpenId('yizhoufang', 'ou_xtr_old')
    expect(ids.resolveForChat('yizhoufang', [{ name: '陆知行', openId: 'ou_zzy' }]).kind).toBe('name-only')
    const r = ids.resolveForChat('yizhoufang', [{ name: '方亦舟', openId: 'ou_different' }])
    expect(r).toEqual({ kind: 'ambiguous', login: 'yizhoufang', name: '方亦舟' })
    expect(Identities.describe(r)).toContain('身份映射冲突')
    expect(Identities.describe(r)).not.toContain('<at ')
  })

  it('群中同名者不按列表顺序挑第一位', () => {
    const ids = seeded()
    const members = [{ name: '周明远', openId: 'ou_a' }, { name: '周明远', openId: 'ou_b' }]
    for (const list of [members, [...members].reverse()]) {
      const r = ids.resolveForChat('mingyuanzhou', list)
      expect(r).toEqual({ kind: 'ambiguous', login: 'mingyuanzhou', name: '周明远' })
      expect(Identities.describe(r)).not.toContain('<at ')
    }
  })

  it('身份表本身同名时，不把唯一一个群同名成员绑定到任一账号', () => {
    const ids = seeded(['different-login\t周明远'])
    expect(ids.resolveForChat('mingyuanzhou', [{ name: '周明远', openId: 'ou_a' }]).kind).toBe('ambiguous')
    expect(ids.resolveForChat('different-login', [{ name: '周明远', openId: 'ou_a' }]).kind).toBe('ambiguous')
  })

  it('已知 open_id 在当前群时可准确消歧，姓名变化不把同名人误认作本人', () => {
    const ids = seeded()
    ids.rememberOpenId('yizhoufang', 'ou_xtr')
    const r = ids.resolveForChat('yizhoufang', [{ name: '方亦舟', openId: 'ou_different' }, { name: '改过的群名片', openId: 'ou_xtr' }])
    expect(r).toEqual({ kind: 'resolved', login: 'yizhoufang', name: '方亦舟', openId: 'ou_xtr' })
  })

  it('重复成员行按身份去重，缺少有效 open_id 的名字不能生成 @', () => {
    const ids = seeded()
    const member = { name: ' 周明远 ', openId: 'ou_cty' }
    expect(ids.resolveForChat(' @mingyuanzhou ', [member, member])).toEqual({ kind: 'resolved', login: 'mingyuanzhou', name: '周明远', openId: 'ou_cty' })
    for (const openId of ['', '   ']) {
      const r = ids.resolveForChat('mingyuanzhou', [{ name: '周明远', openId }])
      expect(r.kind).toBe('name-only')
      expect(Identities.describe(r)).not.toContain('<at ')
    }
  })

  it('重新导入不覆盖已经查到的 open_id，但姓名以表为准', () => {
    const ids = seeded()
    ids.rememberOpenId('yizhoufang', 'ou_xtr')
    const dir = mkdtempSync(join(tmpdir(), 'ident2-'))
    const f = join(dir, 'm.tsv')
    writeFileSync(f, 'yizhoufang\t方亦舟（改过名）')
    ids.seedFrom(f)
    const got = ids.byLogin('yizhoufang')!
    expect(got.displayName).toBe('方亦舟（改过名）')
    expect(got.openId).toBe('ou_xtr')
  })

})

describe('whois 工具输出', () => {
  it('produces a named marker that the post adapter turns into a native mention only after destination verification', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ resolution: { kind: 'resolved', login: 'synthetic-owner', name: '合成负责人', openId: 'ou_owner' } }), { status: 200 }))
    const server = buildServer({ apiUrl: 'http://offline.invalid', token: 'offline' })
    const client = new Client({ name: 'identity-test', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    try {
      await server.connect(a)
      await client.connect(b)
      const result = await client.callTool({ name: 'friday_whois', arguments: { github_login: 'synthetic-owner' } }) as { content: { text: string }[] }
      const text = result.content.map((c) => c.text).join('\n')
      expect(text).toContain('尚未发送通知')
      const marker = text.match(/<at open_id="ou_owner">.*?<\/at>/)![0]
      expect(postContent(`${marker} 请评估。`, undefined, ['ou_owner'])).toEqual({ zh_cn: { content: [[{ tag: 'at', user_id: 'ou_owner' }, { tag: 'md', text: ' 请评估。' }]] } })
      expect(JSON.stringify(postContent(marker))).toContain('合成负责人（未通知）')
    } finally { await client.close(); await server.close(); fetch.mockRestore() }
  })

  it.each(['ambiguous', 'name-only'])('%s 明确不能 @，不误称映射表没有此人或确定不在群', async (kind) => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ resolution: { kind, login: 'yizhoufang', name: '方亦舟' } }), { status: 200 }))
    const server = buildServer({ apiUrl: 'http://offline.invalid', token: 'offline' })
    const client = new Client({ name: 'identity-test', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    try {
      await server.connect(a)
      await client.connect(b)
      const result = await client.callTool({ name: 'friday_whois', arguments: { github_login: 'yizhoufang' } }) as { content: { text: string }[] }
      const text = result.content.map((c) => c.text).join('\n')
      expect(text).toContain('方亦舟')
      expect(text).toContain(kind === 'ambiguous' ? '不能直接 @' : '不要 @')
      expect(text).not.toContain('<at ')
      expect(text).not.toContain('表里没有')
      expect(text).not.toContain('他不在这个群')
    } finally {
      await client.close()
      await server.close()
      fetch.mockRestore()
    }
  })
})
