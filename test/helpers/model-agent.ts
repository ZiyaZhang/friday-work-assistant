import { agent, methods, PROTOCOL_VERSION, RequestError, type SessionConfigOption } from '@agentclientprotocol/sdk'

export const choiceA = '["provider","a"]', choiceB = '["provider","b"]'
export const options = (value: string): SessionConfigOption[] => [{ id: 'model', name: 'Model', type: 'select', currentValue: value,
  options: [{ value: choiceA, name: 'Model A' }, { value: choiceB, name: 'Model B' },
    { value: '["unapproved-provider","a"]', name: 'Not authorized' }] }]
export function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
/** All selection and prompt facts cross a real ACP SDK connection; no actual provider or platform. */
export function modelAgent() {
  let serial = 0
  const sessions = new Map<string, { value: string; cwd: string }>()
  const state = {
    initialValue: choiceA,
    sessions, newCalls: [] as Array<{ cwd: string; mcpServers: unknown[] }>,
    setCalls: [] as Array<{ sessionId: string; value: string | boolean }>,
    prompts: [] as Array<{ sessionId: string; value: string; text: string }>,
    rejectSet: false, wrongReadback: false, omitCatalog: false,
    onSet: undefined as (() => Promise<void>) | undefined,
    onPrompt: undefined as (() => Promise<void>) | undefined,
  }
  const app = agent({ name: 'synthetic-model-peer' })
    .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} }))
    .onRequest(methods.agent.session.new, ({ params }) => {
      const sessionId = `model-session-${++serial}`
      sessions.set(sessionId, { value: state.initialValue, cwd: params.cwd }); state.newCalls.push(params)
      return { sessionId, configOptions: state.omitCatalog ? undefined : options(state.initialValue) }
    })
    .onRequest(methods.agent.session.resume, ({ params }) => {
      if (!sessions.has(params.sessionId)) throw RequestError.resourceNotFound(params.sessionId)
      return { configOptions: state.omitCatalog ? undefined : options(sessions.get(params.sessionId)!.value) }
    })
    .onRequest(methods.agent.session.close, () => ({}))
    .onRequest(methods.agent.session.setConfigOption, async ({ params }) => {
      state.setCalls.push(params); await state.onSet?.()
      if (state.rejectSet) throw RequestError.invalidParams({}, 'synthetic unavailable')
      const session = sessions.get(params.sessionId)!
      if (!state.wrongReadback) session.value = String(params.value)
      return { configOptions: options(session.value) }
    })
    .onNotification(methods.agent.session.cancel, () => {})
    .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
      state.prompts.push({ sessionId: params.sessionId, value: sessions.get(params.sessionId)!.value,
        text: params.prompt.map(p => p.type === 'text' ? p.text : '').join('') })
      await state.onPrompt?.()
      await client.notify(methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: 'usage_update', used: 31, size: 1000 } })
      await client.notify(methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '已检查，结果正常。' } } })
      return { stopReason: 'end_turn' }
    })
  return { app, state }
}
