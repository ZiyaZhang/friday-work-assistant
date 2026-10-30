import { createCipheriv, createDecipheriv, createHash, createHmac, createPublicKey, privateDecrypt, publicEncrypt, randomBytes, timingSafeEqual, constants } from 'node:crypto'

/** Only the paired desktop and Friday hold the content key. The public relay sees ciphertext. */
export function sealDevice(key: Buffer, value: unknown, purpose: string): string {
  if (key.length !== 32) throw new Error('Invalid device key')
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(purpose))
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()])
  return [iv, cipher.getAuthTag(), data].map(v => v.toString('base64url')).join('.')
}

export function openDevice<T>(key: Buffer, payload: string, purpose: string): T {
  const parts = payload.split('.')
  if (key.length !== 32 || parts.length !== 3 || !parts.every(p => /^[A-Za-z0-9_-]+$/.test(p))) throw new Error('Invalid device envelope')
  const [iv, tag, data] = parts.map(p => Buffer.from(p, 'base64url'))
  if (iv!.length !== 12 || tag!.length !== 16) throw new Error('Invalid device envelope')
  const cipher = createDecipheriv('aes-256-gcm', key, iv!)
  cipher.setAAD(Buffer.from(purpose)); cipher.setAuthTag(tag!)
  return JSON.parse(Buffer.concat([cipher.update(data!), cipher.final()]).toString()) as T
}

export function devicePublicKey(der: string): { fingerprint: string } {
  if (!/^[A-Za-z0-9_-]{392}$/.test(der)) throw new Error('Invalid desktop public key')
  const key = createPublicKey({ key: Buffer.from(der, 'base64url'), format: 'der', type: 'spki' })
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength !== 2048) throw new Error('Invalid desktop public key')
  return { fingerprint: createHash('sha256').update(Buffer.from(der, 'base64url')).digest('hex').slice(0, 16).toUpperCase().match(/.{4}/g)!.join(' ') }
}

export function sealPairing(der: string, value: unknown, purpose: string): { key: string; body: string } {
  devicePublicKey(der)
  const key = randomBytes(32)
  return { key: publicEncrypt({ key: createPublicKey({ key: Buffer.from(der, 'base64url'), format: 'der', type: 'spki' }),
    padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key).toString('base64url'), body: sealDevice(key, value, purpose) }
}

export function openPairing<T>(privateKey: string, envelope: { key: string; body: string }, purpose: string): T {
  const key = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(envelope.key, 'base64url'))
  return openDevice<T>(key, envelope.body, purpose)
}

/** A relay ticket authorizes bounded transport only; the host checks the current device for every operation. */
export function deviceTicket(secret: string, id: string, expires: number): string {
  const value = `fd1.${id}.${expires}`
  return `${value}.${createHmac('sha256', secret).update(`friday-device-ticket:${value}`).digest('base64url')}`
}
export function verifyDeviceTicket(secret: string, ticket: string, now: number): { id: string; expires: number } {
  if (!/^fd1\.[a-f0-9-]{36}\.\d{13}\.[A-Za-z0-9_-]{43}$/.test(ticket)) throw new Error('Invalid device ticket')
  const [, id, time] = ticket.split('.'), expires = Number(time), expected = deviceTicket(secret, id!, expires)
  if (expires <= now || ticket.length !== expected.length || !timingSafeEqual(Buffer.from(ticket), Buffer.from(expected))) throw new Error('Device connection expired')
  return { id: id!, expires }
}

export function deviceEnvelopePurpose(id: string, request: string, direction: 'request' | 'response'): string {
  return `friday-device:v1:${id}:${request}:${direction}`
}
