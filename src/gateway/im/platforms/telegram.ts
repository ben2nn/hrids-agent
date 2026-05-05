/**
 * Telegram 平台适配器
 *
 * 使用 node-telegram-bot-api 库，通过长轮询接收消息，
 * 支持 Markdown 格式回复、消息编辑（流式输出）、代理配置。
 *
 * 参考 hermes-agent gateway/platforms/telegram.py
 */

import { logger } from '../../../core/logger.js'
import { BasePlatformAdapter, type SendOptions } from '../BasePlatformAdapter.js'
import type { InboundMessage, MessageSource, MessageType, SendResult, TelegramConfig } from '../types.js'

const log = logger.child({ component: 'im-telegram' })

// ── 动态导入 node-telegram-bot-api（可选依赖）────────────────────────────────
let TelegramBot: TelegramBotConstructor | null = null

interface TelegramBotConstructor {
  new(token: string, options: TelegramBotOptions): TelegramBotInstance
}

interface TelegramBotOptions {
  polling?: boolean | { interval?: number; timeout?: number; limit?: number }
  request?: { proxy?: string; timeout?: number }
  filepath?: boolean
}

interface TelegramBotInstance {
  on(event: string, handler: (...args: unknown[]) => void): void
  onText(regexp: RegExp, handler: (msg: TGMessage, match: RegExpExecArray | null) => void): void
  sendMessage(chatId: string | number, text: string, options?: TGSendOptions): Promise<TGMessage>
  editMessageText(text: string, options: TGEditOptions): Promise<TGMessage | boolean>
  sendChatAction(chatId: string | number, action: string): Promise<boolean>
  stopPolling(): Promise<void>
  getMe(): Promise<{ id: number; username: string; first_name: string }>
}

interface TGMessage {
  message_id: number
  from?: { id: number; username?: string; first_name?: string; last_name?: string; is_bot?: boolean }
  chat: { id: number; type: string; title?: string; username?: string; first_name?: string }
  date: number
  text?: string
  caption?: string
  photo?: Array<{ file_id: string; width: number; height: number }>
  video?: { file_id: string }
  audio?: { file_id: string }
  voice?: { file_id: string }
  document?: { file_id: string; file_name?: string; mime_type?: string }
  sticker?: { file_id: string }
  message_thread_id?: number
  reply_to_message?: TGMessage
}

interface TGSendOptions {
  parse_mode?: 'Markdown' | 'MarkdownV2' | 'HTML'
  reply_to_message_id?: number
  message_thread_id?: number
  disable_web_page_preview?: boolean
  disable_notification?: boolean
}

interface TGEditOptions {
  chat_id?: string | number
  message_id?: number
  parse_mode?: 'Markdown' | 'MarkdownV2' | 'HTML'
  disable_web_page_preview?: boolean
}

async function loadTelegramBot(): Promise<TelegramBotConstructor | null> {
  if (TelegramBot) return TelegramBot
  try {
    // node-telegram-bot-api 是可选依赖，未安装时优雅降级
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — 可选依赖，未安装时 import 会抛出异常
    const mod = await import('node-telegram-bot-api')
    TelegramBot = (mod.default ?? mod) as TelegramBotConstructor
    return TelegramBot
  } catch {
    return null
  }
}

// ── Telegram 消息长度限制（UTF-16 code units）────────────────────────────────
const TELEGRAM_MAX_LENGTH = 4096

