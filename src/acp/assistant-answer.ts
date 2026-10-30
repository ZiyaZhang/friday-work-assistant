import type { SessionUpdate } from '@agentclientprotocol/sdk'

interface AnswerState { body: string }
interface MessageBoundary { messageId?: string; retired: Set<string> }
const boundaries = new WeakMap<AnswerState, MessageBoundary>()

/** ACP identifies assistant messages, not final/commentary channels. A tool
 * boundary makes the preceding assistant text a preamble, never a final result.
 * Legacy peers without messageId still have that structural tool boundary. */
export function updateAssistantAnswer(state: AnswerState, update: SessionUpdate, unannouncedTool = false): void {
  let boundary = boundaries.get(state)
  if (!boundary) { boundary = { retired: new Set() }; boundaries.set(state, boundary) }
  const retire = () => {
    if (boundary.messageId) boundary.retired.add(boundary.messageId)
    boundary.messageId = undefined
    state.body = ''
  }
  if (update.sessionUpdate === 'tool_call' || unannouncedTool) { retire(); return }
  if (update.sessionUpdate !== 'agent_message_chunk') return
  const id = update.messageId ?? undefined
  if (id && boundary.retired.has(id)) return
  if (id && id !== boundary.messageId) { retire(); boundary.messageId = id }
  if (update.content.type === 'text') state.body += update.content.text
}
