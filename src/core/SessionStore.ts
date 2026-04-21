// 会话持久化 —— 将对话历史保存到本地磁盘
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { Message } from './QueryEngine.js'

/** 压缩归档段元数据 */
export interface CompactArchive {
  /** 归档文件名（不含路径），如 transcript.20250421-143022.archive.jsonl */
  filename: string
  /** 归档时间 ISO 字符串 */
  archivedAt: string
  /** 归档前的消息数量 */
  messageCount: number
  /** 本次压缩生成的摘要文本 */
  summary: string
}

const SESSIONS_DIR = join(homedir(), '.hrids-agent', 'sessions')

export interface SessionMeta {
  id: string
  createdAt: string
  updatedAt: string
  messageCount: number
  model: string
  title: string // 第一条用户消息的前 60 字
  workDir?: string // 该会话的独立工作目录
}

function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

export function saveSession(
  sessionId: string,
  messages: readonly Message[],
  model: string,
  workDir?: string,
) {
  ensureDir(SESSIONS_DIR)
  const sessionDir = join(SESSIONS_DIR, sessionId)
  ensureDir(sessionDir)

  // 保存消息历史（JSONL 格式，每行一条消息）
  const lines = messages.map(m => JSON.stringify(m)).join('\n')
  writeFileSync(join(sessionDir, 'transcript.jsonl'), lines, 'utf-8')

  // 保存元数据
  const firstUserMsg = messages.find(m => m.role === 'user')
  const title = typeof firstUserMsg?.content === 'string'
    ? firstUserMsg.content.slice(0, 60)
    : '新对话'

  const existing = loadSessionMeta(sessionId)
  const meta: SessionMeta = {
    id: sessionId,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messageCount: messages.length,
    model,
    title,
    workDir: workDir ?? existing?.workDir,
  }
  writeFileSync(join(sessionDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8')
}

export function loadSession(sessionId: string): Message[] | null {
  const transcriptPath = join(SESSIONS_DIR, sessionId, 'transcript.jsonl')
  if (!existsSync(transcriptPath)) return null

  const lines = readFileSync(transcriptPath, 'utf-8').split('\n').filter(Boolean)
  return lines.map(l => JSON.parse(l) as Message)
}

export function loadSessionMeta(sessionId: string): SessionMeta | null {
  const metaPath = join(SESSIONS_DIR, sessionId, 'meta.json')
  if (!existsSync(metaPath)) return null
  return JSON.parse(readFileSync(metaPath, 'utf-8')) as SessionMeta
}

export function listSessions(): SessionMeta[] {
  ensureDir(SESSIONS_DIR)
  const dirs = readdirSync(SESSIONS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => loadSessionMeta(d.name))
    .filter((m): m is SessionMeta => m !== null)

  // 按更新时间倒序
  return dirs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export function generateSessionId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** 获取最近一次会话的 ID，没有历史会话时返回 null */
export function getLastSessionId(): string | null {
  const sessions = listSessions()
  return sessions.length > 0 ? sessions[0].id : null
}

/**
 * 归档当前会话历史（压缩前调用）
 * 将 transcript.jsonl 重命名为 transcript.{timestamp}.archive.jsonl
 * 同时保存归档元数据到 archives.json
 */
export function archiveSession(sessionId: string, summary: string): string {
  const sessionDir = join(SESSIONS_DIR, sessionId)
  const transcriptPath = join(sessionDir, 'transcript.jsonl')
  
  if (!existsSync(transcriptPath)) {
    throw new Error(`会话 ${sessionId} 的 transcript.jsonl 不存在，无法归档`)
  }

  // 读取当前历史消息数量
  const lines = readFileSync(transcriptPath, 'utf-8').split('\n').filter(Boolean)
  const messageCount = lines.length

  // 生成归档文件名：transcript.{YYYYMMDD-HHmmss}.archive.jsonl
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const archiveFilename = `transcript.${timestamp}.archive.jsonl`
  const archivePath = join(sessionDir, archiveFilename)

  // 复制（而非移动）transcript.jsonl 到归档文件，保留原文件供后续覆盖
  writeFileSync(archivePath, readFileSync(transcriptPath, 'utf-8'), 'utf-8')

  // 更新归档元数据列表
  const archivesPath = join(sessionDir, 'archives.json')
  let archives: CompactArchive[] = []
  if (existsSync(archivesPath)) {
    try {
      archives = JSON.parse(readFileSync(archivesPath, 'utf-8')) as CompactArchive[]
    } catch { /* 解析失败时重置为空数组 */ }
  }

  archives.push({
    filename: archiveFilename,
    archivedAt: now.toISOString(),
    messageCount,
    summary,
  })

  writeFileSync(archivesPath, JSON.stringify(archives, null, 2), 'utf-8')

  return archiveFilename
}

/**
 * 读取会话的所有归档段元数据
 */
export function listArchives(sessionId: string): CompactArchive[] {
  const archivesPath = join(SESSIONS_DIR, sessionId, 'archives.json')
  if (!existsSync(archivesPath)) return []
  
  try {
    const data = JSON.parse(readFileSync(archivesPath, 'utf-8')) as CompactArchive[]
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

/**
 * 读取指定归档段的完整消息历史
 */
export function loadArchive(sessionId: string, filename: string): Message[] | null {
  const archivePath = join(SESSIONS_DIR, sessionId, filename)
  if (!existsSync(archivePath)) return null

  try {
    const lines = readFileSync(archivePath, 'utf-8').split('\n').filter(Boolean)
    return lines.map(l => JSON.parse(l) as Message)
  } catch {
    return null
  }
}
