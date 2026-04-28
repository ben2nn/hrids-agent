/**
 * IM 平台适配器抽象基类
 *
 * 参考 hermes-agent gateway/platforms/base.py BasePlatformAdapter，
 * 定义所有平台适配器必须实现的接口。
 */

import { logger } from '../../core/logger.js'
import type { IMPlatform, InboundMessage, MessageHandler, PlatformConfig, SendResult } from './types.js'

const log = logger.child({ component: 'im-adapter' })

export abstract class BasePlatformAdapter {
  protected platform: IMPlatform
  protected config: PlatformConfig
  protected messageHandler: MessageHandler | null = null
  protected running = false

  constructor(platform: IMPlatform, config: PlatformConfig) {
    this.platform = platform
    this.config = config
  }

  /** 注册消息处理回调 */
  setMessageHandler(handler: MessageHandler): void {
    this.messageHandler = handler
  }

  /** 连接到平台（启动轮询/监听） */
  abstract connect(): Promise<void>

  /** 断开连接 */
  abstract disconnect(): Promise<void>

  /** 发送文本消息到指定聊天 */
  abstract sendText(chatId: string, text: string, options?: SendOptions): Promise<SendResult>

  /** 编辑已发送的消息（可选，不支持的平台返回 { success: false }） */
  async editMessage(_chatId: string, _messageId: string, _text: string): Promise<SendResult> {
    return { success: false, error: '该平台不支持编辑消息' }
  }

  /** 发送"正在输入"指示器（可选） */
  async sendTyping(_chatId: string): Promise<void> {
    // 默认不操作，子类可覆盖
  }

  /** 是否正在运行 */
  get isRunning(): boolean {
    return this.running
  }

  /** 平台名称 */
  get platformName(): IMPlatform {
    return this.platform
  }

  /**
   * 将长文本按平台限制分割后逐段发送
   * 返回最后一段的 SendResult
   */
  protected async sendLongText(
    chatId: string,
    text: string,
    maxLength: number,
    options?: SendOptions,
  ): Promise<SendResult> {
    if (text.length <= maxLength) {
      return this.sendText(chatId, text, options)
    }

    const chunks = splitText(text, maxLength)
    let result: SendResult = { success: true }
    for (const chunk of chunks) {
      result = await this.sendText(chatId, chunk, options)
      if (!result.success) break
    }
    return result
  }

  /** 触发消息处理回调（子类在收到消息时调用） */
  protected async handleInbound(msg: InboundMessage): Promise<void> {
    if (!this.messageHandler) {
      log.warn('收到消息但未注册处理器', { platform: this.platform, chatId: msg.source.chatId })
      return
    }
    try {
      await this.messageHandler(msg)
    } catch (err) {
      log.error('消息处理器异常', { platform: this.platform, error: String(err) })
    }
  }
}

// ── 发送选项 ──────────────────────────────────────────────────────────────────
export interface SendOptions {
  /** 回复的消息 ID（可选） */
  replyToMessageId?: string
  /** 线程/话题 ID（Telegram 超级群组话题等） */
  threadId?: string
  /** 是否解析 Markdown（默认 true） */
  parseMarkdown?: boolean
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────

/**
 * 将长文本按 maxLength 分割，尽量在换行处断开
 */
export function splitText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > maxLength) {
    // 优先在换行处断开
    let cutAt = remaining.lastIndexOf('\n', maxLength)
    if (cutAt < maxLength * 0.5) {
      // 换行位置太靠前，改为在空格处断开
      cutAt = remaining.lastIndexOf(' ', maxLength)
    }
    if (cutAt <= 0) {
      // 没有合适的断点，强制截断
      cutAt = maxLength
    }
    chunks.push(remaining.slice(0, cutAt).trimEnd())
    remaining = remaining.slice(cutAt).trimStart()
  }

  if (remaining.length > 0) {
    chunks.push(remaining)
  }

  return chunks
}

/**
 * 将 Markdown 转换为纯文本（用于不支持 Markdown 的平台）
 */
export function markdownToPlainText(text: string): string {
  return text
    // 代码块
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, '').trim())
    // 行内代码
    .replace(/`([^`]+)`/g, '$1')
    // 标题
    .replace(/^#{1,6}\s+/gm, '')
    // 粗体/斜体
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    // 链接
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // 删除线
    .replace(/~~([^~]+)~~/g, '$1')
    // 引用
    .replace(/^>\s+/gm, '')
    // 列表符号
    .replace(/^[-*+]\s+/gm, '• ')
    .replace(/^\d+\.\s+/gm, '')
    .trim()
}

/**
 * 构建 IM 会话 key（用于映射到 agent session）
 * 格式：im:{platform}:{chatType}:{chatId}[:{userId}]
 */
export function buildIMSessionKey(source: InboundMessage['source']): string {
  const base = `im:${source.platform}:${source.chatType}:${source.chatId}`
  // 私聊按用户隔离，群组共享（可根据需要调整）
  if (source.chatType === 'dm' && source.userId) {
    return `${base}:${source.userId}`
  }
  return base
}
