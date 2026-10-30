import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/** Structural inventory guard, not a substitute for HTTP authorization tests.
 * Discover route and helper bodies from the AST, rather than keeping a list of
 * routes that a newly added unguarded endpoint can quietly escape.
 */
function audit(source: string): string[] {
  const file = ts.createSourceFile('api.ts', source, ts.ScriptTarget.Latest, true)
  const functions = new Map<string, ts.Node[]>()
  const handlers: { name: string; body: ts.Node }[] = []
  const remember = (name: string, node: ts.Node) => functions.set(name, [...functions.get(name) ?? [], node])
  const inventory = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) remember(node.name.text, node.body)
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) remember(node.name.text, node.initializer.body)
    if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name) && /^(?:POST|GET) \/v1\//.test(node.name.text)) {
      handlers.push({ name: node.name.text, body: ts.isArrowFunction(node.initializer) ? node.initializer.body : node.initializer })
    }
    ts.forEachChild(node, inventory)
  }
  inventory(file)

  const memo = new WeakMap<ts.Node, Map<string, boolean>>()
  function reaches(node: ts.Node, gate: string): boolean {
    const cached = memo.get(node)?.get(gate)
    if (cached !== undefined) return cached
    const queue = [node], visited = new Set<ts.Node>()
    let found = false
    while (queue.length && !found) {
      const current = queue.pop()!
      if (visited.has(current)) continue
      visited.add(current)
      if (ts.isCallExpression(current) && ts.isIdentifier(current.expression) && current.expression.text === gate) { found = true; break }
      if (ts.isIdentifier(current)) queue.push(...functions.get(current.text) ?? [])
      ts.forEachChild(current, child => { queue.push(child) })
    }
    const result = memo.get(node) ?? new Map<string, boolean>()
    result.set(gate, found); memo.set(node, result)
    return found
  }

  const violations: string[] = []
  for (const handler of handlers) {
    if (!reaches(handler.body, 'need')) violations.push(`${handler.name}: no capability gate`)
    // Dispatch-by-argument is a separate endpoint per branch, not a reason to
    // count the scope check in another branch as authorization for this one.
    const branches = (node: ts.Node): void => {
      if (ts.isSwitchStatement(node)) for (const clause of node.caseBlock.clauses) {
        if (ts.isCaseClause(clause) && clause.statements.length && !reaches(clause, 'need')) {
          violations.push(`${handler.name} case ${clause.expression.getText(file)}: no capability gate`)
        }
      }
      ts.forEachChild(node, branches)
    }
    // Only the handler's dispatcher, not switches inside independently gated helpers.
    branches(handler.body)

    // KV and Inbox are generic durable-state sinks: their names do not reveal
    // whether the model is changing a preference, subscription or pending work.
    // Require a derived-write gate in the executed prefix; await invalidates it.
    const examine = (node: ts.Node, authorized: false | 'derived' | 'revoke'): false | 'derived' | 'revoke' => {
      if (ts.isArrowFunction(node) || ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) return authorized
      if (ts.isIfStatement(node)) {
        authorized = examine(node.expression, authorized)
        const yes = examine(node.thenStatement, authorized)
        const no = node.elseStatement ? examine(node.elseStatement, authorized) : authorized
        return yes === no ? yes : false
      }
      if (ts.isAwaitExpression(node)) { examine(node.expression, authorized); return false }
      if (ts.isCallExpression(node)) {
        for (const argument of node.arguments) authorized = examine(argument, authorized)
        if (ts.isIdentifier(node.expression) && reaches(node, 'needDerivedWrite')) authorized = 'derived'
        else if (ts.isIdentifier(node.expression) && node.expression.text === 'needConfigureControl') authorized = 'revoke'
        if (ts.isPropertyAccessExpression(node.expression)) {
          const receiver = node.expression.expression.getText(file), method = node.expression.name.text
          const emptyValue = node.arguments[1]
          const fixedRevocation = receiver === 'registry' && method === 'setKv' && emptyValue && ts.isStringLiteral(emptyValue) && emptyValue.text === ''
          if (((receiver === 'registry' && method === 'setKv') || (receiver === 'inbox' && method === 'add')) &&
            !(authorized === 'derived' || (authorized === 'revoke' && fixedRevocation))) {
            const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
            violations.push(`${handler.name}:${line}: durable state write without current write gate`)
          }
        }
        return authorized
      }
      ts.forEachChild(node, child => { authorized = examine(child, authorized) })
      return authorized
    }
    examine(handler.body, false)
  }
  return violations
}

describe('API capability inventory', () => {
  it('checks every registered API handler and generic durable-state sink', () => {
    expect(audit(readFileSync(new URL('../src/internal/api.ts', import.meta.url), 'utf8'))).toEqual([])
  })

  it('detects a new unguarded endpoint without adding its name to a test list', () => {
    expect(audit(`const routes = { 'POST /v1/new-feature': async (cap, body) => {
      registry.setKv(body.key, body.value); return { saved: true }
    } }`)).toHaveLength(2)
  })

  it.each(['readonly', 'after-await', 'other-branch'])('detects %s durable writes even when another capability gate exists', mode => {
    const body = mode === 'readonly' ? `need(cap, 'github:read'); registry.setKv('a', body.value)`
      : mode === 'after-await' ? `needDerivedWrite(cap, 'profile:write'); await provider.read(); registry.setKv('a', body.value)`
        : `if (body.read) { need(cap, 'github:read'); return {} } else { inbox.add(body) }`
    const problems = audit(`function needDerivedWrite(cap, scope) { need(cap, scope) }
      const routes = { 'POST /v1/new-feature': async (cap, body) => { ${body}; return {} } }`)
    expect(problems.some(problem => problem.includes('durable state write'))).toBe(true)
  })
})
