/**
 * 「新提议 · 新增技能」：模型做完一件可复用的事后，提议把流程沉淀成一个 dsh skill（SKILL.md），
 * 提议正文是不可变版本；接受只切当前 Space 的绑定，运行按固定版本经宿主读取。
 * 本模块只负责同步存储事务；当前 Run、人员、Space 与策略授权由调用方执行。
 */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export type ProposalStatus = 'pending' | 'accepted' | 'ignored'

export interface SkillProposal {
  id: number
  name: string
  description: string
  body: string
  sessionKey: string
  chatId: string
  chatType: 'group' | 'p2p'
  proposerOpenId: string | null
  status: ProposalStatus
  cardMessageId: string | null
  decidedBy: string | null
  installedPath: string | null
  createdAt: number
  decidedAt: number | null
  spaceId: string | null
  contentDigest: string | null
  originRunId: string | null
  originTaskId: number | null
  expectedBindingRevision: number | null
  decidedByOpenId: string | null
}

export interface SkillProposalInput {
  name: string; description: string; body: string
  sessionKey: string; chatId: string; chatType: 'group' | 'p2p'; proposerOpenId?: string
  spaceId: string; originRunId: string; originTaskId?: number
}

export interface SpaceSkillBinding {
  spaceId: string; name: string; proposalId: number; revision: number; enabled: boolean
  lastDisabledRevision: number; updatedByOpenId: string; updatedAt: number
}

export interface PinnedSkill {
  name: string; description: string; proposalId: number; contentDigest: string; bindingRevision: number
}

export interface RunSkillSet {
  runId: string; spaceId: string; builtinDigest: string; digest: string; skills: PinnedSkill[]
  /** Versions returned by the host, not claims that a model followed their instructions. */
  served: { proposalId: number; contentDigest: string }[]
}

