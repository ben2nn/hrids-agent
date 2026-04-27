// 结构化日志系统 —— 支持级别控制、JSON 格式、文件持久化
import { existsSync, mkdirSync, appendFileSync, statSync, renameSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

export interface LogEntry {
  ts: string
  level: LogLevel
  msg: string
  [key: string]: unknown
}

const LOG_DIR = join(homedir(), '.hrids-agent', 'logs')
const LOG_FILE = join(LOG_DIR, 'agent.log')
// 单个日志文件上限 10MB，超出后轮转
const MAX_LOG_BYTES = 10 * 1024 * 1024

function ensureLogDir() {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true })
}

function rotateIfNeeded() {
  try {
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > MAX_LOG_BYTES) {
      renameSync(LOG_FILE, LOG_FILE + '.' + Date.now() + '.bak')
    }
  } catch { /* 轮转失败不影响主流程 */ }
}

class Logger {
  private minLevel: LogLevel
  // server 模式下 stdout 是 JSON 通信通道，日志只写文件
  private get serverMode() { return !!process.env.AGENT_SERVER_MODE }

  constructor() {
    const envLevel = process.env.LOG_LEVEL as LogLevel | undefined
    this.minLevel = envLevel && LEVEL_RANK[envLevel] !== undefined ? envLevel : 'info'
  }

  private write(level: LogLevel, msg: string, meta?: Record<string, unknown>) {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.minLevel]) return

    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...meta,
    }

    const line = JSON.stringify(entry)

    // 控制台输出（非 server 模式）
    if (!this.serverMode) {
      const prefix = { debug: '\x1b[90m[DBG]\x1b[0m', info: '\x1b[36m[INF]\x1b[0m', warn: '\x1b[33m[WRN]\x1b[0m', error: '\x1b[31m[ERR]\x1b[0m' }[level]
      const metaStr = meta && Object.keys(meta).length > 0 ? ' ' + JSON.stringify(meta) : ''
      process.stderr.write(`${prefix} ${entry.ts.slice(11, 23)} ${msg}${metaStr}\n`)
    }

    // 文件持久化（始终写入）
    try {
      ensureLogDir()
      rotateIfNeeded()
      appendFileSync(LOG_FILE, line + '\n', 'utf-8')
    } catch { /* 文件写入失败不影响主流程 */ }
  }

  debug(msg: string, meta?: Record<string, unknown>) { this.write('debug', msg, meta) }
  info(msg: string, meta?: Record<string, unknown>) { this.write('info', msg, meta) }
  warn(msg: string, meta?: Record<string, unknown>) { this.write('warn', msg, meta) }
  error(msg: string, meta?: Record<string, unknown>) { this.write('error', msg, meta) }

  // 创建带固定 meta 前缀的子 logger（如 logger.child({ component: 'gateway' })）
  child(defaultMeta: Record<string, unknown>): ChildLogger {
    return new ChildLogger(this, defaultMeta)
  }
}

class ChildLogger {
  constructor(private parent: Logger, private meta: Record<string, unknown>) {}
  debug(msg: string, extra?: Record<string, unknown>) { this.parent.debug(msg, { ...this.meta, ...extra }) }
  info(msg: string, extra?: Record<string, unknown>) { this.parent.info(msg, { ...this.meta, ...extra }) }
  warn(msg: string, extra?: Record<string, unknown>) { this.parent.warn(msg, { ...this.meta, ...extra }) }
  error(msg: string, extra?: Record<string, unknown>) { this.parent.error(msg, { ...this.meta, ...extra }) }
}

export type { ChildLogger }
export const logger = new Logger()
