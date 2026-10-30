import { createHash } from 'node:crypto'
import { TextDecoder } from 'node:util'
import type { GitHubIdentity } from './identity.js'
import { readIssueThread } from './issue-thread.js'

/** Host-selected targets only. Branch names and download URLs are deliberately absent. */
export type WorkAssessmentTarget =
  | { kind: 'issue' | 'pull_request'; repo: string; number: number }
  | { kind: 'file'; repo: string; commit: string; path: string }

export interface WorkAssessmentSource {
  ref: string
  targetRef: string
  url: string
  text: string
  digest: string
  author?: string
  at?: number
}

export interface WorkAssessmentSnapshot {
  version: 1
  repo: string
  targets: { ref: string; target: WorkAssessmentTarget }[]
  sources: WorkAssessmentSource[]
  /** Missing patches are explicit coverage gaps, never silently complete evidence. */
  gaps: string[]
  digest: string
}

const SHA = /^[a-f0-9]{40}$/
const MAX_FILE_BYTES = 64_000
const MAX_SNAPSHOT_BYTES = 200_000
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const row = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const text = (value: unknown): string | undefined => typeof value === 'string' ? value : value === null ? '' : undefined

export class WorkAssessmentSourceError extends Error {
  constructor(readonly code: 'invalid_target' | 'denied' | 'incomplete' | 'changed' | 'too_large' | 'unsupported_file') {
    super(`接单评估资料不可用：${code}`)
    this.name = 'WorkAssessmentSourceError'
  }
}

function validRepo(repo: string): boolean {
  return /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repo)
    && repo.split('/').every(part => part !== '.' && part !== '..')
}

export function validateWorkAssessmentTarget(target: WorkAssessmentTarget): void {
  if (!target || !validRepo(target.repo)) throw new WorkAssessmentSourceError('invalid_target')
  if (target.kind === 'issue' || target.kind === 'pull_request') {
    if (!Number.isSafeInteger(target.number) || target.number < 1) throw new WorkAssessmentSourceError('invalid_target')
    return
  }
  if (target.kind !== 'file' || !SHA.test(target.commit) || typeof target.path !== 'string'
    || !target.path.length || Buffer.byteLength(target.path) > 512 || target.path.split('/').length > 20
    || /[\\\x00-\x1f\x7f]/.test(target.path) || target.path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new WorkAssessmentSourceError('invalid_target')
  }
}

function snapshotPayload(snapshot: Omit<WorkAssessmentSnapshot, 'digest'>) {
  return { version: snapshot.version, repo: snapshot.repo, targets: snapshot.targets, sources: snapshot.sources, gaps: snapshot.gaps }
}

/** Integrity/coverage validation on persisted snapshots as well as freshly brokered input. */
export function assertWorkAssessmentSnapshot(snapshot: WorkAssessmentSnapshot): void {
  if (!snapshot || snapshot.version !== 1 || !validRepo(snapshot.repo) || !Array.isArray(snapshot.targets)
    || snapshot.targets.length < 1 || snapshot.targets.length > 8 || !Array.isArray(snapshot.sources)
    || snapshot.sources.length < 1 || snapshot.sources.length > 1600 || !Array.isArray(snapshot.gaps)
    || snapshot.gaps.some(gap => typeof gap !== 'string' || !gap || gap.length > 600)) throw new WorkAssessmentSourceError('incomplete')
  const targets = new Set<string>(), refs = new Set<string>()
  for (const item of snapshot.targets) {
    validateWorkAssessmentTarget(item.target)
    if (item.target.repo.toLowerCase() !== snapshot.repo || item.ref !== `target:${sha256(JSON.stringify(item.target))}` || targets.has(item.ref)) {
      throw new WorkAssessmentSourceError('invalid_target')
    }
    targets.add(item.ref)
  }
  for (const source of snapshot.sources) {
    if (!source || typeof source.ref !== 'string' || !source.ref || refs.has(source.ref) || !targets.has(source.targetRef)
      || typeof source.text !== 'string' || source.digest !== sha256(source.text)
      || typeof source.url !== 'string' || !source.url.startsWith(`https://github.com/${snapshot.repo}/`)) throw new WorkAssessmentSourceError('incomplete')
    refs.add(source.ref)
  }
  const serialized = JSON.stringify(snapshotPayload(snapshot))
  if (Buffer.byteLength(serialized) > MAX_SNAPSHOT_BYTES) throw new WorkAssessmentSourceError('too_large')
  if (snapshot.digest !== sha256(serialized)) throw new WorkAssessmentSourceError('changed')
}

