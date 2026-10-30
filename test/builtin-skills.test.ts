import { chmodSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.js'
import { ensureDshProfile } from '../src/index.js'
import { createLogger } from '../src/log.js'
import { buildServer } from '../src/mcp/server.js'
import { prepareBuiltinSkillBundle } from '../src/core/builtin-skill-bundle.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../skills')
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? files(path) : [path]
  })
}
const skillFiles = files(root)
const markdown = skillFiles.filter((path) => path.endsWith('.md'))
const examples = markdown.flatMap((path) => [...readFileSync(path, 'utf8').matchAll(/```json\s*\n([\s\S]*?)\n```/g)]
  .map((match) => ({ path, value: JSON.parse(match[1]!) as { tool: string; arguments: Record<string, unknown> } }))
  .filter(({ value }) => typeof value.tool === 'string' && typeof value.arguments === 'object'))

async function connect() {
  const server = buildServer({ apiUrl: 'http://skill-contract.invalid', token: 'fixture-only' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'skill-contract', version: '1' })
  await client.connect(clientTransport)
  return { client, close: async () => { await client.close(); await server.close() } }
}

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('built-in skills delivery and tool contracts', () => {
  it('pins every built-in resource with working relative references and closes default discovery roots', async () => {
    const home = mkdtempSync(join(tmpdir(), 'friday-builtins-'))
    try {
      const command = join(home, 'dsh-fixture')
      const cfg = loadConfig({ FEISHU_APP_ID: 'fixture', FEISHU_APP_SECRET: 'fixture', FRIDAY_HOME: home, DSH_COMMAND: command } as NodeJS.ProcessEnv)
      const profile = join(cfg.dsh.home, 'profiles', cfg.dsh.profile)
      mkdirSync(profile, { recursive: true })
      writeFileSync(join(profile, 'package.json'), '{}')
      const bundle = prepareBuiltinSkillBundle(root, join(cfg.dsh.home, 'friday-skill-bundles'))
      const dump = [{ id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem', config: {
        includeDefaultRoots: false, customSkillDirs: [], bundledSkillDir: bundle.directory, watch: false,
      } }]
      writeFileSync(command, '#!/usr/bin/env node\nprocess.stdout.write(' + JSON.stringify(JSON.stringify(dump)) + ')\n')
      chmodSync(command, 0o700)
      vi.stubEnv('FRIDAY_KEEP_PROFILE_PATCH', '0')
      const result = await ensureDshProfile(cfg, createLogger('skills-test', 'error'))
      expect(result.created).toBe(false)
      for (const path of skillFiles) {
        const copied = join(result.bundle.directory, relative(root, path))
        expect(readFileSync(copied), path).toEqual(readFileSync(path))
        if (!path.endsWith('.md')) continue
        for (const [, target] of readFileSync(path, 'utf8').matchAll(/\[[^\]]+\]\(([^)\s]+\.md)\)/g)) {
          if (/^[a-z]+:|^[/#]/i.test(target!)) continue
          const reference = resolve(dirname(copied), target!)
          expect(reference.startsWith(result.bundle.directory + '/'), path).toBe(true)
          expect(readFileSync(reference, 'utf8').trim().length, `${path} -> ${target}`).toBeGreaterThan(0)
        }
      }
      const patch = readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')
      expect(patch).toContain('includeDefaultRoots: false')
      expect(patch).toContain(`bundledSkillDir: ${JSON.stringify(result.bundle.directory)}`)
      expect((await ensureDshProfile(cfg, createLogger('skills-test', 'error'))).bundle).toEqual(result.bundle)
      // A later home patch can restore global roots even when our own patch is correct.
      dump[0]!.config.includeDefaultRoots = true
      writeFileSync(command, '#!/usr/bin/env node\nprocess.stdout.write(' + JSON.stringify(JSON.stringify(dump)) + ')\n')
      await expect(ensureDshProfile(cfg, createLogger('skills-test', 'error'))).rejects.toMatchObject({ code: 'config_mismatch' })
      writeFileSync(command, '#!/usr/bin/env node\nprocess.stderr.write("fixture-secret"); process.exit(1)\n')
      await expect(ensureDshProfile(cfg, createLogger('skills-test', 'error'))).rejects.toThrow('无法读取 DSH 的有效技能配置，请检查 DSH 安装和配置。')
    } finally { rmSync(home, { recursive: true, force: true }) }
  })

  it('names only currently registered MCP tools throughout the discovered skill bundles', async () => {
    const t = await connect()
    try {
      const tools = new Set((await t.client.listTools()).tools.map((tool) => tool.name))
      for (const path of markdown) {
        for (const [, name] of readFileSync(path, 'utf8').matchAll(/`((?:friday|github|feishu)_[a-z_]+)`/g)) {
          expect(tools.has(name!), `${relative(root, path)} names unavailable tool ${name}`).toBe(true)
        }
      }
    } finally { await t.close() }
  })

  it.each(examples)('accepts documented $value.tool parameters and preserves gateway denial ($path)', async ({ value }) => {
    const gateway = vi.fn(async () => new Response(JSON.stringify({ error: 'fixture: current audience denied' }), { status: 403, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', gateway)
    const t = await connect()
    try {
      const tool = (await t.client.listTools()).tools.find((item) => item.name === value.tool)
      expect(tool).toBeDefined()
      // Check the public schema before invoking; MCP's Zod layer can otherwise silently strip unknown fields.
      const validated = new AjvJsonSchemaValidator().getValidator({ ...tool!.inputSchema, additionalProperties: false })(value.arguments)
      expect(validated.valid, validated.errorMessage).toBe(true)
      const result = await t.client.callTool({ name: value.tool, arguments: value.arguments })
      // Invalid or obsolete parameters fail before fetch. A valid example reaches the permission boundary.
      expect(gateway).toHaveBeenCalledTimes(1)
      const [url, init] = gateway.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toMatch(/^http:\/\/skill-contract\.invalid\/v1\//)
      expect(init.method).toBe('POST')
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain('fixture: current audience denied')
    } finally { await t.close() }
  })
})

describe('friday-workspace-guide 的技能提议口径（P5-1b）', () => {
  it('只有用户明确要求把某个做法设为技能时才提议，不再以“值得复用”为由自行提议', () => {
    const guide = readFileSync(join(root, 'friday-workspace-guide', 'SKILL.md'), 'utf8')
    expect(guide).toContain('只有用户明确要求把某个做法设为技能时才 `friday_propose_skill`')
    expect(guide).not.toContain('值得复用时才')
  })
})
