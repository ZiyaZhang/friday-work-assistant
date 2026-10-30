import axios from 'axios'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { z } from 'zod'
import { DeviceError, type DeviceActor, type PersonalDevices } from './devices.js'

export function createDesktopRelayFetch(proxyUrl?: string): typeof fetch {
  const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl, { keepAlive: true }) : undefined
  return (async (input, init) => {
    try {
      const result = await axios.request({ url: String(input), method: init?.method ?? 'POST', data: init?.body,
        headers: Object.fromEntries(new Headers(init?.headers)), httpsAgent: agent, httpAgent: agent, proxy: false,
        timeout: 10_000, maxRedirects: 0, maxContentLength: 2_500_000, maxBodyLength: 650_000,
        responseType: 'text', validateStatus: () => true, signal: init?.signal ?? undefined })
      return new Response(result.data, { status: result.status })
    } catch { throw new Error('Desktop relay unavailable') }
  }) as typeof fetch
}
const pairPage = z.object({ pairs: z.array(z.object({ state: z.string().max(100), requestHash: z.string().length(64), label: z.string().max(80), publicKey: z.string().length(392) })).max(100) })
const requestPage = z.object({ requests: z.array(z.object({ deviceId: z.uuid(), requestId: z.uuid(), ticket: z.string().max(120), payload: z.string().max(90_000) })).max(20) })
type RelayRequest = z.infer<typeof requestPage>['requests'][number]
const MAX_IN_FLIGHT = 4

/** The public relay never authorizes a user. Every body is authenticated/decrypted and every operation is owner-bound here. */
export class PersonalDesktopBridge {
  private ticking?: Promise<void>
  private closed = false
  private stopped = new AbortController()
  private inFlight = new Map<string, Promise<void>>()
  private announcedPairs = new Map<string, string>()
  constructor(private readonly d: { devices: PersonalDevices; baseUrl: string; token: string; fetch: typeof fetch;
    enabled(): boolean; changed(owner: string): Promise<void>;
    prepare?(owner: string, request: unknown, assertCurrent: () => void): Promise<((actor?: DeviceActor) => unknown) | undefined>;
    execute(actor: DeviceActor, request: unknown, requestId: string): unknown;
    afterCommit(): void; afterRollback(): void; warn(message: string): void }) {}
  private async post(path: string, body: unknown): Promise<unknown> {
    const result = await this.d.fetch(`${this.d.baseUrl}/desktop/relay/${path}`, { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.d.token}` }, body: JSON.stringify(body),
      signal: AbortSignal.any([this.stopped.signal, AbortSignal.timeout(10_000)]) })
    if (!result.ok) throw new Error('Desktop relay unavailable')
    return result.json()
  }
  tick(): Promise<void> {
    if (!this.ticking) this.ticking = this.poll().finally(() => { this.ticking = undefined })
    return this.ticking
  }
  private active() { return !this.closed && this.d.enabled() }
  private async poll() {
    if (!this.active()) return
    try {
      const pending = this.d.devices.pending()
      const live = new Set(pending.map(pair => pair.state))
      for (const state of this.announcedPairs.keys()) if (!live.has(state)) this.announcedPairs.delete(state)
      for (let start = 0; start < pending.length && this.active(); start += 100) {
        const batch = pending.slice(start, start + 100), states = new Set(batch.map(p => p.state))
        const page = pairPage.parse(await this.post('pairs', { states: [...states] }))
        if (!this.active()) return
        for (const input of page.pairs) {
          if (!states.has(input.state)) continue
          try {
            const pair = this.d.devices.request(input.state, input)
            if (pair.requestHash !== input.requestHash) continue
            if (pair.status === 'approved' && pair.result || pair.status === 'rejected') {
              await this.post('pair-result', { state: pair.state, requestHash: pair.requestHash,
                result: pair.status === 'approved' ? { state: 'approved', ...pair.result } : { state: 'rejected' } })
            }
            // Delivery can fail after the request was persisted. Retry the same
            // card update until it succeeds, including after a host restart.
            if (this.announcedPairs.get(pair.state) !== pair.status) {
              await this.d.changed(pair.owner)
              this.announcedPairs.set(pair.state, pair.status)
            }
          } catch { this.d.warn('Desktop pairing update deferred') }
        }
      }
      if (!this.active() || !this.d.devices.hasConnections()) return
      const page = requestPage.parse(await this.post('requests', {}))
      for (const request of page.requests) {
        if (!this.active()) return
        const key = `${request.deviceId}:${request.requestId}`
        if (this.inFlight.has(key)) continue
        // Leave excess work in the relay's durable queue. Neither a slow read
        // nor its response upload owns the next poll or starts duplicate reads.
        if (this.inFlight.size >= MAX_IN_FLIGHT) break
        const work = this.process(request).catch(() => {
          if (this.active()) this.d.warn('Desktop relay request deferred')
        }).finally(() => { this.inFlight.delete(key) })
        this.inFlight.set(key, work)
      }
    } catch { if (this.active()) this.d.warn('Desktop relay poll deferred') }
  }
  private async process(request: RelayRequest) {
    let result: { payload: string } | { error: string }
    try {
      // deviceId is an index for relay delivery, never the authorization actor.
      if (request.ticket.split('.')[1] !== request.deviceId) throw new DeviceError('denied', 'Device identity mismatch')
      const admitted = this.d.devices.prepare(request.ticket, request.requestId, request.payload)
      const current = () => {
        if (!this.active()) throw new DeviceError('unavailable', 'Desktop bridge inactive')
        admitted.assertCurrent()
      }
      const prepared = await this.d.prepare?.(admitted.owner, admitted.request, current)
      current()
      // No await between the device transaction and its effect boundary: async
      // preparations may overlap, but SQLite commits and rollback remain atomic.
      result = { payload: this.d.devices.execute(request.ticket, request.requestId, request.payload,
        (actor, value) => prepared ? prepared(actor) : this.d.execute(actor, value, request.requestId)) }
      this.d.afterCommit()
    } catch (error) { this.d.afterRollback(); result = { error: error instanceof DeviceError ? error.code : 'unavailable' } }
    if (!this.active()) return
    await this.post('result', { deviceId: request.deviceId, requestId: request.requestId, result })
  }
  /** Stop admission synchronously; the host must await this before closing SQLite. */
  async close(): Promise<void> {
    this.closed = true
    this.stopped.abort()
    await Promise.allSettled([this.ticking, ...this.inFlight.values()])
  }
}
