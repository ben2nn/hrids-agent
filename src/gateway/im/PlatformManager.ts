/**
 * IM 平台管理器
 *
 * 负责：
 * 1. 根据配置创建并启动各平台适配器
 * 2. 将 IM 消息路由到 SessionManager（自动创建/复用 agent session）
 * 3. 将 agent 的流式输出回传给对应平台
 * 4. 管理 IM 会话 key → agent session ID 的映射
 *
 * 参考 hermes-agent gateway/run.py GatewayRunner
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { logger } from '../../core/logger.js'
import type { SessionManager } from '../SessionManager.js'
import { BasePlatformAdapter, buildIMSessionKey } from './BasePlatformAdapter.js'
import { TelegramAdapter } from './platforms/telegram.js'
import { WeixinAdapter } from './platforms/weixin.js'
import { getWeixinQrCode, pollWeixinQrCodeStatus } from './platforms/weixin.js'
import type { WeixinQrCodeResult, WeixinLoginResult } from './platforms/weixin.js'
import { WebhookAdapter } from './platforms/webhook.js'
import type {
  IMGatewayConfig,
  IMPlatform,
  InboundMessage,
  PlatformConfig,
  SendResult,
  TelegramConfig,
  WebhookConfig,
  WeixinConfig,
} from './types.js'

const log = logger.child({ component: 'im-platform-manager' })

// IM 会话 key → agent session ID 的持久化映射文件
const IM_SESSIONS_FILE = join(homedir(), '.hrids-agent', 'im-sessions.json')
// IM 平台配置文件
const IM_CONFIG_FILE = join(homedir(), '.hrids-agent', 'im-platforms.json')

// ── 流式输出缓冲器（每个 IM 会话独立）────────────────────────────────────────
interface StreamBuffer {
  /** 已累积的文本 */
  text: string
  /** 平台已发送的消息 ID（用于编辑） */
  sentMessageId?: string
  /** 上次编辑时间 */
  lastEditAt: number
  /** 是否已完成 */
  done: boolean
  /** 编辑定时器 */
  editTimer?: ReturnType<typeof setTimeout>
}

// 流式编辑间隔（ms）：避免触发平台速率限制
const STREAM_EDIT_INTERVAL_MS = 1500
// 流式输出完成后的最终编辑延迟（ms）
const STREAM_FINAL_DELAY_MS = 200

export class PlatformManager {
  private adapters = new Map<IMPlatform, BasePlatformAdapter>()
  private sessionManager: SessionManager
  /** IM session key → agent session ID */
  private imSessionMap = new Map<string, string>()
  /** IM session key → 流式缓冲器 */
  private streamBuffers = new Map<string, StreamBuffer>()
  /** IM session key → 正在处理中（防止并发） */
  private processingLocks = new Set<string>()
  /** IM session key → 待处理的消息队列（处理中时排队） */
  private pendingMessages = new Map<string, InboundMessage>()

  /** 微信扫码登录状态（同时只允许一个进行中的登录流程） */
  private weixinLoginState: {
    qrcodeKey: string
    qrcodeImgUrl: string
    startedAt: number
    polling: boolean
    result?: WeixinLoginResult
  } | null = null

  constructor(sessionManager: SessionManager) {
    this.sessionManager = sessionManager
    this.loadIMSessions()
  }

  // ── 配置管理 ──────────────────────────────────────────────────────────────

  /** 加载 IM 平台配置 */
  static loadConfig(): IMGatewayConfig {
    if (!existsSync(IM_CONFIG_FILE)) {
      return { platforms: [] }
    }
    try {
      return JSON.parse(readFileSync(IM_CONFIG_FILE, 'utf-8')) as IMGatewayConfig
    } catch (err) {
      log.warn('IM 配置文件解析失败', { error: String(err) })
      return { platforms: [] }
    }
  }

  /** 保存 IM 平台配置 */
  static saveConfig(config: IMGatewayConfig): void {
    const dir = join(homedir(), '.hrids-agent')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const tmp = IM_CONFIG_FILE + '.tmp'
    writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf-8')
    renameSync(tmp, IM_CONFIG_FILE)
  }

  // ── 生命周期 ──────────────────────────────────────────────────────────────

