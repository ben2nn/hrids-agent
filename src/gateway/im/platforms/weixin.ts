/**
 * 微信平台适配器（iLink Bot API）
 *
 * 完整移植自 hermes-agent gateway/platforms/weixin.py
 *
 * 关键协议细节（来自逆向 @tencent-weixin/openclaw-weixin）：
 * - 所有请求必须携带 AuthorizationType / Authorization / X-WECHAT-UIN 等头
 * - sendmessage 必须包含 client_id / message_type:2 / message_state:2 / base_info
 *   缺少任何一个字段 → HTTP 200 但消息静默丢弃
 * - context_token 必须持久化到磁盘，重启后恢复
 * - get_updates_buf（sync cursor）同样需要持久化
 * - sendTyping 需要先调 getconfig 获取 typing_ticket
 */

import crypto from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs'
import https from 'https'
import { homedir } from 'os'
import { join } from 'path'
import { logger } from '../../../core/logger.js'
import { BasePlatformAdapter, type SendOptions } from '../BasePlatformAdapter.js'
import type { InboundMessage, MessageSource, MessageType, SendResult, WeixinConfig } from '../types.js'

const log = logger.child({ component: 'im-weixin' })

// ── iLink API 常量 ────────────────────────────────────────────────────────────
const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com'
const ILINK_APP_ID = 'bot'
const CHANNEL_VERSION = '2.2.0'
// (2 << 16) | (2 << 8) | 0 = 131072
const ILINK_APP_CLIENT_VERSION = (2 << 16) | (2 << 8) | 0

const EP_GET_UPDATES = 'ilink/bot/getupdates'
const EP_SEND_MESSAGE = 'ilink/bot/sendmessage'
const EP_SEND_TYPING = 'ilink/bot/sendtyping'
const EP_GET_CONFIG = 'ilink/bot/getconfig'

const LONG_POLL_TIMEOUT_MS = 35_000
const API_TIMEOUT_MS = 15_000
const CONFIG_TIMEOUT_MS = 10_000
const MAX_CONSECUTIVE_FAILURES = 3
const RETRY_DELAY_MS = 2_000
const BACKOFF_DELAY_MS = 30_000
const SESSION_EXPIRED_ERRCODE = -14
const MESSAGE_DEDUP_TTL_MS = 300_000
const MAX_MESSAGE_LENGTH = 4000
// 多段消息之间的延迟（避免乱序）
const SEND_CHUNK_DELAY_MS = 350
const SEND_CHUNK_RETRIES = 2

// ── iLink 消息类型常量 ────────────────────────────────────────────────────────
const ITEM_TEXT = 1
const MSG_TYPE_USER = 1
const MSG_TYPE_BOT = 2
const MSG_STATE_FINISH = 2
const TYPING_START = 1

