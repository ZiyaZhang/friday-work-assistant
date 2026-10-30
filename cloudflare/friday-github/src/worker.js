/** Authenticated transport only. Business permissions, source admission and
 * uncertain-write reconciliation remain on the Friday host. No storage/logging. */
import { ARTIFACT_DOWNLOAD_TIMEOUT_MS, artifactStorageLocation, validateArtifactArchive, validateArchiveLength } from '../../../src/github/artifact-download-policy.js'
import { JOB_LOG_TIMEOUT_MS, GitHubJobLogError, jobLogStorageLocation, validateJobLog, jobLogRange, jobLogHttpError } from '../../../src/github/job-log-policy.js'
const VERSION = 'github-relay-v1'
const encoder = new TextEncoder()
const REQUEST_HEADERS = [
  'accept', 'accept-encoding', 'authorization', 'content-type', 'content-encoding', 'user-agent',
  'git-protocol', 'x-github-api-version', 'if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since',
]
const RESPONSE_HEADERS = [
  'content-type', 'content-encoding', 'etag', 'last-modified', 'link', 'retry-after', 'www-authenticate',
  'x-github-request-id', 'x-github-api-version-selected', 'x-ratelimit-limit', 'x-ratelimit-remaining',
  'x-ratelimit-reset', 'x-ratelimit-resource', 'x-ratelimit-used', 'x-oauth-scopes', 'x-accepted-oauth-scopes',
  'x-accepted-github-permissions',
]
const API_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
const REPOSITORY = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_.-]+)$/
const GIT_ROUTE = /^\/git\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_.-]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/
const SECURITY_HEADERS = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' }

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url)
      if (url.pathname === '/health' && request.method === 'GET') return json({ ok: true, version: VERSION })
      const access = await authorization(request, env)
      if (!access) return json({ error: 'unauthorized' }, 401)
      request.signal.throwIfAborted()
      // RELAY_READ_TOKEN reaches only fixed read routes: no receive-pack and no
      // write method, before any route handling or upstream request.
      if (access === 'read' && !readOnlyRoute(url, request.method)) return json({ error: 'read_only_token' }, 403)
      // Only the full relay credential may use the hosted PAT for writes, and
      // only in the exact configured repositories. Its historical secret name
      // does not determine the PAT's GitHub permissions.
      let hostedToken
      if (access === 'full' && env.GITHUB_CREDENTIAL_MODE === 'worker') {
        if (!hostedCredentialRoute(url, request.method, env)) return json({ error: 'credential_route_not_allowed' }, 403)
        hostedToken = secret(env.GITHUB_READ_TOKEN)
        if (!hostedToken || !/^[\x21-\x7e]+$/.test(hostedToken)) return json({ error: 'github_token_unavailable' }, 503)
      }
      const apiAuthorization = hostedToken ? `Bearer ${hostedToken}` : undefined
      if (url.pathname.startsWith('/logs/')) return await actionsJobLog(request, url, apiAuthorization)
      if (url.pathname.startsWith('/artifacts/')) return await artifactArchive(request, url, apiAuthorization)
      const target = destination(url, request.method, env)
      if (target instanceof Response) return target
      const headers = copyHeaders(request.headers, REQUEST_HEADERS)
      if (hostedToken) headers.set('authorization', url.pathname.startsWith('/git/')
        ? `Basic ${btoa(`x-access-token:${hostedToken}`)}` : apiAuthorization)
      // A RELAY_READ_TOKEN Git fetch (already limited to upload-pack of an
      // allowlisted repository) without its own Authorization uses the relay's
      // GITHUB_READ_TOKEN. No anonymous fallback; a caller's header is kept.
      if (access === 'read' && url.pathname.startsWith('/git/') && !headers.has('authorization')) {
        const credential = githubReadCredential(env)
        if (!credential) return json({ error: 'github_read_token_unavailable' }, 503)
        headers.set('authorization', credential)
      }
      if (!headers.has('user-agent')) headers.set('user-agent', 'Friday-GitHub-Relay')
      headers.set('cache-control', 'no-store')
      // Passing the original stream neither parses nor buffers Git packfiles or
      // API payloads. Forward only the current request's GitHub Authorization.
      const upstream = await fetch(target, { method: request.method, headers,
        ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body: request.body }),
        redirect: 'manual', cache: 'no-store', signal: request.signal })
      if (request.signal.aborted) { await cancel(upstream); return json({ error: 'request_cancelled' }, 499) }
      // 304 is a conditional-read result, not a redirect. All other 3xx are
      // rejected, with neither Location nor redirect body exposed to clients.
      if (upstream.status < 200 || upstream.status >= 300 && upstream.status < 400 && upstream.status !== 304) {
        await cancel(upstream)
        return json({ error: 'upstream_redirect_or_protocol_rejected' }, 502)
      }
      const responseHeaders = copyHeaders(upstream.headers, RESPONSE_HEADERS)
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) responseHeaders.set(name, value)
      // Preserve the original stream/content encoding; no credential, cookie,
      // relay header, hop-by-hop header or cache instruction is reflected.
      return new Response(upstream.body, { status: upstream.status, headers: responseHeaders })
    } catch {
      // Do not print exception text: network exceptions can contain URLs/tokens.
      return request.signal.aborted ? json({ error: 'request_cancelled' }, 499) : json({ error: 'upstream_unavailable' }, 502)
    }
  },
}

