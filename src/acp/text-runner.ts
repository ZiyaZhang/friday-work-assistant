import { isAbsolute } from 'node:path'
import { textBlock, type AcpRuntime } from './runtime.js'

export type TextRunnerRuntime = Pick<AcpRuntime, 'start' | 'newSession' | 'subscribe' | 'prompt' | 'closeSession' | 'stop'>

export class TextRunnerError extends Error {
  constructor(readonly code: 'timeout' | 'tool_use' | 'too_long' | 'incomplete' | 'unavailable') {
    super(code)
    this.name = 'TextRunnerError'
  }
}

/**
 * One prompt in, the model's plain text out, on a dedicated tool-less runtime (the same kind the ingress classifier uses).
 * Any tool call aborts the answer; thinking never counts as output. Calls run one at a time; `close()` stops the runtime.
 * Used for short judgements where the host parses and validates the answer itself.
 */
export class TextRunner {
  private runtime?: TextRunnerRuntime
  private started = false
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: { createRuntime: () => TextRunnerRuntime; cwd: string; timeoutMs: number; maxChars?: number }) {
    if (!isAbsolute(options.cwd) || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) throw new TextRunnerError('unavailable')
  }

  run(prompt: string): Promise<string> {
    const next = this.chain.then(() => this.once(prompt))
    this.chain = next.catch(() => undefined)
    return next
  }

  async close(): Promise<void> {
    const runtime = this.runtime
    this.runtime = undefined; this.started = false
    await runtime?.stop().catch(() => undefined)
  }

  private async once(prompt: string): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new TextRunnerError('timeout')), this.options.timeoutMs)
    timer.unref()
    const runtime = this.runtime ??= this.options.createRuntime()
    let unsubscribe: (() => void) | undefined
    try {
      if (!this.started) { await runtime.start(); this.started = true }
      const sessionId = await runtime.newSession(this.options.cwd, [])
      let output = ''
      unsubscribe = runtime.subscribe(sessionId, update => {
        if (controller.signal.aborted) return
        if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') controller.abort(new TextRunnerError('tool_use'))
        else if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
          output += update.content.text
          if (output.length > (this.options.maxChars ?? 16_000)) controller.abort(new TextRunnerError('too_long'))
        }
      })
      const result = await runtime.prompt(sessionId, [textBlock(prompt)], { signal: controller.signal })
      if (controller.signal.aborted) throw controller.signal.reason
      if (result.stopReason !== 'end_turn') throw new TextRunnerError('incomplete')
      await runtime.closeSession(sessionId).catch(() => undefined)
      return output
    } catch (error) {
      // A failed or aborted answer retires the runtime; the next call starts a fresh one.
      await this.close()
      if (error instanceof TextRunnerError) throw error
      if (controller.signal.reason instanceof TextRunnerError) throw controller.signal.reason
      throw new TextRunnerError('unavailable')
    } finally {
      clearTimeout(timer)
      unsubscribe?.()
    }
  }
}