// ── 持久化路径 ────────────────────────────────────────────────────────────────
function accountDir(): string {
  const dir = join(homedir(), '.hrids-agent', 'weixin', 'accounts')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function contextTokensPath(accountId: string): string {
  return join(accountDir(), `${accountId}.context-tokens.json`)
}

function syncBufPath(accountId: string): string {
  return join(accountDir(), `${accountId}.sync.json`)
}

function atomicWrite(path: string, data: unknown): void {
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
  renameSync(tmp, path)
}

// ── context_token 磁盘持久化存储 ──────────────────────────────────────────────
class ContextTokenStore {
  private cache = new Map<string, string>()

  private key(accountId: string, userId: string): string {
    return `${accountId}:${userId}`
  }

  restore(accountId: string): void {
    const path = contextTokensPath(accountId)
    if (!existsSync(path)) return
    try {
      const data = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, string>
      let count = 0
      for (const [userId, token] of Object.entries(data)) {
        if (typeof token === 'string' && token) {
          this.cache.set(this.key(accountId, userId), token)
          count++
        }
      }
      if (count > 0) log.debug('恢复 context_token', { accountId: accountId.slice(0, 8), count })
    } catch (err) {
      log.warn('context_token 恢复失败', { error: String(err) })
    }
  }

  get(accountId: string, userId: string): string | undefined {
    return this.cache.get(this.key(accountId, userId))
  }

  set(accountId: string, userId: string, token: string): void {
    this.cache.set(this.key(accountId, userId), token)
    this.persist(accountId)
  }

  private persist(accountId: string): void {
    const prefix = `${accountId}:`
    const payload: Record<string, string> = {}
    for (const [k, v] of this.cache) {
      if (k.startsWith(prefix)) {
        payload[k.slice(prefix.length)] = v
      }
    }
    try {
      atomicWrite(contextTokensPath(accountId), payload)
    } catch (err) {
      log.warn('context_token 持久化失败', { error: String(err) })
    }
  }
}

// ── typing_ticket 内存缓存（10 分钟 TTL）─────────────────────────────────────
class TypingTicketCache {
  private cache = new Map<string, { ticket: string; at: number }>()
  private readonly ttlMs: number

  constructor(ttlMs = 600_000) {
    this.ttlMs = ttlMs
  }

  get(userId: string): string | undefined {
    const entry = this.cache.get(userId)
    if (!entry) return undefined
    if (Date.now() - entry.at >= this.ttlMs) {
      this.cache.delete(userId)
      return undefined
    }
    return entry.ticket
  }

  set(userId: string, ticket: string): void {
    this.cache.set(userId, { ticket, at: Date.now() })
  }
}

// ── sync_buf 持久化 ───────────────────────────────────────────────────────────
function loadSyncBuf(accountId: string): string {
  const path = syncBufPath(accountId)
  if (!existsSync(path)) return ''
  try {
    return (JSON.parse(readFileSync(path, 'utf-8')) as Record<string, string>).get_updates_buf ?? ''
  } catch {
    return ''
  }
}

function saveSyncBuf(accountId: string, buf: string): void {
  try {
    atomicWrite(syncBufPath(accountId), { get_updates_buf: buf })
  } catch { /* 忽略 */ }
}

// ── 请求头构造 ────────────────────────────────────────────────────────────────
function randomWechatUin(): string {
  const val = crypto.randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(val), 'utf-8').toString('base64')
}

function buildHeaders(token: string | null, bodyBytes: Buffer): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'AuthorizationType': 'ilink_bot_token',
    'Content-Length': String(bodyBytes.length),
    'X-WECHAT-UIN': randomWechatUin(),
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
  }
  if (token) headers['Authorization'] = `Bearer ${token}`
  return headers
}

// ── 核心 HTTP 请求 ────────────────────────────────────────────────────────────
function apiPost(
  endpoint: string,
  payload: Record<string, unknown>,
  token: string | null,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  // 每个请求自动附加 base_info
  const body = JSON.stringify({ ...payload, base_info: { channel_version: CHANNEL_VERSION } })
  const bodyBytes = Buffer.from(body, 'utf-8')
  const headers = buildHeaders(token, bodyBytes)
  const url = new URL(`${ILINK_BASE_URL}/${endpoint}`)

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        let raw = ''
        res.on('data', (chunk) => { raw += chunk })
        res.on('end', () => {
          if (!res.statusCode || res.statusCode >= 400) {
            reject(new Error(`iLink POST ${endpoint} HTTP ${res.statusCode}: ${raw.slice(0, 200)}`))
            return
          }
          const text = raw.trim()
          if (!text || text === '{}') {
            resolve({})
            return
          }
          try {
            resolve(JSON.parse(text) as Record<string, unknown>)
          } catch (err) {
            reject(new Error(`JSON 解析失败: ${String(err)}, 原始: ${raw.slice(0, 200)}`))
          }
        })
      },
    )
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error(`请求超时 (${timeoutMs}ms): ${endpoint}`))
    })
    req.write(bodyBytes)
    req.end()
  })
}

