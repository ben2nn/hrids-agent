// 会话持久化 —— 将对话历史保存到本地磁盘
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, renameSync } from 'fs'
import { join } from 'path'
import type { ConversationEvent } from './ConversationStore.js'
import { getConfigDir } from './Config.js'

/** 压缩归档段元数据 */
export interface CompactArchive {
  /** 归档文件名（不含路径），如 events.20250421-143022.archive.jsonl */
  filename: string
  /** 归档时间 ISO 字符串 */
  archivedAt: string
  /** 归档前的事件数量 */
  messageCount: number
  /** 本次压缩生成的摘要文本 */
  summary: string
}

const SESSIONS_DIR = join(getConfigDir(), 'sessions')

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
  /** 所属智能体名称（如 main），子智能体由 AgentTool/AgentPool 标记 */
  agent?: string
}

function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

/** 从事件日志中提取会话标题（首条用户消息前 60 字）和最近用户消息（末条前 80 字） */
export function extractSessionTitle(events: readonly ConversationEvent[]): { title?: string; lastUserMessage?: string } {
  let title: string | undefined
  let lastUserMessage: string | undefined
  for (const ev of events) {
    if (ev.type === 'user_message' && ev.content && !ev.content.startsWith('[系统') && !ev.content.startsWith('[上下文压缩]')) {
      if (!title) title = ev.content.slice(0, 60)
      lastUserMessage = ev.content.slice(0, 80)
    }
  }
  return { title, lastUserMessage }
}

/**
 * 加载会话的事件日志。
 * 从 events.jsonl 加载，返回 null 表示文件不存在。
 */
export function loadSessionEvents(sessionId: string): ConversationEvent[] | null {
  const sessionDir = join(SESSIONS_DIR, sessionId)
  const eventsPath = join(sessionDir, 'events.jsonl')

  if (existsSync(eventsPath)) {
    try {
      const content = readFileSync(eventsPath, 'utf-8')
      if (!content.trim()) return []
      return content
        .split('\n')
        .filter(line => line.trim())
        .map(line => JSON.parse(line) as ConversationEvent)
    } catch {
      // 事件文件损坏时返回空数组，避免阻塞会话创建
      return []
    }
  }

  // 没有 events.jsonl，返回 null
  return null
}

/**
 * 仅保存会话元数据。
 * 用于事件溯源模式下更新 meta.json（title、updatedAt、messageCount 等）。
 */
export function saveSessionMeta(
  sessionId: string,
  opts: { model?: string; workDir?: string; agent?: string; eventCount?: number; title?: string; lastUserMessage?: string },
): void {
  const sessionDir = join(SESSIONS_DIR, sessionId)
  ensureDir(sessionDir)

  const existing = loadSessionMeta(sessionId)
  const now = new Date().toISOString()

  const meta: SessionMeta = {
    id: sessionId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    messageCount: opts.eventCount ?? existing?.messageCount ?? 0,
    savedMessageCount: opts.eventCount ?? existing?.savedMessageCount ?? 0,
    model: opts.model ?? existing?.model ?? '',
    title: opts.title ?? existing?.title ?? '新对话',
    lastUserMessage: opts.lastUserMessage ?? existing?.lastUserMessage,
    workDir: opts.workDir ?? existing?.workDir,
    agent: opts.agent ?? existing?.agent ?? 'main',
  }

  const metaPath = join(sessionDir, 'meta.json')
  const metaTmp = metaPath + '.tmp'
  writeFileSync(metaTmp, JSON.stringify(meta, null, 2), 'utf-8')
  renameSync(metaTmp, metaPath)
}

export function loadSessionMeta(sessionId: string): SessionMeta | null {
  const metaPath = join(SESSIONS_DIR, sessionId, 'meta.json')
  if (!existsSync(metaPath)) return null
  try {
    return JSON.parse(readFileSync(metaPath, 'utf-8')) as SessionMeta
  } catch {
    return null
  }
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
 * 将 events.jsonl 复制为 events.{timestamp}.archive.jsonl
 * 同时保存归档元数据到 archives.json
 */
export function archiveSession(sessionId: string, summary: string): string {
  const sessionDir = join(SESSIONS_DIR, sessionId)
  const eventsPath = join(sessionDir, 'events.jsonl')

  if (!existsSync(eventsPath)) {
    throw new Error(`会话 ${sessionId} 的 events.jsonl 不存在，无法归档`)
  }

  // 读取当前事件数量
  const content = readFileSync(eventsPath, 'utf-8')
  const eventCount = content.split('\n').filter(line => {
    const trimmed = line.trim()
    if (!trimmed) return false
    // 跳过 schema marker 行
    try { return !JSON.parse(trimmed).$schema } catch { return false }
  }).length

  // 生成归档文件名
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const archiveFilename = `events.${timestamp}.archive.jsonl`
  const archivePath = join(sessionDir, archiveFilename)

  // 复制 events.jsonl 到归档文件
  writeFileSync(archivePath, content, 'utf-8')

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
    messageCount: eventCount,
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
 * 读取指定归档段的事件日志
 */
export function loadArchive(sessionId: string, filename: string): ConversationEvent[] | null {
  const archivePath = join(SESSIONS_DIR, sessionId, filename)
  if (!existsSync(archivePath)) return null

  try {
    const content = readFileSync(archivePath, 'utf-8')
    if (!content.trim()) return []
    return content
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line))
      .filter(obj => !obj.$schema) as ConversationEvent[]
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
 * 删除指定会话的所有数据（events、meta、归档文件等全部删除）。
 * 同时删除该会话的工作目录（~/.hrids/work/<date>-<id>/）。
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

  // 删除工作目录（仅删除 ~/.hrids/work/ 下的子目录，防止误删用户自定义路径）
  if (workDir) {
    const workBase = join(getConfigDir(), 'work')
    // 安全检查：只删 work/ 下的目录，且不能是 work/ 本身
    if (workDir.startsWith(workBase + '/') || workDir.startsWith(workBase + '\\')) {
      if (existsSync(workDir)) {
        rmSync(workDir, { recursive: true, force: true })
      }
    }
  }
}
