import { z } from 'zod'
import type { Capability } from './tokens.js'
import { WorkAssessmentError } from '../core/work-assessment.js'
import type { IssueAssessmentActor, IssueAssessmentRuntime } from '../core/issue-assessment-runtime.js'

const schemas = {
  assess: z.object({ number: z.number().int().positive() }).strict(),
  get: z.object({ assessmentId: z.string().min(1).max(500) }).strict(),
  execute: z.object({ assessmentId: z.string().min(1).max(500) }).strict(),
}
export type IssueAssessmentOperation = keyof typeof schemas
/** Read-only assembly (P3-3a) registers only these. `execute` is opted in by the root once the
 * confirmation entry and the `issue_assessment` execution branch exist (P3-3b). */
export const READ_ONLY_ISSUE_ASSESSMENT_OPERATIONS: readonly IssueAssessmentOperation[] = ['assess', 'get']
/** All routes remain bound to a current real request. The execute endpoint schedules
 * an already-authorized input; it does not grant repository write scope. */
export function createIssueAssessmentRoutes<C extends Capability>(deps: {
  runtime?: IssueAssessmentRuntime
  requireActor(cap: C, operation: IssueAssessmentOperation): IssueAssessmentActor
  assertCurrent(cap: C): void
  error(status: number, message: string): Error
  /** Which of the three operations to expose; defaults to the read-only pair. */
  operations?: readonly IssueAssessmentOperation[]
}): Record<string, (cap: C, body: Record<string, unknown>) => Promise<unknown>> {
  const operations = [...new Set(deps.operations ?? READ_ONLY_ISSUE_ASSESSMENT_OPERATIONS)].filter(operation => operation in schemas)
  return Object.fromEntries(operations.map(operation => [`POST /v1/github/assessment/${operation}`,
    async (cap: C, body: Record<string, unknown>) => {
      const actor = deps.requireActor(cap, operation)
      if (!deps.runtime) throw deps.error(503, '本次执行尚未接入只读接单评估。')
      const parsed = schemas[operation].safeParse(body)
      if (!parsed.success) throw deps.error(400, '接单评估参数无效；身份、仓库和授权由当前真实工作确定。')
      try {
        const result = operation === 'assess' ? await deps.runtime.assess(actor, schemas.assess.parse(parsed.data).number)
          : operation === 'get' ? await deps.runtime.get(actor, schemas.get.parse(parsed.data).assessmentId)
            : await deps.runtime.execute(actor, schemas.execute.parse(parsed.data).assessmentId)
        deps.assertCurrent(cap)
        return result
      } catch (error) {
        if (!(error instanceof WorkAssessmentError)) throw error
        throw deps.error(error.code === 'not_authorized' ? 403 : 409, error.message)
      }
    }]))
}