/** The only redirect-following route. It accepts a fixed artifact id, never a
 * URL; ordinary /api requests (including writes) retain manual rejection. */
async function artifactArchive(request, url, hostedAuthorization) {
  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405)
  const match = /^\/artifacts\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_.-]+)\/([1-9][0-9]*)\/zip$/.exec(url.pathname)
  if (!match || url.search) return json({ error: 'invalid_artifact_request' }, 400)
  const [, owner, repo, id] = match, rawLimit = request.headers.get('x-friday-artifact-max-bytes')
  const maxBytes = rawLimit && /^[1-9][0-9]*$/.test(rawLimit) ? Number(rawLimit) : 0
  try { validateArtifactArchive(`${owner}/${repo}`, Number(id), maxBytes) }
  catch { return json({ error: 'invalid_artifact_request' }, 400) }
  const abort = new AbortController(), signal = AbortSignal.any([request.signal, abort.signal])
  const timer = setTimeout(() => abort.abort(), ARTIFACT_DOWNLOAD_TIMEOUT_MS)
  let upstream, reader
  const cleanup = () => clearTimeout(timer)
  try {
    const headers = new Headers({ accept: 'application/vnd.github+json', 'accept-encoding': 'identity',
      'x-github-api-version': '2022-11-28', 'user-agent': 'Friday-GitHub-Relay', 'cache-control': 'no-store' })
    const authorization = hostedAuthorization ?? request.headers.get('authorization')
    if (authorization) headers.set('authorization', authorization)
    upstream = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/artifacts/${id}/zip`,
      { method: 'GET', headers, redirect: 'manual', cache: 'no-store', signal })
    signal.throwIfAborted()
    if (upstream.status !== 302) throw new Error('artifact_upstream_rejected')
    const location = artifactStorageLocation(upstream.headers.get('location'))
    await cancel(upstream); signal.throwIfAborted()
    // Never reuse incoming/upstream headers for signed object storage.
    upstream = await fetch(location, { method: 'GET', headers: { accept: 'application/octet-stream', 'accept-encoding': 'identity' },
      redirect: 'manual', cache: 'no-store', signal })
    signal.throwIfAborted()
    if (upstream.status !== 200 || !upstream.body || upstream.headers.has('content-encoding') && upstream.headers.get('content-encoding') !== 'identity') throw new Error('artifact_upstream_rejected')
    validateArchiveLength(upstream.headers.get('content-length'), maxBytes)
    const expectedLength = upstream.headers.get('content-length')
    reader = upstream.body.getReader()
    let size = 0
    const body = new ReadableStream({
      async pull(controller) {
        try {
          signal.throwIfAborted()
          const next = await reader.read()
          signal.throwIfAborted()
          if (next.done) {
            if (expectedLength !== null && size !== Number(expectedLength)) throw new Error('artifact_length_changed')
            cleanup(); controller.close(); return
          }
          size += next.value.byteLength
          if (size > maxBytes) throw new Error('artifact_too_large')
          controller.enqueue(next.value)
        } catch {
          cleanup(); abort.abort(); void reader.cancel().catch(() => {})
          controller.error(new Error('artifact_download_failed'))
        }
      },
      cancel() { cleanup(); abort.abort(); return reader.cancel().catch(() => {}) },
    })
    return new Response(body, { status: 200, headers: { ...SECURITY_HEADERS, 'content-type': 'application/zip' } })
  } catch {
    cleanup(); abort.abort(); if (upstream) await cancel(upstream)
    return json({ error: request.signal.aborted ? 'request_cancelled' : 'artifact_download_failed' }, request.signal.aborted ? 499 : 502)
  }
}

/** Fixed Actions job log route. Ordinary /api redirects remain rejected. */
async function actionsJobLog(request, url, hostedAuthorization) {
  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405)
  const match = /^\/logs\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_.-]+)\/([1-9][0-9]*)$/.exec(url.pathname)
  const rawLimit = request.headers.get('x-friday-log-max-bytes'), rawStart = request.headers.get('x-friday-log-start-byte')
  if (!match || url.search || !rawLimit || !/^[1-9][0-9]*$/.test(rawLimit) || rawStart !== null && !/^(0|[1-9][0-9]*)$/.test(rawStart)) return json({ error: 'invalid_log_request' }, 400)
  const [, owner, repo, id] = match, maxBytes = Number(rawLimit), startByte = rawStart === null ? undefined : Number(rawStart)
  try { validateJobLog(`${owner}/${repo}`, Number(id), maxBytes, startByte) }
  catch { return json({ error: 'invalid_log_request' }, 400) }
  const abort = new AbortController(), signal = AbortSignal.any([request.signal, abort.signal])
  const timer = setTimeout(() => abort.abort(), JOB_LOG_TIMEOUT_MS)
  let upstream, reader
  const cleanup = () => clearTimeout(timer)
  const get = async (target, headers) => {
    signal.throwIfAborted()
    const result = await fetch(target, { method: 'GET', headers, redirect: 'manual', cache: 'no-store', signal })
    if (signal.aborted) { await cancel(result); signal.throwIfAborted() }
    return result
  }
  try {
    const headers = { accept: 'application/vnd.github+json', 'accept-encoding': 'identity',
      'x-github-api-version': '2022-11-28', 'user-agent': 'Friday-GitHub-Relay',
      ...((hostedAuthorization ?? request.headers.get('authorization')) ? { authorization: hostedAuthorization ?? request.headers.get('authorization') } : {}) }
    upstream = await get(`https://api.github.com/repos/${owner}/${repo}/actions/jobs/${id}/logs`, headers)
    if (upstream.status !== 302) throw jobLogHttpError(upstream.status)
    const location = jobLogStorageLocation(upstream.headers.get('location'))
    await cancel(upstream); signal.throwIfAborted()
    const storageHeaders = { accept: 'text/plain', 'accept-encoding': 'identity' }
    let range, start = startByte ?? 0
    if (startByte === undefined) {
      upstream = await get(location, { ...storageHeaders, range: 'bytes=0-0' })
      if (upstream.status === 200) range = jobLogRange(200, undefined, upstream.headers.get('content-length'), 0, maxBytes)
      else {
        const probe = jobLogRange(upstream.status, upstream.headers.get('content-range'), upstream.headers.get('content-length'), 0, 1)
        start = Math.max(0, probe.totalBytes - maxBytes)
        const etag = upstream.headers.get('etag')
        await cancel(upstream); signal.throwIfAborted()
        upstream = await get(location, { ...storageHeaders, range: `bytes=${start}-${start + maxBytes - 1}`, ...(etag ? { 'if-match': etag } : {}) })
        range = jobLogRange(upstream.status, upstream.headers.get('content-range'), upstream.headers.get('content-length'), start, maxBytes)
        if (range.totalBytes !== probe.totalBytes) throw new GitHubJobLogError('range_changed')
      }
    } else {
      upstream = await get(location, { ...storageHeaders, range: `bytes=${start}-${start + maxBytes - 1}` })
      range = jobLogRange(upstream.status, upstream.headers.get('content-range'), upstream.headers.get('content-length'), start, maxBytes)
    }
    if (!upstream.body || upstream.headers.has('content-encoding') && upstream.headers.get('content-encoding') !== 'identity') throw new GitHubJobLogError('invalid_response')
    reader = upstream.body.getReader()
    let size = 0
    const body = new ReadableStream({
      async pull(controller) {
        try {
          signal.throwIfAborted()
          const next = await reader.read()
          signal.throwIfAborted()
          if (next.done) {
            if (size !== range.endByte - range.startByte) throw new GitHubJobLogError('invalid_response')
            cleanup(); controller.close(); return
          }
          size += next.value.byteLength
          if (size > maxBytes || size > range.endByte - range.startByte) throw new GitHubJobLogError('too_large')
          controller.enqueue(next.value)
        } catch {
          cleanup(); abort.abort(); void reader.cancel().catch(() => {})
          controller.error(new Error('job_log_download_failed'))
        }
      },
      cancel() { cleanup(); abort.abort(); return reader.cancel().catch(() => {}) },
    })
    return new Response(body, { status: range.totalBytes ? 206 : 200, headers: { ...SECURITY_HEADERS,
      'content-type': 'text/plain; charset=utf-8', 'content-length': String(range.endByte - range.startByte),
      'x-friday-log-start-byte': String(range.startByte),
      ...(range.totalBytes ? { 'content-range': `bytes ${range.startByte}-${range.endByte - 1}/${range.totalBytes}` } : {}),
    } })
  } catch (error) {
    cleanup(); abort.abort(); if (upstream) await cancel(upstream)
    const code = error instanceof GitHubJobLogError ? error.code : 'unavailable'
    const status = request.signal.aborted ? 499 : code === 'permission_denied' ? 403 : code === 'not_found_or_inaccessible' ? 404
      : code === 'rate_limited' ? 429 : code === 'range_changed' ? 416 : 502
    return json({ error: request.signal.aborted ? 'request_cancelled' : code }, status)
  }
}