  /** 根据配置启动所有已启用的平台适配器 */
  async start(config?: IMGatewayConfig): Promise<void> {
    const cfg = config ?? PlatformManager.loadConfig()
    const enabledPlatforms = cfg.platforms.filter(p => p.enabled)

    if (enabledPlatforms.length === 0) {
      log.info('没有已启用的 IM 平台，跳过启动')
      return
    }

    for (const platformCfg of enabledPlatforms) {
      await this.startPlatform(platformCfg)
    }

    log.info('IM 平台管理器已启动', { platforms: Array.from(this.adapters.keys()) })
  }

  /** 启动单个平台适配器 */
  async startPlatform(platformCfg: PlatformConfig): Promise<void> {
    const platform = platformCfg.platform

    // 如果已在运行，先停止
    if (this.adapters.has(platform)) {
      await this.stopPlatform(platform)
    }

    let adapter: BasePlatformAdapter

    try {
      switch (platform) {
        case 'telegram':
          adapter = new TelegramAdapter(platformCfg as TelegramConfig)
          break
        case 'weixin':
          adapter = new WeixinAdapter(platformCfg as WeixinConfig)
          break
        case 'webhook':
          adapter = new WebhookAdapter(platformCfg as WebhookConfig)
          break
        default:
          log.warn('未知平台，跳过', { platform })
          return
      }

      adapter.setMessageHandler((msg) => this.onMessage(msg))
      await adapter.connect()
      this.adapters.set(platform, adapter)
      log.info('平台适配器已启动', { platform })
    } catch (err) {
      log.error('平台适配器启动失败', { platform, error: String(err) })
      throw err
    }
  }

  /** 停止单个平台适配器 */
  async stopPlatform(platform: IMPlatform): Promise<void> {
    const adapter = this.adapters.get(platform)
    if (!adapter) return
    try {
      await adapter.disconnect()
    } catch (err) {
      log.warn('平台适配器停止时出错', { platform, error: String(err) })
    }
    this.adapters.delete(platform)
  }

  /** 停止所有平台适配器 */
  async stop(): Promise<void> {
    for (const platform of this.adapters.keys()) {
      await this.stopPlatform(platform)
    }
    log.info('IM 平台管理器已停止')
  }

  /** 获取所有平台的运行状态 */
  getStatus(): Array<{ platform: IMPlatform; running: boolean }> {
    const result: Array<{ platform: IMPlatform; running: boolean }> = []
    for (const [platform, adapter] of this.adapters) {
      result.push({ platform, running: adapter.isRunning })
    }
    return result
  }

  // ── 微信扫码登录 ──────────────────────────────────────────────────────────

  /**
   * 发起微信扫码登录流程。
   * 返回二维码信息，同时在后台启动轮询。
   * 二维码有效期约 5 分钟，过期后需重新调用。
   */
  async startWeixinLogin(): Promise<WeixinQrCodeResult> {
    // 如果已有进行中的登录且未过期（5 分钟内），直接复用
    if (this.weixinLoginState && !this.weixinLoginState.result) {
      const elapsed = Date.now() - this.weixinLoginState.startedAt
      if (elapsed < 4.5 * 60 * 1000) {
        return {
          qrcodeKey: this.weixinLoginState.qrcodeKey,
          qrcodeImgUrl: this.weixinLoginState.qrcodeImgUrl,
        }
      }
    }

    // 获取新二维码
    const qr = await getWeixinQrCode()
    this.weixinLoginState = {
      qrcodeKey: qr.qrcodeKey,
      qrcodeImgUrl: qr.qrcodeImgUrl,
      startedAt: Date.now(),
      polling: true,
    }

    // 后台轮询扫码状态
    void this.pollWeixinLoginLoop(qr.qrcodeKey)

    log.info('微信扫码登录已发起', { qrcodeKey: qr.qrcodeKey.slice(0, 8) + '...' })
    return qr
  }

  /**
   * 查询当前微信扫码登录状态。
   * 前端应每隔 2s 轮询此接口，直到 status 为 confirmed / expired / error。
   */
  getWeixinLoginStatus(): WeixinLoginResult & { qrcodeImgUrl?: string } {
    if (!this.weixinLoginState) {
      return { status: 'error', error: '尚未发起扫码登录，请先调用 POST /im/platforms/weixin/login' }
    }
    const state = this.weixinLoginState
    const base = state.result ?? { status: 'pending' as const }
    return { ...base, qrcodeImgUrl: state.qrcodeImgUrl }
  }