// ── getupdates（长轮询，超时返回空结果而非抛出）──────────────────────────────
async function getUpdates(
  token: string,
  syncBuf: string,
): Promise<Record<string, unknown>> {
  try {
    return await apiPost(
      EP_GET_UPDATES,
      { get_updates_buf: syncBuf },
      token,
      LONG_POLL_TIMEOUT_MS + 5_000,
    )
  } catch (err) {
    // 超时视为空响应，继续轮询
    if (String(err).includes('超时')) {
      return { ret: 0, msgs: [], get_updates_buf: syncBuf }
    }
    throw err
  }
}

// ── sendmessage（包含所有必填字段）───────────────────────────────────────────
async function sendMessage(
  token: string,
  to: string,
  text: string,
  contextToken: string | undefined,
  clientId: string,
): Promise<Record<string, unknown>> {
  const msg: Record<string, unknown> = {
    from_user_id: '',
    to_user_id: to,
    client_id: clientId,
    message_type: MSG_TYPE_BOT,
    message_state: MSG_STATE_FINISH,
    item_list: [{ type: ITEM_TEXT, text_item: { text } }],
  }
  if (contextToken) msg.context_token = contextToken
  return apiPost(EP_SEND_MESSAGE, { msg }, token, API_TIMEOUT_MS)
}

// ── getconfig（获取 typing_ticket）───────────────────────────────────────────
async function getConfig(
  token: string,
  userId: string,
  contextToken: string | undefined,
): Promise<Record<string, unknown>> {
  const payload: Record<string, unknown> = { ilink_user_id: userId }
  if (contextToken) payload.context_token = contextToken
  return apiPost(EP_GET_CONFIG, payload, token, CONFIG_TIMEOUT_MS)
}

// ── sendtyping ────────────────────────────────────────────────────────────────
async function sendTypingReq(
  token: string,
  toUserId: string,
  typingTicket: string,
  status: number,
): Promise<void> {
  await apiPost(
    EP_SEND_TYPING,
    { ilink_user_id: toUserId, typing_ticket: typingTicket, status },
    token,
    CONFIG_TIMEOUT_MS,
  )
}

// ── 文本格式化（保留 Markdown，清理多余空行）─────────────────────────────────
const FENCE_RE = /^```([^\n`]*)\s*$/

function normalizeMarkdownBlocks(content: string): string {
  const lines = content.split('\n')
  const result: string[] = []
  let inCodeBlock = false
  let blankRun = 0

  for (const rawLine of lines) {
    const line = rawLine.trimEnd()
    if (FENCE_RE.test(line.trim())) {
      inCodeBlock = !inCodeBlock
      result.push(line)
      blankRun = 0
      continue
    }
    if (inCodeBlock) {
      result.push(line)
      continue
    }
    if (!line.trim()) {
      blankRun++
      if (blankRun <= 1) result.push('')
      continue
    }
    blankRun = 0
    result.push(line)
  }
  return result.join('\n').trim()
}

// ── 文本分割（智能按 Markdown 块打包）────────────────────────────────────────
function splitMarkdownBlocks(content: string): string[] {
  if (!content) return []
  const blocks: string[] = []
  const lines = content.split('\n')
  let current: string[] = []
  let inCodeBlock = false

  for (const rawLine of lines) {
    const line = rawLine.trimEnd()
    if (FENCE_RE.test(line.trim())) {
      if (!inCodeBlock && current.length) {
        blocks.push(current.join('\n').trim())
        current = []
      }
      current.push(line)
      inCodeBlock = !inCodeBlock
      if (!inCodeBlock) {
        blocks.push(current.join('\n').trim())
        current = []
      }
      continue
    }
    if (inCodeBlock) { current.push(line); continue }
    if (!line.trim()) {
      if (current.length) { blocks.push(current.join('\n').trim()); current = [] }
      continue
    }
    current.push(line)
  }
  if (current.length) blocks.push(current.join('\n').trim())
  return blocks.filter(Boolean)
}

