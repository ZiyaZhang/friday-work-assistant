import { JobProtocolError, type JobInput } from './job-protocol.js'

/** One changed file inside the declared capture scope. Digests are SHA-256 of
 * the file bytes; null means absent on that side. mode is the Git file mode. */
export interface OutputArtifactFile {
  path: string
  beforeDigest: string | null
  afterDigest: string | null
  mode: '100644' | '100755'
}
/** Protocol 2: an immutable binary patch from beforeTree to afterTree, stored
 * by the provider and downloaded only through GET /jobs/:id/output. */
export interface OutputArtifact {
  id: string
  digest: string
  bytes: number
  beforeTree: string
  afterTree: string
  files: OutputArtifactFile[]
}
export interface JobResult {
  status: 'passed' | 'failed' | 'source_changed' | 'input_mismatch' | 'setup_failed' | 'output_limit'
  beforeTree: string | null
  afterTree: string | null
  exitCode: number | null
  output: { stdout: string; stderr: string; truncated: boolean }
  runtime: string
  phase: 'prepare' | 'command' | 'verify'
  /** Protocol 2 capture only. The controller moves these to the receipt; they are never stored in result. */
  outputArtifact?: OutputArtifact
  outputError?: string
}
export interface JobReceipt {
  /** 1 for jobs without capture (unchanged protocol 1 shape); 2 for capture jobs. */
  version: 1 | 2
  id: string
  digest: string | null
  state: 'queued' | 'running' | 'stopping' | 'finished'
  outcome: JobResult['status'] | 'cancelled' | 'timed_out' | 'interrupted' | 'executor_unavailable' | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  deadline: number | null
  cleanup: 'not_started' | 'pending' | 'confirmed'
  result: JobResult | null
  /** Version 2 only: present from submission, set together with a command result. */
  outputArtifact?: OutputArtifact | null
  /** Version 2 only: a fixed code when the command changed files but no artifact was produced. */
  outputError?: string | null
}
/** A result without output facts; clears version 2 output fields whenever result is cleared. */
function noOutput(receipt: JobReceipt): Partial<JobReceipt> {
  return receipt.version === 2 ? { outputArtifact: null, outputError: null } : {}
}
export interface JobStore {
  load(): Promise<JobReceipt | undefined>
  input(): Promise<JobInput | undefined>
  /** Receipt and input update are atomic; null discards the body, undefined preserves it. */
  save(receipt: JobReceipt, input?: JobInput | null): Promise<void>
  alarm(at: number | null): Promise<void>
}
export interface JobExecutor {
  run(input: JobInput, checkCurrent: () => void): Promise<JobResult>
  destroy(): Promise<void>
}

/** Claim before execution. A persisted running receipt after an isolate restart
 * is interrupted and cleaned up; it can never execute the command a second time.
 * Destroy confirmation is separate from the command's result. */
export class JobController {
  private receipt: JobReceipt | undefined
  private loaded = false
  private serial: Promise<unknown> = Promise.resolve()
  private active = false
  constructor(private readonly id: string, private readonly store: JobStore,
    private readonly executor: JobExecutor, private readonly now: () => number = Date.now) {}

  private locked<T>(use: () => Promise<T>): Promise<T> {
    const next = this.serial.then(use)
    this.serial = next.catch(() => {})
    return next
  }
  private async load() {
    if (this.loaded) return
    this.receipt = await this.store.load()
    if (this.receipt?.state === 'running') {
      this.receipt = { ...this.receipt, state: 'stopping', outcome: 'interrupted', cleanup: 'pending' }
      await this.store.save(this.receipt)
      await this.store.alarm(this.now() + 1)
    }
    this.loaded = true
  }
  private copy(): JobReceipt | undefined { return this.receipt ? structuredClone(this.receipt) : undefined }

  read(): Promise<JobReceipt | undefined> { return this.locked(async () => { await this.load(); return this.copy() }) }
  submit(input: JobInput, digest: string): Promise<JobReceipt> {
    return this.locked(async () => {
      await this.load()
      if (this.receipt) {
        if (this.receipt.digest === null) throw new JobProtocolError(409, 'job_cancelled_before_submission')
        if (this.receipt.digest !== digest) throw new JobProtocolError(409, 'job_payload_changed')
        if (this.receipt.state === 'queued') await this.store.alarm(this.now() + 1)
        return this.copy()!
      }
      this.receipt = { version: input.capture ? 2 : 1, id: this.id, digest, state: 'queued', outcome: null, createdAt: this.now(),
        startedAt: null, finishedAt: null, deadline: null, cleanup: 'not_started', result: null,
        ...(input.capture ? { outputArtifact: null, outputError: null } : {}) }
      await this.store.save(this.receipt, input)
      await this.store.alarm(this.now() + 1)
      return this.copy()!
    })
  }
  async stop(): Promise<JobReceipt> {
    await this.locked(async () => {
      await this.load()
      if (!this.receipt) {
        // A stop can overtake a timed-out submit. Keep a tombstone for that same id.
        this.receipt = { version: 1, id: this.id, digest: null, state: 'finished', outcome: 'cancelled',
          createdAt: this.now(), startedAt: null, finishedAt: this.now(), deadline: null, cleanup: 'confirmed', result: null }
        await this.store.save(this.receipt, null)
        return
      }
      if (this.receipt.state === 'finished') return
      const neverStarted = this.receipt.state === 'queued'
      this.receipt = { ...this.receipt, state: neverStarted ? 'finished' : 'stopping', outcome: 'cancelled',
        result: null, ...noOutput(this.receipt), cleanup: neverStarted ? 'confirmed' : 'pending', finishedAt: neverStarted ? this.now() : null }
      await this.store.save(this.receipt, neverStarted ? null : undefined)
      await this.store.alarm(neverStarted ? null : this.now() + 1)
    })
    await this.cleanup()
    return (await this.read())!
  }

