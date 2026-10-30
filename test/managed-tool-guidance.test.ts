import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildTurnPrompt, workspaceInstructions } from '../src/core/prompt.js'
import type { RunSkillSet } from '../src/core/skills.js'
import { buildServer } from '../src/mcp/server.js'

// Inspect generated host guidance, not arbitrary user/skill bodies. The prefix
// convention covers references independently of today's registered tool list.
function toolReferences(guidance: string): string[] {
  return [...new Set(guidance.match(/\b(?:(?:friday|github|feishu)_[a-z][a-z0-9_]*|web_fetch)\b/g) ?? [])].sort()
}

describe('managed tool guidance matches the advertised MCP contract', () => {
  const server = buildServer({ apiUrl: 'http://127.0.0.1:1', token: 'guidance-list-only' })
  const client = new Client({ name: 'managed-tool-guidance', version: '1' })
  const advertised = new Set<string>()

  beforeAll(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    let cursor: string | undefined
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined)
      for (const tool of page.tools) advertised.add(tool.name)
      cursor = page.nextCursor
    } while (cursor)
  })

  afterAll(async () => {
    await client.close()
    await server.close()
  })

  const unavailable = (guidance: string) => toolReferences(guidance).filter(name => !advertised.has(name))
  function expectUsableSkillGuidance(guidance: string): void {
    const references = toolReferences(guidance)
    // A removed discovery instruction must not make the contract pass vacuously.
    expect(references).toEqual(expect.arrayContaining(['friday_list_skills', 'friday_load_skill']))
    expect(unavailable(guidance)).toEqual([])
  }

  it.each([false, true])('managed workspace with repositories=%s only names advertised tools', hasRepos => {
    const guidance = workspaceInstructions({ botName: 'Friday', executionMode: 'managed', hasRepos,
      repoNames: hasRepos ? ['sample/repository'] : [] })
    expectUsableSkillGuidance(guidance)
  })

  it.each([false, true])('the actual turn prompt with custom skills=%s preserves usable skill discovery', hasCustomSkill => {
    const skillSet: RunSkillSet = {
      runId: 'run-guidance', spaceId: 'space-guidance', builtinDigest: 'builtin-version', digest: 'run-version', served: [],
      skills: hasCustomSkill ? [{ name: 'sample-review', description: 'Review the supplied evidence', proposalId: 7,
        contentDigest: 'pinned-body-version', bindingRevision: 2 }] : [],
    }
    const prompt = buildTurnPrompt({ botName: 'Friday', chatName: 'Sample', chatId: 'sample-chat', chatType: 'p2p',
      sessionKey: 'sample-session', requesterName: 'Sample user', requesterOpenId: 'sample-user',
      nowMs: 1_790_000_000_000, isFirstTurn: true, body: 'Review the supplied evidence.', skillSet })
    expectUsableSkillGuidance(prompt)
    expect(prompt).toContain('source=builtin')
    if (hasCustomSkill) expect(prompt).toContain('"proposalId":7')
  })

  it('detects the former managed skill aliases against the real tools/list response', () => {
    const current = workspaceInstructions({ botName: 'Friday', executionMode: 'managed', hasRepos: false, repoNames: [] })
    const former = current.replaceAll('friday_list_skills', 'friday_skill_list')
      .replaceAll('friday_load_skill', 'friday_skill_load')
    expect(unavailable(former)).toEqual(['friday_skill_list', 'friday_skill_load'])
  })
})