function packMarkdownBlocks(content: string, maxLength: number): string[] {
  if (content.length <= maxLength) return [content]
  const packed: string[] = []
  let current = ''
  for (const block of splitMarkdownBlocks(content)) {
    const candidate = current ? `${current}\n\n${block}` : block
    if (candidate.length <= maxLength) { current = candidate; continue }
    if (current) { packed.push(current); current = '' }
    if (block.length <= maxLength) { current = block; continue }
    // 强制截断超长块
    let remaining = block
    while (remaining.length > maxLength) {
      packed.push(remaining.slice(0, maxLength))
      remaining = remaining.slice(maxLength)
    }
    if (remaining) current = remaining
  }
  if (current) packed.push(current)
  return packed
}

function splitTextForDelivery(content: string): string[] {
  if (!content) return []
  if (content.length <= MAX_MESSAGE_LENGTH) return [content]
  return packMarkdownBlocks(content, MAX_MESSAGE_LENGTH).filter(Boolean)
}

// ── 消息去重 ──────────────────────────────────────────────────────────────────
class MessageDeduplicator {
  private seen = new Map<string, number>()

  isDuplicate(id: string): boolean {
    const now = Date.now()
    // 清理过期记录
    for (const [k, ts] of this.seen) {
      if (now - ts > MESSAGE_DEDUP_TTL_MS) this.seen.delete(k)
    }
    if (this.seen.has(id)) return true
    this.seen.set(id, now)
    return false
  }
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function safeId(val: unknown, keep = 8): string {
  const s = String(val ?? '').trim()
  return s.length <= keep ? s : s.slice(0, keep)
}

function guessIsGroup(msg: Record<string, unknown>, accountId: string): [boolean, string] {
  const roomId = String(msg.room_id ?? msg.chat_room_id ?? '').trim()
  const toUserId = String(msg.to_user_id ?? '').trim()
  const isGroup = !!roomId || (!!toUserId && toUserId !== accountId && msg.msg_type === MSG_TYPE_USER)
  if (isGroup) return [true, roomId || toUserId || String(msg.from_user_id ?? '')]
  return [false, String(msg.from_user_id ?? '')]
}

function extractText(itemList: unknown[]): string {
  for (const item of itemList as Record<string, unknown>[]) {
    if (item.type === ITEM_TEXT) {
      return String((item.text_item as Record<string, unknown> | undefined)?.text ?? '')
    }
  }
  return ''
}

// ── 适配器主体 ────────────────────────────────────────────────────────────────
export class WeixinAdapter extends BasePlatformAdapter {
  private weixinConfig: WeixinConfig
  private stopSignal = false
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private tokenStore: ContextTokenStore
  private typingCache: TypingTicketCache
  private dedup: MessageDeduplicator
  private syncBuf: string

  constructor(config: WeixinConfig) {
    super('weixin', config)
    this.weixinConfig = config
    this.tokenStore = new ContextTokenStore()
    this.typingCache = new TypingTicketCache()
    this.dedup = new MessageDeduplicator()
    this.syncBuf = ''
  }

  async connect(): Promise<void> {
    if (!this.weixinConfig.token) throw new Error('微信适配器缺少 token')
    if (!this.weixinConfig.accountId) throw new Error('微信适配器缺少 accountId')

    this.stopSignal = false
    this.running = true

    // 恢复持久化状态
    this.tokenStore.restore(this.weixinConfig.accountId)
    this.syncBuf = loadSyncBuf(this.weixinConfig.accountId)

    log.info('微信适配器已启动', {
      accountId: safeId(this.weixinConfig.accountId),
      hasSyncBuf: !!this.syncBuf,
    })

    void this.pollLoop()
  }

