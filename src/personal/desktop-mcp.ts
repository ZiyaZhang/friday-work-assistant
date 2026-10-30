import { z } from 'zod'
import { DeviceError } from './devices.js'
import { mcpConnect, type PersonalMcpConnections } from './mcp-connections.js'

const identity = { id: z.uuid(), revision: z.number().int().positive() }
const command = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('mcp-list') }).strict(),
  mcpConnect.extend({ operation: z.literal('mcp-connect') }).strict(),
  z.object({ operation: z.literal('mcp-configure'), ...identity, automatic: z.array(z.string().min(1).max(200)).max(100) }).strict(),
  z.object({ operation: z.literal('mcp-disconnect'), ...identity }).strict(),
])
export class DesktopMcp {
  constructor(private readonly connections: PersonalMcpConnections) {}
  async prepare(owner: string, raw: unknown, guard: () => void) {
    const parsed = command.safeParse(raw)
    if (!parsed.success) throw new DeviceError('invalid', 'MCP 连接操作格式无效。')
    guard(); const { operation, ...input } = parsed.data
    if (parsed.data.operation === 'mcp-connect') return this.connections.prepareConnect(owner, input, guard)
    return () => {
      guard(); const value = parsed.data
      if (value.operation === 'mcp-list') return { connections: this.connections.list(owner), calls: this.connections.calls(owner) }
      if (value.operation === 'mcp-configure') return this.connections.configure(owner, value.id, value.revision, value.automatic)
      if (value.operation === 'mcp-disconnect') return this.connections.disconnect(owner, value.id, value.revision)
      throw new DeviceError('invalid', '请重新连接。')
    }
  }
}
