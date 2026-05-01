// Gateway HTTP + WebSocket 服务器
import http from 'http'
import express from 'express'
import { WebSocketServer, WebSocket } from 'ws'
import { execSync } from 'child_process'
import { randomBytes } from 'crypto'
import jwt from 'jsonwebtoken'
import { SessionManager } from './SessionManager.js'
import { listSessions as listDiskSessions, loadSession as loadDiskSession, loadSessionMeta, listArchives as listSessionArchives, loadArchive as loadSessionArchive, deleteSessionFromDisk } from '../core/SessionStore.js'
import { logger } from '../core/logger.js'
import type { CreateSessionRequest } from './types.js'
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, renameSync } from 'fs'
import { resolve, join, basename, extname } from 'path'
import { homedir } from 'os'
import { loadConfig, saveConfig } from '../core/Config.js'
import mammoth from 'mammoth'
import * as XLSX from 'xlsx'
import { PlatformManager } from './im/PlatformManager.js'
import type { IMGatewayConfig, IMPlatform, PlatformConfig } from './im/types.js'

const log = logger.child({ component: 'gateway-server' })

/** 原子写入 JSON 文件：先写 .tmp 再 rename，防止并发写入时文件损坏 */
function atomicWriteJson(filePath: string, data: unknown): void {
  const tmp = filePath + '.tmp'
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
  renameSync(tmp, filePath)
}

// ── 消息格式转换 ──────────────────────────────────────────────────────────────

export interface DisplayMessage {
  id: string
  type: string
  content?: string
  toolId?: string
  toolName?: string
  toolInput?: unknown
  toolStatus?: 'success' | 'error'
  toolResult?: unknown
  images?: string[]
  isCron?: boolean
  cronDescription?: string
  requestId?: string
  timestamp: number
}

const IMAGE_PATTERN = /@([^\s]+\.(jpg|jpeg|png|gif|webp|svg|bmp|ico|tiff|tif))/gi

/**
 * 将原始 Message[] 转换为前端 DisplayMessage[]。
 * 两处端点（/messages 和 /history-segments/:filename/messages）共用此函数。
 *
 * @param rawMessages 原始消息列表
 * @param idPrefix    消息 ID 前缀，用于区分来源（'' 或 'arc-'）
 */
function formatMessagesForDisplay(
  rawMessages: readonly import('../core/QueryEngine.js').Message[],
  idPrefix = '',
): DisplayMessage[] {
  // 第一遍：建立 toolId → result 映射
  type ToolResultEntry = { content: unknown; isError: boolean }
  const toolResults = new Map<string, ToolResultEntry>()
  for (const msg of rawMessages) {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
    for (const block of msg.content as Array<{ type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }>) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        toolResults.set(block.tool_use_id, {
          content: block.content,
          isError: block.is_error === true,
        })
      }
    }
  }

  // 第二遍：构建 DisplayMessage 列表
  const displayMessages: DisplayMessage[] = []
  let idx = 0
  const baseTs = Date.now()

  for (const msg of rawMessages) {
    // 优先使用消息自带的 timestamp，无则用序号估算（兼容旧历史数据）
    const timestamp = msg.timestamp ?? (baseTs - (rawMessages.length - idx) * 1000)
    idx++

    if (msg.role === 'user') {
      if (typeof msg.content !== 'string') continue
      if (msg.content.startsWith('[系统') || msg.content.startsWith('[上下文压缩]')) continue

      const images: string[] = []
      IMAGE_PATTERN.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = IMAGE_PATTERN.exec(msg.content)) !== null) {
        images.push(match[1])
      }

      displayMessages.push({
        id: `${idPrefix}u-${idx}`,
        type: 'user',
        content: msg.content,
        timestamp,
        ...(images.length > 0 ? { images } : {}),
      })
    } else if (msg.role === 'assistant') {
      const isCron = msg.trigger === 'cron'
      const requestId = msg.requestId
      const cronDescription = msg.cronDescription

      if (typeof msg.content === 'string') {
        if (msg.content.trim()) {
          displayMessages.push({
            id: `${idPrefix}a-${idx}`,
            type: 'assistant',
            content: msg.content,
            timestamp,
            ...(isCron ? { isCron: true } : {}),
            ...(cronDescription ? { cronDescription } : {}),
            ...(requestId ? { requestId } : {}),
          })
        }
      } else if (Array.isArray(msg.content)) {
        const textParts = (msg.content as Array<{ type: string; text?: string }>)
          .filter(b => b.type === 'text')
          .map(b => b.text ?? '')
          .join('')
        if (textParts.trim()) {
          displayMessages.push({
            id: `${idPrefix}a-${idx}`,
            type: 'assistant',
            content: textParts,
            timestamp,
            ...(isCron ? { isCron: true } : {}),
            ...(cronDescription ? { cronDescription } : {}),
            ...(requestId ? { requestId } : {}),
          })
        }
        for (const block of msg.content as Array<{ type: string; id?: string; name?: string; input?: unknown }>) {
          if (block.type === 'tool_use' && block.id && block.name) {
            const resultEntry = toolResults.get(block.id)
            displayMessages.push({
              id: `${idPrefix}t-${block.id}`,
              type: 'tool',
              toolId: block.id,
              toolName: block.name,
              toolInput: block.input,
              toolStatus: resultEntry ? (resultEntry.isError ? 'error' : 'success') : 'success',
              toolResult: resultEntry?.content,
              timestamp: timestamp + 1,
              ...(requestId ? { requestId } : {}),
            })
          }
        }
      }
    }
  }

  return displayMessages
}

export interface GatewayConfig {
  port?: number
  host?: string
  authToken?: string       // Token 模式：若设置，所有请求需携带 Authorization: Bearer <token>
  idleTimeoutMs?: number
  maxSessions?: number
  rateLimitPerMinute?: number
  corsOrigin?: string
  // 登录模式：配置用户列表后启用，登录成功颁发 JWT
  users?: Array<{ username: string; password: string }>
  // JWT 签名密钥（登录模式自动生成，也可手动指定）
  jwtSecret?: string
}

// 简单的内存速率限制（令牌桶，按 IP 计数）
class RateLimiter {
  private counts = new Map<string, { count: number; resetAt: number }>()
  constructor(private limit: number, private windowMs = 60_000) {}

  check(ip: string): boolean {
    const now = Date.now()
    const entry = this.counts.get(ip)
    if (!entry || now > entry.resetAt) {
      // 顺手清理已过期的条目，防止长期运行内存泄漏
      if (this.counts.size > 10_000) {
        for (const [k, v] of this.counts) {
          if (now > v.resetAt) this.counts.delete(k)
        }
      }
      this.counts.set(ip, { count: 1, resetAt: now + this.windowMs })
      return true
    }
    if (entry.count >= this.limit) return false
    entry.count++
    return true
  }
}