export class SkillStateError extends Error {
  constructor(readonly code: 'needs_reconfirmation' | 'binding_conflict' | 'unavailable' | 'run_mismatch' | 'content_changed', message: string) {
    super(message)
    this.name = 'SkillStateError'
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS skill_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  body TEXT NOT NULL,
  session_key TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  chat_type TEXT NOT NULL,
  proposer_open_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  card_message_id TEXT,
  decided_by TEXT,
  installed_path TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_skill_proposals_status ON skill_proposals(status, created_at);
`

// Match DSH's discoverable skill-name grammar, retaining Friday's 2–49 character limit.
export const SKILL_NAME_RE = /^(?=.{2,49}$)[a-z0-9]+(?:-[a-z0-9]+)*$/

export function renderSkillMd(p: { name: string; description: string; body: string }): string {
  const desc = p.description.replace(/\s+/g, ' ').trim()
  // JSON strings are YAML string scalars too; ':' / '#' / 'true' must not change metadata types.
  return `---\nname: ${JSON.stringify(p.name)}\ndescription: ${JSON.stringify(desc)}\n---\n\n${p.body.trim()}\n`
}

/** 完整可安装正文按 Unicode 字符切分；只加段落标头，不改写或省略正文。 */
export function skillReviewParts(proposal: SkillProposal): { key: string; text: string }[] {
  if (!proposal.contentDigest || contentDigest(proposal) !== proposal.contentDigest) {
    throw new SkillStateError('content_changed', '技能提议内容已变化，请重新提议')
  }
  const chars = Array.from(renderSkillMd(proposal))
  const count = Math.ceil(chars.length / 2500)
  return Array.from({ length: count }, (_, index) => ({
    key: `skill-proposal:${proposal.id}:content:${proposal.contentDigest}:${index + 1}`,
    text: `技能「${proposal.name}」完整正文 ${index + 1}/${count} · 版本 ${proposal.contentDigest!.slice(0, 12)}\n\n`
      + chars.slice(index * 2500, (index + 1) * 2500).join(''),
  }))
}

export class SkillProposals {
  constructor(
    private readonly db: DatabaseSync,
    /** 仓库自带、不可被提议覆盖的 skill 名 */
    private readonly reserved: Set<string> = new Set(),
    private readonly now: () => number = () => Date.now(),
  ) {
    this.transaction(() => {
      db.exec(SCHEMA)
      const columns = new Set((db.prepare('PRAGMA table_info(skill_proposals)').all() as { name: string }[]).map(row => row.name))
      for (const [name, type] of [
        ['space_id', 'TEXT'], ['content_digest', 'TEXT'], ['origin_run_id', 'TEXT'], ['origin_task_id', 'INTEGER'],
        ['expected_binding_revision', 'INTEGER'], ['decided_by_open_id', 'TEXT'],
      ]) if (!columns.has(name!)) db.exec(`ALTER TABLE skill_proposals ADD COLUMN ${name} ${type}`)
      // Old accepted records stay historical; no inferred Space or automatic binding.
      db.exec(`CREATE TABLE IF NOT EXISTS space_skill_bindings (
        space_id TEXT NOT NULL, name TEXT NOT NULL, proposal_id INTEGER NOT NULL REFERENCES skill_proposals(id),
        revision INTEGER NOT NULL CHECK(revision > 0), enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
        last_disabled_revision INTEGER NOT NULL DEFAULT 0,
        updated_by_open_id TEXT NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(space_id,name)
      );
      CREATE TABLE IF NOT EXISTS run_skill_sets (
        run_id TEXT PRIMARY KEY, space_id TEXT NOT NULL, builtin_bundle_digest TEXT NOT NULL,
        digest TEXT NOT NULL, bindings_json TEXT NOT NULL, served_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS idx_run_skill_space ON run_skill_sets(space_id);
      CREATE INDEX IF NOT EXISTS idx_skill_proposals_origin ON skill_proposals(origin_run_id,name,content_digest);`)
    })
  }

  validate(input: { name: string; description: string; body: string }): string | undefined {
    if (!SKILL_NAME_RE.test(input.name)) return 'skill 名只能是小写字母、数字、连字符，2–49 个字符，例如 feishu-group-history-dig'
    if (this.reserved.has(input.name)) return `${input.name} 是内置 skill，不能覆盖`
    if (!input.description.trim() || input.description.length > 500) return 'description 要有内容且不超过 500 字'
    if (input.body.trim().length < 80 || input.body.length > 20_000) return 'SKILL.md 正文要在 80 到 20000 字之间'
    return undefined
  }

  propose(input: SkillProposalInput): SkillProposal {
    const problem = this.validate(input)
    if (problem) throw new Error(problem)
    if (!input.spaceId?.trim() || !input.originRunId?.trim()) throw new Error('技能提议缺少宿主空间或运行来源')
    if (input.originTaskId !== undefined && (!Number.isSafeInteger(input.originTaskId) || input.originTaskId < 1)) throw new Error('技能提议任务来源无效')
    return this.transaction(() => {
      const digest = contentDigest(input)
      const row = this.db.prepare('SELECT id FROM skill_proposals WHERE origin_run_id=? AND name=? AND content_digest=? ORDER BY id LIMIT 1')
        .get(input.originRunId, input.name, digest)
      if (row) {
        const existing = this.get(Number(row.id))!
        if (existing.spaceId !== input.spaceId || existing.sessionKey !== input.sessionKey || existing.chatId !== input.chatId ||
          existing.chatType !== input.chatType || existing.proposerOpenId !== (input.proposerOpenId ?? null) || existing.originTaskId !== (input.originTaskId ?? null)) {
          throw new SkillStateError('run_mismatch', '同一运行的技能提议来源不能改变')
        }
        if (contentDigest(existing) !== digest) throw new SkillStateError('content_changed', '技能提议内容已变化，请核对原记录')
        return existing
      }
      const expected = this.getBinding(input.spaceId, input.name)?.revision ?? 0
      const res = this.db.prepare(`INSERT INTO skill_proposals
        (name,description,body,session_key,chat_id,chat_type,proposer_open_id,status,created_at,
         space_id,content_digest,origin_run_id,origin_task_id,expected_binding_revision)
        VALUES (?,?,?,?,?,?,?,'pending',?,?,?,?,?,?)`)
        .run(input.name, input.description.trim(), input.body.trim(), input.sessionKey, input.chatId, input.chatType,
          input.proposerOpenId ?? null, this.now(), input.spaceId, digest, input.originRunId, input.originTaskId ?? null, expected)
      return this.get(Number(res.lastInsertRowid))!
    })
  }

  get(id: number): SkillProposal | undefined {
    const r = this.db.prepare('SELECT * FROM skill_proposals WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return r ? toProposal(r) : undefined
  }

  setCard(id: number, cardMessageId: string): void {
    this.db.prepare('UPDATE skill_proposals SET card_message_id = ? WHERE id = ?').run(cardMessageId, id)
  }

  /** The proposal captured the binding revision when proposed; a late card cannot overwrite a newer choice. */
  accept(id: number, decidedBy: string, decidedByOpenId: string): SkillProposal | undefined {
    requireActor(decidedByOpenId)
    return this.transaction(() => {
      const p = this.get(id)
      if (!p || p.status === 'ignored') return undefined
      if (!p.spaceId || !p.originRunId || p.expectedBindingRevision === null || !p.contentDigest) {
        throw new SkillStateError('needs_reconfirmation', '这条旧技能提议尚未绑定空间，请在当前空间重新核对后提议')
      }
      // A repeated acceptance is a historical receipt, never a second binding update.
      if (p.status === 'accepted') return p
      const problem = this.validate(p)
      if (problem) throw new Error(problem)
      if (contentDigest(p) !== p.contentDigest) throw new SkillStateError('content_changed', '技能提议内容已变化，请重新提议')
      const binding = this.getBinding(p.spaceId, p.name)
      if ((binding?.revision ?? 0) !== p.expectedBindingRevision) throw new SkillStateError('binding_conflict', '这个空间的同名技能已更新，请核对当前版本后重新提议')
      const now = this.now()
      this.db.prepare(`INSERT INTO space_skill_bindings
        (space_id,name,proposal_id,revision,enabled,last_disabled_revision,updated_by_open_id,updated_at)
        VALUES (?,?,?,?,1,0,?,?) ON CONFLICT(space_id,name) DO UPDATE SET
        proposal_id=excluded.proposal_id,revision=excluded.revision,enabled=1,
        updated_by_open_id=excluded.updated_by_open_id,updated_at=excluded.updated_at`)
        .run(p.spaceId, p.name, p.id, p.expectedBindingRevision + 1, decidedByOpenId, now)
      this.db.prepare(`UPDATE skill_proposals SET status='accepted',decided_by=?,decided_by_open_id=?,decided_at=? WHERE id=? AND status='pending'`)
        .run(decidedBy, decidedByOpenId, now, id)
      return this.get(id)
    })
  }

  ignore(id: number, decidedBy: string, decidedByOpenId: string): SkillProposal | undefined {
    requireActor(decidedByOpenId)
    const p = this.get(id)
    if (!p || p.status !== 'pending') return undefined
    this.db.prepare(`UPDATE skill_proposals SET status = 'ignored', decided_by = ?, decided_by_open_id = ?, decided_at = ? WHERE id = ?`).run(decidedBy, decidedByOpenId, this.now(), id)
    return this.get(id)
  }

  getBinding(spaceId: string, name: string): SpaceSkillBinding | undefined {
    const row = this.db.prepare(`SELECT space_id AS spaceId,name,proposal_id AS proposalId,revision,enabled,
      last_disabled_revision AS lastDisabledRevision,updated_by_open_id AS updatedByOpenId,updated_at AS updatedAt
      FROM space_skill_bindings WHERE space_id=? AND name=?`).get(spaceId, name)
    return row ? { ...(row as unknown as SpaceSkillBinding), enabled: Boolean(row.enabled) } : undefined
  }

  isInstalled(spaceId: string, name: string): boolean {
    return this.getBinding(spaceId, name)?.enabled ?? false
  }

  listInstalled(spaceId: string): string[] {
    return (this.db.prepare('SELECT name FROM space_skill_bindings WHERE space_id=? AND enabled=1 ORDER BY name').all(spaceId) as { name: string }[]).map(row => row.name)
  }

  disable(spaceId: string, name: string, expectedRevision: number, actorOpenId: string): { binding: SpaceSkillBinding; changed: boolean; runIds: string[] } {
    requireActor(actorOpenId)
    return this.transaction(() => {
      const binding = this.getBinding(spaceId, name)
      if (!binding) throw new SkillStateError('unavailable', '该空间没有这项技能')
      if (binding.revision !== expectedRevision) throw new SkillStateError('binding_conflict', '技能版本已更新，请核对后再停用')
      const changed = binding.enabled
      if (changed) this.db.prepare(`UPDATE space_skill_bindings SET enabled=0,revision=revision+1,
        last_disabled_revision=revision+1,updated_by_open_id=?,updated_at=? WHERE space_id=? AND name=?`)
        .run(actorOpenId, this.now(), spaceId, name)
      const runIds = (this.db.prepare(`SELECT run_id FROM run_skill_sets
        WHERE space_id=? AND EXISTS (SELECT 1 FROM json_each(bindings_json) WHERE json_extract(value,'$.name')=?) ORDER BY run_id`)
        .all(spaceId, name) as { run_id: string }[]).map(row => row.run_id)
      return { binding: this.getBinding(spaceId, name)!, changed, runIds }
    })
  }

  pinForRun(input: { runId: string; spaceId: string; builtinDigest: string }): RunSkillSet {
    if (!input.runId?.trim() || !input.spaceId?.trim() || !input.builtinDigest?.trim()) throw new Error('技能运行绑定不完整')
    return this.transaction(() => {
      const existing = this.getRunSkillSet(input.runId)
      if (existing) {
        if (existing.spaceId !== input.spaceId || existing.builtinDigest !== input.builtinDigest) throw new SkillStateError('run_mismatch', '不能改变已开始运行的技能空间或内置版本')
        return existing
      }
      const skills = this.listInstalled(input.spaceId).map(name => {
        if (this.reserved.has(name)) throw new SkillStateError('unavailable', '自定义技能与当前内置技能重名，请先核对并停用自定义版本')
        const binding = this.getBinding(input.spaceId, name)!
        const proposal = this.get(binding.proposalId)
        if (!proposal || proposal.spaceId !== input.spaceId || proposal.status !== 'accepted' || !proposal.contentDigest || contentDigest(proposal) !== proposal.contentDigest) {
          throw new SkillStateError('content_changed', '当前技能绑定内容不一致，请核对提议版本')
        }
        return { name, description: proposal.description, proposalId: proposal.id, contentDigest: proposal.contentDigest, bindingRevision: binding.revision }
      })
      const digest = hash(JSON.stringify({ spaceId: input.spaceId, builtinDigest: input.builtinDigest, skills }))
      this.db.prepare(`INSERT INTO run_skill_sets(run_id,space_id,builtin_bundle_digest,digest,bindings_json) VALUES(?,?,?,?,?)`)
        .run(input.runId, input.spaceId, input.builtinDigest, digest, JSON.stringify(skills))
      return this.getRunSkillSet(input.runId)!
    })
  }

  getRunSkillSet(runId: string): RunSkillSet | undefined {
    const row = this.db.prepare('SELECT * FROM run_skill_sets WHERE run_id=?').get(runId)
    return row ? { runId: String(row.run_id), spaceId: String(row.space_id), builtinDigest: String(row.builtin_bundle_digest),
      digest: String(row.digest), skills: JSON.parse(String(row.bindings_json)) as PinnedSkill[],
      served: JSON.parse(String(row.served_json)) as RunSkillSet['served'] } : undefined
  }

  listForRun(spaceId: string, runId: string): PinnedSkill[] {
    const set = this.requireRunSet(spaceId, runId)
    return set.skills.filter(skill => this.available(spaceId, skill))
  }

  /** Updates preserve an existing pin; an explicit disable invalidates the entire old run. */
  isRunEligible(runId: string): boolean {
    const set = this.getRunSkillSet(runId)
    return Boolean(set && set.skills.every(skill => this.available(set.spaceId, skill)))
  }

  loadForRun(spaceId: string, runId: string, name: string, proposalId: number): PinnedSkill & { content: string } {
    return this.transaction(() => {
      const set = this.requireRunSet(spaceId, runId)
      const skill = set.skills.find(item => item.name === name && item.proposalId === proposalId)
      if (!skill || !this.available(spaceId, skill)) throw new SkillStateError('unavailable', '该技能版本未绑定本轮运行或已经停用')
      const p = this.get(proposalId)
      if (!p || p.spaceId !== spaceId || p.name !== name || p.status !== 'accepted' || p.contentDigest !== skill.contentDigest || contentDigest(p) !== skill.contentDigest) {
        throw new SkillStateError('content_changed', '技能版本内容已改变，不能继续读取')
      }
      if (!set.served.some(item => item.proposalId === proposalId && item.contentDigest === skill.contentDigest)) {
        set.served.push({ proposalId, contentDigest: skill.contentDigest })
        this.db.prepare('UPDATE run_skill_sets SET served_json=? WHERE run_id=?').run(JSON.stringify(set.served), runId)
      }
      return { ...skill, content: renderSkillMd(p) }
    })
  }

  private requireRunSet(spaceId: string, runId: string): RunSkillSet {
    const set = this.getRunSkillSet(runId)
    if (!set || set.spaceId !== spaceId) throw new SkillStateError('run_mismatch', '该运行没有本空间的技能绑定')
    return set
  }

  private available(spaceId: string, skill: PinnedSkill): boolean {
    const binding = this.getBinding(spaceId, skill.name)
    // An update does not affect an old pin; any intervening disable permanently invalidates it.
    return Boolean(binding?.enabled && binding.lastDisabledRevision < skill.bindingRevision)
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('SAVEPOINT skill_write')
    try {
      const result = fn()
      this.db.exec('RELEASE SAVEPOINT skill_write')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK TO SAVEPOINT skill_write')
      this.db.exec('RELEASE SAVEPOINT skill_write')
      throw error
    }
  }
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }
function contentDigest(value: { name: string; description: string; body: string }): string { return hash(renderSkillMd(value)) }
function requireActor(openId: string): void { if (!openId?.trim()) throw new Error('技能决定缺少真实操作者') }

function toProposal(r: Record<string, unknown>): SkillProposal {
  return {
    id: Number(r.id),
    name: String(r.name),
    description: String(r.description),
    body: String(r.body),
    sessionKey: String(r.session_key),
    chatId: String(r.chat_id),
    chatType: r.chat_type === 'p2p' ? 'p2p' : 'group',
    proposerOpenId: (r.proposer_open_id as string | null) ?? null,
    status: (r.status as ProposalStatus) ?? 'pending',
    cardMessageId: (r.card_message_id as string | null) ?? null,
    decidedBy: (r.decided_by as string | null) ?? null,
    installedPath: (r.installed_path as string | null) ?? null,
    createdAt: Number(r.created_at),
    decidedAt: r.decided_at === null || r.decided_at === undefined ? null : Number(r.decided_at),
    spaceId: (r.space_id as string | null) ?? null,
    contentDigest: (r.content_digest as string | null) ?? null,
    originRunId: (r.origin_run_id as string | null) ?? null,
    originTaskId: r.origin_task_id == null ? null : Number(r.origin_task_id),
    expectedBindingRevision: r.expected_binding_revision == null ? null : Number(r.expected_binding_revision),
    decidedByOpenId: (r.decided_by_open_id as string | null) ?? null,
  }
}
