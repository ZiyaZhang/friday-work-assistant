const encode = new TextEncoder()
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const CIPHER = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
const b64 = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', encode.encode(value)))].map(x => x.toString(16).padStart(2, '0')).join('')
const rows = async statement => (await statement.all()).results

/** A signed ticket admits bounded encrypted transport. Only the host decides whether a device is still authorized. */
async function ticket(request, env) {
  const value = (request.headers.get('authorization') ?? '').replace(/^Bearer /, '')
  if (!env.RELAY_TOKEN || !/^fd1\.[0-9a-f-]{36}\.\d{13}\.[A-Za-z0-9_-]{43}$/.test(value)) return
  const [, id, time, signature] = value.split('.'), expires = Number(time)
  if (!UUID.test(id) || expires <= Date.now() || expires > Date.now() + 90 * 86_400_000) return
  const key = await crypto.subtle.importKey('raw', encode.encode(env.RELAY_TOKEN), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  if (await crypto.subtle.verify('HMAC', key, b64(signature), encode.encode(`friday-device-ticket:fd1.${id}.${time}`))) return { id, value }
}
async function readBody(request, max) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new Error('invalid_body')
  const reader = request.body?.getReader(); if (!reader) throw new Error('invalid_body')
  const chunks = []; let size = 0
  while (true) {
    const { value, done } = await reader.read(); if (done) break
    size += value.length; if (size > max) { await reader.cancel(); throw new Error('too_large') }; chunks.push(value)
  }
  const data = new Uint8Array(size); let offset = 0
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length }
  const result = JSON.parse(new TextDecoder().decode(data))
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('invalid_body')
  return result
}
export async function desktopRoute(request, env, h) {
  const url = new URL(request.url), path = url.pathname
  if (path === '/desktop/pair' && request.method === 'GET') return h.page('连接 Friday 到 DSH', '在 DSH 的 Friday 面板中粘贴本页地址。随后回到 Friday 飞书私聊，核对设备名称与验证码并确认连接。')
  if (request.method !== 'POST') return h.json({ error: 'method' }, 405)
  const host = path.startsWith('/desktop/relay/')
  if (host && !await h.authorized(request, env)) return h.json({ error: 'unauthorized' }, 401)
  // Browser-origin requests are accepted only from this origin. Desktop requests have no Origin header.
  if (!host && request.headers.get('origin') && request.headers.get('origin') !== url.origin) return h.json({ error: 'origin' }, 403)
  let input
  try { input = await readBody(request, host ? 650_000 : path === '/desktop/request' ? 92_000 : 4096) }
  catch { return h.json({ error: 'invalid_body' }, 400) }
  if (path === '/desktop/pair' || path === '/desktop/pair/status') {
    if (typeof input.state !== 'string' || !input.state.startsWith('dp1.') || !await h.validState(input.state, env)) return h.json({ error: 'expired' }, 410)
    let requestHash = input.requestHash
    if (path === '/desktop/pair') {
      if (typeof input.label !== 'string' || !input.label.trim() || input.label.length > 80 || /[\u0000-\u001f]/.test(input.label) ||
        typeof input.publicKey !== 'string' || !/^[A-Za-z0-9_-]{392}$/.test(input.publicKey)) return h.json({ error: 'invalid_device' }, 400)
      try {
        const key = await crypto.subtle.importKey('spki', b64(input.publicKey), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt'])
        if (key.algorithm.modulusLength !== 2048) throw new Error('invalid_key')
      } catch { return h.json({ error: 'invalid_device' }, 400) }
      requestHash = await digest(JSON.stringify([input.label, input.publicKey]))
      await env.DB.prepare('INSERT INTO desktop_pairs(state,request_hash,request,expires_at) VALUES (?,?,?,?) ON CONFLICT(state) DO NOTHING')
        .bind(input.state, requestHash, JSON.stringify({ label: input.label, publicKey: input.publicKey }), Number(input.state.split('.')[1])).run()
    }
    if (typeof requestHash !== 'string' || !/^[a-f0-9]{64}$/.test(requestHash)) return h.json({ error: 'invalid_device' }, 400)
    const record = await env.DB.prepare('SELECT request_hash,result FROM desktop_pairs WHERE state=?').bind(input.state).first()
    if (!record) return h.json({ state: 'pending' }, 202)
    if (record.request_hash !== requestHash) return h.json({ error: 'conflict' }, 409)
    return h.json({ requestHash, ...(record.result ? JSON.parse(record.result) : { state: 'pending' }) })
  }
  if (host) {
    if (path === '/desktop/relay/pairs') {
      if (!Array.isArray(input.states) || input.states.length > 100 || input.states.some(x => typeof x !== 'string' || x.length > 100)) return h.json({ error: 'invalid' }, 400)
      const results = []
      for (const state of input.states) {
        const record = await env.DB.prepare('SELECT request,request_hash FROM desktop_pairs WHERE state=? AND expires_at>?').bind(state, Date.now()).first()
        if (record) results.push({ state, requestHash: record.request_hash, ...JSON.parse(record.request) })
      }
      return h.json({ pairs: results })
    }
    if (path === '/desktop/relay/pair-result') {
      if (typeof input.state !== 'string' || !input.state.startsWith('dp1.') || !await h.validState(input.state, env) || !/^[a-f0-9]{64}$/.test(input.requestHash ?? '')) return h.json({ error: 'invalid' }, 400)
      const result = input.result
      if (!result || !['approved', 'rejected'].includes(result.state) || result.state === 'approved' &&
        (!/^[A-Za-z0-9_-]{342}$/.test(result.key ?? '') || typeof result.body !== 'string' || result.body.length > 2048 || !CIPHER.test(result.body))) return h.json({ error: 'invalid' }, 400)
      const value = result.state === 'rejected' ? { state: 'rejected' } : { state: 'approved', key: result.key, body: result.body }
      await env.DB.prepare('UPDATE desktop_pairs SET result=? WHERE state=? AND request_hash=? AND result IS NULL').bind(JSON.stringify(value), input.state, input.requestHash).run()
      return h.json({ ok: true })
    }
    if (path === '/desktop/relay/requests') {
      const requests = await rows(env.DB.prepare('SELECT device_id,request_id,request FROM desktop_requests WHERE expires_at>? AND result IS NULL ORDER BY created_at LIMIT 20').bind(Date.now()))
      return h.json({ requests: await Promise.all(requests.map(async row => ({ deviceId: row.device_id, requestId: row.request_id, ...await h.decodeReply(row.request, env) }))) })
    }
    if (path === '/desktop/relay/result') {
      if (!UUID.test(input.deviceId ?? '') || !UUID.test(input.requestId ?? '')) return h.json({ error: 'invalid' }, 400)
      const result = input.result
      if (!result || !(typeof result.payload === 'string' && result.payload.length <= 600_000 && CIPHER.test(result.payload) ||
        ['invalid', 'expired', 'denied', 'conflict', 'unavailable'].includes(result.error))) return h.json({ error: 'invalid' }, 400)
      const value = result.payload ? { payload: result.payload } : { error: result.error }
      await env.DB.prepare('UPDATE desktop_requests SET result=?,request=? WHERE device_id=? AND request_id=? AND result IS NULL').bind(JSON.stringify(value), '', input.deviceId, input.requestId).run()
      return h.json({ ok: true })
    }
    return h.json({ error: 'not_found' }, 404)
  }
  if (path !== '/desktop/request' && path !== '/desktop/result') return h.json({ error: 'not_found' }, 404)
  const auth = await ticket(request, env)
  if (!auth) return h.json({ error: 'expired' }, 401)
  if (!UUID.test(input.requestId ?? '')) return h.json({ error: 'invalid' }, 400)
  let requestHash
  if (path === '/desktop/request') {
    if (typeof input.payload !== 'string' || input.payload.length > 90_000 || !CIPHER.test(input.payload)) return h.json({ error: 'invalid' }, 400)
    requestHash = await digest(input.payload)
    const encrypted = await h.encodeReply({ ticket: auth.value, payload: input.payload }, env)
    // One statement enforces the per-device queue cap under concurrent callers.
    await env.DB.prepare(`INSERT INTO desktop_requests(device_id,request_id,request_hash,request,created_at,expires_at)
      SELECT ?,?,?,?,?,? WHERE (SELECT count(*) FROM desktop_requests WHERE device_id=? AND expires_at>? AND result IS NULL)<16
      ON CONFLICT(device_id,request_id) DO NOTHING`).bind(auth.id, input.requestId, requestHash, encrypted, Date.now(), Date.now() + 5 * 60_000, auth.id, Date.now()).run()
  }
  const record = await env.DB.prepare('SELECT request_hash,result,expires_at FROM desktop_requests WHERE device_id=? AND request_id=?').bind(auth.id, input.requestId).first()
  if (!record) return h.json({ error: path === '/desktop/request' ? 'busy' : 'not_found' }, path === '/desktop/request' ? 429 : 404)
  if (requestHash && requestHash !== record.request_hash) return h.json({ error: 'conflict' }, 409)
  if (record.expires_at <= Date.now()) return h.json({ error: 'expired' }, 410)
  return record.result ? h.json(JSON.parse(record.result)) : h.json({ state: 'pending' }, 202)
}
export async function cleanupDesktop(env) {
  await env.DB.prepare('DELETE FROM desktop_pairs WHERE expires_at<=?').bind(Date.now()).run()
  // Retain only id/hash tombstones for late retries. Erase ciphertext promptly.
  await env.DB.prepare("UPDATE desktop_requests SET request='',result=NULL WHERE expires_at<=?").bind(Date.now()).run()
  await env.DB.prepare('DELETE FROM desktop_requests WHERE expires_at<=?').bind(Date.now() - 86_400_000).run()
}
