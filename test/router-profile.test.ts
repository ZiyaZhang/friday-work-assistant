import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseDocument } from 'yaml'
import { expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { createIngressClassifier } from '../src/index.js'
import { createLogger } from '../src/log.js'

it('installs finite provider defaults only in the owned router profile, preserving its deadline and worker settings', async () => {
  const home = mkdtempSync(join(tmpdir(), 'friday-router-profile-test-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'fixture', FEISHU_APP_SECRET: 'fixture', FRIDAY_HOME: home,
    DSH_PROFILE: 'worker-profile' })
  const worker = structuredClone(cfg.dsh)
  const owner = createIngressClassifier(cfg, createLogger('router-profile-test', 'error'))
  try {
    const runtimeParent = join(home, 'runtime')
    const routerHome = join(runtimeParent, readdirSync(runtimeParent)[0]!)
    const profile = join(routerHome, 'profiles', 'friday-router')
    const doc = parseDocument(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8'), {
      customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (expression: string) => expression }],
    })
    expect(doc.errors).toEqual([])
    const patches = doc.toJS() as { id?: string; disabled?: boolean; config?: Record<string, unknown>; insert?: unknown[] }[]
    expect(patches.find(patch => patch.id === 'llm-deepseek')?.config).toEqual({
      thinking: 'disabled', reasoningEffort: 'off', maxTokens: 1024,
    })
    expect(patches.filter(patch => patch.disabled).map(patch => patch.id)).toEqual(expect.arrayContaining([
      'sdk-app-startup', 'sdk-jsonrpc-server', 'persistent-bash', 'persistent-pwsh', 'mcp-resources',
    ]))
    expect(JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')).dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-sdk-minimal'])
    expect(readdirSync(join(routerHome, 'workspace'))).toEqual([])
    expect(cfg.dsh).toEqual(worker)
    expect(cfg.dsh.profile).toBe('worker-profile')
    expect(cfg.dsh.routerTimeoutMs).toBe(15000)
  } finally { await owner.close(); rmSync(home, { recursive: true, force: true }) }
})
