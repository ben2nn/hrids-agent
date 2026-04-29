// 会话持久化 —— 将对话历史保存到本地磁盘
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, rmSync, renameSync } from 'fs'
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
  lastUserMessage?: string // 最近一条用户消息的前 80 字
  workDir?: string // 该会话的独立工作目录
  /** 上次保存时已持久化的消息数，用于增量追加 */
  savedMessageCount?: number
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

  const transcriptPath = join(sessionDir, 'transcript.jsonl')
  const existing = loadSessionMeta(sessionId)
  const savedCount = existing?.savedMessageCount ?? 0

  if (savedCount === 0 || !existsSync(transcriptPath)) {
    // 首次保存或文件不存在：全量写入
    const lines = messages.map(m => JSON.stringify(m)).join('\n')
    writeFileSync(transcriptPath, lines + (lines ? '\n' : ''), 'utf-8')
  } else if (messages.length > savedCount) {
    // 增量追加：只写新增的消息
    const newLines = messages.slice(savedCount).map(m => JSON.stringify(m)).join('\n')
    appendFileSync(transcriptPath, newLines + '\n', 'utf-8')
  } else if (messages.length < savedCount) {
    // 消息数减少（发生了 compact/clearHistory）：全量重写
    const lines = messages.map(m => JSON.stringify(m)).join('\n')
    writeFileSync(transcriptPath, lines + (lines ? '\n' : ''), 'utf-8')
  }
  // messages.length === savedCount：无变化，跳过写入

  // 保存元数据
  const firstUserMsg = messages.find(
    m => m.role === 'user' && typeof m.content === 'string' &&
    !m.content.startsWith('[系统') && !m.content.startsWith('[上下文压缩]')
  )
  const title = typeof firstUserMsg?.content === 'string'
    ? firstUserMsg.content.slice(0, 60)
    : (existing?.title ?? '新对话')

  const lastUserMsg = [...messages].reverse().find(
    m => m.role === 'user' && typeof m.content === 'string' &&
    !m.content.startsWith('[系统') && !m.content.startsWith('[上下文压缩]')
  )
  const lastUserMessage = typeof lastUserMsg?.content === 'string'
    ? lastUserMsg.content.slice(0, 80)
    : undefined

  const meta: SessionMeta = {
    id: sessionId,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messageCount: messages.length,
    savedMessageCount: messages.length,
    model,
    title,
    lastUserMessage,
    workDir: workDir ?? existing?.workDir,
  }
  // 原子写入 meta.json：先写 .tmp 再 rename，防止并发写入时文件损坏
  const metaPath = join(sessionDir, 'meta.json')
  const metaTmp = metaPath + '.tmp'
  writeFileSync(metaTmp, JSON.stringify(meta, null, 2), 'utf-8')
  renameSync(metaTmp, metaPath)
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
    .filter(d => !d.name.startsWith('ephemeral-'))  // 过滤子智能体临时会话
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

/**
 * 清理过期会话（保留最近 N 个，删除超过 maxAgeDays 天的旧会话）
 * 同时清理 ephemeral- 前缀的临时会话（子智能体产生的，无需保留）。
 * 建议在应用启动时调用一次，避免 sessions/ 目录无限增长。
 */
export function pruneOldSessions(opts: {
  keepCount?: number   // 至少保留的会话数，默认 50
  maxAgeDays?: number  // 超过此天数的会话将被删除，默认 90 天
} = {}): number {
  const keepCount = opts.keepCount ?? 50
  const maxAgeDays = opts.maxAgeDays ?? 90
  const cutoff = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString()

  ensureDir(SESSIONS_DIR)
  let deleted = 0

  // 第一步：直接扫描目录，清理所有 ephemeral- 前缀的临时会话
  // 注意：listSessions() 已过滤 ephemeral-，所以必须直接读目录
  const allDirs = readdirSync(SESSIONS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
  for (const d of allDirs) {
    if (d.name.startsWith('ephemeral-')) {
      deleteSessionFromDisk(d.name)
      deleted++
    }
  }

  // 第二步：清理过期的普通会话（listSessions 已排除 ephemeral-）
  const sessions = listSessions() // 已按 updatedAt 倒序
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i]
    // 保留最近 keepCount 个，无论多旧
    if (i < keepCount) continue
    // 超过 maxAgeDays 的才删除
    if (s.updatedAt < cutoff) {
      deleteSessionFromDisk(s.id)
      deleted++
    }
  }

  return deleted
}

/**
 * 删除指定会话的所有数据（transcript、meta、归档文件等全部删除）。
 * 同时删除该会话的工作目录（~/.hrids-agent/work/<date>-<id>/）。
 * inMemoryCwd：活跃会话在内存中的 cwd，优先于 meta.json 里的 workDir（防止 meta 未写入的情况）。
 * 若目录不存在则静默忽略。
 */
export function deleteSessionFromDisk(sessionId: string, inMemoryCwd?: string): void {
  // 先读取 workDir（优先用内存传入的 cwd，其次读 meta.json）
  const meta = loadSessionMeta(sessionId)
  const workDir = inMemoryCwd ?? meta?.workDir

  // 删除会话历史目录
  const sessionDir = join(SESSIONS_DIR, sessionId)
  if (existsSync(sessionDir)) {
    rmSync(sessionDir, { recursive: true, force: true })
  }

  // 删除工作目录（仅删除 ~/.hrids-agent/work/ 下的子目录，防止误删用户自定义路径）
  if (workDir) {
    const workBase = join(homedir(), '.hrids-agent', 'work')
    // 安全检查：只删 work/ 下的目录，且不能是 work/ 本身
    if (workDir.startsWith(workBase + '/') || workDir.startsWith(workBase + '\\')) {
      if (existsSync(workDir)) {
        rmSync(workDir, { recursive: true, force: true })
      }
    }
  }
}
