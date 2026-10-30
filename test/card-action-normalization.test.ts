import { EventDispatcher, LoggerLevel } from '@larksuiteoapi/node-sdk'
import { describe, expect, it } from 'vitest'
import { normalizeCardAction, type CardAction } from '../src/feishu/ws.js'

/** The published card.action.trigger envelope passes through the actual SDK parser. */
async function dispatch(action: Record<string, unknown>): Promise<CardAction> {
  const dispatcher = new EventDispatcher({ verificationToken: 'synthetic-verification', loggerLevel: LoggerLevel.error })
    .register({ 'card.action.trigger': data => normalizeCardAction(data) })
  return await dispatcher.invoke({
    schema: '2.0',
    header: { event_type: 'card.action.trigger', event_id: 'synthetic-event', token: 'synthetic-verification' },
    event: {
      operator: { open_id: 'synthetic-actor' },
      context: { open_message_id: 'synthetic-card', open_chat_id: 'synthetic-chat' },
      action,
    },
  }) as CardAction
}

describe('card action wire normalization', () => {
  it('preserves successive checker states even when the old custom value is unchanged', async () => {
    const value = { action: 'todo', id: 9, op: 'done', ids: [9], page: 0 }
    const check = await dispatch({ tag: 'checker', checked: true, value })
    const uncheck = await dispatch({ tag: 'checker', checked: false, value })
    expect(check).toMatchObject({ tag: 'checker', checked: true, value,
      operatorOpenId: 'synthetic-actor', messageId: 'synthetic-card', chatId: 'synthetic-chat' })
    expect(uncheck).toMatchObject({ tag: 'checker', checked: false, value })
  })

  it('takes actual state from action rather than a forged or stale custom value', async () => {
    const result = await dispatch({ tag: 'checker', checked: false,
      value: { action: 'todo', id: 9, tag: 'button', checked: true } })
    expect(result.tag).toBe('checker')
    expect(result.checked).toBe(false)
  })

  it('does not promote metadata from custom values when platform fields are absent', async () => {
    const result = await dispatch({ value: { action: 'todo', id: 9, tag: 'checker', checked: true } })
    expect(result.tag).toBeUndefined()
    expect(result.checked).toBeUndefined()
  })

  it.each([undefined, null, 0, 1, 'false', 'true'])('does not coerce malformed checked %j into an intended state', async checked => {
    const result = await dispatch({ tag: 'checker', checked, value: { action: 'todo', id: 9 } })
    expect(result.tag).toBe('checker')
    expect(result.checked).toBeUndefined()
  })

  it('preserves legacy button values without inventing a checker state', async () => {
    const value = { action: 'todo', id: 9, op: 'reopen' }
    const result = await dispatch({ tag: 'button', value })
    expect(result).toMatchObject({ tag: 'button', value })
    expect(result.checked).toBeUndefined()
  })
})
