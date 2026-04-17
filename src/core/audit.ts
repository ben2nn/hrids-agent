// 审计日志 —— 记录所有写操作、权限检查、bash 命令执行
import { existsSync, mkdirSync, appendFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const AUDIT_DIR = join(homedir(), '.hrids-agent', 'logs')
const AUDIT_FILE = join(AUDIT_DIR, 'audit.log')

export type AuditAction =
  | 'file_write'
  | 'file_edit'
  | 'file_delete'
  | 'bash_execute'
  | 'powershell_execute'
  | 'permission_check'
  | 'permission_denied'
  | 'session_create'
  | 'session_destroy'
  | 'skillhub_config_set'
  | 'skillhub_install_cli'
  | 'skillhub_setup'
  | 'skillhub_uninstall'
  | 'skillhub_upgrade'

export interface AuditEntry {
  ts: string
  sessionId?: string
  action: AuditAction
  resource: string          // 文件路径、命令内容等
  result: 'allowed' | 'denied' | 'error'
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
