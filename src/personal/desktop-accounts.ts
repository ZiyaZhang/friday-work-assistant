import { z } from 'zod'
import type { GitHubUserConnections } from '../github/user-connection.js'
import type { GmailConnections } from '../gmail/connection.js'
import { DeviceError } from './devices.js'

const provider = z.enum(['github', 'gmail'])
const command = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('account-list') }).strict(),
  z.object({ operation: z.literal('account-connect'), provider, method: z.enum(['oauth', 'token', 'send']).default('oauth') }).strict(),
  z.object({ operation: z.literal('account-disconnect'), provider, revision: z.number().int().nonnegative() }).strict(),
])
export class DesktopAccounts {
  constructor(private readonly d: { github?: GitHubUserConnections; gmail?: GmailConnections }) {}
  prepare(owner: string, raw: unknown, guard: () => void) {
    const parsed = command.safeParse(raw)
    if (!parsed.success) throw new DeviceError('invalid', '账号操作格式无效。')
    return () => {
      guard(); const value = parsed.data
      if (value.operation === 'account-list') return {
        github: { available: Boolean(this.d.github?.available), tokenAvailable: Boolean(this.d.github?.tokenAvailable), ...this.d.github?.view(owner) },
        gmail: { available: Boolean(this.d.gmail?.available), ...this.d.gmail?.view(owner) },
      }
      const connection = this.d[value.provider]
      if (!connection) throw new DeviceError('unavailable', '这个账号连接暂不可用。')
      if (value.operation === 'account-disconnect') { connection.disconnect(owner, value.revision); return { disconnected: true } }
      if (value.provider === 'github' && value.method === 'token') return this.d.github!.beginToken(owner)
      if (value.provider === 'gmail' && value.method === 'token' || value.provider === 'github' && value.method === 'send') throw new DeviceError('invalid', '不支持的连接方式。')
      return value.provider === 'gmail' ? this.d.gmail!.begin(owner, value.method === 'send') : this.d.github!.begin(owner)
    }
  }
}
