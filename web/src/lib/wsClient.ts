import type { ServerMessage, ClientMessage } from './types.js'

// 指数退避重连延迟（毫秒）：1s → 2s → 4s → 8s → 16s
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000]

export type WsStatus = 'connected' | 'reconnecting' | 'disconnected'

export class WsClient {
  private readonly url: string
  private readonly token: string
  private readonly onMessage: (msg: ServerMessage) => void
  private readonly onStatusChange?: (status: WsStatus) => void
  private readonly onMaxRetriesExceeded?: () => void
  private readonly onUnauthorized?: () => void

  private ws: WebSocket | null = null
  private status: WsStatus = 'disconnected'
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  /** 当前连接是否已成功握手（onopen 已触发） */
  private opened = false

  /** 断线期间积压的待发消息队列 */
  private pendingQueue: ClientMessage[] = []

  /** 是否已主动调用 close()，主动关闭不触发重连 */
  private closed = false

  constructor(
    url: string,
    token: string,
    onMessage: (msg: ServerMessage) => void,
    onStatusChange?: (status: WsStatus) => void,
    onMaxRetriesExceeded?: () => void,
    onUnauthorized?: () => void,
  ) {
    this.url = url
    this.token = token
    this.onMessage = onMessage
    this.onStatusChange = onStatusChange
    this.onMaxRetriesExceeded = onMaxRetriesExceeded
    this.onUnauthorized = onUnauthorized
    this.connect()
  }

  // ─── 公开方法 ────────────────────────────────────────────────────────────

  /** 发送消息；若当前未连接则加入队列，重连后自动发送 */
  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      console.debug('[WsClient] ▶ send', msg)
      this.ws.send(JSON.stringify(msg))
    } else {
      console.warn('[WsClient] 连接未就绪，消息入队', { status: this.status, msg })
      this.pendingQueue.push(msg)
    }
  }

  /** 手动触发重连（重置重连计数） */
  reconnect(): void {
    if (this.closed) return
    this.reconnectAttempt = 0
    this.clearReconnectTimer()
    this.connect()
  }

  /** 主动关闭连接，不再重连 */
  close(): void {
    this.closed = true
    this.clearReconnectTimer()
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.setStatus('disconnected')
  }

  /** 获取当前连接状态 */
  getStatus(): WsStatus {
    return this.status
  }

  // ─── 内部方法 ────────────────────────────────────────────────────────────

  private connect(): void {
    if (this.closed) return
    this.opened = false

    // 通过 Sec-WebSocket-Protocol 传递 token（避免 token 出现在 URL/日志中）
    const wsUrl = this.url
    const protocols = this.token ? [this.token] : undefined

    console.debug('[WsClient] 🔗 正在连接...', { url: wsUrl, attempt: this.reconnectAttempt })

    try {
      this.ws = protocols ? new WebSocket(wsUrl, protocols) : new WebSocket(wsUrl)
    } catch (err) {
      // URL 格式错误等同步异常
      console.error('[WsClient] 创建 WebSocket 失败:', err)
      this.scheduleReconnect()
      return
    }

    this.ws.onopen = () => {
      this.opened = true
      this.reconnectAttempt = 0
      this.setStatus('connected')
      console.debug('[WsClient] ✅ 连接已建立', { url: this.url })
      this.flushPendingQueue()
    }

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data as string) as ServerMessage
        console.debug('[WsClient] ◀ recv', msg)
        // 收到"会话不存在"错误时主动关闭，不再重连（避免死循环）
        if (msg.type === 'error' && typeof msg.message === 'string' && msg.message.includes('会话不存在')) {
          console.warn('[WsClient] 会话不存在，停止重连:', msg.message)
          this.close()
          return
        }
        this.onMessage(msg)
      } catch (err) {
        console.error('[WsClient] 消息解析失败:', err, event.data)
      }
    }

    this.ws.onerror = (event) => {
      console.error('[WsClient] ❌ WebSocket 错误:', event)
      // 连接从未建立就出错 → 握手被拒绝（通常是认证失败），停止重连
      if (!this.opened) {
        console.warn('[WsClient] 握手失败，连接从未建立，停止重连')
        this.close()
        this.onUnauthorized?.()
      }
    }

    this.ws.onclose = (event) => {
      this.ws = null
      console.warn(`[WsClient] 🔌 onclose 触发: code=${event.code}, reason=${event.reason || '无'}, wasClean=${event.wasClean}, this.closed=${this.closed}`)
      if (this.closed) return

      // 1008 = Policy Violation，服务端用于拒绝未授权连接
      if (event.code === 1008) {
        console.warn(`[WsClient] 🔌 连接未授权 (code=1008)，停止重连，触发 onUnauthorized`)
        this.close()
        this.onUnauthorized?.()
        return
      }

      console.warn(`[WsClient] 🔌 连接断开 (code=${event.code}, reason=${event.reason || '无'})，准备重连...`)
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return

    if (this.reconnectAttempt >= RECONNECT_DELAYS.length) {
      // 超过最大重连次数，标记为断开，并触发回调
      console.error('[WsClient] 已达最大重连次数，停止重连')
      this.setStatus('disconnected')
      this.onMaxRetriesExceeded?.()
      return
    }

    const delay = RECONNECT_DELAYS[this.reconnectAttempt]
    this.reconnectAttempt++
    this.setStatus('reconnecting')

    console.info(`[WsClient] 第 ${this.reconnectAttempt} 次重连，${delay}ms 后尝试...`)

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  /** 连接恢复后，将积压队列中的消息依次发送 */
  private flushPendingQueue(): void {
    if (this.pendingQueue.length > 0) {
      console.debug('[WsClient] 🚀 刷新积压队列', { count: this.pendingQueue.length })
    }
    while (this.pendingQueue.length > 0) {
      const msg = this.pendingQueue.shift()!
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        console.debug('[WsClient] ▶ flush send', msg)
        this.ws.send(JSON.stringify(msg))
      } else {
        // 连接再次断开，将消息放回队首
        this.pendingQueue.unshift(msg)
        break
      }
    }
  }

  private setStatus(status: WsStatus): void {
    if (this.status !== status) {
      this.status = status
      this.onStatusChange?.(status)
    }
  }
}
