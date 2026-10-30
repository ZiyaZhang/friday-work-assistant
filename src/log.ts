/**
 * 极简结构化日志：stderr 输出一行 JSON，方便 systemd/tmux 里 grep。
 * stdout 留给 MCP stdio 传输（friday-lark-mcp 进程里绝不能往 stdout 写日志）。
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void
  info(msg: string, data?: Record<string, unknown>): void
  warn(msg: string, data?: Record<string, unknown>): void
  error(msg: string, data?: Record<string, unknown>): void
  child(scope: string): Logger
}

export function createLogger(scope: string, level: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info'): Logger {
  const min = ORDER[level] ?? ORDER.info
  const emit = (lvl: LogLevel, msg: string, data?: Record<string, unknown>): void => {
    if (ORDER[lvl] < min) return
    const line = { t: new Date().toISOString(), lvl, scope, msg, ...(data ?? {}) }
    process.stderr.write(JSON.stringify(line, safeReplacer) + '\n')
  }
  return {
    debug: (m, d) => emit('debug', m, d),
    info: (m, d) => emit('info', m, d),
    warn: (m, d) => emit('warn', m, d),
    error: (m, d) => emit('error', m, d),
    child: (s) => createLogger(`${scope}:${s}`, level),
  }
}

function safeReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack }
  if (typeof value === 'bigint') return value.toString()
  return value
}