  async disconnect(): Promise<void> {
    this.stopSignal = true
    this.running = false
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
    log.info('微信适配器已停止')
  }

  async sendText(chatId: string, text: string, _options?: SendOptions): Promise<SendResult> {
    const formatted = normalizeMarkdownBlocks(text)
    const chunks = splitTextForDelivery(formatted)
    let result: SendResult = { success: true }

    for (let i = 0; i < chunks.length; i++) {
      result = await this.sendChunkWithRetry(chatId, chunks[i])
      if (!result.success) break
      if (i < chunks.length - 1) await sleep(SEND_CHUNK_DELAY_MS)
    }
    return result
  }

  async sendTyping(chatId: string): Promise<void> {
    const { token } = this.weixinConfig
    let ticket = this.typingCache.get(chatId)

    // 没有 ticket 时先 getconfig 获取
    if (!ticket) {
      try {
        const contextToken = this.tokenStore.get(this.weixinConfig.accountId, chatId)
        const resp = await getConfig(token, chatId, contextToken)
        const t = String(resp.typing_ticket ?? '')
        if (t) {
          this.typingCache.set(chatId, t)
          ticket = t
        }
      } catch (err) {
        log.debug('getConfig 失败', { chatId: safeId(chatId), error: String(err) })
        return
      }
    }

    if (!ticket) return
    try {
      await sendTypingReq(token, chatId, ticket, TYPING_START)
    } catch (err) {
      log.debug('sendTyping 失败', { chatId: safeId(chatId), error: String(err) })
    }
  }

  // ── 私有：轮询循环 ──────────────────────────────────────────────────────────

