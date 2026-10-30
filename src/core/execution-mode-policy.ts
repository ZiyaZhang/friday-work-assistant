import type { AcpRuntimeMode } from '../acp/runtime-pool.js'

export interface ExecutionModePolicyInput {
  publicMode?: boolean
  defaultMode?: AcpRuntimeMode
  /** Host-only helper runs that must never use native workspace tools, including issue validity review. */
  requireManaged?: boolean
  /** Background work includes reflections, routines, automatic followups and helper runs. */
  unattended: boolean
  requesterOpenId?: string
  /** Current deployment authority, never a historical role or model-supplied flag. */
  isAdmin(openId: string | undefined): boolean
}

/** Admission selects the audited tool/profile surface. This is not an OS isolation boundary. */
export function selectExecutionMode(input: ExecutionModePolicyInput): AcpRuntimeMode {
  if (input.requireManaged) return 'managed'
  if (input.publicMode && (input.unattended || !input.requesterOpenId || !input.isAdmin(input.requesterOpenId))) return 'managed'
  return input.defaultMode ?? 'workspace'
}

export class ExecutionModePolicyError extends Error {
  constructor(readonly code: 'managed_unavailable' | 'mode_changed' | 'source_unverified') {
    super(code === 'managed_unavailable' ? '受控执行尚未配置，本次任务未开始；不会回落到工作区执行。'
      : code === 'mode_changed' ? '本次执行的运行权限已变化，请重新发起任务。'
      : '公开模式下，这批历史资料尚缺完整的来源与受众核验，本次批量操作未执行。')
    this.name = 'ExecutionModePolicyError'
  }
}