/** 'full' for RELAY_TOKEN, 'read' for RELAY_READ_TOKEN, otherwise null. */
async function authorization(request, env) {
  const full = secret(env.RELAY_TOKEN), read = secret(env.RELAY_READ_TOKEN)
  // Equal values would let the read-only holder push: fail closed for both.
  if (!full && !read || full && read && full === read) return null
  // Fixed-size hashes plus Workers' native constant-time comparison; no JS
  // prefix comparison and no different-length secret comparison shortcut.
  const supplied = await digest(request.headers.get('x-friday-relay-token') ?? '')
  if (full && crypto.subtle.timingSafeEqual(await digest(full), supplied)) return 'full'
  if (read && crypto.subtle.timingSafeEqual(await digest(read), supplied)) return 'read'
  return null
}
// Surrounding whitespace (e.g. a newline from a piped secret) can never match an HTTP header value.
function secret(value) { return typeof value === 'string' && value.trim() ? value.trim() : undefined }
function digest(value) { return crypto.subtle.digest('SHA-256', encoder.encode(value)) }
/** HTTP Basic credential for GitHub smart HTTP, or undefined if the secret is absent or malformed. */
function githubReadCredential(env) {
  const token = secret(env.GITHUB_READ_TOKEN)
  return token && /^[\x21-\x7e]+$/.test(token) ? `Basic ${btoa(`x-access-token:${token}`)}` : undefined
}

