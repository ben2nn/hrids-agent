/**
 * 微信平台适配器（iLink Bot API）
 *
 * 通过腾讯 iLink Bot API 接入微信个人号，
 * 使用长轮询接收消息，支持文本发送和 Markdown 转换。
 *
 * 参考 hermes-agent gateway/platforms/weixin.py
 *
 * 注意：需要微信账号已通过 iLink 平台授权（扫码登录）。
 */

import https from 'https'
import { logger } from '../../../core/logger.js'
import { BasePlatformAdapter, markdownToPlainText, type SendOptions } from '../BasePlatformAdapter.js'
import type { InboundMessage, MessageSource, MessageType, SendResult, WeixinConfig } from '../types.js'

const log = logger.child({ component: 'im-weixin' })

// ── iLink API 常量 ────────────────────────────────────────────────────────────
const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com'
const EP_GET_UPDATES = 'ilink/bot/getupdates'
const EP_SEND_MESSAGE = 'ilink/bot/sendmessage'
const EP_SEND_TYPING = 'ilink/bot/sendtyping'

const LONG_POLL_TIMEOUT_MS = 35_000
const API_TIMEOUT_MS = 15_000
const MAX_CONSECUTIVE_FAILURES = 5
const RETRY_DELAY_MS = 2_000
const BACKOFF_DELAY_MS = 30_000
const SESSION_EXPIRED_ERRCODE = -14
const MESSAGE_DEDUP_TTL_MS = 300_000  // 5 分钟

// ── iLink 消息类型常量 ────────────────────────────────────────────────────────
const ITEM_TEXT = 1
const MSG_TYPE_USER = 1
const MSG_STATE_FINISH = 2
const TYPING_START = 1
const TYPING_STOP = 2

// ── iLink API 响应类型 ────────────────────────────────────────────────────────
interface ILinkResponse<T = unknown> {
  errcode: number
  errmsg: string
  data?: T
}

interface ILinkUpdate {
  msg_id: string
  msg_type: number
  msg_state: number
  from_user: string
  from_user_name?: string
  to_user: string
  group_id?: string
  group_name?: string
  context_token: string
  items?: Array<{
    type: number
    content?: string
  }>
  timestamp: number
}

interface ILinkGetUpdatesResponse {
  updates?: ILinkUpdate[]
  next_token?: string
}

interface ILinkSendResponse {
  msg_id?: string
}

// ── 适配器实现 ────────────────────────────────────────────────────────────────
export class WeixinAdapter extends BasePlatformAdapter {
  private weixinConfig: WeixinConfig
  private pollToken = ''
  private stopSignal = false
  /** 最近收到的消息 ID → 时间戳（用于去重） */
  private processedIds = new Map<string, number>()
  /** 每个聊天的最新 context_token（发送消息时必须携带） */
  private contextTokens = new Map<string, string>()

  constructor(config: WeixinConfig) {
    super('weixin', config)
    this.weixinConfig = config
  }

  async connect(): Promise<void> {
    this.stopSignal = false
    this.running = true
    log.info('微信适配器已启动，开始长轮询')
    // 在后台启动轮询循环
    void this.pollLoop()
  }

  async disconnect(): Promise<void> {
    this.stopSignal = true
    this.running = false
    log.info('微信适配器已停止')
  }

  async sendText(chatId: string, text: string, options?: SendOptions): Promise<SendResult> {
    // 微信不支持 Markdown，转换为纯文本
    const plainText = markdownToPlainText(text)

    // 微信单条消息建议不超过 2000 字
    if (plainText.length > 2000) {
      return this.sendLongText(chatId, plainText, 2000, options)
    }

    return this.sendWeixinMessage(chatId, plainText)
  }

  async sendTyping(chatId: string): Promise<void> {
    const contextToken = this.contextTokens.get(chatId)
    if (!contextToken) return

    try {
      await this.callAPI(EP_SEND_TYPING, {
        to_user: chatId,
        context_token: contextToken,
        typing: TYPING_START,
      })
    } catch { /* 忽略 */ }
  }

  // ── 私有方法 ────────────────────────────────────────────────────────────────

