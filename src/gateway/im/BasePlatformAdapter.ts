/**
 * IM 平台适配器抽象基类
 *
 * 定义所有平台适配器必须实现的接口，以及可选覆盖的能力声明。
 *
 * ## 设计原则
 * - 平台能力（是否支持编辑消息、是否需要持续 typing）通过 getter 声明，
 *   PlatformManager 根据能力自动选择处理策略，无需 if/else 平台判断。
 * - 所有平台共享同一套消息处理骨架（processMessage），差异由适配器自身封装。
 *
 * ## 新增平台步骤
 * 1. 继承 BasePlatformAdapter
 * 2. 实现 connect / disconnect / sendText（sendText 内部调用 this.formatOutbound()）
 * 3. 按需覆盖能力 getter（supportsMessageEdit / supportsKeepTyping）
 * 4. 按需覆盖 formatOutbound（平台格式转换）/ editMessage / keepTyping
 * 5. 在 PlatformManager.startPlatform() 中注册
 */

import { logger } from '../../core/logger.js'
import type { IMPlatform, InboundMessage, MessageHandler, PlatformConfig, SendResult } from './types.js'

const log = logger.child({ component: 'im-adapter' })

// ── 发送选项 ──────────────────────────────────────────────────────────────────
export interface SendOptions {
  /** 回复的消息 ID（可选） */
  replyToMessageId?: string
  /** 线程/话题 ID（Telegram 超级群组话题等） */
  threadId?: string
  /** 是否解析 Markdown（默认 true） */
  parseMarkdown?: boolean
}

// ── 平台能力声明 ──────────────────────────────────────────────────────────────

/**
 * 平台能力描述，由适配器通过 getter 声明，PlatformManager 据此选择处理策略。
 * 不要在 PlatformManager 里用平台名做 if/else 判断，改为读取这些能力。
 */
export interface PlatformCapabilities {
  /**
   * 是否支持编辑已发送的消息。
   * true  → 启用流式推送（先发占位消息，持续编辑追加内容）
   * false → 等待完整输出后一次性发送（微信、Webhook 同步模式）
   */
  supportsMessageEdit: boolean

  /**
   * 是否需要持续续发 typing 状态。
   * true  → PlatformManager 会在 agent 运行期间持续调用 keepTyping
   * false → 只在开始时调用一次 sendTyping（Telegram 等平台 typing 自动消失）
   */
  supportsKeepTyping: boolean
}

// ── 抽象基类 ──────────────────────────────────────────────────────────────────
export abstract class BasePlatformAdapter {
  protected platform: IMPlatform
  protected config: PlatformConfig
  protected messageHandler: MessageHandler | null = null
  protected running = false

  constructor(platform: IMPlatform, config: PlatformConfig) {
    this.platform = platform
    this.config = config
  }

  // ── 必须实现的接口 ──────────────────────────────────────────────────────────

  /** 连接到平台（启动轮询/监听） */
  abstract connect(): Promise<void>

  /** 断开连接 */
  abstract disconnect(): Promise<void>

  /**
   * 发送文本消息到指定聊天。
   * 实现时应在内部调用 this.formatOutbound(text) 完成平台格式化，
   * 调用方永远传入原始 Markdown，无需关心平台格式细节。
   */
  abstract sendText(chatId: string, text: string, options?: SendOptions): Promise<SendResult>

  // ── 平台能力声明（子类按需覆盖）────────────────────────────────────────────

  /**
   * 平台能力声明。子类覆盖需要的字段即可，未覆盖的使用默认值（最保守策略）。
   *
   * 默认：不支持编辑、不需要持续 typing（适合大多数简单平台）
   */
  get capabilities(): PlatformCapabilities {
    return {
      supportsMessageEdit: false,
      supportsKeepTyping: false,
    }
  }

  // ── 可选覆盖的方法 ──────────────────────────────────────────────────────────

  /**
   * 编辑已发送的消息（仅 supportsMessageEdit=true 的平台需要实现）。
   * 实现时同样应在内部调用 this.formatOutbound(text)。
   * 默认返回失败，PlatformManager 会降级为重新发送。
   */
  async editMessage(_chatId: string, _messageId: string, _text: string): Promise<SendResult> {
    return { success: false, error: '该平台不支持编辑消息' }
  }

  /**
   * 发送单次 typing 状态指示器。
   * 默认不操作，子类可覆盖。
   */
  async sendTyping(_chatId: string): Promise<void> {
    // 默认不操作
  }

  /**
   * 持续发送 typing 状态，直到 doneSignal resolve/reject。
   *
   * 默认实现：每 4 秒续发一次（适合 typing 会自动消失的平台，如 Telegram）。
   * 仅当 capabilities.supportsKeepTyping = true 时，PlatformManager 才会调用此方法。
   *
   * 微信等需要特殊 ticket 的平台应覆盖此方法。
   */
  async keepTyping(chatId: string, doneSignal: Promise<unknown>): Promise<void> {
    const INTERVAL_MS = 4_000
    let stopped = false
    doneSignal.finally(() => { stopped = true })

    while (!stopped) {
      await this.sendTyping(chatId)
      await Promise.race([
        new Promise(r => setTimeout(r, INTERVAL_MS)),
        doneSignal.catch(() => {}),
      ])
    }
  }

  /**
   * 格式化出站消息文本（平台特定的 Markdown 转换、长度截断等）。
   *
   * 这是一个 protected 的内部方法，由 sendText / editMessage 在内部调用。
   * 调用方（PlatformManager）永远传入原始 Markdown，不需要关心格式细节。
   *
   * 默认实现：原样返回。
   * Telegram 等有特殊格式要求的平台应覆盖此方法。
   */
  protected formatOutbound(text: string): string {
    return text
  }

  // ── 基类工具方法 ────────────────────────────────────────────────────────────

  /** 注册消息处理回调 */
  setMessageHandler(handler: MessageHandler): void {
    this.messageHandler = handler
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
   * 将长文本按平台限制分割后逐段发送，返回最后一段的 SendResult。
   *
   * 注意：此方法递归调用 sendText，而 sendText 内部会调用 formatOutbound。
   * 因此调用方应传入**原始文本**（未格式化），让每个 chunk 各自经过 formatOutbound。
   * 如果需要传入已格式化的文本，请在子类中自行实现分割逻辑（参考 TelegramAdapter.sendFormatted）。
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

// ── 工具函数 ──────────────────────────────────────────────────────────────────

/**
 * 将长文本按 maxLength 分割，尽量在换行处断开。
 */
export function splitText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > maxLength) {
    let cutAt = remaining.lastIndexOf('\n', maxLength)
    if (cutAt < maxLength * 0.5) {
      cutAt = remaining.lastIndexOf(' ', maxLength)
    }
    if (cutAt <= 0) {
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
 * 将 Markdown 转换为纯文本（用于不支持 Markdown 的平台）。
 */
export function markdownToPlainText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, '').trim())
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/^>\s+/gm, '')
    .replace(/^[-*+]\s+/gm, '• ')
    .replace(/^\d+\.\s+/gm, '')
    .trim()
}

/**
 * 构建 IM 会话 key（用于映射到 agent session）。
 * 格式：im:{platform}:{chatType}:{chatId}[:{userId}]
 */
export function buildIMSessionKey(source: InboundMessage['source']): string {
  const base = `im:${source.platform}:${source.chatType}:${source.chatId}`
  if (source.chatType === 'dm' && source.userId) {
    return `${base}:${source.userId}`
  }
  return base
}
