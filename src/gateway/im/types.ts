/**
 * IM 平台接入层 — 公共类型定义
 *
 * 参考 hermes-agent gateway/platforms/base.py 的 MessageEvent / SendResult 设计，
 * 将不同 IM 平台的消息规范化为统一的内部格式。
 */

// ── 平台枚举 ──────────────────────────────────────────────────────────────────
export type IMPlatform =
  | 'telegram'
  | 'weixin'    // 微信个人号（iLink Bot API）
  | 'webhook'   // 通用 Webhook（任意 HTTP 客户端）

// ── 消息类型 ──────────────────────────────────────────────────────────────────
export type MessageType =
  | 'text'
  | 'photo'
  | 'video'
  | 'audio'
  | 'voice'
  | 'document'
  | 'sticker'
  | 'command'   // 以 / 开头的命令消息

// ── 消息来源（用于构建 session key 和回复路由）────────────────────────────────
export interface MessageSource {
  platform: IMPlatform
  /** 聊天 ID（群组 ID 或私聊 ID） */
  chatId: string
  /** 聊天名称（可选，用于展示） */
  chatName?: string
  /** 聊天类型：dm（私聊）| group（群组）| channel（频道） */
  chatType: 'dm' | 'group' | 'channel'
  /** 发送者 ID */
  userId?: string
  /** 发送者名称 */
  userName?: string
  /** 线程/话题 ID（Telegram 超级群组话题等） */
  threadId?: string
}

// ── 规范化的入站消息 ──────────────────────────────────────────────────────────
export interface InboundMessage {
  /** 平台原始消息 ID（用于去重） */
  messageId: string
  /** 消息来源 */
  source: MessageSource
  /** 消息类型 */
  messageType: MessageType
  /** 文本内容（命令消息去掉 / 前缀后的完整文本） */
  text: string
  /** 本地缓存的媒体文件路径（图片/音频/视频/文档），需要落盘时使用 */
  mediaFiles?: string[]
  /** 媒体 MIME 类型（与 mediaFiles 一一对应） */
  mediaTypes?: string[]
  /**
   * 直接携带的媒体附件（base64 编码），供 LLM 多模态调用。
   * 适配器在内存中完成 base64 转换后填入此字段，无需落盘再读回。
   * 格式与 SessionManager.runMessage 的 attachments 参数一致。
   */
  attachments?: Array<{ name: string; data: string; mediaType: string }>
  /** 接收时间戳（ms） */
  receivedAt: number
  /** 平台原始数据（调试用） */
  raw?: unknown
}

// ── 发送结果 ──────────────────────────────────────────────────────────────────
export interface SendResult {
  success: boolean
  /** 平台返回的消息 ID（用于后续编辑） */
  messageId?: string
  /** 错误信息 */
  error?: string
  /** 是否可以安全重试（幂等操作） */
  retryable?: boolean
}

// ── 平台配置（存储在 ~/.hrids/im-platforms.json）────────────────────────
export interface TelegramConfig {
  platform: 'telegram'
  enabled: boolean
  /** Bot Token（从 @BotFather 获取） */
  token: string
  /** 允许的用户 ID 列表（空数组表示允许所有人） */
  allowedUsers?: string[]
  /** 代理 URL（可选，格式：socks5://host:port 或 http://host:port） */
  proxy?: string
}

export interface WeixinConfig {
  platform: 'weixin'
  enabled: boolean
  /** iLink Bot API Token */
  token: string
  /** 微信账号 ID（account_id） */
  accountId: string
  /** 允许的用户 ID 列表（空数组表示允许所有人） */
  allowedUsers?: string[]
}

export interface WebhookConfig {
  platform: 'webhook'
  enabled: boolean
  /** 监听端口（默认 3283） */
  port?: number
  /** 监听地址（默认 127.0.0.1） */
  host?: string
  /** 鉴权 Token（可选，客户端需在 Authorization: Bearer <token> 中携带） */
  secret?: string
}

export type PlatformConfig = TelegramConfig | WeixinConfig | WebhookConfig

// ── IM 网关全局配置 ────────────────────────────────────────────────────────────
export interface IMGatewayConfig {
  platforms: PlatformConfig[]
  /**
   * 会话空闲超时（分钟），超时后 IM 会话对应的 agent session 被销毁
   * 默认 60 分钟
   */
  sessionIdleMinutes?: number
  /**
   * 是否在每次 IM 消息处理完成后自动保存会话
   * 默认 true
   */
  autoSave?: boolean
}

// ── 消息处理回调 ──────────────────────────────────────────────────────────────
/** 平台适配器收到消息后调用此回调，由 PlatformManager 统一处理 */
export type MessageHandler = (msg: InboundMessage) => Promise<void>