/** Only GETs canonical GitHub API paths; no shell, checkout, URL fetch or personal credential return. */
export class WorkAssessmentSourceBroker {
  constructor(private readonly github: Pick<GitHubIdentity, 'api' | 'repoAllowed'>) {}

  async read(input: { targets: readonly WorkAssessmentTarget[]; assertCurrent(): void }): Promise<WorkAssessmentSnapshot> {
    if (!input.targets.length || input.targets.length > 8) throw new WorkAssessmentSourceError('invalid_target')
    const requested = input.targets.map(target => {
      validateWorkAssessmentTarget(target)
      return { ...target, repo: target.repo.toLowerCase() } as WorkAssessmentTarget
    })
    const repo = requested[0]!.repo
    if (requested.some(target => target.repo !== repo)) throw new WorkAssessmentSourceError('invalid_target')
    const check = () => { input.assertCurrent(); if (!this.github.repoAllowed(repo)) throw new WorkAssessmentSourceError('denied') }
    const get = async (path: string): Promise<unknown> => {
      check()
      const value = await this.github.api<unknown>('GET', path, undefined, repo.split('/')[0], check)
      check()
      return value
    }
    const targets: WorkAssessmentSnapshot['targets'] = [], sources: WorkAssessmentSource[] = [], gaps: string[] = []
    const add = (targetRef: string, ref: string, url: string, content: string, author?: string, at?: number): void => {
      sources.push({ ref: `${targetRef}:${ref}`, targetRef, url, text: content, digest: sha256(content),
        ...(author ? { author } : {}), ...(at !== undefined ? { at } : {}) })
      if (Buffer.byteLength(JSON.stringify(sources)) > MAX_SNAPSHOT_BYTES) throw new WorkAssessmentSourceError('too_large')
    }
    for (const target of requested) {
      check()
      const ref = `target:${sha256(JSON.stringify(target))}`
      if (targets.some(item => item.ref === ref)) throw new WorkAssessmentSourceError('invalid_target')
      targets.push({ ref, target })
      if (target.kind === 'file') {
        const content = await this.readFile(target, get)
        check()
        add(ref, 'file', `https://github.com/${repo}/blob/${target.commit}/${target.path.split('/').map(encodeURIComponent).join('/')}`, content)
      } else if (target.kind === 'issue') {
        // The adapter enforces beforeRequest even while the identity refreshes its installation token.
        const guarded = { api: async <T>(_method: string, path: string) => {
          const value = await get(path)
          if (path === `/repos/${repo}/issues/${target.number}`) {
            const issue = row(value)
            if (!issue || !Array.isArray(issue.assignees) || issue.assignees.some(item => typeof row(item)?.login !== 'string' || !row(item)?.login)
              || !Array.isArray(issue.labels) || issue.labels.some(item => typeof row(item)?.name !== 'string' || !row(item)?.name)) {
              throw new WorkAssessmentSourceError('incomplete')
            }
          }
          return value as T
        } }
        const thread = await readIssueThread(guarded, repo, target.number, check)
        check()
        if (!thread) throw new WorkAssessmentSourceError('incomplete')
        add(ref, 'body', thread.snapshot.url, `${thread.snapshot.title}\n${thread.body}`, thread.author, thread.snapshot.createdAt)
        add(ref, 'metadata', thread.snapshot.url, JSON.stringify({ ...thread.snapshot, author: thread.author }))
        for (const comment of thread.comments) add(ref, `comment:${comment.id}`, comment.url, comment.body, comment.author, comment.at)
        add(ref, 'timeline', thread.snapshot.url, JSON.stringify(thread.timeline))
      } else {
        await this.readPullRequest(target, ref, get, add, gaps)
        check()
      }
    }
    check()
    const payload = { version: 1 as const, repo, targets, sources, gaps }
    const snapshot = { ...payload, digest: sha256(JSON.stringify(snapshotPayload(payload))) }
    assertWorkAssessmentSnapshot(snapshot)
    return snapshot
  }

