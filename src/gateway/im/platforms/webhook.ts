/**
 * 通用 Webhook 平台适配器
 *
 * 启动一个独立的 HTTP 服务器，接受任意客户端通过 HTTP POST 发送消息，
 * 并通过 SSE（Server-Sent Events）或轮询接口获取 agent 回复。
 *
 * 接口设计（OpenAI 兼容风格）：
 *   POST /message          — 发送消息，同步等待回复（适合简单场景）
 *   POST /message/stream   — 发送消息，SSE 流式返回回复
 *   GET  /health           — 健康检查
 *
 * 请求体（JSON）：
 *   { "chat_id": "user123", "text": "你好", "user_id": "user123", "user_name": "张三" }
 *
 * 鉴权：
 *   Authorization: Bearer <secret>（若配置了 secret）
 */

import http from 'http'
import { logger } from '../../../shared/logger.js'
import { BasePlatformAdapter, type SendOptions } from '../base-platform-adapter.js'
import type { InboundMessage, MessageSource, MessageType, SendResult, WebhookConfig } from '../types.js'

const log = logger.child({ component: 'im-webhook' })

// ── SSE 连接管理 ──────────────────────────────────────────────────────────────
interface SSEClient {
  chatId: string
  res: http.ServerResponse
  createdAt: number
}

// ── 适配器实现 ────────────────────────────────────────────────────────────────
export class WebhookAdapter extends BasePlatformAdapter {
  private webhookConfig: WebhookConfig
  private server: http.Server | null = null
  /** chatId → 待发送的消息队列（同步模式用） */
  private pendingReplies = new Map<string, string[]>()
  /** chatId → SSE 客户端（流式模式用） */
  private sseClients = new Map<string, SSEClient>()
  /** 等待回复的 Promise resolve 函数（同步模式） */
  private replyWaiters = new Map<string, (text: string) => void>()

  constructor(config: WebhookConfig) {
    super('webhook', config)
    this.webhookConfig = config
  }

  /**
   * Webhook 能力声明：
   * - 不支持编辑消息（HTTP 无状态，无法回头编辑已发送的响应）
   * - 不需要持续 typing（HTTP 场景无 typing 概念）
   */
  override get capabilities() {
    return {
      supportsMessageEdit: false,
      supportsKeepTyping: false,
    }
  }

  async connect(): Promise<void> {
    const port = this.webhookConfig.port ?? 3283
    const host = this.webhookConfig.host ?? '127.0.0.1'

    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res)
    })

    if (!this.webhookConfig.secret) {
      log.warn('Webhook 适配器未配置 secret，任意来源可发送消息，生产环境建议配置 secret')
    }

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(port, host, () => {
        log.info('Webhook 适配器已启动', { host, port })
        resolve()
      })
      this.server!.on('error', reject)
    })

    this.running = true
  }

  async disconnect(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve())
      })
      this.server = null
    }
    // 关闭所有 SSE 连接
    for (const client of this.sseClients.values()) {
      try { client.res.end() } catch { /* 忽略 */ }
    }
    this.sseClients.clear()
    this.running = false
    log.info('Webhook 适配器已停止')
  }

  async sendText(chatId: string, text: string, _options?: SendOptions): Promise<SendResult> {
    // 优先通过 SSE 推送
    const sseClient = this.sseClients.get(chatId)
    if (sseClient) {
      try {
        const data = JSON.stringify({ type: 'text', content: text })
        sseClient.res.write(`data: ${data}\n\n`)
        return { success: true }
      } catch (err) {
        this.sseClients.delete(chatId)
        log.warn('SSE 推送失败，客户端可能已断开', { chatId, error: String(err) })
      }
    }

    // 其次通过同步等待 resolve
    const waiter = this.replyWaiters.get(chatId)
    if (waiter) {
      waiter(text)
      this.replyWaiters.delete(chatId)
      return { success: true }
    }

    // 最后放入队列（客户端轮询获取）
    const queue = this.pendingReplies.get(chatId) ?? []
    queue.push(text)
    this.pendingReplies.set(chatId, queue)
    return { success: true }
  }

  // ── HTTP 请求处理 ────────────────────────────────────────────────────────────

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    // 鉴权
    if (this.webhookConfig.secret) {
      const auth = req.headers.authorization ?? ''
      if (auth !== `Bearer ${this.webhookConfig.secret}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: '未授权' }))
        return
      }
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)

    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', platform: 'webhook' }))
      return
    }

    if (url.pathname === '/message' && req.method === 'POST') {
      await this.handleSyncMessage(req, res)
      return
    }

    if (url.pathname === '/message/stream' && req.method === 'POST') {
      await this.handleStreamMessage(req, res)
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: '路径不存在' }))
  }

  /** 同步模式：等待 agent 回复后一次性返回 */
  private async handleSyncMessage(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: MessageBody
    try {
      body = await readJSON<MessageBody>(req)
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: `请求体解析失败: ${String(err)}` }))
      return
    }

    if (!body.text?.trim()) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: '缺少 text 字段' }))
      return
    }

    const chatId = body.chat_id ?? body.user_id ?? 'default'

    // 注册等待器（最多等 120 秒）
    const replyPromise = new Promise<string>((resolve) => {
      this.replyWaiters.set(chatId, resolve)
      setTimeout(() => {
        if (this.replyWaiters.get(chatId) === resolve) {
          this.replyWaiters.delete(chatId)
          resolve('（Agent 响应超时）')
        }
      }, 120_000)
    })

    // 触发消息处理
    await this.dispatchMessage(body, chatId)

    // 等待回复
    const reply = await replyPromise

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ reply, chat_id: chatId }))
  }

  /** 流式模式：通过 SSE 实时推送 agent 输出 */
  private async handleStreamMessage(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: MessageBody
    try {
      body = await readJSON<MessageBody>(req)
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: `请求体解析失败: ${String(err)}` }))
      return
    }

    if (!body.text?.trim()) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: '缺少 text 字段' }))
      return
    }

    const chatId = body.chat_id ?? body.user_id ?? 'default'

    // 建立 SSE 连接
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    // 关闭同 chatId 的旧 SSE 连接，防止资源泄漏
    const oldClient = this.sseClients.get(chatId)
    if (oldClient) {
      try { oldClient.res.end() } catch { /* 忽略 */ }
    }

    const client: SSEClient = { chatId, res, createdAt: Date.now() }
    this.sseClients.set(chatId, client)

    req.on('close', () => {
      this.sseClients.delete(chatId)
    })

    // 发送连接确认
    res.write(`data: ${JSON.stringify({ type: 'connected', chat_id: chatId })}\n\n`)

    // 触发消息处理
    await this.dispatchMessage(body, chatId)
  }

  private async dispatchMessage(body: MessageBody, chatId: string): Promise<void> {
    const source: MessageSource = {
      platform: 'webhook',
      chatId,
      chatType: 'dm',
      userId: body.user_id ?? chatId,
      userName: body.user_name,
    }

    const text = body.text ?? ''
    const messageType: MessageType = text.startsWith('/') ? 'command' : 'text'

    const inbound: InboundMessage = {
      messageId: `wh-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      source,
      messageType,
      text,
      receivedAt: Date.now(),
      raw: body,
    }

    await this.handleInbound(inbound)
  }
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────

interface MessageBody {
  text?: string
  chat_id?: string
  user_id?: string
  user_name?: string
}

function readJSON<T>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let data = ''
    const MAX_BODY = 10 * 1024 * 1024 // 10MB
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > MAX_BODY) {
        req.destroy()
        reject(new Error('请求体超过 10MB 限制'))
      }
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(data) as T)
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}
