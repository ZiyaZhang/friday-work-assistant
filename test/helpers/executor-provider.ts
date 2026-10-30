import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ExecutorClient, type ExecutorTransportRequest } from '../../src/github/executor-client.js'
import { createExecutorHttpService } from '../../services/friday-executor/http-service.js'
import { DockerJobExecutor } from '../../services/friday-executor/docker-executor.js'
import { readOutputArtifact } from '../../services/friday-executor/output-capture.js'

export const PROVIDER_SECRET = 'synthetic-executor-output-secret-for-tests-only'
const IMAGE = `node:22.19.0-bookworm-slim@sha256:${'a'.repeat(64)}`
/** Content the fixture container writes for command `generate`; `verify` exits 0 only when present. */
export const GENERATED = { before: { a: 'hash: before-a\n', b: 'hash: before-b\n' },
  after: { a: 'hash: after-a\n', b: 'hash: after-b\r\nno-newline', c: 'hash: new-c\n' } }

/** Provider over real HTTP and node:sqlite with the rootless runner. Docker is a
 * subprocess CLI fixture: `start` edits the bind-mounted worktree, nothing else. */
export async function startExecutorProvider(input: { root: string; bare: string; baseSha: string; repo?: string }) {
  const repo = input.repo ?? 'org/demo'
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim()
  const bundles = join(input.root, 'sources'), work = join(input.root, 'jobs'), artifacts = join(input.root, 'artifacts')
  mkdirSync(join(bundles, ...repo.split('/')), { recursive: true }); mkdirSync(work, { recursive: true, mode: 0o700 })
  git(input.bare, 'bundle', 'create', join(bundles, ...repo.split('/'), `${input.baseSha}.bundle`), 'main')
  const dockerState = join(input.root, 'container.json'), docker = join(input.root, 'docker-fixture')
  writeFileSync(docker, `#!${process.execPath}\n` + String.raw`
const fs=require('node:fs'),p=require('node:path');
const args=process.argv.slice(2), state=${JSON.stringify(dockerState)};
if(args[0]==='info'){process.stdout.write(JSON.stringify(['name=rootless']));return}
if(args[0]==='create'){
 const name=args[args.indexOf('--name')+1], label=args[args.indexOf('--label')+1].split('=')[1], work=args[args.indexOf('--mount')+1].match(/src=([^,]+)/)[1];
 fs.writeFileSync(state,JSON.stringify({Id:'d'.repeat(64),Name:'/'+name,Config:{Labels:{'com.friday.executor.job':label}},State:{Running:false,Status:'created',ExitCode:0},work,command:args.at(-1)}));
 process.stdout.write('d'.repeat(64)+'\n');return
}
if(args[0]==='start'){
 const value=JSON.parse(fs.readFileSync(state)), at=(...parts)=>p.join(value.work,...parts);
 let code=0;
 if(value.command==='generate'){fs.writeFileSync(at('docs/a.i18n.yaml'),${JSON.stringify(GENERATED.after.a)});fs.writeFileSync(at('docs/b.i18n.yaml'),${JSON.stringify(GENERATED.after.b)});fs.writeFileSync(at('docs/c.i18n.yaml'),${JSON.stringify(GENERATED.after.c)})}
 else if(value.command==='verify'){code=fs.existsSync(at('docs/c.i18n.yaml'))&&fs.readFileSync(at('docs/c.i18n.yaml'),'utf8')===${JSON.stringify(GENERATED.after.c)}?0:1}
 process.stdout.write(value.command+' exit '+code+'\n');
 value.State={Running:false,Status:'exited',ExitCode:code};fs.writeFileSync(state,JSON.stringify(value));return
}
if(args[0]==='container'&&args[1]==='ls'){if(fs.existsSync(state))process.stdout.write('d'.repeat(64)+'\n');return}
if(args[0]==='container'&&args[1]==='inspect'){process.stdout.write(fs.readFileSync(state));return}
if(args[0]==='container'&&args[1]==='rm'){fs.rmSync(state,{force:true});return}
process.exitCode=2;
`, { mode: 0o700 })
  const db = new DatabaseSync(join(input.root, 'jobs.sqlite'))
  const service = createExecutorHttpService({ db, token: PROVIDER_SECRET, allowedRepos: [repo], isReady: () => true, capture: true,
    readOutput: (jobId, artifact) => readOutputArtifact(artifacts, jobId, artifact),
    createExecutor: id => new DockerJobExecutor(id, { bundleRoot: bundles, workRoot: work, artifactRoot: artifacts, image: IMAGE,
      allowedRepos: [repo], dockerPath: docker, gitPath: '/usr/bin/git', dockerHost: 'unix:///run/user/1000/docker.sock' }) })
  await service.recover()
  const server = createServer(service.handler)
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const local = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  // Explicit fixture transport; the configured origin and fixed mount stay HTTPS.
  const sent: ExecutorTransportRequest[] = []
  const hooks: { response?: (request: ExecutorTransportRequest, response: Response) => Promise<Response> } = {}
  const client = new ExecutorClient({ baseUrl: 'https://executor.example.test/friday-executor', secret: PROVIDER_SECRET, requestTimeoutMs: 10_000 },
    async request => {
      sent.push(request)
      const url = new URL(request.url)
      if (url.origin !== 'https://executor.example.test') throw new Error('unexpected executor origin')
      const response = await fetch(local + url.pathname.replace(/^\/friday-executor/, ''), { method: request.method, body: request.body,
        headers: request.headers, signal: request.signal, redirect: 'manual' })
      return hooks.response ? hooks.response(request, response) : response
    })
  return { client, sent, hooks, artifacts,
    async close() {
      await service.close({ timeoutMs: 2000 }); server.closeAllConnections()
      await new Promise<void>(done => server.close(() => done())); db.close()
    } }
}