export function createGateway(config: GatewayConfig = {}) {
  const port = config.port ?? 3282
  const host = config.host ?? '127.0.0.1'
  const startTime = Date.now()

  // ── 鉴权模式判断 ──────────────────────────────────────────────
  // 登录模式：配置了 users 列表
  // Token 模式：配置了 authToken（静态 token）
  // 无鉴权：两者都未配置
  const hasUsers = (config.users ?? []).length > 0
  const hasStaticToken = !!config.authToken

  // 登录模式下的 JWT 密钥（启动时生成随机密钥，或使用配置中的密钥）
  const jwtSecret = config.jwtSecret
    ?? (hasUsers ? randomBytes(32).toString('hex') : '')

  /** 验证 Bearer token（自动去除 "Bearer " 前缀） */
  function verifyToken(authHeader: string): boolean {
    const bearer = authHeader.replace(/^Bearer\s+/i, '')
    return verifyRawToken(bearer)
  }

  /** 验证裸 token（不含 "Bearer " 前缀） */
  function verifyRawToken(token: string): boolean {
    if (!token) return false
    if (hasStaticToken) {
      return token === config.authToken
    }
    if (hasUsers) {
      try {
        jwt.verify(token, jwtSecret)
        return true
      } catch {
        return false
      }
    }
    return true // 无鉴权模式
  }

  const manager = new SessionManager({
    idleTimeoutMs: config.idleTimeoutMs,
    maxSessions: config.maxSessions,
    authToken: config.authToken,
  })

  // IM 平台管理器（多 IM 平台接入）
  const platformManager = new PlatformManager(manager)

  const rateLimiter = new RateLimiter(config.rateLimitPerMinute ?? 10)

  const app = express()
  app.use(express.json({ limit: '50mb' }))

  // ── CORS 中间件（在所有 API 路由之前）──────────────────────
  const corsOrigin = config.corsOrigin ?? '*'
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', corsOrigin)
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    if (req.method === 'OPTIONS') {
      res.status(204).end()
      return
    }
    next()
  })

  // ── 登录接口（在鉴权中间件之前，无需 token）──────────────────
  app.post('/api/login', (req, res) => {
    const { username, password } = req.body as { username?: string; password?: string }
    const users = config.users ?? []

    if (users.length === 0) {
      // 无鉴权模式：直接返回静态 token（可能为空）
      res.json({ token: config.authToken ?? '', mode: 'none' })
      return
    }

    const matched = users.find(u => u.username === username && u.password === password)
    if (!matched) {
      log.warn('登录失败', { username, ip: req.ip })
      res.status(401).json({ error: '用户名或密码错误' })
      return
    }

    log.info('登录成功', { username, ip: req.ip })

    if (hasStaticToken) {
      // Token 模式：验证用户身份后返回静态 token
      res.json({ token: config.authToken!, mode: 'token' })
    } else {
      // 登录模式：签发 JWT（7 天有效期）
      const token = jwt.sign(
        { username, iat: Math.floor(Date.now() / 1000) },
        jwtSecret,
        { expiresIn: '7d' }
      )
      res.json({ token, mode: 'jwt' })
    }
  })

  // 健康检查（在鉴权中间件之前，无需 token）
  app.get('/health', (_req, res) => {
    const sessions = manager.listSessions()
    const busySessions = sessions.filter(s => s.status === 'busy').length
    const memUsage = process.memoryUsage()
    // 鉴权模式：none | token | login
    const authMode = hasUsers ? (hasStaticToken ? 'token' : 'login') : 'none'
    res.json({
      status: 'ok',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      authMode,
      sessions: {
        total: sessions.length,
        busy: busySessions,
        idle: sessions.length - busySessions,
      },
      memory: {
        heapUsedMb: Math.round(memUsage.heapUsed / 1024 / 1024),
        heapTotalMb: Math.round(memUsage.heapTotal / 1024 / 1024),
        rssMb: Math.round(memUsage.rss / 1024 / 1024),
      },
    })
  })

  // ── 静态文件托管（鉴权之前，前端资源无需 token）────────────────
  const webDistPath = join(resolve('.'), 'dist', 'web')
  if (existsSync(webDistPath)) {
    log.info('托管前端静态文件', { path: webDistPath })
    app.use(express.static(webDistPath))
    // SPA fallback：非 API 的 GET 请求一律返回 index.html
    app.get('/{*splat}', (req, res, next) => {
      if (req.path.startsWith('/api/') || req.path.startsWith('/sessions') ||
          req.path.startsWith('/todos') || req.path.startsWith('/crons') ||
          req.path.startsWith('/skills') || req.path.startsWith('/mcp') ||
          req.path.startsWith('/config')) {
        return next()
      }
      res.sendFile(join(webDistPath, 'index.html'))
    })
  }

  // ── 鉴权中间件（仅保护 API，静态文件已在上方放行）────────────
  app.use((req, res, next) => {
    // 无鉴权模式：直接放行
    if (!hasUsers && !hasStaticToken) return next()
    // 非 API 路径（前端静态资源）：直接放行
    const isApiPath = req.path.startsWith('/api/') || req.path.startsWith('/sessions') ||
      req.path.startsWith('/todos') || req.path.startsWith('/crons') ||
      req.path.startsWith('/skills') || req.path.startsWith('/mcp') ||
      req.path.startsWith('/config')
    if (!isApiPath) return next()
    const auth = req.headers.authorization ?? ''
    if (verifyToken(auth)) return next()
    log.warn('未授权请求', { path: req.path, ip: req.ip })
    res.status(401).json({ error: '未授权' })
  })

  // ── REST API ─────────────────────────────────────────────────

  // 列出所有会话
  app.get('/sessions', (_req, res) => {
    res.json(manager.listSessions())
  })

  // 列出历史会话（从磁盘读取，包含已停止的会话）
  app.get('/sessions/history', (_req, res) => {
    try {
      const diskSessions = listDiskSessions()
      const activeSessions = manager.listSessions()
      const activeIds = new Set(activeSessions.map(s => s.id))

      // 合并：活跃 session 用内存数据，历史 session 转为 stopped 状态
      const history = diskSessions
        .filter(s => !activeIds.has(s.id))
        .map(s => ({
          id: s.id,
          status: 'stopped' as const,
          createdAt: new Date(s.createdAt).getTime(),
          lastActiveAt: new Date(s.updatedAt).getTime(),
          model: s.model ?? '',
          cwd: s.workDir ?? '',
          title: s.title ?? '',
          lastUserMessage: s.lastUserMessage,
        }))

      res.json([...activeSessions, ...history])
    } catch (err) {
      log.warn('读取历史会话失败', { error: String(err) })
      res.json(manager.listSessions())
    }
  })

  // 创建新会话（带速率限制）
  app.post('/sessions', async (req, res) => {
    const ip = req.ip ?? 'unknown'
    if (!rateLimiter.check(ip)) {
      log.warn('速率限制触发', { ip })
      res.status(429).json({ error: '请求过于频繁，请稍后再试' })
      return
    }
    try {
      const body = req.body as CreateSessionRequest
      const session = await manager.createSession(body)
      // 返回完整的 SessionInfo，前端直接使用 session.id 等字段
      res.json(session.info)
    } catch (err) {
      log.error('创建会话失败', { error: String(err) })
      res.status(500).json({ error: String(err) })
    }
  })

  // 查询单个会话状态
  app.get('/sessions/:id', (req, res) => {
    const session = manager.getSession(req.params.id)
    if (!session) return res.status(404).json({ error: '会话不存在' })
    res.json(session.info)
  })

  // 销毁会话
  app.delete('/sessions/:id', async (req, res) => {
    const id = req.params.id
    // 在 destroySession 之前先取内存中的 cwd（destroySession 会把 session 从 Map 删掉）
    const inMemoryCwd = manager.getSession(id)?.info.cwd
    await manager.destroySession(id)
    // 同时删除磁盘上的会话数据和工作目录，避免刷新后重新出现
    deleteSessionFromDisk(id, inMemoryCwd)
    res.json({ ok: true })
  })

  // GET /config — 读取 agent 全局配置（模型、权限模式等）
  app.get('/config', (_req, res) => {
    try {
      const cfg = loadConfig()
      res.json({
        model: cfg.model,
        permissionMode: cfg.permissionMode,
        maxTokens: cfg.maxTokens,
        maxTurns: cfg.maxTurns,
      })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  // PUT /config — 更新 agent 全局配置
  app.put('/config', (req, res) => {
    try {
      const body = req.body as { model?: string; permissionMode?: string }
      const patch: Record<string, unknown> = {}
      if (body.model) patch.model = body.model
      if (body.permissionMode && ['ask', 'craft', 'plan'].includes(body.permissionMode)) {
        patch.permissionMode = body.permissionMode
      }
      saveConfig(patch)
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  // GET /config/zhile-session — 读取知了专属会话 ID
  app.get('/config/zhile-session', (_req, res) => {
    const file = join(homedir(), '.hrids-agent', 'zhile-session.json')
    if (!existsSync(file)) { res.json({ sessionId: null }); return }
    try {
      const data = JSON.parse(readFileSync(file, 'utf-8')) as { sessionId?: string }
      res.json({ sessionId: data.sessionId ?? null })
    } catch {
      res.json({ sessionId: null })
    }
  })

  // PUT /config/zhile-session — 保存知了专属会话 ID
  app.put('/config/zhile-session', (req, res) => {
    const dir = join(homedir(), '.hrids-agent')
    const file = join(dir, 'zhile-session.json')
    try {
      const body = req.body as { sessionId?: string | null }
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(file, JSON.stringify({ sessionId: body.sessionId ?? null }, null, 2), 'utf-8')
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  // GET /config/models — 从环境变量解析可用模型列表
  app.get('/config/models', (_req, res) => {
    try {
      const models: Array<{ provider: string; model: string; isDefault: boolean }> = []
      const cfg = loadConfig()
      const defaultModel = cfg.model

      // 从 config.json 的 llm.fallbacks 读取模型列表
      for (const group of cfg.llm?.fallbacks ?? []) {
        for (const m of group.models) {
          models.push({ provider: group.provider, model: m, isDefault: m === defaultModel })
        }
      }

      // 若没有 fallbacks，至少返回默认模型
      if (models.length === 0 && defaultModel) {
        models.push({ provider: cfg.provider ?? 'default', model: defaultModel, isDefault: true })
      }

      // 确保 defaultModel 标记正确
      const hasDefault = models.some(m => m.isDefault)
      if (!hasDefault && defaultModel) {
        models.unshift({ provider: cfg.provider ?? 'default', model: defaultModel, isDefault: true })
      }

      res.json({ models, defaultModel })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  // GET /todos — 读取所有活跃会话的任务列表（聚合）
  // todos 按会话工作目录存储，路径为 <session.cwd>/.hrids/tasks/todos.json
  app.get('/todos', (_req, res) => {
    try {
      const allTodos: Array<Record<string, unknown>> = []
      const activeSessions = manager.listSessions()
      for (const session of activeSessions) {
        if (!session.cwd) continue
        const todoFile = join(session.cwd, '.hrids', 'tasks', 'todos.json')
        if (!existsSync(todoFile)) continue
        try {
          const raw = JSON.parse(readFileSync(todoFile, 'utf-8'))
          if (Array.isArray(raw)) {
            // 附加 sessionId 字段，方便前端区分来源
            allTodos.push(...raw.map((t: Record<string, unknown>) => ({ ...t, sessionId: session.id })))
          }
        } catch { /* 单个文件读取失败不影响整体 */ }
      }
      res.json(allTodos)
    } catch {
      res.json([])
    }
  })

  // GET /sessions/:id/messages — 读取会话历史消息（转换为前端 DisplayMessage 格式）
  app.get('/sessions/:id/messages', (req, res) => {
    // 优先从内存中的活跃 session 读取（最新状态）
    const activeSession = manager.getSession(req.params.id)
    const rawMessages = activeSession
      ? activeSession.engine.getHistory()
      : loadDiskSession(req.params.id)

    if (!rawMessages) {
      res.json([])
      return
    }

    res.json(formatMessagesForDisplay(rawMessages))
  })

  // GET /sessions/:id/history-segments — 读取会话的压缩归档段列表
  app.get('/sessions/:id/history-segments', (req, res) => {
    try {
      const archives = listSessionArchives(req.params.id)
      res.json(archives)
    } catch (err) {
      log.warn('读取归档段失败', { error: String(err) })
      res.json([])
    }
  })

  app.get('/sessions/:id/history-segments/:filename/messages', (req, res) => {
    try {
      const rawMessages = loadSessionArchive(req.params.id, req.params.filename)
      if (!rawMessages) { res.json([]); return }
      res.json(formatMessagesForDisplay(rawMessages, 'arc-'))
    } catch (err) {
      log.warn('读取归档消息失败', { error: String(err) })
      res.json([])
    }
  })

  // GET /sessions/:id/todos — 读取会话任务列表（活跃或历史会话均可）
  // todos 存储在会话工作目录下：<session.cwd>/.hrids/tasks/todos.json
  app.get('/sessions/:id/todos', (req, res) => {
    // 优先从内存中取 cwd（活跃会话），历史会话则从磁盘 meta 读取
    const activeSession = manager.getSession(req.params.id)
    const cwd = activeSession?.info.cwd ?? loadSessionMeta(req.params.id)?.workDir ?? null

    if (!cwd) {
      res.json([])
      return
    }

    const todoFile = join(cwd, '.hrids', 'tasks', 'todos.json')
    if (!existsSync(todoFile)) {
      res.json([])
      return
    }
    try {
      const raw = JSON.parse(readFileSync(todoFile, 'utf-8'))
      res.json(Array.isArray(raw) ? raw : [])
    } catch {
      res.json([])
    }
  })

  // GET /sessions/:id/files?path= — 读取会话工作目录文件列表（活跃或历史会话均可）
  app.get('/sessions/:id/files', (req, res) => {
    // 优先从内存中取 cwd，历史会话则从磁盘 meta 读取
    const activeSession = manager.getSession(req.params.id)
    const cwd = activeSession?.info.cwd ?? loadSessionMeta(req.params.id)?.workDir ?? null

    if (!cwd) {
      res.status(404).json({ error: '会话不存在或无工作目录' })
      return
    }
    const relPath = (req.query.path as string) || '.'

    // 安全检查：禁止 .. 跳出 cwd
    const absPath = resolve(cwd, relPath)
    if (!absPath.startsWith(resolve(cwd))) {
      res.status(403).json({ error: '禁止访问 cwd 之外的路径' })
      return
    }

    try {
      const entries = readdirSync(absPath).map(name => {
        const entryPath = join(absPath, name)
        const stat = statSync(entryPath)
        return {
          name,
          type: stat.isDirectory() ? 'dir' : 'file',
          size: stat.isFile() ? stat.size : undefined,
          mtime: stat.mtimeMs,
        }
      })
      // 目录优先，同类型按名称字母序
      entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      res.json({ cwd, path: relPath, entries })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  // GET /sessions/:id/file-content?path= — 读取单个文件内容
  app.get('/sessions/:id/file-content', (req, res) => {
    const activeSession = manager.getSession(req.params.id)
    const cwd = activeSession?.info.cwd ?? loadSessionMeta(req.params.id)?.workDir ?? null

    if (!cwd) {
      res.status(404).json({ error: '会话不存在或无工作目录' })
      return
    }

    const relPath = req.query.path as string
    if (!relPath) {
      res.status(400).json({ error: '缺少 path 参数' })
      return
    }

    const absPath = resolve(cwd, relPath)
    if (!absPath.startsWith(resolve(cwd))) {
      res.status(403).json({ error: '禁止访问 cwd 之外的路径' })
      return
    }

    try {
      const stat = statSync(absPath)
      if (!stat.isFile()) {
        res.status(400).json({ error: '路径不是文件' })
        return
      }
      // 限制文件大小：2MB
      if (stat.size > 2 * 1024 * 1024) {
        res.status(413).json({ error: '文件超过 2MB，无法在线预览' })
        return
      }
      const content = readFileSync(absPath, 'utf-8')
      res.json({ path: relPath, content, size: stat.size, mtime: stat.mtimeMs })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  // GET /sessions/:id/file-preview?path= — 预览 Word/Excel 文件
  // docx → { type: 'html', html: string }
  // xlsx/xls/csv → { type: 'table', sheets: Array<{ name, headers, rows }> }
  app.get('/sessions/:id/file-preview', async (req, res) => {
    const activeSession = manager.getSession(req.params.id)
    const cwd = activeSession?.info.cwd ?? loadSessionMeta(req.params.id)?.workDir ?? null

    if (!cwd) {
      res.status(404).json({ error: '会话不存在或无工作目录' })
      return
    }

    const relPath = req.query.path as string
    if (!relPath) {
      res.status(400).json({ error: '缺少 path 参数' })
      return
    }

    const absPath = resolve(cwd, relPath)
    if (!absPath.startsWith(resolve(cwd))) {
      res.status(403).json({ error: '禁止访问 cwd 之外的路径' })
      return
    }

    try {
      const stat = statSync(absPath)
      if (!stat.isFile()) {
        res.status(400).json({ error: '路径不是文件' })
        return
      }
      if (stat.size > 20 * 1024 * 1024) {
        res.status(413).json({ error: '文件超过 20MB，无法预览' })
        return
      }

      const ext = extname(absPath).toLowerCase()

      if (ext === '.docx') {
        const result = await mammoth.convertToHtml({ path: absPath })
        res.json({ type: 'html', html: result.value })
        return
      }

      if (ext === '.doc') {
        // .doc 是旧版二进制格式，mammoth 支持有限，尝试提取纯文本
        const result = await mammoth.extractRawText({ path: absPath })
        // 将纯文本转为简单 HTML（保留换行）
        const html = result.value
          .split('\n')
          .map(line => line.trim() ? `<p>${line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>` : '<br>')
          .join('')
        res.json({ type: 'html', html })
        return
      }

      if (['.xlsx', '.xls', '.csv'].includes(ext)) {
        const buf = readFileSync(absPath)
        const workbook = XLSX.read(buf, { type: 'buffer' })
        const sheets = workbook.SheetNames.map(name => {
          const ws = workbook.Sheets[name]
          const json = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: '' })
          if (json.length === 0) return { name, headers: [] as string[], rows: [] as string[][] }
          const [headers, ...rows] = json
          return {
            name,
            headers: (headers as string[]).map(h => String(h ?? '')),
            rows: (rows as string[][]).map(r => (headers as string[]).map((_, i) => String(r[i] ?? ''))),
          }
        })
        res.json({ type: 'table', sheets })
        return
      }

      res.status(400).json({ error: '不支持的文件格式，仅支持 docx/doc/xlsx/xls/csv' })
    } catch (err) {
      log.error('文件预览失败', { error: String(err) })
      res.status(500).json({ error: String(err) })
    }
  })

  // PUT /sessions/:id/file-content — 保存单个文件内容
  // 请求体：JSON { path: string; content: string }
  app.put('/sessions/:id/file-content', (req, res) => {
    const activeSession = manager.getSession(req.params.id)
    const cwd = activeSession?.info.cwd ?? loadSessionMeta(req.params.id)?.workDir ?? null

    if (!cwd) {
      res.status(404).json({ error: '会话不存在或无工作目录' })
      return
    }

    try {
      const body = req.body as { path?: string; content?: string }
      if (!body.path || typeof body.content !== 'string') {
        res.status(400).json({ error: '请求体缺少 path 或 content 字段' })
        return
      }

      const absPath = resolve(cwd, body.path)
      if (!absPath.startsWith(resolve(cwd))) {
        res.status(403).json({ error: '禁止写入 cwd 之外的路径' })
        return
      }

      mkdirSync(resolve(absPath, '..'), { recursive: true })
      writeFileSync(absPath, body.content, 'utf-8')
      log.info('文件内容已保存', { sessionId: req.params.id, path: body.path })
      res.json({ ok: true })
    } catch (err) {
      log.error('文件保存失败', { error: String(err) })
      res.status(500).json({ error: String(err) })
    }
  })

  // GET /sessions/:id/git-file?path= — 获取文件在 git HEAD 中的原始内容
  app.get('/sessions/:id/git-file', (req, res) => {
    const activeSession = manager.getSession(req.params.id)
    const cwd = activeSession?.info.cwd ?? loadSessionMeta(req.params.id)?.workDir ?? null

    if (!cwd) {
      res.status(404).json({ error: '会话不存在或无工作目录' })
      return
    }

    const relPath = req.query.path as string
    if (!relPath) {
      res.status(400).json({ error: '缺少 path 参数' })
      return
    }

    const absPath = resolve(cwd, relPath)
    if (!absPath.startsWith(resolve(cwd))) {
      res.status(403).json({ error: '禁止访问 cwd 之外的路径' })
      return
    }

    try {
      const content = execSync(`git show HEAD:${relPath}`, { cwd, encoding: 'utf-8', timeout: 5000 })
      res.json({ path: relPath, content })
    } catch {
      // 文件在 git 中不存在（新文件）或不在 git 仓库中
      res.status(404).json({ error: '文件在 git HEAD 中不存在（可能是新文件或不在 git 仓库中）' })
    }
  })

  // POST /sessions/:id/upload — 上传文件到会话工作目录
  // 请求体：JSON { files: Array<{ name: string; data: string }> }
  // data 为 base64 编码的文件内容
  app.post('/sessions/:id/upload', (req, res) => {
    const activeSession = manager.getSession(req.params.id)
    const cwd = activeSession?.info.cwd ?? loadSessionMeta(req.params.id)?.workDir ?? null

    if (!cwd) {
      res.status(404).json({ error: '会话不存在或无工作目录' })
      return
    }

    try {
      const body = req.body as { files?: Array<{ name: string; data: string }> }
      if (!Array.isArray(body.files) || body.files.length === 0) {
        res.status(400).json({ error: '请求体缺少 files 字段' })
        return
      }

      // 限制单次上传数量
      if (body.files.length > 20) {
        res.status(400).json({ error: '单次最多上传 20 个文件' })
        return
      }

      const uploaded: Array<{ name: string; path: string; size: number }> = []

      for (const file of body.files) {
        if (!file.name || typeof file.data !== 'string') {
          res.status(400).json({ error: '文件格式错误：缺少 name 或 data' })
          return
        }

        // 安全处理文件名：去掉路径分隔符，防止路径穿越
        const safeName = basename(file.name).replace(/[/\\]/g, '_')
        if (!safeName) {
          res.status(400).json({ error: `无效的文件名: ${file.name}` })
          return
        }

        const destPath = resolve(cwd, safeName)

        // 安全检查：确保目标路径在 cwd 内
        if (!destPath.startsWith(resolve(cwd))) {
          res.status(403).json({ error: '禁止写入 cwd 之外的路径' })
          return
        }

        // 解码 base64 并写入文件
        const buffer = Buffer.from(file.data, 'base64')

        // 限制单文件大小：50MB
        if (buffer.length > 50 * 1024 * 1024) {
          res.status(400).json({ error: `文件 ${safeName} 超过 50MB 限制` })
          return
        }

        mkdirSync(cwd, { recursive: true })
        writeFileSync(destPath, buffer)

        log.info('文件已上传', { sessionId: req.params.id, file: safeName, size: buffer.length })
        uploaded.push({ name: safeName, path: destPath, size: buffer.length })
      }

      res.json({ files: uploaded })
    } catch (err) {
      log.error('文件上传失败', { error: String(err) })
      res.status(500).json({ error: String(err) })
    }
  })

  // GET /crons — 读取定时任务列表
  app.get('/crons', (_req, res) => {
    const cronFile = join(homedir(), '.hrids-agent', 'crons.json')
    if (!existsSync(cronFile)) {
      res.json([])
      return
    }
    try {
      const raw = JSON.parse(readFileSync(cronFile, 'utf-8'))
      res.json(Array.isArray(raw) ? raw : [])
    } catch {
      res.json([])
    }
  })

  // PUT /crons/:id/toggle — 启用/禁用定时任务（同步更新文件和内存调度器）
  app.put('/crons/:id/toggle', async (req, res) => {
    const cronFile = join(homedir(), '.hrids-agent', 'crons.json')
    if (!existsSync(cronFile)) {
      res.status(404).json({ error: '定时任务文件不存在' })
      return
    }
    try {
      const crons = JSON.parse(readFileSync(cronFile, 'utf-8')) as Array<{ id: string; enabled: boolean }>
      const idx = crons.findIndex(c => c.id === req.params.id)
      if (idx === -1) {
        res.status(404).json({ error: '定时任务不存在' })
        return
      }
      const { enabled } = req.body as { enabled: boolean }
      crons[idx].enabled = enabled
      atomicWriteJson(cronFile, crons)

      // 同步更新内存调度器，避免"显示改了但实际还在跑/没跑"的问题
      try {
        const { toggleJobInScheduler } = await import('../tools/ScheduleCronTool.js')
        toggleJobInScheduler(req.params.id, enabled)
      } catch { /* 调度器不可用时忽略 */ }

      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  // DELETE /crons/:id — 删除定时任务（同步清除内存调度器中的 timer）
  app.delete('/crons/:id', async (req, res) => {
    const cronFile = join(homedir(), '.hrids-agent', 'crons.json')
    if (!existsSync(cronFile)) {
      res.status(404).json({ error: '定时任务文件不存在' })
      return
    }
    try {
      const crons = JSON.parse(readFileSync(cronFile, 'utf-8')) as Array<{ id: string }>
      const filtered = crons.filter(c => c.id !== req.params.id)
      if (filtered.length === crons.length) {
        res.status(404).json({ error: '定时任务不存在' })
        return
      }
      atomicWriteJson(cronFile, filtered)

      // 同步清除内存中的 timer，避免已删除的任务仍然触发
      try {
        const { deleteJobFromScheduler } = await import('../tools/ScheduleCronTool.js')
        deleteJobFromScheduler(req.params.id)
      } catch { /* 调度器不可用时忽略 */ }

      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  // POST /crons — 创建定时任务（前端直接创建，不经过 Agent）
  app.post('/crons', async (req, res) => {
    const cronDir = join(homedir(), '.hrids-agent')
    const cronFile = join(cronDir, 'crons.json')
    try {
      const body = req.body as {
        expression: string
        description: string
        task: string
        once?: boolean
        startDate?: string
        endDate?: string
        sessionId?: string
      }
      if (!body.expression || !body.description || !body.task) {
        res.status(400).json({ error: '缺少必填字段：expression、description、task' })
        return
      }

      // 读取现有任务
      let crons: Array<Record<string, unknown>> = []
      if (existsSync(cronFile)) {
        try { crons = JSON.parse(readFileSync(cronFile, 'utf-8')) } catch { crons = [] }
      } else {
        if (!existsSync(cronDir)) mkdirSync(cronDir, { recursive: true })
      }

      // 去重检查：相同 expression + description + sessionId 的任务已存在时直接返回
      const sessionId = body.sessionId ?? ''
      const duplicate = crons.find(c =>
        c['expression'] === body.expression &&
        c['description'] === body.description &&
        ((c['sessionId'] ?? '') === sessionId)
      )
      if (duplicate) {
        res.json(duplicate)
        return
      }

      // 计算下次执行时间（使用 ScheduleCronTool 的完整解析器）
      let nextRunAt: number | undefined
      try {
        const { parseCronNextRun } = await import('../tools/ScheduleCronTool.js')
        nextRunAt = parseCronNextRun(body.expression)
      } catch {
        nextRunAt = undefined
      }

      // 判断是否为周期性表达式
      const parts = body.expression.trim().split(/\s+/)
      const isRecurring = parts.length === 5 && parts.some(p => p.includes('*') || p.includes('/') || p.includes('-') || p.includes(','))
      const once = isRecurring ? false : (body.once ?? false)

      const id = `cron-${Date.now().toString(36)}`
      const job = {
        id,
        expression: body.expression,
        description: body.description,
        task: body.task,
        createdAt: Date.now(),
        nextRunAt,
        enabled: true,
        once,
        ...(body.startDate ? { startDate: body.startDate } : {}),
        ...(body.endDate ? { endDate: body.endDate } : {}),
        ...(body.sessionId ? { sessionId: body.sessionId } : {}),
      }

      crons.push(job)
      atomicWriteJson(cronFile, crons)

      // 通知调度器注册新任务
      try {
        const { scheduleNewJob } = await import('../tools/ScheduleCronTool.js')
        scheduleNewJob(job as Parameters<typeof scheduleNewJob>[0])
      } catch { /* 调度器不可用时忽略，重启后会自动恢复 */ }

      res.json(job)
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  // ── MCP 服务器配置 API ──────────────────────────────────────────────────

  // GET /mcp — 读取 MCP 服务器配置列表
  app.get('/mcp', (_req, res) => {
    const mcpFile = join(homedir(), '.hrids-agent', 'mcp.json')
    if (!existsSync(mcpFile)) {
      res.json({ mcpServers: {} })
      return
    }
    try {
      const raw = JSON.parse(readFileSync(mcpFile, 'utf-8'))
      res.json(raw)
    } catch {
      res.json({ mcpServers: {} })
    }
  })

  // PUT /mcp — 保存完整 MCP 配置（覆盖写入）
  app.put('/mcp', (req, res) => {
    const mcpDir = join(homedir(), '.hrids-agent')
    const mcpFile = join(mcpDir, 'mcp.json')
    try {
      const body = req.body as { mcpServers?: Record<string, unknown> }
      if (!body || typeof body !== 'object') {
        res.status(400).json({ error: '请求体格式错误' })
        return
      }
      if (!existsSync(mcpDir)) mkdirSync(mcpDir, { recursive: true })
      atomicWriteJson(mcpFile, body)
      log.info('MCP 配置已保存', { serverCount: Object.keys(body.mcpServers ?? {}).length })
      res.json({ ok: true })
    } catch (err) {
      log.error('MCP 配置保存失败', { error: String(err) })
      res.status(500).json({ error: String(err) })
    }
  })

  // POST /mcp/:name — 添加或更新单个 MCP 服务器
  app.post('/mcp/:name', (req, res) => {
    const mcpDir = join(homedir(), '.hrids-agent')
    const mcpFile = join(mcpDir, 'mcp.json')
    try {
      const serverName = req.params.name
      const serverConfig = req.body as Record<string, unknown>
      if (!serverConfig || typeof serverConfig !== 'object') {
        res.status(400).json({ error: '请求体格式错误' })
        return
      }

      let config: { mcpServers: Record<string, unknown> } = { mcpServers: {} }
      if (existsSync(mcpFile)) {
        try { config = JSON.parse(readFileSync(mcpFile, 'utf-8')) } catch { config = { mcpServers: {} } }
      }
      if (!config.mcpServers) config.mcpServers = {}
      config.mcpServers[serverName] = serverConfig

      if (!existsSync(mcpDir)) mkdirSync(mcpDir, { recursive: true })
      atomicWriteJson(mcpFile, config)
      log.info('MCP 服务器已添加/更新', { name: serverName })
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  // DELETE /mcp/:name — 删除单个 MCP 服务器
  app.delete('/mcp/:name', (req, res) => {
    const mcpFile = join(homedir(), '.hrids-agent', 'mcp.json')
    try {
      const serverName = req.params.name
      if (!existsSync(mcpFile)) {
        res.status(404).json({ error: 'MCP 配置文件不存在' })
        return
      }
      const config = JSON.parse(readFileSync(mcpFile, 'utf-8')) as { mcpServers?: Record<string, unknown> }
      if (!config.mcpServers || !(serverName in config.mcpServers)) {
        res.status(404).json({ error: `MCP 服务器 "${serverName}" 不存在` })
        return
      }
      delete config.mcpServers[serverName]
      atomicWriteJson(mcpFile, config)
      log.info('MCP 服务器已删除', { name: serverName })
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  // GET /mcp/config-path — 返回 MCP 配置文件路径（供前端展示）
  app.get('/mcp/config-path', (_req, res) => {
    const mcpFile = join(homedir(), '.hrids-agent', 'mcp.json')
    res.json({ path: mcpFile })
  })

  // GET /skills — 读取已安装技能列表
  app.get('/skills', async (_req, res) => {
    try {
      const { loadSkillsFromDir, getBundledSkills, getUserSkillsDir, getDisabledUserSkills } = await import('../skills/registry.js')
      const { registerAllBundledSkills } = await import('../skills/bundled/index.js')
      const { existsSync, readFileSync } = await import('fs')
      const { join } = await import('path')
      const { homedir } = await import('os')

      // 确保内置 skills 已注册
      if (getBundledSkills().length === 0) {
        registerAllBundledSkills()
      }

      // 读取 user lockfile，获取已安装的 slug 集合
      const userSkillsDir = getUserSkillsDir()
      const lockPath = join(userSkillsDir, '.skills_store_lock.json')
      let installedSlugs = new Set<string>()
      if (existsSync(lockPath)) {
        try {
          const lock = JSON.parse(readFileSync(lockPath, 'utf-8')) as { skills?: Record<string, unknown> }
          installedSlugs = new Set(Object.keys(lock.skills ?? {}))
        } catch { /* 解析失败忽略 */ }
      }

      // 读取禁用列表
      const disabledSet = getDisabledUserSkills()

      // 内置技能（从全局注册表取）
      const builtinSkillsRaw = getBundledSkills().filter(s => s.userInvocable)
      const builtinSkills = await Promise.all(
        builtinSkillsRaw.map(async s => ({
          name: s.name,
          description: s.description,
          source: 'builtin' as const,
          installed: undefined,
          enabled: undefined,
          prompt: s.getPrompt ? await s.getPrompt('') : undefined,
        })),
      )

      // 用户技能：直接从文件系统加载，不经过禁用过滤，确保禁用的技能也能显示
      // 异步读取 SKILL.md 内容作为 prompt（用于前端详情展示）
      const userSkillsRaw = loadSkillsFromDir(userSkillsDir, 'user')
      const userSkills = await Promise.all(
        userSkillsRaw.map(async s => ({
          name: s.name,
          description: s.description,
          source: 'user' as const,
          installed: installedSlugs.has(s.name),
          enabled: !disabledSet.has(s.name),
          prompt: s.getPrompt ? await s.getPrompt('') : undefined,
        })),
      )

      res.json([...builtinSkills, ...userSkills])
    } catch (err) {
      log.warn('获取技能列表失败', { error: String(err) })
      res.json([])
    }
  })

  // PUT /skills/:name/toggle — 切换用户技能启用/禁用状态
  app.put('/skills/:name/toggle', async (req, res) => {
    try {
      const { writeFileSync, existsSync, readFileSync, mkdirSync } = await import('fs')
      const { join } = await import('path')
      const { homedir } = await import('os')

      const skillName = decodeURIComponent(req.params.name)
      const { enabled } = req.body as { enabled: boolean }

      const agentDir = join(homedir(), '.hrids-agent')
      const disabledPath = join(agentDir, 'skills-disabled.json')

      let disabled: string[] = []
      if (existsSync(disabledPath)) {
        try {
          const arr = JSON.parse(readFileSync(disabledPath, 'utf-8')) as string[]
          disabled = Array.isArray(arr) ? arr : []
        } catch { /* 忽略 */ }
      }

      if (enabled) {
        disabled = disabled.filter(n => n !== skillName)
      } else {
        if (!disabled.includes(skillName)) disabled.push(skillName)
      }

      mkdirSync(agentDir, { recursive: true })
      const { renameSync: rs } = await import('fs')
      const tmpPath = disabledPath + '.tmp'
      writeFileSync(tmpPath, JSON.stringify(disabled, null, 2), 'utf-8')
      rs(tmpPath, disabledPath)
      res.json({ ok: true, enabled })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  // POST /skills/market/install — 从技能市场安装技能
  app.post('/skills/market/install', async (req, res) => {
    try {
      const { slug, force = false } = req.body as { slug: string; force?: boolean }
      if (!slug || typeof slug !== 'string') {
        res.status(400).json({ error: '缺少 slug 参数' })
        return
      }

      // 直接复用 SkillHubInstallTool 的 execute 逻辑
      const { SkillHubInstallTool } = await import('../tools/SkillHubTool.js')
      const result = await SkillHubInstallTool.execute({ skill_id: slug, scope: 'user', force })

      if (result.type === 'success') {
        res.json({ ok: true, message: result.output })
      } else {
        res.status(500).json({ error: result.message })
      }
    } catch (err) {
      log.warn('技能安装失败', { error: String(err) })
      res.status(500).json({ error: String(err) })
    }
  })

  // DELETE /skills/market/uninstall/:slug — 卸载技能
  app.delete('/skills/market/uninstall/:slug', async (req, res) => {
    try {
      const slug = decodeURIComponent(req.params.slug)
      if (!slug) {
        res.status(400).json({ error: '缺少 slug 参数' })
        return
      }

      const { SkillHubUninstallTool } = await import('../tools/SkillHubTool.js')
      const result = await SkillHubUninstallTool.execute({ skill_id: slug, scope: 'user' })

      if (result.type === 'success') {
        res.json({ ok: true, message: result.output })
      } else {
        res.status(500).json({ error: result.message })
      }
    } catch (err) {
      log.warn('技能卸载失败', { error: String(err) })
      res.status(500).json({ error: String(err) })
    }
  })

  // GET /skills/market/search — 技能市场搜索（代理 SkillHub API，避免前端跨域）
  app.get('/skills/market/search', async (req, res) => {
    try {
      const q = String(req.query.q ?? '').trim()
      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '20'), 10) || 20, 1), 500)
      const page = Math.max(parseInt(String(req.query.page ?? '1'), 10) || 1, 1)

      const searchApiBase = (loadConfig().skillHub?.searchUrl ?? 'https://lightmake.site/api/v1/search').replace(/\/$/, '')
      const offset = (page - 1) * limit
      const url = `${searchApiBase}?q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}&page=${page}`

      const upstream = await fetch(url, {
        headers: { 'User-Agent': 'hrids-agent/skillhub', 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10000),
      })

      if (!upstream.ok) {
        res.status(upstream.status).json({ error: `SkillHub API 返回 ${upstream.status}` })
        return
      }

      const data = await upstream.json() as {
        results?: Array<{
          slug?: string
          displayName?: string
          name?: string
          summary?: string
          description?: string
          version?: string
          category?: string
          tags?: string[]
          author?: string
          downloads?: number
          icon?: string
        }>
        total?: number
      }

      // 标准化返回格式
      const results = (data.results ?? []).map(item => ({
        slug: String(item.slug ?? ''),
        name: String(item.displayName ?? item.name ?? item.slug ?? '').trim(),
        description: String(item.summary ?? item.description ?? '').trim(),
        version: String(item.version ?? '').trim(),
        category: String(item.category ?? '').trim(),
        tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
        author: String(item.author ?? '').trim(),
        downloads: typeof item.downloads === 'number' ? item.downloads : 0,
        icon: String(item.icon ?? '').trim(),
      }))

      res.json({ results, total: data.total ?? results.length })
    } catch (err) {
      log.warn('技能市场搜索失败', { error: String(err) })
      res.status(500).json({ error: String(err) })
    }
  })

  // ── IM 平台管理 API ──────────────────────────────────────────────────────

  // GET /im/platforms — 读取 IM 平台配置列表
  app.get('/im/platforms', (_req, res) => {
    try {
      const cfg = PlatformManager.loadConfig()
      // 脱敏：不返回 token/secret 等敏感字段
      const sanitized = cfg.platforms.map(p => {
        const rest = { ...(p as unknown as Record<string, unknown>) }
        if (rest.token) rest.token = '***'
        if (rest.secret) rest.secret = '***'
        return rest
      })
      res.json({ platforms: sanitized, status: platformManager.getStatus() })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  // GET /im/platforms/config — 读取完整配置（含 token，需鉴权）
  app.get('/im/platforms/config', (_req, res) => {
    try {
      const cfg = PlatformManager.loadConfig()
      res.json(cfg)
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  // PUT /im/platforms/config — 保存完整 IM 配置
  app.put('/im/platforms/config', (req, res) => {
    try {
      const body = req.body as IMGatewayConfig
      if (!body || !Array.isArray(body.platforms)) {
        res.status(400).json({ error: '请求体格式错误，需要 { platforms: [...] }' })
        return
      }
      PlatformManager.saveConfig(body)
      log.info('IM 平台配置已保存', { platformCount: body.platforms.length })
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  // POST /im/platforms/:platform — 添加或更新单个平台配置
  app.post('/im/platforms/:platform', async (req, res) => {
    try {
      const platform = req.params.platform as IMPlatform
      const platformCfg = req.body as PlatformConfig

      if (!platformCfg || platformCfg.platform !== platform) {
        res.status(400).json({ error: 'platform 字段与路径不匹配' })
        return
      }

      const cfg = PlatformManager.loadConfig()
      const idx = cfg.platforms.findIndex(p => p.platform === platform)
      if (idx >= 0) {
        cfg.platforms[idx] = platformCfg
      } else {
        cfg.platforms.push(platformCfg)
      }
      PlatformManager.saveConfig(cfg)

      // 如果平台已启用，立即重启适配器
      if (platformCfg.enabled) {
        try {
          await platformManager.startPlatform(platformCfg)
          log.info('IM 平台适配器已重启', { platform })
        } catch (err) {
          log.warn('IM 平台适配器重启失败', { platform, error: String(err) })
          res.json({ ok: true, warning: `配置已保存，但适配器启动失败: ${String(err)}` })
          return
        }
      } else {
        // 禁用时停止适配器
        await platformManager.stopPlatform(platform)
      }

      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  // DELETE /im/platforms/:platform — 删除平台配置并停止适配器
  app.delete('/im/platforms/:platform', async (req, res) => {
    try {
      const platform = req.params.platform as IMPlatform
      const cfg = PlatformManager.loadConfig()
      const filtered = cfg.platforms.filter(p => p.platform !== platform)
      if (filtered.length === cfg.platforms.length) {
        res.status(404).json({ error: `平台 "${platform}" 不存在` })
        return
      }
      cfg.platforms = filtered
      PlatformManager.saveConfig(cfg)
      await platformManager.stopPlatform(platform)
      log.info('IM 平台已删除', { platform })
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  // POST /im/platforms/:platform/restart — 重启单个平台适配器
  app.post('/im/platforms/:platform/restart', async (req, res) => {
    try {
      const platform = req.params.platform as IMPlatform
      const cfg = PlatformManager.loadConfig()
      const platformCfg = cfg.platforms.find(p => p.platform === platform)
      if (!platformCfg) {
        res.status(404).json({ error: `平台 "${platform}" 未配置` })
        return
      }
      if (!platformCfg.enabled) {
        res.status(400).json({ error: `平台 "${platform}" 未启用` })
        return
      }
      await platformManager.startPlatform(platformCfg)
      log.info('IM 平台适配器已重启', { platform })
      res.json({ ok: true, status: platformManager.getStatus() })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  // GET /im/status — 获取所有平台运行状态
  app.get('/im/status', (_req, res) => {
    res.json({ status: platformManager.getStatus() })
  })

  // POST /im/platforms/weixin/login — 发起微信扫码登录，返回二维码
  app.post('/im/platforms/weixin/login', async (_req, res) => {
    try {
      const qr = await platformManager.startWeixinLogin()
      res.json({
        qrcodeKey: qr.qrcodeKey,
        qrcodeImgUrl: qr.qrcodeImgUrl,
      })
    } catch (err) {
      log.error('发起微信扫码登录失败', { error: String(err) })
      res.status(500).json({ error: String(err) })
    }
  })

  // GET /im/platforms/weixin/login/status — 轮询微信扫码状态
  // status: pending | scaned | confirmed | expired | error
  app.get('/im/platforms/weixin/login/status', (_req, res) => {
    const result = platformManager.getWeixinLoginStatus()
    res.json(result)
  })

  // GET /sessions/:id/image?path= — 直接返回图片二进制（用于前端 <img> 标签显示）
  app.get('/sessions/:id/image', (req, res) => {
    const activeSession = manager.getSession(req.params.id)
    const cwd = activeSession?.info.cwd ?? loadSessionMeta(req.params.id)?.workDir ?? null

    if (!cwd) {
      res.status(404).json({ error: '会话不存在或无工作目录' })
      return
    }

    const relPath = req.query.path as string
    if (!relPath) {
      res.status(400).json({ error: '缺少 path 参数' })
      return
    }

    const absPath = resolve(cwd, relPath)
    if (!absPath.startsWith(resolve(cwd))) {
      res.status(403).json({ error: '禁止访问 cwd 之外的路径' })
      return
    }

    try {
      const stat = statSync(absPath)
      if (!stat.isFile()) {
        res.status(400).json({ error: '路径不是文件' })
        return
      }

      // 限制图片大小：20MB
      if (stat.size > 20 * 1024 * 1024) {
        res.status(413).json({ error: '图片超过 20MB' })
        return
      }

      const ext = extname(absPath).toLowerCase()
      const mimeMap: Record<string, string> = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.bmp': 'image/bmp',
        '.ico': 'image/x-icon',
        '.tiff': 'image/tiff',
        '.tif': 'image/tiff',
      }
      const mime = mimeMap[ext]
      if (!mime) {
        res.status(400).json({ error: '不支持的图片格式' })
        return
      }

      res.setHeader('Content-Type', mime)
      res.setHeader('Cache-Control', 'public, max-age=3600')
      const buf = readFileSync(absPath)
      res.send(buf)
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  // GET /api/logs — 读取最近的日志条目
  app.get('/api/logs', (req, res) => {
    const logFile = join(homedir(), '.hrids-agent', 'logs', 'agent.log')
    const limit = Math.min(parseInt(String(req.query.limit ?? '200'), 10) || 200, 1000)
    const level = String(req.query.level ?? 'all')

    if (!existsSync(logFile)) {
      res.json({ logs: [], total: 0 })
      return
    }

    try {
      const content = readFileSync(logFile, 'utf-8')
      const lines = content.split('\n').filter(l => l.trim())
      const entries: Array<Record<string, unknown>> = []

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as Record<string, unknown>
          if (level !== 'all' && entry.level !== level) continue
          entries.push(entry)
        } catch { /* 跳过非 JSON 行 */ }
      }

      // 返回最新的 limit 条
      const sliced = entries.slice(-limit)
      res.json({ logs: sliced, total: entries.length })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  // GET /api/usage — 读取模型用量统计（从日志中聚合）
  app.get('/api/usage', (_req, res) => {
    const logFile = join(homedir(), '.hrids-agent', 'logs', 'agent.log')

    if (!existsSync(logFile)) {
      res.json({ sessions: [], totals: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 } })
      return
    }

    try {
      const content = readFileSync(logFile, 'utf-8')
      const lines = content.split('\n').filter(l => l.trim())

      // 按日期聚合用量
      const byDate = new Map<string, { inputTokens: number; outputTokens: number; costUsd: number; calls: number }>()
      let totalInput = 0, totalOutput = 0, totalCost = 0, totalCalls = 0

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as Record<string, unknown>
          // 从 usage 相关日志中提取 token 数据
          if (
            entry.inputTokens !== undefined &&
            entry.outputTokens !== undefined
          ) {
            const date = String(entry.ts ?? '').slice(0, 10) || 'unknown'
            const input = Number(entry.inputTokens) || 0
            const output = Number(entry.outputTokens) || 0
            const cost = Number(entry.costUsd ?? entry.cost ?? 0)

            const prev = byDate.get(date) ?? { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 }
            byDate.set(date, {
              inputTokens: prev.inputTokens + input,
              outputTokens: prev.outputTokens + output,
              costUsd: prev.costUsd + cost,
              calls: prev.calls + 1,
            })
            totalInput += input
            totalOutput += output
            totalCost += cost
            totalCalls++
          }
        } catch { /* 跳过 */ }
      }

      const sessions = Array.from(byDate.entries())
        .map(([date, stats]) => ({ date, ...stats }))
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, 30)

      res.json({
        sessions,
        totals: { inputTokens: totalInput, outputTokens: totalOutput, costUsd: totalCost, calls: totalCalls },
      })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  // GET /api/config-file — 读取 config.json 原始内容
  app.get('/api/config-file', (_req, res) => {
    const configFile = join(homedir(), '.hrids-agent', 'config.json')
    if (!existsSync(configFile)) {
      res.json({ content: '{}', path: configFile })
      return
    }
    try {
      const content = readFileSync(configFile, 'utf-8')
      res.json({ content, path: configFile })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  // PUT /api/config-file — 保存 config.json 原始内容
  app.put('/api/config-file', async (req, res) => {
    const configFile = join(homedir(), '.hrids-agent', 'config.json')
    try {
      const { content } = req.body as { content?: string }
      if (typeof content !== 'string') {
        res.status(400).json({ error: '缺少 content 字段' })
        return
      }
      // 验证 JSON 格式
      JSON.parse(content)
      const tmp = configFile + '.tmp'
      writeFileSync(tmp, content, 'utf-8')
      renameSync(tmp, configFile)
      // 清除配置缓存，下次读取时重新加载
      const { _resetConfigCache } = await import('../core/Config.js')
      _resetConfigCache()
      log.info('config.json 已通过 Web 界面更新')
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  // ── WebSocket 服务器 ─────────────────────────────────────────
  const server = http.createServer(app)
  // 不设置 path，由 connection 回调自行匹配 /sessions/:id/stream
  const wss = new WebSocketServer({ server })

  wss.on('connection', (ws: WebSocket, req) => {
    // req.url 包含路径和查询参数，先解析出纯路径部分再匹配
    // 格式：/sessions/:id/stream 或 /sessions/:id/stream?token=xxx
    const parsedUrl = new URL(req.url!, `http://${req.headers.host}`)
    const match = parsedUrl.pathname.match(/^\/sessions\/([^/]+)\/stream$/)
    if (!match) {
      ws.close(1008, '无效的路径')
      return
    }
    const sessionId = match[1]

    // WebSocket 鉴权（通过 URL query 参数 token 或 Sec-WebSocket-Protocol）
    if (hasUsers || hasStaticToken) {
      const token = parsedUrl.searchParams.get('token')
        ?? req.headers['sec-websocket-protocol']
      if (!token || !verifyRawToken(token)) {
        log.warn('WebSocket 未授权', { sessionId })
        ws.close(1008, '未授权')
        return
      }
    }

    const session = manager.getSession(sessionId)
    if (!session) {
      ws.send(JSON.stringify({ type: 'error', message: `会话不存在: ${sessionId}` }))
      ws.close(1008, '会话不存在')
      return
    }

    log.debug('WebSocket 连接', { sessionId })
    // 先发 ready，告知前端连接已建立
    ws.send(JSON.stringify({ type: 'ready', sessionId }))
    // 再订阅（会触发回放缓冲区推送，前端已准备好接收）
    manager.subscribe(sessionId, ws)
    ws.on('message', (data) => {
      manager.handleClientMessage(sessionId, data.toString())
    })

    ws.on('close', () => {
      log.debug('WebSocket 断开', { sessionId })
      manager.unsubscribe(sessionId, ws)
    })

    ws.on('error', (err) => {
      log.error('WebSocket 错误', { sessionId, error: err.message })
      manager.unsubscribe(sessionId, ws)
    })
  })

  return {
    start(): Promise<void> {
      return new Promise(resolve => {
        server.listen(port, host, () => {
          log.info('Gateway 已启动', { host, port })
          // 启动 IM 平台适配器（异步，不阻塞 HTTP 服务启动）
          platformManager.start().catch(err => {
            log.warn('IM 平台管理器启动时出现错误', { error: String(err) })
          })
          // 注册 cron → IM 推送回调：cron 触发时将提醒文本推送到对应 IM 会话
          manager.setCronIMCallback((agentSessionId, text) =>
            platformManager.sendCronToIM(agentSessionId, text)
          )
          resolve()
        })
      })
    },
    // 优雅关闭：等待进行中任务完成，再关闭 HTTP/WS 服务
    async stop(gracefulTimeoutMs = 10000): Promise<void> {
      log.info('开始关闭 Gateway')

      // 先停止 IM 平台适配器
      await platformManager.stop()

      await manager.gracefulShutdown(gracefulTimeoutMs)

      // 主动关闭所有 WebSocket 连接，否则 server.close() 会因连接保持而一直 pending
      for (const ws of wss.clients) {
        try { ws.terminate() } catch { /* 忽略 */ }
      }
      wss.close()

      return new Promise((resolve) => {
        // 尝试使用 Node 18.2+ 的 closeAllConnections() 强制关闭所有 keep-alive 连接
        if (typeof (server as unknown as { closeAllConnections?: () => void }).closeAllConnections === 'function') {
          (server as unknown as { closeAllConnections: () => void }).closeAllConnections()
        }
        server.close(err => {
          if (err) {
            log.warn('关闭 HTTP 服务时有错误（忽略）', { error: String(err) })
          }
          log.info('Gateway 已关闭')
          resolve()
        })
        // 兜底超时：5 秒后强制 resolve，避免残留连接导致进程无法退出
        setTimeout(() => {
          log.warn('server.close() 超时，强制完成关闭')
          resolve()
        }, 5000)
      })
    },
    manager,
    server,
    platformManager,
  }
}