  /** 后台轮询扫码状态，确认后自动保存配置并启动适配器 */
  private async pollWeixinLoginLoop(qrcodeKey: string): Promise<void> {
    const DEADLINE_MS = 5 * 60 * 1000 // 最多等 5 分钟
    const POLL_INTERVAL_MS = 2_000     // 短轮询间隔 2s
    const startedAt = Date.now()

    while (Date.now() - startedAt < DEADLINE_MS) {
      // 检查是否仍是当前登录流程（防止重新发起后旧轮询干扰）
      if (!this.weixinLoginState || this.weixinLoginState.qrcodeKey !== qrcodeKey) {
        log.debug('微信扫码轮询：检测到新登录流程，停止旧轮询')
        return
      }

      const result = await pollWeixinQrCodeStatus(qrcodeKey)

      if (result.status === 'confirmed') {
        log.info('微信扫码登录成功', { accountId: result.accountId })
        this.weixinLoginState.result = result
        this.weixinLoginState.polling = false
        await this.applyWeixinLoginResult(result)
        return
      }

      if (result.status === 'expired') {
        log.info('微信扫码二维码已过期')
        this.weixinLoginState.result = { status: 'expired' }
        this.weixinLoginState.polling = false
        return
      }

      if (result.status === 'scaned') {
        this.weixinLoginState.result = { status: 'scaned' }
      } else if (result.status === 'error') {
        log.warn('微信扫码轮询出错，3s 后重试', { error: result.error })
        await new Promise(r => setTimeout(r, 3_000))
        continue
      }
      // pending / scaned：等待后继续轮询
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
    }

    // 超时
    if (this.weixinLoginState?.qrcodeKey === qrcodeKey) {
      this.weixinLoginState.result = { status: 'expired' }
      this.weixinLoginState.polling = false
    }
  }

  /** 扫码确认后：保存配置 + 启动/重启微信适配器 */
  private async applyWeixinLoginResult(result: WeixinLoginResult): Promise<void> {
    if (!result.botToken || !result.accountId) {
      log.error('微信登录结果缺少 botToken 或 accountId', { result })
      return
    }

    const cfg = PlatformManager.loadConfig()
    const weixinCfg: WeixinConfig = {
      platform: 'weixin',
      enabled: true,
      token: result.botToken,
      accountId: result.accountId,
    }

    const idx = cfg.platforms.findIndex(p => p.platform === 'weixin')
    if (idx >= 0) {
      // 保留原有的 allowedUsers 等配置
      const existing = cfg.platforms[idx] as WeixinConfig
      weixinCfg.allowedUsers = existing.allowedUsers
      cfg.platforms[idx] = weixinCfg
    } else {
      cfg.platforms.push(weixinCfg)
    }

    PlatformManager.saveConfig(cfg)
    log.info('微信配置已保存', { accountId: result.accountId })

    // 启动/重启适配器
    try {
      await this.startPlatform(weixinCfg)
      log.info('微信适配器已自动启动')
    } catch (err) {
      log.error('微信适配器自动启动失败', { error: String(err) })
    }
  }

  // ── 消息路由 ──────────────────────────────────────────────────────────────

  /** 收到 IM 消息时的处理入口 */
  private async onMessage(msg: InboundMessage): Promise<void> {
    const sessionKey = buildIMSessionKey(msg.source)

    // 处理内置命令
    if (msg.messageType === 'command') {
      const handled = await this.handleBuiltinCommand(msg, sessionKey)
      if (handled) return
    }

    // 防止并发：同一会话同时只处理一条消息
    if (this.processingLocks.has(sessionKey)) {
      // 排队（只保留最新的一条）
      this.pendingMessages.set(sessionKey, msg)
      log.debug('消息排队等待', { sessionKey })
      return
    }

    await this.processMessage(msg, sessionKey)
  }