function hostedCredentialRoute(url, method, env) {
  if (url.pathname === '/api/user') return method === 'GET'
  if (url.pathname === '/api/search/issues') {
    const p = url.searchParams
    const match = /^is:open is:(pr|issue) (review-requested|assignee|author):[A-Za-z0-9-]{1,39} repo:([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+)$/.exec(p.get('q') ?? '')
    return method === 'GET' && [...p.keys()].length === 4 && p.getAll('q').length === 1 &&
      [...p.keys()].every(key => ['q', 'sort', 'order', 'per_page'].includes(key)) &&
      p.get('sort') === 'updated' && p.get('order') === 'desc' && p.get('per_page') === '50' &&
      Boolean(match && allowedRepo(match[3], env.ALLOWED_GIT_REPOS))
  }
  const match = /^\/api\/repos\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_.-]+)(?:\/|$)/.exec(url.pathname)
    ?? /^\/git\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_.-]+)\.git\//.exec(url.pathname)
    ?? /^\/(?:logs|artifacts)\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_.-]+)\//.exec(url.pathname)
  return Boolean(match && allowedRepo(`${match[1]}/${match[2]}`, env.ALLOWED_GIT_REPOS))
}

/** Read token scope: API GET/HEAD, fixed log/artifact GET, and Git fetch
 * (upload-pack discovery and exchange). Everything else is refused. */
