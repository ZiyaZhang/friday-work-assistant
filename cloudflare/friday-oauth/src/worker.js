/** Public OAuth callback only. Token exchange and Feishu credentials stay on the gateway.
 * Signed expiring states admit writes. Encrypted replies survive a lost poll response;
 * explicit acknowledgement clears them, retaining a tombstone against callback replay.
 */
import { tokenPage } from './token-page.js'
import { desktopRoute, cleanupDesktop } from './desktop.js'
const TTL_MS = 10 * 60_000
const encoder = new TextEncoder()
const headers = {
  'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    try {
      if (url.pathname === '/healthz' && request.method === 'GET') return json({ ok: true })
      if (url.pathname.startsWith('/desktop/')) return await desktopRoute(request, env, { validState, authorized, json, page, encodeReply, decodeReply })
      if (url.pathname === '/github/token') return await tokenSetup(request, url, env)
      if (url.pathname === '/oauth/callback' || url.pathname === '/github/callback' || url.pathname === '/gmail/callback') {
        if (request.method !== 'GET') return json({ error: 'method' }, 405)
        return await callback(url, env, url.pathname === '/gmail/callback' ? 'gm1' : url.pathname === '/github/callback' ? 'gh1' : 'v1')
      }
      if (url.pathname === '/relay/claim' || url.pathname === '/relay/ack') {
        if (request.method !== (url.pathname.endsWith('/ack') ? 'POST' : 'GET')) return json({ error: 'method' }, 405)
        if (!await authorized(request, env)) return json({ error: 'unauthorized' }, 401)
        const state = url.searchParams.get('state') ?? ''
        if (!await validState(state, env)) return json({ error: 'expired_or_invalid_state' }, 410)
        if (url.pathname.endsWith('/ack')) {
          await env.DB.prepare("UPDATE pending SET payload = '', completed = 1 WHERE state = ?").bind(state).run()
          return json({ ok: true })
        }
        const row = await env.DB.prepare('SELECT payload, completed FROM pending WHERE state = ?').bind(state).first()
        if (!row) return json({ pending: true }, 404)
        if (row.completed) return json({ completed: true })
        return json(await decodeReply(row.payload, env))
      }
      return json({ error: 'not_found' }, 404)
    } catch {
      // Never log URLs, OAuth replies or database errors that might contain codes.
      console.error('friday-oauth request failed')
      return url.pathname === '/oauth/callback' || url.pathname === '/github/callback' || url.pathname === '/gmail/callback'
        ? page('暂时没有接收成功', '请稍后刷新此页。仍无法完成时，回飞书让 Friday 重新发一张授权卡。', 503)
        : json({ error: 'internal' }, 503)
    }
  },
  async scheduled(_event, env) {
    await env.DB.prepare('DELETE FROM pending WHERE expires_at <= ?').bind(Date.now()).run()
    await cleanupDesktop(env)
  },
}
async function callback(url, env, provider) {
  const state = url.searchParams.get('state') ?? ''
  const code = url.searchParams.get('code') ?? ''
  const error = url.searchParams.get('error') ?? ''
  if (!state.startsWith(`${provider}.`) || !await validState(state, env)) return page('授权链接已失效', '请回飞书私聊，让 Friday 重新发一张授权卡。', 400)
  if ((!code && !error) || (code && error) || code.length > 2048 || error.length > 128)
    return page('授权没有完成', '没有收到有效的授权结果。请回飞书让 Friday 重新发一张授权卡。', 400)
  // Provider error descriptions are untrusted; relay a fixed outcome only.
  const payload = await encodeReply(code ? { code } : { error: 'denied' }, env)
  await env.DB.prepare('INSERT INTO pending (state, payload, expires_at) VALUES (?, ?, ?) ON CONFLICT(state) DO NOTHING')
    .bind(state, payload, Number(state.split('.')[1])).run()
  return error ? page('这次没有完成授权', '你可以回飞书私聊，让 Friday 重新发一张授权卡。')
    : page('正在完成连接', `已收到${provider === 'gm1' ? 'Gmail' : provider === 'gh1' ? 'GitHub' : '飞书'}返回的结果，Friday 正在核验。可以关闭此页，最终结果会发到飞书私聊。`)
}
async function validState(state, env) {
  if (!env.RELAY_TOKEN || !/^(?:v1|gh1|gp1|gm1|dp1)\.\d{13}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/.test(state)) return false
  const [provider, expires, nonce, signature] = state.split('.')
  const remaining = Number(expires) - Date.now()
  if (remaining <= 0 || remaining > TTL_MS) return false
  const key = await crypto.subtle.importKey('raw', encoder.encode(env.RELAY_TOKEN), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  return crypto.subtle.verify('HMAC', key, from64(signature), encoder.encode(`friday-oauth-state:${provider}.${expires}.${nonce}`))
}
async function tokenSetup(request, url, env) {
  if (!['GET', 'POST'].includes(request.method)) return json({ error: 'method' }, 405)
  let input = Object.fromEntries(url.searchParams)
  if (request.method === 'POST') {
    if (request.headers.get('origin') !== url.origin || !request.headers.get('content-type')?.startsWith('application/json')) return json({ error: 'origin' }, 403)
    const reader = request.body?.getReader()
    if (!reader) return json({ error: 'body' }, 400)
    const chunks = []; let size = 0
    while (true) {
      const { value, done } = await reader.read(); if (done) break
      size += value.length
      if (size > 4096) { await reader.cancel(); return json({ error: 'too_large' }, 413) }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size); let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    try { input = JSON.parse(new TextDecoder().decode(bytes)) } catch { return json({ error: 'body' }, 400) }
  }
  const { state, key, signature } = input ?? {}
  if (typeof state !== 'string' || !state.startsWith('gp1.') || !await validState(state, env) ||
    typeof key !== 'string' || !/^[A-Za-z0-9_-]{392}$/.test(key) || typeof signature !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(signature))
    return request.method === 'GET' ? page('配置链接已失效', '请回 Friday 私聊的账号连接，重新打开个人令牌配置页。', 400) : json({ error: 'invalid_setup' }, 400)
  const signing = await crypto.subtle.importKey('raw', encoder.encode(env.RELAY_TOKEN), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  if (!await crypto.subtle.verify('HMAC', signing, from64(signature), encoder.encode(`friday-token-key:${state}:${key}`))) return json({ error: 'invalid_setup' }, 400)
  const prior = await env.DB.prepare('SELECT completed FROM pending WHERE state = ?').bind(state).first()
  if (prior) return request.method === 'GET' ? page('这次配置已提交', '请回 Friday 私聊查看结果。需要更换令牌时，重新打开配置页。') : json({ error: 'already_submitted' }, 409)
  if (request.method === 'GET') return tokenPage({ state, key, signature }, headers)
  if (typeof input.code !== 'string' || !/^[A-Za-z0-9_-]{342}$/.test(input.code)) return json({ error: 'encrypted_value_required' }, 400)
  // Only RSA ciphertext reaches this Worker. The one-use private key is encrypted on the gateway.
  const payload = await encodeReply({ code: input.code }, env)
  await env.DB.prepare('INSERT INTO pending (state,payload,expires_at) VALUES (?,?,?) ON CONFLICT(state) DO NOTHING')
    .bind(state, payload, Number(state.split('.')[1])).run()
  return json({ ok: true })
}
async function authorized(request, env) {
  if (!env.RELAY_TOKEN) return false
  const hash = s => crypto.subtle.digest('SHA-256', encoder.encode(s))
  const [a, b] = await Promise.all([hash(request.headers.get('authorization') ?? ''), hash(`Bearer ${env.RELAY_TOKEN}`)])
  const aa = new Uint8Array(a), bb = new Uint8Array(b)
  return aa.reduce((diff, v, i) => diff | (v ^ bb[i]), 0) === 0
}
const to64 = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const from64 = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
async function encryptionKey(env) {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(`friday-oauth-payload:${env.RELAY_TOKEN}`))
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt'])
}
async function encodeReply(reply, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await encryptionKey(env), encoder.encode(JSON.stringify(reply)))
  return `${to64(iv)}.${to64(new Uint8Array(data))}`
}
async function decodeReply(payload, env) {
  const [iv, data] = payload.split('.')
  const decoded = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: from64(iv) }, await encryptionKey(env), from64(data))
  return JSON.parse(new TextDecoder().decode(decoded))
}
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, 'content-type': 'application/json; charset=utf-8' } })
}
function page(title, detail, status = 200) {
  return new Response(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Friday · 账号连接</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;box-sizing:border-box;font:16px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;background:#f6f7f9;color:#1f2329;padding:24px}main{max-width:28rem}h1{font-size:1.4rem}p{color:#646a73}</style><main><h1>${title}</h1><p>${detail}</p></main></html>`,
    { status, headers: { ...headers, 'content-type': 'text/html; charset=utf-8' } })
}