// ── Markdown 转义（MarkdownV2 格式）──────────────────────────────────────────
// Telegram MarkdownV2 需要转义这些字符
const MDV2_ESCAPE_RE = /([_*[\]()~`>#+=|{}.!\\-])/g

function escapeMarkdownV2(text: string): string {
  return text.replace(MDV2_ESCAPE_RE, '\\$1')
}

/**
 * 分割已格式化的 MarkdownV2 文本，尽量在换行处断开，不破坏转义序列。
 * 用于 sendFormatted 内部，避免在 \* 等转义序列中间截断。
 */
function splitFormattedText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text]
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > maxLength) {
    // 优先在换行处断开
    let cutAt = remaining.lastIndexOf('\n', maxLength)
    if (cutAt < maxLength * 0.5) {
      cutAt = remaining.lastIndexOf(' ', maxLength)
    }
    if (cutAt <= 0) cutAt = maxLength
    // 确保不在转义序列 \X 中间截断
    while (cutAt > 1 && remaining[cutAt - 1] === '\\') cutAt--
    chunks.push(remaining.slice(0, cutAt).trimEnd())
    remaining = remaining.slice(cutAt).trimStart()
  }
  if (remaining.length > 0) chunks.push(remaining)
  return chunks
}

/**
 * 将标准 Markdown 转换为 Telegram MarkdownV2 格式
 * 只处理常见语法，复杂情况降级为纯文本
 */
function convertToTelegramMarkdown(text: string): string {
  try {
    // 先提取代码块，避免内部内容被转义
    const codeBlocks: string[] = []
    let result = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
      const idx = codeBlocks.length
      codeBlocks.push(`\`\`\`${lang}\n${code}\`\`\``)
      return `CODE${idx}`
    })

    // 提取行内代码
    const inlineCodes: string[] = []
    result = result.replace(/`([^`\n]+)`/g, (_m, code) => {
      const idx = inlineCodes.length
      inlineCodes.push(`\`${code}\``)
      return `INLINE${idx}`
    })

    // 转义剩余文本中的特殊字符
    result = result.replace(/([_*[\]()~`>#+=|{}.!\\-])/g, '\\$1')

    // 还原粗体（**text** → *text*）
    result = result.replace(/\\\*\\\*([^*]+)\\\*\\\*/g, '*$1*')
    // 还原斜体（_text_ → _text_）
    result = result.replace(/\\_([^_]+)\\_/g, '_$1_')
    // 还原删除线（~~text~~ → ~text~）
    result = result.replace(/~~([^~]+)~~/g, '~$1~')
    // 还原链接（[text](url) → [text](url)）
    result = result.replace(/\\\[([^\]]+)\\\]\\\(([^)]+)\\\)/g, '[$1]($2)')

    // 还原代码块和行内代码
    result = result.replace(/CODE(\d+)/g, (_m, idx) => codeBlocks[parseInt(idx)])
    result = result.replace(/INLINE(\d+)/g, (_m, idx) => inlineCodes[parseInt(idx)])

    return result
  } catch {
    // 转换失败，返回纯文本（转义所有特殊字符）
    return escapeMarkdownV2(text)
  }
}

// ── 适配器实现 ────────────────────────────────────────────────────────────────
export class TelegramAdapter extends BasePlatformAdapter {
  private bot: TelegramBotInstance | null = null
  private telegramConfig: TelegramConfig
  /** 已处理的消息 ID 集合（去重，最多保留 1000 条） */
  private processedIds = new Set<number>()

  constructor(config: TelegramConfig) {
    super('telegram', config)
    this.telegramConfig = config
  }

  /**
   * Telegram 能力声明：
   * - 支持编辑消息 → 启用流式推送
   * - 需要持续 typing → Telegram typing 约 5s 自动消失，长任务需续发
   */
  override get capabilities() {
    return {
      supportsMessageEdit: true,
      supportsKeepTyping: true,
    }
  }

  /**
   * Telegram 出站格式化：将标准 Markdown 转换为 MarkdownV2。
   * 由 sendText / editMessage 在内部调用，调用方传入原始 Markdown 即可。
   */
  protected override formatOutbound(text: string): string {
    return convertToTelegramMarkdown(text)
  }

  async connect(): Promise<void> {
    const BotClass = await loadTelegramBot()
    if (!BotClass) {
      throw new Error(
        'Telegram 适配器需要安装 node-telegram-bot-api：npm install node-telegram-bot-api @types/node-telegram-bot-api',
      )
    }

    const options: TelegramBotOptions = {
      polling: {
        interval: 300,
        timeout: 10,
        limit: 100,
      },
      filepath: false,
    }

    if (this.telegramConfig.proxy) {
      options.request = { proxy: this.telegramConfig.proxy, timeout: 30000 }
    }

    this.bot = new BotClass(this.telegramConfig.token, options)

    // 验证 token
    try {
      const me = await this.bot.getMe()
      log.info('Telegram Bot 已连接', { username: me.username, id: me.id })
    } catch (err) {
      throw new Error(`Telegram Bot Token 无效或网络不通: ${String(err)}`)
    }

    // 注册消息处理器
    this.bot.on('message', (msg: unknown) => {
      void this.onMessage(msg as TGMessage)
    })

    this.bot.on('polling_error', (err: unknown) => {
      log.error('Telegram 轮询错误', { error: String(err) })
    })

    this.running = true
    log.info('Telegram 适配器已启动')
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      await this.bot.stopPolling()
      this.bot = null
    }
    this.running = false
    log.info('Telegram 适配器已停止')
  }

  async sendText(chatId: string, text: string, options?: SendOptions): Promise<SendResult> {
    if (!this.bot) return { success: false, error: '适配器未连接' }

    const formatted = this.formatOutbound(text)
    return this.sendFormatted(chatId, text, formatted, options)
  }

  /**
   * 内部发送方法，接收已格式化的文本，避免 sendLongText 递归时重复格式化。
   * sendLongText 分割的是已格式化文本，每个 chunk 直接走这里。
   */
  private async sendFormatted(
    chatId: string,
    rawText: string,
    formatted: string,
    options?: SendOptions,
  ): Promise<SendResult> {
    if (!this.bot) return { success: false, error: '适配器未连接' }

    // 分割长消息（按已格式化长度判断）
    const maxLen = TELEGRAM_MAX_LENGTH - 100
    if (formatted.length > maxLen) {
      // 分割已格式化文本，每段直接发送，不再经过 formatOutbound
      const chunks = splitFormattedText(formatted, maxLen)
      let result: SendResult = { success: true }
      for (const chunk of chunks) {
        result = await this.sendFormatted(chatId, chunk, chunk, options)
        if (!result.success) break
      }
      return result
    }

    try {
      const tgOptions: TGSendOptions = {
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: true,
      }
      if (options?.replyToMessageId) {
        tgOptions.reply_to_message_id = parseInt(options.replyToMessageId)
      }
      if (options?.threadId) {
        tgOptions.message_thread_id = parseInt(options.threadId)
      }

      const sent = await this.bot.sendMessage(chatId, formatted, tgOptions)
      return { success: true, messageId: String(sent.message_id) }
    } catch (err) {
      // MarkdownV2 解析失败时降级为纯文本
      log.warn('MarkdownV2 发送失败，降级为纯文本', { chatId, error: String(err) })
      try {
        const sent = await this.bot!.sendMessage(chatId, rawText, {
          disable_web_page_preview: true,
          ...(options?.replyToMessageId ? { reply_to_message_id: parseInt(options.replyToMessageId) } : {}),
          ...(options?.threadId ? { message_thread_id: parseInt(options.threadId) } : {}),
        })
        return { success: true, messageId: String(sent.message_id) }
      } catch (err2) {
        log.error('Telegram 发送消息失败', { chatId, error: String(err2) })
        return { success: false, error: String(err2) }
      }
    }
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<SendResult> {
    if (!this.bot) return { success: false, error: '适配器未连接' }

    const formatted = this.formatOutbound(text)

    // 截断超长消息
    const truncated = formatted.length > TELEGRAM_MAX_LENGTH - 100
      ? formatted.slice(0, TELEGRAM_MAX_LENGTH - 200) + '\n\n…（内容过长已截断）'
      : formatted

    try {
      await this.bot.editMessageText(truncated, {
        chat_id: chatId,
        message_id: parseInt(messageId),
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: true,
      })
      return { success: true, messageId }
    } catch {
      // 降级为纯文本编辑（传入原始文本）
      try {
        await this.bot!.editMessageText(text, {
          chat_id: chatId,
          message_id: parseInt(messageId),
        })
        return { success: true, messageId }
      } catch (err2) {
        return { success: false, error: String(err2) }
      }
    }
  }

  async sendTyping(chatId: string): Promise<void> {
    if (!this.bot) return
    try {
      await this.bot.sendChatAction(chatId, 'typing')
    } catch { /* 忽略 */ }
  }

  // ── 私有方法 ────────────────────────────────────────────────────────────────

  private async onMessage(msg: TGMessage): Promise<void> {
    // 去重
    if (this.processedIds.has(msg.message_id)) return
    this.processedIds.add(msg.message_id)
    if (this.processedIds.size > 1000) {
      // 清理旧记录（简单策略：清空重来）
      this.processedIds.clear()
    }

    // 忽略 Bot 自身的消息
    if (msg.from?.is_bot) return

    // 鉴权：检查是否在允许列表中
    const userId = String(msg.from?.id ?? '')
    if (this.telegramConfig.allowedUsers && this.telegramConfig.allowedUsers.length > 0) {
      if (!this.telegramConfig.allowedUsers.includes(userId)) {
        log.warn('Telegram 未授权用户', { userId, chatId: msg.chat.id })
        return
      }
    }

    const text = msg.text ?? msg.caption ?? ''
    const chatId = String(msg.chat.id)
    const chatType = this.mapChatType(msg.chat.type)

    const source: MessageSource = {
      platform: 'telegram',
      chatId,
      chatName: msg.chat.title ?? msg.chat.username ?? msg.chat.first_name,
      chatType,
      userId,
      userName: [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || msg.from?.username,
      threadId: msg.message_thread_id ? String(msg.message_thread_id) : undefined,
    }

    const messageType = this.detectMessageType(msg)

    const inbound: InboundMessage = {
      messageId: String(msg.message_id),
      source,
      messageType,
      text,
      receivedAt: msg.date * 1000,
      raw: msg,
    }

    await this.handleInbound(inbound)
  }

  private mapChatType(tgType: string): 'dm' | 'group' | 'channel' {
    switch (tgType) {
      case 'private': return 'dm'
      case 'channel': return 'channel'
      default: return 'group'
    }
  }

  private detectMessageType(msg: TGMessage): MessageType {
    if (msg.photo) return 'photo'
    if (msg.video) return 'video'
    if (msg.audio) return 'audio'
    if (msg.voice) return 'voice'
    if (msg.document) return 'document'
    if (msg.sticker) return 'sticker'
    const text = msg.text ?? ''
    if (text.startsWith('/')) return 'command'
    return 'text'
  }
}

export function checkTelegramRequirements(): boolean {
  try {
    // 动态检测 node-telegram-bot-api 是否已安装
    // 使用 import.meta.resolve 在 ESM 中检测（Node 18.9+）
    // 降级方案：直接尝试 import
    return TelegramBot !== null
  } catch {
    return false
  }
}
