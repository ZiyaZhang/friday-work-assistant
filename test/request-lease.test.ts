import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { assertRequestCurrent, currentRequestSignal, RequestEndedError, withRequestLease, withoutRequestLease } from '../src/core/request-lease.js'
import { RunApiCalls } from '../src/core/run-api-calls.js'

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

describe('request lifetime across host delegates', () => {
  it('keeps simultaneous callers separate even when they belong to the same Run', async () => {
    const first = new AbortController(), second = new AbortController(), released = deferred()
    const failed = withRequestLease(first.signal, async () => { await released.promise; assertRequestCurrent() })
    const succeeded = withRequestLease(second.signal, async () => { await released.promise; assertRequestCurrent(); return currentRequestSignal() })
    first.abort(); released.resolve()
    await expect(failed).rejects.toBeInstanceOf(RequestEndedError)
    expect(await succeeded).toBe(second.signal)
    expect(currentRequestSignal()).toBeUndefined()
    expect(() => assertRequestCurrent()).not.toThrow()
  })

  it('keeps deferred effects owned by their request, but an explicitly detached durable dispatch can finish', async () => {
    const controller = new AbortController(), released = deferred()
    const delayed = withRequestLease(controller.signal, async () => { await released.promise; assertRequestCurrent() })
    const durable = withRequestLease(controller.signal, () => withoutRequestLease(async () => {
      await released.promise; assertRequestCurrent(); return 'durable dispatch finished'
    }))
    controller.abort(); released.resolve()
    await expect(delayed).rejects.toBeInstanceOf(RequestEndedError)
    expect(await durable).toBe('durable dispatch finished')
  })

  it('retains a real effect ACK after cancellation without permitting the next effect', async () => {
    const db = new DatabaseSync(':memory:'), calls = new RunApiCalls(db), controller = new AbortController()
    const entered = deferred(), released = deferred()
    let started = 0
    try {
      const result = withRequestLease(controller.signal, async () => {
        const ack = await calls.capture('same-run', 'HOST /documents/create', ['doc:write'], async () => {
          started++; entered.resolve(); await released.promise; return { documentId: 'actual-ack' }
        })
        expect(ack).toEqual({ documentId: 'actual-ack' })
        await calls.capture('same-run', 'HOST /documents/grant', ['doc:write'], () => { started++ })
      })
      await entered.promise
      expect(calls.forRun('same-run')).toMatchObject([{ state: 'started' }])
      controller.abort(); released.resolve()
      await expect(result).rejects.toBeInstanceOf(RequestEndedError)
      expect(started).toBe(1)
      expect(calls.forRun('same-run')).toMatchObject([{ route: 'HOST /documents/create', state: 'returned' }])
      const fresh = new AbortController()
      await withRequestLease(fresh.signal, () => calls.capture('same-run', 'HOST /documents/create', ['doc:write'], () => { started++ }))
      expect(started).toBe(2)
      expect(calls.forRun('same-run')).toHaveLength(2)
    } finally { released.resolve(); db.close() }
  })

  it('keeps a provider rejection unresolved after cancellation instead of erasing started evidence', async () => {
    const db = new DatabaseSync(':memory:'), calls = new RunApiCalls(db), controller = new AbortController(), released = deferred()
    const providerError = new Error('synthetic provider outcome unresolved')
    try {
      const result = withRequestLease(controller.signal, () => calls.capture('run', 'HOST /documents/create', ['doc:write'], async () => {
        await released.promise; throw providerError
      }))
      controller.abort(); released.resolve()
      await expect(result).rejects.toBe(providerError)
      expect(calls.forRun('run')).toMatchObject([{ state: 'failed' }])
    } finally { released.resolve(); db.close() }
  })
})