  async alarm(): Promise<void> {
    let input: JobInput | undefined
    await this.locked(async () => {
      await this.load()
      const receipt = this.receipt
      if (!receipt || receipt.state === 'finished') return
      if (receipt.state === 'queued') {
        input = await this.store.input()
        if (!input) {
          this.receipt = { ...receipt, state: 'stopping', outcome: 'interrupted', cleanup: 'pending' }
        } else {
          this.active = true
          this.receipt = { ...receipt, state: 'running', startedAt: this.now(), deadline: this.now() + input.timeoutMs, cleanup: 'pending' }
        }
        await this.store.save(this.receipt)
      } else if (receipt.state === 'running' && receipt.deadline !== null && this.now() >= receipt.deadline) {
        this.receipt = { ...receipt, state: 'stopping', outcome: 'timed_out', result: null, ...noOutput(receipt) }
        await this.store.save(this.receipt)
      }
      await this.store.alarm(this.receipt!.state === 'running' ? this.receipt!.deadline! : this.now() + 10_000)
    })
    if (!input) { await this.cleanup(); return }
    const execution = this.execute(input)
    // Cloudflare runs only one alarm handler at a time for an object. A later
    // alarm cannot interrupt this await: race the total budget in this handler.
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const winner = await Promise.race([execution.then(() => 'settled' as const),
        new Promise<'deadline'>(resolve => { timer = setTimeout(() => resolve('deadline'), Math.max(1, this.receipt!.deadline! - this.now())) })])
      if (winner === 'deadline') {
        await this.locked(async () => {
          if (this.receipt?.state !== 'running') return
          this.receipt = { ...this.receipt, state: 'stopping', outcome: 'timed_out', result: null, ...noOutput(this.receipt) }
          await this.store.save(this.receipt)
        })
        await this.cleanup()
      }
    } finally { if (timer !== undefined) clearTimeout(timer) }
  }

  private async execute(input: JobInput): Promise<void> {
    try {
      const result = await this.executor.run(input, () => {
        if (this.receipt?.state !== 'running' || this.now() >= this.receipt.deadline!) throw new JobProtocolError(409, 'execution_no_longer_current')
      })
      await this.locked(async () => {
        if (this.receipt?.state !== 'running') return // Late success never undoes a stop.
        const late = this.now() >= this.receipt.deadline!
        const { outputArtifact, outputError, ...plain } = result
        // A version 1 receipt never carries output facts, whatever the executor returned.
        const output = this.receipt.version === 2 ? { outputArtifact: late ? null : outputArtifact ?? null,
          outputError: late || outputArtifact ? null : outputError ?? null } : {}
        this.receipt = { ...this.receipt, state: 'stopping', outcome: late ? 'timed_out' : result.status,
          result: late ? null : plain, ...output }
        await this.store.save(this.receipt)
      })
    } catch {
      // Provider errors can contain command bytes or signed internal URLs. Keep
      // the diagnosis category; no raw SDK exception crosses this boundary.
      await this.locked(async () => {
        if (this.receipt?.state !== 'running') return
        this.receipt = { ...this.receipt, state: 'stopping', outcome: this.now() >= this.receipt.deadline! ? 'timed_out' : 'executor_unavailable',
          result: null, ...noOutput(this.receipt) }
        await this.store.save(this.receipt)
      })
    } finally {
      this.active = false
      await this.cleanup()
    }
  }

  private async cleanup(): Promise<void> {
    const shouldDestroy = await this.locked(async () => { await this.load(); return this.receipt?.state === 'stopping' })
    if (!shouldDestroy) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([this.executor.destroy(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('termination_unconfirmed')), 10_000)
      })])
    } catch {
      await this.store.alarm(this.now() + 10_000)
      return // Pending termination is observable; never claim the VM stopped.
    } finally { if (timer !== undefined) clearTimeout(timer) }
    await this.locked(async () => {
      if (this.receipt?.state !== 'stopping') return
      if (this.active) {
        // A start RPC may still be resolving. Destroy again after its finalizer;
        // this acknowledgement alone cannot certify all in-flight work stopped.
        await this.store.alarm(this.now() + 10_000)
        return
      }
      this.receipt = { ...this.receipt, state: 'finished', cleanup: 'confirmed', finishedAt: this.now() }
      await this.store.save(this.receipt, null)
      await this.store.alarm(null)
    })
  }
}