  private async pollLoop(): Promise<void> {
    let consecutiveFailures = 0

    while (!this.stopSignal) {
      try {
        const resp = await this.callAPI<ILinkGetUpdatesResponse>(EP_GET_UPDATES, {
          token: this.weixinConfig.token,
          account_id: this.weixinConfig.accountId,
          next_token: this.pollToken,
          timeout: LONG_POLL_TIMEOUT_MS,
        }, LONG_POLL_TIMEOUT_MS + 5000)

        consecutiveFailures = 0

        if (resp.data?.next_token) {
          this.pollToken = resp.data.next_token
        }

        const updates = resp.data?.updates ?? []
        for (const update of updates) {
          await this.processUpdate(update)
        }
      } catch (err) {
        consecutiveFailures++
        const errMsg = String(err)

        // 会话过期：需要重新登录
        if (errMsg.includes(String(SESSION_EXPIRED_ERRCODE))) {
          log.error('微信会话已过期，需要重新扫码登录')
          this.running = false
          return
        }

        log.warn('微信轮询失败', { error: errMsg, consecutiveFailures })

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          log.error('微信连续失败次数过多，等待后重试', { delay: BACKOFF_DELAY_MS })
          await sleep(BACKOFF_DELAY_MS)
          consecutiveFailures = 0
        } else {
          await sleep(RETRY_DELAY_MS)
        }
      }
    }
  }

  private async processUpdate(update: ILinkUpdate): Promise<void> {
    // 只处理用户发来的已完成消息
    if (update.msg_type !== MSG_TYPE_USER) return
    if (update.msg_state !== MSG_STATE_FINISH) return

    // 去重
    const msgId = update.msg_id
    const now = Date.now()
    if (this.processedIds.has(msgId)) return
    this.processedIds.set(msgId, now)

    // 清理过期的去重记录
    for (const [id, ts] of this.processedIds) {
      if (now - ts > MESSAGE_DEDUP_TTL_MS) this.processedIds.delete(id)
    }

    // 保存 context_token（发送回复时需要）
    const chatId = update.group_id ?? update.from_user
    this.contextTokens.set(chatId, update.context_token)

    // 提取文本内容
    const textItem = update.items?.find(item => item.type === ITEM_TEXT)
    const text = textItem?.content ?? ''

    if (!text.trim()) return  // 忽略非文本消息（图片等暂不处理）

    // 鉴权
    if (this.weixinConfig.allowedUsers && this.weixinConfig.allowedUsers.length > 0) {
      if (!this.weixinConfig.allowedUsers.includes(update.from_user)) {
        log.warn('微信未授权用户', { userId: update.from_user })
        return
      }
    }

    const isGroup = !!update.group_id
    const source: MessageSource = {
      platform: 'weixin',
      chatId,
      chatName: isGroup ? update.group_name : update.from_user_name,
      chatType: isGroup ? 'group' : 'dm',
      userId: update.from_user,
      userName: update.from_user_name,
    }

    const messageType: MessageType = text.startsWith('/') ? 'command' : 'text'

    const inbound: InboundMessage = {
      messageId: msgId,
      source,
      messageType,
      text,
      receivedAt: update.timestamp * 1000,
      raw: update,
    }

    await this.handleInbound(inbound)
  }

  private async sendWeixinMessage(chatId: string, text: string): Promise<SendResult> {
    const contextToken = this.contextTokens.get(chatId) ?? ''

    try {
      const resp = await this.callAPI<ILinkSendResponse>(EP_SEND_MESSAGE, {
        token: this.weixinConfig.token,
        account_id: this.weixinConfig.accountId,
        to_user: chatId,
        context_token: contextToken,
        items: [{ type: ITEM_TEXT, content: text }],
      })

      if (resp.errcode !== 0) {
        return { success: false, error: `iLink API 错误 ${resp.errcode}: ${resp.errmsg}` }
      }

      return { success: true, messageId: resp.data?.msg_id }
    } catch (err) {
      log.error('微信发送消息失败', { chatId, error: String(err) })
      return { success: false, error: String(err) }
    }
  }

  private async callAPI<T = unknown>(
    endpoint: string,
    body: Record<string, unknown>,
    timeoutMs = API_TIMEOUT_MS,
  ): Promise<ILinkResponse<T>> {
    const url = `${ILINK_BASE_URL}/${endpoint}`
    const payload = JSON.stringify(body)

    return new Promise((resolve, reject) => {
      const urlObj = new URL(url)
      const options = {
        hostname: urlObj.hostname,
        path: urlObj.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: timeoutMs,
      }

      const req = https.request(options, (res) => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          try {
            resolve(JSON.parse(data) as ILinkResponse<T>)
          } catch (err) {
            reject(new Error(`JSON 解析失败: ${String(err)}, 原始响应: ${data.slice(0, 200)}`))
          }
        })
      })

      req.on('error', reject)
      req.on('timeout', () => {
        req.destroy()
        reject(new Error(`请求超时 (${timeoutMs}ms)`))
      })

      req.write(payload)
      req.end()
    })
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