function readOnlyRoute(url, method) {
  if (url.pathname.startsWith('/api/')) return method === 'GET' || method === 'HEAD'
  if (url.pathname.startsWith('/logs/') || url.pathname.startsWith('/artifacts/')) return method === 'GET'
  const git = GIT_ROUTE.exec(url.pathname)
  if (git?.[3] === 'info/refs') return method === 'GET' && url.search === '?service=git-upload-pack'
  return git?.[3] === 'git-upload-pack' && method === 'POST' && !url.search
}

function destination(url, method, env) {
  if (url.pathname.startsWith('/api/')) {
    if (!API_METHODS.has(method)) return json({ error: 'method_not_allowed' }, 405)
    // Assigning pathname, rather than resolving an untrusted URL, fixes the
    // upstream origin even for //host, encoded slashes or URL-like path text.
    const target = new URL('https://api.github.com/')
    target.pathname = url.pathname.slice('/api'.length)
    target.search = url.search
    return target
  }
  const match = GIT_ROUTE.exec(url.pathname)
  if (!match) return json({ error: 'not_found' }, 404)
  const [, owner, repo, operation] = match
  if (!allowedRepo(`${owner}/${repo}`, env.ALLOWED_GIT_REPOS)) return json({ error: 'repository_not_allowed' }, 403)
  if (operation === 'info/refs') {
    if (method !== 'GET') return json({ error: 'method_not_allowed' }, 405)
    const params = [...url.searchParams]
    if (params.length !== 1 || params[0][0] !== 'service' || !['git-upload-pack', 'git-receive-pack'].includes(params[0][1])) return json({ error: 'invalid_git_service' }, 400)
  } else {
    if (method !== 'POST') return json({ error: 'method_not_allowed' }, 405)
    if (url.search) return json({ error: 'invalid_git_query' }, 400)
  }
  // The path has already matched a closed smart-HTTP grammar. Neither query
  // values nor Authorization can influence the hostname or another repository.
  const target = new URL('https://github.com/')
  target.pathname = `/${owner}/${repo}.git/${operation}`
  target.search = url.search
  return target
}

function allowedRepo(repo, raw) {
  if (typeof raw !== 'string' || !raw.trim()) return false
  const entries = raw.trim().split(/[\s,]+/)
  // Malformed configuration is fail-closed, not an implicit wildcard or prefix.
  if (entries.some(value => { const match = REPOSITORY.exec(value); return !match || match[2] === '.' || match[2] === '..' })) return false
  return entries.some(value => value.toLowerCase() === repo.toLowerCase())
}
function copyHeaders(source, names) {
  const headers = new Headers()
  for (const name of names) { const value = source.get(name); if (value !== null) headers.set(name, value) }
  return headers
}
async function cancel(response) { try { await response.body?.cancel() } catch { /* No response content or error logging. */ } }
function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' } })
}