  private async pollLoop(): Promise<void> {
    let consecutiveFailures = 0

    while (!this.stopSignal) {
      try {
        const resp = await getUpdates(this.weixinConfig.token, this.syncBuf)

        const ret = resp.ret as number | undefined
        const errcode = resp.errcode as number | undefined

        // 会话过期：暂停 10 分钟
        if (ret === SESSION_EXPIRED_ERRCODE || errcode === SESSION_EXPIRED_ERRCODE) {
          log.error('微信会话已过期，暂停 10 分钟后重试')
          await sleep(600_000)
          consecutiveFailures = 0
          continue
        }

        // 其他错误码
        if ((ret != null && ret !== 0) || (errcode != null && errcode !== 0)) {
          consecutiveFailures++
          log.warn('getupdates 返回错误', { ret, errcode, errmsg: resp.errmsg, consecutiveFailures })
          await sleep(consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS)
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) consecutiveFailures = 0
          continue
        }

        consecutiveFailures = 0

        // 更新并持久化 sync cursor
        const newBuf = String(resp.get_updates_buf ?? '')
        if (newBuf) {
          this.syncBuf = newBuf
          saveSyncBuf(this.weixinConfig.accountId, newBuf)
        }

        // 处理消息
        const msgs = (resp.msgs ?? []) as Record<string, unknown>[]
        for (const msg of msgs) {
          void this.processMessageSafe(msg)
        }
      } catch (err) {
        consecutiveFailures++
        log.error('微信轮询异常', { error: String(err), consecutiveFailures })
        await sleep(consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS)
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) consecutiveFailures = 0
      }
    }
  }

  private async processMessageSafe(msg: Record<string, unknown>): Promise<void> {
    try {
      await this.processMessage(msg)
    } catch (err) {
      log.error('消息处理异常', { from: safeId(msg.from_user_id), error: String(err) })
    }
  }

  private async processMessage(msg: Record<string, unknown>): Promise<void> {
    const senderId = String(msg.from_user_id ?? '').trim()
    if (!senderId) return
    // 过滤自己发出的消息
    if (senderId === this.weixinConfig.accountId) return

    const messageId = String(msg.message_id ?? '').trim()
    if (messageId && this.dedup.isDuplicate(messageId)) return

    // 判断群聊 / 私聊
    const [isGroup, effectiveChatId] = guessIsGroup(msg, this.weixinConfig.accountId)

    // 群聊暂不处理（iLink 主要支持私聊）
    if (isGroup) return

    // 鉴权
    const { allowedUsers } = this.weixinConfig
    if (allowedUsers && allowedUsers.length > 0 && !allowedUsers.includes(senderId)) {
      log.warn('未授权用户', { userId: safeId(senderId) })
      return
    }

    // 保存 context_token
    const contextToken = String(msg.context_token ?? '').trim()
    if (contextToken) {
      this.tokenStore.set(this.weixinConfig.accountId, senderId, contextToken)
      // 异步预取 typing_ticket
      void this.maybeFetchTypingTicket(senderId, contextToken)
    }

    // 提取文本
    const itemList = (msg.item_list ?? []) as unknown[]
    const text = extractText(itemList)
    if (!text.trim()) return  // 暂不处理非文本消息

    const source: MessageSource = {
      platform: 'weixin',
      chatId: effectiveChatId,
      chatType: isGroup ? 'group' : 'dm',
      userId: senderId,
      userName: senderId,
    }

    const messageType: MessageType = text.startsWith('/') ? 'command' : 'text'

    const inbound: InboundMessage = {
      messageId: messageId || `wx-${Date.now()}`,
      source,
      messageType,
      text,
      receivedAt: Date.now(),
      raw: msg,
    }

    log.info('收到微信消息', { from: safeId(senderId), type: messageType })
    await this.handleInbound(inbound)
  }

  private async maybeFetchTypingTicket(userId: string, contextToken: string): Promise<void> {
    if (this.typingCache.get(userId)) return
    try {
      const resp = await getConfig(this.weixinConfig.token, userId, contextToken)
      const ticket = String(resp.typing_ticket ?? '')
      if (ticket) this.typingCache.set(userId, ticket)
    } catch (err) {
      log.debug('预取 typing_ticket 失败', { userId: safeId(userId), error: String(err) })
    }
  }

  // ── 私有：带重试的单段发送 ──────────────────────────────────────────────────

  private async sendChunkWithRetry(chatId: string, chunk: string): Promise<SendResult> {
    const { token, accountId } = this.weixinConfig
    let contextToken = this.tokenStore.get(accountId, chatId)
    let lastError: Error | null = null
    let retriedWithoutToken = false

    for (let attempt = 0; attempt <= SEND_CHUNK_RETRIES; attempt++) {
      try {
        const clientId = `hrids-weixin-${crypto.randomBytes(8).toString('hex')}`
        const resp = await sendMessage(token, chatId, chunk, contextToken, clientId)

        const ret = resp.ret as number | undefined
        const errcode = resp.errcode as number | undefined

        if ((ret != null && ret !== 0) || (errcode != null && errcode !== 0)) {
          const isExpired = ret === SESSION_EXPIRED_ERRCODE || errcode === SESSION_EXPIRED_ERRCODE
          // session 过期：去掉 context_token 重试一次
          if (isExpired && !retriedWithoutToken && contextToken) {
            retriedWithoutToken = true
            contextToken = undefined
            log.warn('session 过期，去掉 context_token 重试', { chatId: safeId(chatId) })
            continue
          }
          throw new Error(`iLink sendmessage 错误: ret=${ret} errcode=${errcode} errmsg=${resp.errmsg ?? ''}`)
        }

        return { success: true, messageId: clientId }
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        if (attempt < SEND_CHUNK_RETRIES) {
          const wait = RETRY_DELAY_MS * (attempt + 1)
          log.warn('发送失败，重试', { chatId: safeId(chatId), attempt: attempt + 1, wait })
          await sleep(wait)
        }
      }
    }

    log.error('发送消息最终失败', { chatId: safeId(chatId), error: String(lastError) })
    return { success: false, error: String(lastError) }
  }
}
