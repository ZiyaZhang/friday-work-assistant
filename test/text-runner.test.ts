import { describe, expect, it, vi } from 'vitest'
import { TextRunner, TextRunnerError, type TextRunnerRuntime } from '../src/acp/text-runner.js'

type Update = { sessionUpdate: string; content?: { type: string; text: string } }

function runtime(script: (emit: (update: Update) => void, signal?: AbortSignal) => Promise<{ stopReason: string }>) {
  let listener: ((update: Update) => void) | undefined
  const fake = {
    start: vi.fn(async () => undefined),
    newSession: vi.fn(async () => 'session-1'),
    subscribe: vi.fn((_id: string, fn: (update: Update) => void) => { listener = fn; return () => { listener = undefined } }),
    prompt: vi.fn(async (_id: string, _blocks: unknown, options?: { signal?: AbortSignal }) => script(update => listener?.(update), options?.signal)),
    closeSession: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  }
  return fake
}

const text = (value: string): Update => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } })

describe('TextRunner', () => {
  it('returns only the answer text, never thinking, and reuses one runtime until closed', async () => {
    const fake = runtime(async emit => { emit({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } }); emit(text('{"a"')); emit(text(':1}')); return { stopReason: 'end_turn' } })
    const runner = new TextRunner({ createRuntime: () => fake as unknown as TextRunnerRuntime, cwd: '/tmp', timeoutMs: 1000 })
    expect(await runner.run('p1')).toBe('{"a":1}')
    expect(await runner.run('p2')).toBe('{"a":1}')
    expect(fake.start).toHaveBeenCalledTimes(1)
    await runner.close()
    expect(fake.stop).toHaveBeenCalledTimes(1)
  })

  it('refuses an answer that tried to use a tool, ended early or took too long, and starts fresh afterwards', async () => {
    const tool = runtime(async emit => { emit({ sessionUpdate: 'tool_call' }); return { stopReason: 'end_turn' } })
    const runner = new TextRunner({ createRuntime: () => tool as unknown as TextRunnerRuntime, cwd: '/tmp', timeoutMs: 1000 })
    await expect(runner.run('p')).rejects.toMatchObject({ code: 'tool_use' })
    expect(tool.stop).toHaveBeenCalledTimes(1)
    const early = runtime(async emit => { emit(text('部分')); return { stopReason: 'max_tokens' } })
    await expect(new TextRunner({ createRuntime: () => early as unknown as TextRunnerRuntime, cwd: '/tmp', timeoutMs: 1000 }).run('p'))
      .rejects.toMatchObject({ code: 'incomplete' })
    const slow = runtime((_emit, signal) => new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason))))
    await expect(new TextRunner({ createRuntime: () => slow as unknown as TextRunnerRuntime, cwd: '/tmp', timeoutMs: 20 }).run('p'))
      .rejects.toBeInstanceOf(TextRunnerError)
    expect(() => new TextRunner({ createRuntime: () => slow as unknown as TextRunnerRuntime, cwd: 'relative', timeoutMs: 20 })).toThrow(TextRunnerError)
  })
})
