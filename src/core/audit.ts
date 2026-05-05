// 审计日志 —— 记录所有写操作、权限检查、bash 命令执行
import { existsSync, mkdirSync, appendFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const AUDIT_DIR = join(homedir(), '.hrids-agent', 'logs')
const AUDIT_FILE = join(AUDIT_DIR, 'audit.log')

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

export function auditLog(entry: Omit<AuditEntry, 'ts'>) {
  const full: AuditEntry = { ts: new Date().toISOString(), ...entry }
  try {
    ensureDir()
    appendFileSync(AUDIT_FILE, JSON.stringify(full) + '\n', 'utf-8')
  } catch { /* 审计写入失败不影响主流程 */ }
}
