// 审计日志 —— 记录所有写操作、权限检查、bash 命令执行
import { existsSync, mkdirSync, appendFileSync, statSync, renameSync } from 'fs'
import { join } from 'path'
import { getConfigDir } from './Config.js'

const AUDIT_DIR = join(getConfigDir(), 'logs')
const AUDIT_FILE = join(AUDIT_DIR, 'audit.log')
const MAX_AUDIT_SIZE = 50 * 1024 * 1024 // 50MB

// 开放字符串类型，新增工具无需修改此文件
// 建议格式：<模块>_<动作>，如 file_write、bash_execute、skillhub_install
export type AuditAction = string

export interface AuditEntry {
  ts: string
  sessionId?: string
  action: AuditAction
  resource: string          // 文件路径、命令内容等
  result: 'allowed' | 'denied' | 'error'
  permissionMode?: string   // 拒绝时记录当时的权限模式，便于诊断
  details?: Record<string, unknown>
}

function ensureDir() {
  if (!existsSync(AUDIT_DIR)) mkdirSync(AUDIT_DIR, { recursive: true })
}

/** 日志轮转：超过大小限制时重命名为 .old（保留最近一份） */
function rotateIfNeeded() {
  try {
    if (!existsSync(AUDIT_FILE)) return
    const stat = statSync(AUDIT_FILE)
    if (stat.size > MAX_AUDIT_SIZE) {
      const rotated = AUDIT_FILE + '.old'
      renameSync(AUDIT_FILE, rotated)
    }
  } catch { /* 轮转失败不阻塞写入 */ }
}

export function auditLog(entry: Omit<AuditEntry, 'ts'>) {
  const full: AuditEntry = { ts: new Date().toISOString(), ...entry }
  try {
    ensureDir()
    rotateIfNeeded()
    appendFileSync(AUDIT_FILE, JSON.stringify(full) + '\n', 'utf-8')
  } catch (err) {
    // 审计写入失败不影响主流程，但记录到 stderr 便于排查
    process.stderr.write(`[audit] 写入失败: ${err instanceof Error ? err.message : String(err)}\n`)
  }
}