  private async readFile(target: Extract<WorkAssessmentTarget, { kind: 'file' }>, get: (path: string) => Promise<unknown>): Promise<string> {
    const base = `/repos/${target.repo}/git`
    const commit = row(await get(`${base}/commits/${target.commit}`))
    let treeSha = row(commit?.tree)?.sha
    if (commit?.sha !== target.commit || typeof treeSha !== 'string' || !SHA.test(treeSha)) throw new WorkAssessmentSourceError('incomplete')
    const parts = target.path.split('/')
    for (let index = 0; index < parts.length; index++) {
      const tree = row(await get(`${base}/trees/${treeSha}`))
      if (!tree || tree.sha !== treeSha || tree.truncated !== false || !Array.isArray(tree.tree) || tree.tree.length > 5000
        || tree.tree.some(item => !row(item))) throw new WorkAssessmentSourceError('incomplete')
      const matching = tree.tree.map(row).filter(item => item?.path === parts[index])
      if (matching.length !== 1) throw new WorkAssessmentSourceError('incomplete')
      const item = matching[0]!
      if (typeof item.sha !== 'string' || !SHA.test(item.sha)) throw new WorkAssessmentSourceError('incomplete')
      if (index < parts.length - 1) {
        if (item.type !== 'tree' || item.mode !== '040000') throw new WorkAssessmentSourceError('unsupported_file')
        treeSha = item.sha
        continue
      }
      if (item.type !== 'blob' || !['100644', '100755'].includes(String(item.mode))
        || !Number.isSafeInteger(item.size) || Number(item.size) < 0 || Number(item.size) > MAX_FILE_BYTES) throw new WorkAssessmentSourceError('unsupported_file')
      const blob = row(await get(`${base}/blobs/${item.sha}`))
      if (blob?.sha !== item.sha || blob.encoding !== 'base64' || blob.size !== item.size || typeof blob.content !== 'string'
        || blob.content.length > Math.ceil(MAX_FILE_BYTES * 1.5)) throw new WorkAssessmentSourceError('incomplete')
      const encoded = blob.content.replace(/[\r\n]/g, '')
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new WorkAssessmentSourceError('incomplete')
      const bytes = Buffer.from(encoded, 'base64')
      if (bytes.length !== item.size || bytes.toString('base64') !== encoded
        || createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== item.sha) throw new WorkAssessmentSourceError('changed')
      let content: string
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
      catch { throw new WorkAssessmentSourceError('unsupported_file') }
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content)) throw new WorkAssessmentSourceError('unsupported_file')
      return content
    }
    throw new WorkAssessmentSourceError('incomplete')
  }

  private async readPullRequest(target: Extract<WorkAssessmentTarget, { kind: 'issue' | 'pull_request' }>, ref: string,
    get: (path: string) => Promise<unknown>, add: (targetRef: string, ref: string, url: string, content: string) => void, gaps: string[]): Promise<void> {
    const base = `/repos/${target.repo}/pulls/${target.number}`, url = `https://github.com/${target.repo}/pull/${target.number}`
    const before = row(await get(base))
    const version = (pr: Record<string, unknown> | undefined): string => {
      if (!pr || pr.number !== target.number || typeof row(pr.head)?.sha !== 'string' || !SHA.test(String(row(pr.head)?.sha))
        || typeof row(pr.base)?.sha !== 'string' || !SHA.test(String(row(pr.base)?.sha))
        || typeof pr.title !== 'string' || text(pr.body) === undefined || !Number.isSafeInteger(pr.changed_files)
        || !Number.isSafeInteger(pr.comments) || !Number.isSafeInteger(pr.review_comments)) throw new WorkAssessmentSourceError('incomplete')
      return JSON.stringify([pr.number, pr.title, pr.body, pr.state, pr.updated_at, pr.head, pr.base, pr.comments, pr.review_comments, pr.changed_files])
    }
    const identity = version(before)
    add(ref, 'body', url, `${before!.title}\n${text(before!.body)}`)
    add(ref, 'metadata', url, JSON.stringify({ state: before!.state, head: row(before!.head)?.sha, base: row(before!.base)?.sha,
      assignees: before!.assignees, author: row(before!.user)?.login, draft: before!.draft, merged: before!.merged }))
    const pages = async (path: string): Promise<Record<string, unknown>[]> => {
      const all: Record<string, unknown>[] = []
      for (let page = 1; page <= 5; page++) {
        const value = await get(`${path}?per_page=100&page=${page}`)
        if (!Array.isArray(value) || value.length > 100 || value.some(item => !row(item))) throw new WorkAssessmentSourceError('incomplete')
        all.push(...value)
        if (Buffer.byteLength(JSON.stringify(all)) > MAX_SNAPSHOT_BYTES) throw new WorkAssessmentSourceError('too_large')
        if (value.length < 100) return all
      }
      throw new WorkAssessmentSourceError('incomplete')
    }
    const files = await pages(`${base}/files`), paths = new Set<string>()
    if (files.length !== before!.changed_files) throw new WorkAssessmentSourceError('changed')
    for (const file of files) {
      if (typeof file.filename !== 'string' || !file.filename || paths.has(file.filename)) throw new WorkAssessmentSourceError('incomplete')
      paths.add(file.filename)
      if (typeof file.patch !== 'string') gaps.push(`未返回完整 patch：${file.filename}`)
      else {
        // GitHub can omit/truncate patch text even when the file-list pagination is complete.
        const lines = file.patch.split('\n')
        if (!Number.isSafeInteger(file.additions) || !Number.isSafeInteger(file.deletions)
          || lines.filter(line => line.startsWith('+')).length !== file.additions
          || lines.filter(line => line.startsWith('-')).length !== file.deletions) gaps.push(`patch 覆盖不完整：${file.filename}`)
        add(ref, `patch:${encodeURIComponent(file.filename)}`, url, `${file.filename}\n${file.patch}`)
      }
    }
    for (const [kind, path, expected] of [
      ['review', `${base}/reviews`, undefined],
      ['inline', `${base}/comments`, before!.review_comments],
      ['comment', `/repos/${target.repo}/issues/${target.number}/comments`, before!.comments],
    ] as const) {
      const items = await pages(path), ids = new Set<number>()
      if (expected !== undefined && items.length !== expected) throw new WorkAssessmentSourceError('changed')
      for (const item of items) {
        if (!Number.isSafeInteger(item.id) || Number(item.id) < 1 || ids.has(Number(item.id)) || text(item.body) === undefined) throw new WorkAssessmentSourceError('incomplete')
        ids.add(Number(item.id))
        add(ref, `${kind}:${item.id}`, url, JSON.stringify({ id: item.id, author: row(item.user)?.login, state: item.state,
          body: text(item.body), path: item.path, line: item.line, commit: item.commit_id }))
      }
    }
    if (identity !== version(row(await get(base)))) throw new WorkAssessmentSourceError('changed')
  }
}