  private async processMessage(msg: InboundMessage, sessionKey: string): Promise<void> {
    this.processingLocks.add(sessionKey)

    try {
      // 获取或创建 agent session
      const agentSessionId = await this.getOrCreateAgentSession(msg, sessionKey)
      if (!agentSessionId) {
        log.error('无法获取 agent session', { sessionKey })
        return
      }

      const adapter = this.adapters.get(msg.source.platform)
      if (!adapter) return

      // 微信不支持消息编辑，不使用流式缓冲器
      const isWeixin = msg.source.platform === 'weixin'

      // 非微信平台：初始化流式缓冲器，支持实时编辑
      if (!isWeixin) {
        const buffer: StreamBuffer = {
          text: '',
          lastEditAt: 0,
          done: false,
        }
        this.streamBuffers.set(sessionKey, buffer)
      }

      // 通过 SessionManager 运行消息，收集流式输出
      // 微信平台：持续发送 typing 状态，等 LLM 完整输出后一次性发送
      // 其他平台：流式推送中间状态（实时编辑消息）
      let fullText: string
      if (isWeixin) {
        const weixinAdapter = adapter as import('./platforms/weixin.js').WeixinAdapter
        const agentPromise = this.runAgentMessage(agentSessionId, msg.text, sessionKey, true)
        void weixinAdapter.keepTyping(msg.source.chatId, agentPromise)
        fullText = await agentPromise
      } else {
        await adapter.sendTyping(msg.source.chatId)
        fullText = await this.runAgentMessage(agentSessionId, msg.text, sessionKey, false)
      }
      // 发送最终回复
      if (fullText.trim()) {
        const buffer = this.streamBuffers.get(sessionKey)
        await this.sendReply(adapter, msg, fullText, isWeixin ? undefined : buffer?.sentMessageId)
      }
    } catch (err) {
      log.error('消息处理失败', { sessionKey, error: String(err) })
      const adapter = this.adapters.get(msg.source.platform)
      if (adapter) {
        await adapter.sendText(msg.source.chatId, `⚠️ 处理消息时出错：${String(err)}`, {
          threadId: msg.source.threadId,
        }).catch(() => { /* 忽略 */ })
      }
    } finally {
      this.streamBuffers.delete(sessionKey)
      this.processingLocks.delete(sessionKey)

      // 处理排队的消息
      const pending = this.pendingMessages.get(sessionKey)
      if (pending) {
        this.pendingMessages.delete(sessionKey)
        void this.processMessage(pending, sessionKey)
      }
    }
  }

