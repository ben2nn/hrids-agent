// 会话持久化 —— 将对话历史保存到本地磁盘
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { Message } from './QueryEngine.js'

const SESSIONS_DIR = join(homedir(), '.hrids-agent', 'sessions')

export interface SessionMeta {
  id: string
  createdAt: string
  updatedAt: string
  messageCount: number
  model: string
  title: string // 第一条用户消息的前 60 字
}

function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

export function saveSession(
  sessionId: string,
  messages: readonly Message[],
  model: string,
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
