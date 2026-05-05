/**
 * IM 平台接入层 — 公共导出
 */

export { PlatformManager } from './PlatformManager.js'
export { BasePlatformAdapter, buildIMSessionKey, splitText, markdownToPlainText } from './BasePlatformAdapter.js'
export { TelegramAdapter } from './platforms/telegram.js'
export { WeixinAdapter } from './platforms/weixin.js'
export { WebhookAdapter } from './platforms/webhook.js'
export type {
  IMPlatform,
  MessageType,
  MessageSource,
  InboundMessage,
  SendResult,
  TelegramConfig,
  WeixinConfig,
  WebhookConfig,
  PlatformConfig,
  IMGatewayConfig,
  MessageHandler,
} from './types.js'