  /**
   * 通过 SessionManager 运行消息，收集完整的文本输出。
   * skipStreaming=true 时（微信等不支持编辑的平台）只累积文本，不触发流式推送。
   */
  private async runAgentMessage(
    agentSessionId: string,
    text: string,
    sessionKey: string,
    skipStreaming = false,
  ): Promise<string> {
    let fullText = ''

    const timeoutMs = 5 * 60 * 1000
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('响应超时')), timeoutMs)
    )

    const runPromise = this.sessionManager.runMessageWithCallback(
      agentSessionId,
      text,
      (ev) => {
        if (ev.type === 'text_delta' && ev.delta) {
          fullText += ev.delta
          // 微信平台跳过流式推送，等完整输出后一次性发送
          if (!skipStreaming) {
            void this.onStreamDelta(sessionKey, ev.delta)
          }
        }
      },
    )

    await Promise.race([runPromise, timeoutPromise])
    return fullText
  }

  /** 流式输出增量处理（可选：支持编辑的平台实时更新消息） */
  private async onStreamDelta(sessionKey: string, delta: string): Promise<void> {
    const buffer = this.streamBuffers.get(sessionKey)
    if (!buffer) return

    buffer.text += delta

    // 找到对应的适配器和消息来源
    // 从 sessionKey 解析平台和 chatId：im:{platform}:{chatType}:{chatId}[:{userId}]
    const parts = sessionKey.split(':')
    if (parts.length < 4 || parts[0] !== 'im') return

    const platform = parts[1] as IMPlatform
    const chatId = parts[3]
    const adapter = this.adapters.get(platform)
    if (!adapter) return

    const now = Date.now()

    // 首次输出：发送初始消息
    if (!buffer.sentMessageId && buffer.text.length > 20) {
      const result = await adapter.sendText(chatId, buffer.text + ' ▌')
      if (result.success && result.messageId) {
        buffer.sentMessageId = result.messageId
        buffer.lastEditAt = now
      }
      return
    }

    // 后续输出：定时编辑（避免速率限制）
    if (buffer.sentMessageId && now - buffer.lastEditAt > STREAM_EDIT_INTERVAL_MS) {
      await adapter.editMessage(chatId, buffer.sentMessageId, buffer.text + ' ▌')
      buffer.lastEditAt = now
    }
  }

  /** 发送最终回复（清除流式光标） */
  private async sendReply(
    adapter: BasePlatformAdapter,
    msg: InboundMessage,
    text: string,
    existingMessageId?: string,
  ): Promise<SendResult> {
    const chatId = msg.source.chatId
    const options = {
      threadId: msg.source.threadId,
      replyToMessageId: msg.messageId,
    }

    // 如果已有流式消息，编辑它（去掉光标）
    if (existingMessageId) {
      const editResult = await adapter.editMessage(chatId, existingMessageId, text)
      if (editResult.success) return editResult
      // 编辑失败则重新发送
    }

    return adapter.sendText(chatId, text, options)
  }

  // ── 内置命令处理 ──────────────────────────────────────────────────────────

  private async handleBuiltinCommand(msg: InboundMessage, sessionKey: string): Promise<boolean> {
    const cmd = msg.text.trim().toLowerCase().split(/\s+/)[0]
    const adapter = this.adapters.get(msg.source.platform)
    if (!adapter) return false

    switch (cmd) {
      case '/new':
      case '/reset': {
        // 清除 IM 会话映射，下次消息时创建新的 agent session
        const oldSessionId = this.imSessionMap.get(sessionKey)
        if (oldSessionId) {
          this.imSessionMap.delete(sessionKey)
          this.saveIMSessions()
        }
        await adapter.sendText(msg.source.chatId, '✅ 会话已重置，开始新对话。', {
          threadId: msg.source.threadId,
        })
        return true
      }

      case '/status': {
        const agentSessionId = this.imSessionMap.get(sessionKey)
        const session = agentSessionId ? this.sessionManager.getSession(agentSessionId) : null
        const statusText = session
          ? `📊 当前会话状态：${session.info.status}\n模型：${session.info.model}\n工作目录：${session.info.cwd}`
          : '📊 当前没有活跃会话'
        await adapter.sendText(msg.source.chatId, statusText, { threadId: msg.source.threadId })
        return true
      }

      case '/stop': {
        const agentSessionId = this.imSessionMap.get(sessionKey)
        if (agentSessionId) {
          const session = this.sessionManager.getSession(agentSessionId)
          if (session?.info.status === 'busy') {
            session.engine.abort()
            await adapter.sendText(msg.source.chatId, '⏹️ 已中止当前任务。', {
              threadId: msg.source.threadId,
            })
          } else {
            await adapter.sendText(msg.source.chatId, '没有正在运行的任务。', {
              threadId: msg.source.threadId,
            })
          }
        }
        return true
      }

      case '/help': {
        const helpText = [
          '🤖 **可用命令：**',
          '',
          '/new 或 /reset — 重置会话，开始新对话',
          '/stop — 中止当前正在执行的任务',
          '/status — 查看当前会话状态',
          '/help — 显示此帮助信息',
          '',
          '直接发送消息即可与 AI 对话。',
        ].join('\n')
        await adapter.sendText(msg.source.chatId, helpText, { threadId: msg.source.threadId })
        return true
      }

      default:
        return false
    }
  }

  // ── Agent Session 管理 ────────────────────────────────────────────────────

  private async getOrCreateAgentSession(
    msg: InboundMessage,
    sessionKey: string,
  ): Promise<string | null> {
    // 检查是否有已存在的 agent session
    const existingId = this.imSessionMap.get(sessionKey)
    if (existingId && this.sessionManager.getSession(existingId)) {
      return existingId
    }

    // 创建新的 agent session
    try {
      const session = await this.sessionManager.createSession({
        title: `IM: ${msg.source.platform} / ${msg.source.chatName ?? msg.source.chatId}`,
        permissionMode: 'craft',  // IM 场景默认自动执行
      })

      const sessionId = session.info.id
      this.imSessionMap.set(sessionKey, sessionId)
      this.saveIMSessions()

      log.info('为 IM 会话创建 agent session', {
        sessionKey,
        agentSessionId: sessionId,
        platform: msg.source.platform,
      })

      return sessionId
    } catch (err) {
      log.error('创建 agent session 失败', { sessionKey, error: String(err) })
      return null
    }
  }

  // ── 持久化 ────────────────────────────────────────────────────────────────

  private loadIMSessions(): void {
    if (!existsSync(IM_SESSIONS_FILE)) return
    try {
      const data = JSON.parse(readFileSync(IM_SESSIONS_FILE, 'utf-8')) as Record<string, string>
      for (const [key, value] of Object.entries(data)) {
        this.imSessionMap.set(key, value)
      }
      log.debug('已加载 IM 会话映射', { count: this.imSessionMap.size })
    } catch (err) {
      log.warn('IM 会话映射加载失败', { error: String(err) })
    }
  }

  private saveIMSessions(): void {
    try {
      const dir = join(homedir(), '.hrids-agent')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const data = Object.fromEntries(this.imSessionMap)
      const tmp = IM_SESSIONS_FILE + '.tmp'
      writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
      renameSync(tmp, IM_SESSIONS_FILE)
    } catch (err) {
      log.warn('IM 会话映射保存失败', { error: String(err) })
    }
  }
}
