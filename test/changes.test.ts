import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { Registry } from '../src/core/registry.js'
import { describe, expect, it } from 'vitest'
import { ChangeManager, MARKER_FILE, slugify } from '../src/github/changes.js'
import { GitHubIdentity, loadGitHubConfig, type GitHubHttp } from '../src/github/identity.js'
import { createLogger } from '../src/log.js'
import { spaceDeps } from './helpers/space.js'

const log = createLogger('test', 'error')
const actor = { sessionKey: 'session-a', requesterOpenId: 'ou_a' }

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } }).trim()
}

/** 一个本地 bare 仓库当"GitHub 远端"，里面有 main 分支和一个文件。 */
function makeRemote(): { bare: string } {
  const root = mkdtempSync(join(tmpdir(), 'friday-remote-'))
  const src = join(root, 'src')
  execFileSync('git', ['init', '-q', src])
  git(src, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  writeFileSync(join(src, 'README.md'), '# demo\n')
  git(src, 'add', '-A')
  git(src, 'commit', '-q', '-m', 'init')
  const bare = join(root, 'remote.git')
  execFileSync('git', ['clone', '-q', '--bare', src, bare])
  git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  return { bare }
}

function identity(calls: { method: string; path: string; body?: unknown }[]): GitHubIdentity {
  const http: GitHubHttp = {
    async request(method, path, body) {
      calls.push({ method, path, body })
      if (path === '/user') return { status: 200, data: { login: 'friday-bot' } as never }
      if (path === '/users/friday-bot') return { status: 200, data: { id: 777 } as never }
      if (path.endsWith('/pulls') && method === 'POST') return { status: 201, data: { html_url: 'https://github.com/org/demo/pull/5', number: 5 } as never }
      return { status: 404, data: { message: 'nope' } as never }
    },
  }
  const cfg = loadGitHubConfig({ GITHUB_TOKEN: 'ghp_x', FRIDAY_GITHUB_REPOS: 'org/demo', FRIDAY_GITHUB_WRITE_REPOS: 'org/demo' } as NodeJS.ProcessEnv)!
  return new GitHubIdentity(cfg, log, http)
}

describe('ChangeManager (file:// remote)', () => {
  it('slugifies branch hints', () => {
    expect(slugify('Fix Session Resume!')).toBe('fix-session-resume')
    expect(slugify('修复会话恢复')).toBe('change')
    expect(slugify('a'.repeat(80)).length).toBeLessThanOrEqual(40)
  })

  it('prepares a writable copy in the workspace, commits as the bot, pushes the branch and opens a draft PR after confirmation', async () => {
    const { bare } = makeRemote()
    const calls: { method: string; path: string; body?: unknown }[] = []
    const home = mkdtempSync(join(tmpdir(), 'friday-changes-'))
    const cwd = join(home, 'ws', 'chats', 'oc_1')
    const cm = new ChangeManager({ db: new Registry(':memory:').db, cacheDir: join(home, 'git'), github: identity(calls), log, remoteUrlFor: () => `file://${bare}`, now: () => 1_700_000_000_000 })

    await expect(cm.prepare({ repo: 'other/repo', cwd, ...actor })).rejects.toThrow('不在允许范围内')
    const prep = await cm.prepare({ repo: 'org/demo', cwd, ...actor, branchHint: 'Fix README typo' })
    expect(prep.dir).toBe(join(realpathSync(cwd), 'work', prep.id, 'demo'))
    expect(prep.base).toBe('main')
    expect(prep.branch).toMatch(/^friday\/fix-readme-typo-[a-f0-9-]{36}$/)
    expect(existsSync(join(prep.dir, MARKER_FILE))).toBe(true)
    expect(git(prep.dir, 'remote', 'get-url', 'origin')).toBe(`file://${bare}`)
    expect(git(prep.dir, 'status', '--porcelain')).toBe('') // marker 被排除，工作区干净
    const independent = await cm.prepare({ repo: 'org/demo', cwd, ...actor })
    expect(independent.dir).not.toBe(prep.dir)

    // 模型在副本里改代码
    writeFileSync(join(prep.dir, 'README.md'), '# demo\n\nfixed\n')
    writeFileSync(join(prep.dir, 'NEW.md'), 'new file\n')
    const sum = await cm.summarize(prep.dir)
    expect(sum.files.sort()).toEqual(['NEW.md', 'README.md'])

    const approval = await cm.inspect({ dir: prep.dir, cwd, ...actor })
    const confirmed = { cwd, ...actor, expectedSnapshot: approval.snapshot }
    await expect(cm.publish({ dir: '/tmp/elsewhere', ...confirmed, title: 't', body: '' })).rejects.toThrow('不是 github_start_change')
    await expect(cm.publish({ dir: prep.dir, ...confirmed, title: '   ', body: '' })).rejects.toThrow('PR 标题')
    const pub = await cm.publish({ dir: prep.dir, ...confirmed, title: 'Fix README typo', body: 'why: typo\nwhat: fixed\ntest: n/a' })
    expect(pub.branch).toBe(prep.branch)
    expect(pub.files.sort()).toEqual(['NEW.md', 'README.md'])
    expect(pub.url).toBe('') // file:// 远端不开 PR，只推分支
    // 远端真的有这个分支，提交作者是机器人
    expect(git(bare, 'show-ref', '--verify', `refs/heads/${prep.branch}`)).toContain(prep.branch)
    expect(git(bare, 'log', '-1', '--format=%an <%ae>', prep.branch)).toBe('friday-bot <777+friday-bot@users.noreply.github.com>')
    expect(readFileSync(join(prep.dir, 'README.md'), 'utf8')).toContain('fixed')
    // 重复同一确认返回已完成结果，不再提交或推送。
    const again = await cm.publish({ dir: prep.dir, ...confirmed, title: 'Fix README typo', body: 'why: typo\nwhat: fixed\ntest: n/a' })
    expect(again.files.sort()).toEqual(['NEW.md', 'README.md'])
    expect(again.replayed).toBe(true)
  })
})

describe('change routes: publishing a PR', () => {
  it('start prepares under the session cwd; publish goes through without asking anyone', async () => {
    const { Registry } = await import('../src/core/registry.js')
    const { ChannelMemory } = await import('../src/core/memory.js')
    const { MessageCache } = await import('../src/core/message-cache.js')
    const { MessageService } = await import('../src/core/messages.js')
    const { Todos } = await import('../src/core/todos.js')
    const { createInternalApi } = await import('../src/internal/api.js')
    const { ALL_SCOPES, TokenIssuer } = await import('../src/internal/tokens.js')
    const { FakeFeishu, asFeishuClient } = await import('./helpers/fake-feishu.js')

    const { bare } = makeRemote()
    const calls: { method: string; path: string; body?: unknown }[] = []
    const github = identity(calls)
    const home = mkdtempSync(join(tmpdir(), 'friday-changes-api-'))
    const cwd = join(home, 'ws', 'dm', 'ou_alice')
    const registry = new Registry(':memory:')
    const changes = new ChangeManager({ db: registry.db, cacheDir: join(home, 'git'), github, log, remoteUrlFor: () => `file://${bare}` })
    const asked: { header: string; headline: string; detail?: string }[] = []
    let answer = false
    const feishu = new FakeFeishu()
    const messageCache = new MessageCache(registry.db)
    const api = createInternalApi({
      feishu: asFeishuClient(feishu),
      memory: new ChannelMemory(registry.db),
      registry,
      messages: new MessageService(asFeishuClient(feishu), messageCache, log),
      messageCache,
      todos: new Todos(registry.db),
      ...spaceDeps(registry.db),
      github,
      changes,
      confirm: async (input) => {
        asked.push(input)
        return answer
      },
      tokens: new TokenIssuer('s'),
      log,
      maxHistoryPerCall: 50,
    })
    const cap = { sessionKey: 'dm:ou_alice', chatId: 'oc_dm', chatType: 'p2p' as const, requesterOpenId: 'ou_alice', cwd, scopes: [...ALL_SCOPES], exp: 0 }
    const start = (await api.routes['POST /v1/github/change/start']!(cap, { repo: 'org/demo', branch_hint: 'tweak' })) as { id: string; dir: string; branch: string }
    expect(start.dir).toBe(join(realpathSync(cwd), 'work', start.id, 'demo'))
    writeFileSync(join(start.dir, 'README.md'), 'changed\n')

    // 开 PR 不再拦一道确认：PR 是提议不是改动，draft、要 review 才能合、关掉就没了。
    // 一张确认卡防的是"模型理解错了"，而 PR 本身就是拿给人看的。
    const pub = (await api.routes['POST /v1/github/change/publish']!(cap, { dir: relative(realpathSync(cwd), start.dir), title: 'tweak', body: 'b' })) as { branch: string; files: string[] }
    expect(asked).toEqual([])
    expect(pub.files).toEqual(['README.md'])
    expect(git(bare, 'branch', '--list', start.branch)).toContain(start.branch)
    // 越出工作区的目录不行
    await expect(api.routes['POST /v1/github/change/publish']!(cap, { dir: '/tmp', title: 't', body: '' })).rejects.toThrow(/不是 github_start_change/)
  })
})
