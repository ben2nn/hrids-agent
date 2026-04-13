// Gateway HTTP + WebSocket 服务器
import http from 'http'
import express from 'express'
import { WebSocketServer, WebSocket } from 'ws'
import { SessionManager } from './SessionManager.js'
import { logger } from '../core/logger.js'
import type { CreateSessionRequest } from './types.js'

const log = logger.child({ component: 'gateway-server' })

export interface GatewayConfig {
  port?: number
  host?: string
  authToken?: string       // 若设置，所有请求需携带 Authorization: Bearer <token>
  idleTimeoutMs?: number
  maxSessions?: number
  // 每个 IP 每分钟最多创建的会话数（默认 10）
  rateLimitPerMinute?: number
}

// 简单的内存速率限制（令牌桶，按 IP 计数）
class RateLimiter {
  private counts = new Map<string, { count: number; resetAt: number }>()
  constructor(private limit: number, private windowMs = 60_000) {}

  check(ip: string): boolean {
    const now = Date.now()
    const entry = this.counts.get(ip)
    if (!entry || now > entry.resetAt) {
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

  const manager = new SessionManager({
    idleTimeoutMs: config.idleTimeoutMs,
    maxSessions: config.maxSessions,
    authToken: config.authToken,
  })

  const rateLimiter = new RateLimiter(config.rateLimitPerMinute ?? 10)

  const app = express()
  app.use(express.json())

  // ── 鉴权中间件 ──────────────────────────────────────────────
  app.use((req, res, next) => {
    if (!config.authToken) return next()
    const auth = req.headers.authorization ?? ''
    if (auth === `Bearer ${config.authToken}`) return next()
    log.warn('未授权请求', { path: req.path, ip: req.ip })
    res.status(401).json({ error: '未授权' })
  })

  // ── REST API ─────────────────────────────────────────────────

  // 列出所有会话
  app.get('/sessions', (_req, res) => {
    res.json(manager.listSessions())
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
      res.json({
        session_id: session.info.id,
        ws_url: `ws://${host}:${port}/sessions/${session.info.id}/stream`,
      })
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
    await manager.destroySession(req.params.id)
    res.json({ ok: true })
  })

  // 健康检查（增强版：包含运行时指标）
  app.get('/health', (_req, res) => {
    const sessions = manager.listSessions()
    const busySessions = sessions.filter(s => s.status === 'busy').length
    const memUsage = process.memoryUsage()
    res.json({
      status: 'ok',
      uptime: Math.floor((Date.now() - startTime) / 1000),
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

  // ── WebSocket 服务器 ─────────────────────────────────────────
  const server = http.createServer(app)
  const wss = new WebSocketServer({ server, path: '/sessions' })

  wss.on('connection', (ws: WebSocket, req) => {
    // 路径格式：/sessions/:id/stream
    const match = req.url?.match(/^\/sessions\/([^/]+)\/stream$/)
    if (!match) {
      ws.close(1008, '无效的路径')
      return
    }
    const sessionId = match[1]

    // WebSocket 鉴权（通过 URL query 参数 token 或 Sec-WebSocket-Protocol）
    if (config.authToken) {
      const url = new URL(req.url!, `http://${req.headers.host}`)
      const token = url.searchParams.get('token')
        ?? req.headers['sec-websocket-protocol']
      if (token !== config.authToken) {
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
    manager.subscribe(sessionId, ws)
    ws.send(JSON.stringify({ type: 'ready', session_id: sessionId }))

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
          resolve()
        })
      })
    },
    // 优雅关闭：等待进行中任务完成，再关闭 HTTP/WS 服务
    async stop(gracefulTimeoutMs = 10000): Promise<void> {
      log.info('开始关闭 Gateway')
      await manager.gracefulShutdown(gracefulTimeoutMs)
      return new Promise((resolve, reject) => {
        wss.close()
        server.close(err => {
          if (err) { log.error('关闭 HTTP 服务失败', { error: String(err) }); reject(err) }
          else { log.info('Gateway 已关闭'); resolve() }
        })
      })
    },
    manager,
    server,
  }
}
