/**
 * IM 平台管理器
 *
 * 负责：
 * 1. 根据配置创建并启动各平台适配器
 * 2. 将 IM 消息路由到 SessionManager（自动创建/复用 agent session）
 * 3. 将 agent 的流式输出回传给对应平台
 * 4. 管理 IM 会话 key → agent session ID 的映射
 *
 * ## 统一处理骨架
 *
 * 所有平台共享同一套 processMessage 流程，平台差异通过适配器的能力声明驱动：
 *
 *   adapter.capabilities.supportsMessageEdit
 *     true  → 流式推送（先发占位消息，持续编辑追加内容）
 *     false → 等待完整输出后一次性发送
 *
 *   adapter.capabilities.supportsKeepTyping
 *     true  → 在 agent 运行期间持续调用 adapter.keepTyping()
 *     false → 只在开始时调用一次 adapter.sendTyping()
 *
 * 新增平台时，只需在适配器中声明能力，无需修改此文件。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs'
import { join, resolve } from 'path'
import { getConfigDir } from '../../core/Config.js'
import { logger } from '../../shared/logger.js'
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
const IM_SESSIONS_FILE = join(getConfigDir(), 'im-sessions.json')
// IM 平台配置文件
const IM_CONFIG_FILE = join(getConfigDir(), 'im-platforms.json')

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
}

// 流式编辑间隔（ms）：避免触发平台速率限制
const STREAM_EDIT_INTERVAL_MS = 1500

// ── 消息合并窗口 ──────────────────────────────────────────────────────────────
// 图片消息到达后等待此时间（ms），若窗口内来了文字则合并后一起处理
const MSG_MERGE_WINDOW_MS = 4000

interface MergeBuffer {
  /** 已缓冲的消息（第一条通常是图片） */
  msg: InboundMessage
  /** 定时器句柄 */
  timer: ReturnType<typeof setTimeout>
}

export class PlatformManager {
  private adapters = new Map<IMPlatform, BasePlatformAdapter>()
  private sessionManager: SessionManager
  /** IM session key → agent session ID */
  private imSessionMap = new Map<string, string>()
  /** IM session key → 流式缓冲器（仅 supportsMessageEdit 平台使用） */
  private streamBuffers = new Map<string, StreamBuffer>()
  /** IM session key → 正在处理中（防止并发） */
  private processingLocks = new Set<string>()
  /** IM session key → 待处理的消息（处理中时排队，只保留最新一条） */
  private pendingMessages = new Map<string, InboundMessage>()
  /**
   * IM session key → 合并窗口缓冲区。
   * 图片消息到达后暂存于此，等待 MSG_MERGE_WINDOW_MS 内的文字消息合并。
   */
  private mergeBuffers = new Map<string, MergeBuffer>()

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

  static loadConfig(): IMGatewayConfig {
    if (!existsSync(IM_CONFIG_FILE)) return { platforms: [] }
    try {
      return JSON.parse(readFileSync(IM_CONFIG_FILE, 'utf-8')) as IMGatewayConfig
    } catch (err) {
      log.warn('IM 配置文件解析失败', { error: String(err) })
      return { platforms: [] }
    }
  }

  static saveConfig(config: IMGatewayConfig): void {
    const dir = getConfigDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const tmp = IM_CONFIG_FILE + '.tmp'
    writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf-8')
    renameSync(tmp, IM_CONFIG_FILE)
  }

  // ── 生命周期 ──────────────────────────────────────────────────────────────

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

  async startPlatform(platformCfg: PlatformConfig): Promise<void> {
    const platform = platformCfg.platform

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
      log.info('平台适配器已启动', { platform, capabilities: adapter.capabilities })
    } catch (err) {
      log.error('平台适配器启动失败', { platform, error: String(err) })
      throw err
    }
  }

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

  async stop(): Promise<void> {
    // 清理所有待合并的定时器，避免进程退出后悬空
    for (const { timer } of this.mergeBuffers.values()) {
      clearTimeout(timer)
    }
    this.mergeBuffers.clear()

    for (const platform of this.adapters.keys()) {
      await this.stopPlatform(platform)
    }
    log.info('IM 平台管理器已停止')
  }

  getStatus(): Array<{ platform: IMPlatform; running: boolean }> {
    const result: Array<{ platform: IMPlatform; running: boolean }> = []
    for (const [platform, adapter] of this.adapters) {
      result.push({ platform, running: adapter.isRunning })
    }
    return result
  }

  /**
   * 将定时任务提醒推送到 IM 平台。
   * 由 SessionManager.sendCronReminder 在广播 WebSocket 事件后调用。
   *
   * 根据 agentSessionId 反查 imSessionMap，找到对应的 IM 会话 key，
   * 再解析出 platform 和 chatId，通过对应适配器发送消息。
   */
  async sendCronToIM(agentSessionId: string, text: string): Promise<void> {
    // 反查：找到所有映射到该 agentSessionId 的 IM 会话 key
    for (const [sessionKey, mappedSessionId] of this.imSessionMap) {
      if (mappedSessionId !== agentSessionId) continue

      // sessionKey 格式：im:{platform}:{chatType}:{chatId}[:{userId}]
      const parts = sessionKey.split(':')
      // parts[0]='im', parts[1]=platform, parts[2]=chatType, parts[3]=chatId
      const platform = parts[1] as IMPlatform
      const chatId = parts[3]
      if (!platform || !chatId) continue

      const adapter = this.adapters.get(platform)
      if (!adapter) {
        log.warn('[cron] IM 适配器不存在，跳过推送', { platform, chatId, agentSessionId })
        continue
      }

      try {
        await adapter.sendText(chatId, text)
        log.info('[cron] 定时任务提醒已推送到 IM', { platform, chatId, agentSessionId })
      } catch (err) {
        log.error('[cron] 推送定时任务提醒到 IM 失败', { platform, chatId, error: String(err) })
      }
    }
  }

  // ── 微信扫码登录 ──────────────────────────────────────────────────────────

  async startWeixinLogin(): Promise<WeixinQrCodeResult> {
    if (this.weixinLoginState && !this.weixinLoginState.result) {
      const elapsed = Date.now() - this.weixinLoginState.startedAt
      if (elapsed < 4.5 * 60 * 1000) {
        return {
          qrcodeKey: this.weixinLoginState.qrcodeKey,
          qrcodeImgUrl: this.weixinLoginState.qrcodeImgUrl,
        }
      }
    }

    const qr = await getWeixinQrCode()
    this.weixinLoginState = {
      qrcodeKey: qr.qrcodeKey,
      qrcodeImgUrl: qr.qrcodeImgUrl,
      startedAt: Date.now(),
      polling: true,
    }

    void this.pollWeixinLoginLoop(qr.qrcodeKey)
    log.info('微信扫码登录已发起', { qrcodeKey: qr.qrcodeKey.slice(0, 8) + '...' })
    return qr
  }

  getWeixinLoginStatus(): WeixinLoginResult & { qrcodeImgUrl?: string } {
    if (!this.weixinLoginState) {
      return { status: 'error', error: '尚未发起扫码登录，请先调用 POST /im/platforms/weixin/login' }
    }
    const state = this.weixinLoginState
    const base = state.result ?? { status: 'pending' as const }
    return { ...base, qrcodeImgUrl: state.qrcodeImgUrl }
  }

  private async pollWeixinLoginLoop(qrcodeKey: string): Promise<void> {
    const DEADLINE_MS = 5 * 60 * 1000
    const POLL_INTERVAL_MS = 2_000
    const startedAt = Date.now()
    let currentBaseUrl = 'https://ilinkai.weixin.qq.com'

    while (Date.now() - startedAt < DEADLINE_MS) {
      if (!this.weixinLoginState || this.weixinLoginState.qrcodeKey !== qrcodeKey) return

      const result = await pollWeixinQrCodeStatus(qrcodeKey, currentBaseUrl)

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

      if (result.status === 'scaned_but_redirect') {
        // 切换到新 host 继续轮询，不更新 result（前端仍显示 pending）
        if (result.redirectHost) {
          currentBaseUrl = `https://${result.redirectHost}`
          log.info('微信扫码重定向', { newBaseUrl: currentBaseUrl })
        }
        // 不设置 result，继续轮询
      } else if (result.status === 'scaned') {
        this.weixinLoginState.result = { status: 'scaned' }
      } else if (result.status === 'error') {
        log.warn('微信扫码轮询出错，3s 后重试', { error: result.error })
        await new Promise(r => setTimeout(r, 3_000))
        continue
      }

      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
    }

    if (this.weixinLoginState?.qrcodeKey === qrcodeKey) {
      this.weixinLoginState.result = { status: 'expired' }
      this.weixinLoginState.polling = false
    }
  }

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
      const existing = cfg.platforms[idx] as WeixinConfig
      weixinCfg.allowedUsers = existing.allowedUsers
      cfg.platforms[idx] = weixinCfg
    } else {
      cfg.platforms.push(weixinCfg)
    }

    PlatformManager.saveConfig(cfg)
    log.info('微信配置已保存', { accountId: result.accountId })

    try {
      await this.startPlatform(weixinCfg)
      log.info('微信适配器已自动启动')
    } catch (err) {
      log.error('微信适配器自动启动失败', { error: String(err) })
    }
  }

  // ── 消息路由 ──────────────────────────────────────────────────────────────

  private async onMessage(msg: InboundMessage): Promise<void> {
    const sessionKey = buildIMSessionKey(msg.source)

    if (msg.messageType === 'command') {
      const handled = await this.handleBuiltinCommand(msg, sessionKey)
      if (handled) return
    }

    // ── 消息合并窗口逻辑 ──────────────────────────────────────────────────
    // 场景：微信等平台图片和文字是两条独立消息，需要合并后一起发给 LLM。
    //
    // 规则：
    //   1. 收到带附件的消息（图片）→ 暂存，启动 MSG_MERGE_WINDOW_MS 定时器
    //   2. 窗口内收到纯文字消息 → 合并到暂存消息（文字追加到 text，附件保留）
    //   3. 窗口超时 → 直接处理暂存消息（无文字则用 [图片] 占位）
    //   4. 纯文字消息且无暂存 → 正常处理（B 策略兜底：视觉意图检测）

    const hasAttachments = (msg.attachments?.length ?? 0) > 0
    const existing = this.mergeBuffers.get(sessionKey)

    if (existing) {
      // 窗口内来了新消息
      clearTimeout(existing.timer)
      this.mergeBuffers.delete(sessionKey)

      if (!hasAttachments && msg.text.trim()) {
        // 纯文字：合并到已缓冲的图片消息
        const merged: InboundMessage = {
          ...existing.msg,
          text: msg.text.trim(),  // 用用户的文字替换 [图片] 占位
          messageId: msg.messageId,  // 用最新消息 ID 避免去重误判
        }
        log.info('消息合并：图片 + 文字', { sessionKey, text: msg.text.slice(0, 50) })
        await this.dispatchMessage(merged, sessionKey)
      } else if (hasAttachments) {
        // 又来了一张图片：先处理旧的，再开新窗口
        await this.dispatchMessage(existing.msg, sessionKey)
        this.startMergeWindow(msg, sessionKey)
      } else {
        // 空消息或其他情况：直接处理旧的，再处理新的
        await this.dispatchMessage(existing.msg, sessionKey)
        await this.dispatchMessage(msg, sessionKey)
      }
      return
    }

    if (hasAttachments) {
      // 图片消息：开启合并窗口
      this.startMergeWindow(msg, sessionKey)
      return
    }

    // 纯文字消息，无待合并缓冲：正常处理
    await this.dispatchMessage(msg, sessionKey)
  }

  /** 启动合并窗口，超时后自动处理缓冲消息 */
  private startMergeWindow(msg: InboundMessage, sessionKey: string): void {
    const timer = setTimeout(() => {
      this.mergeBuffers.delete(sessionKey)
      log.debug('合并窗口超时，直接处理图片消息', { sessionKey })
      void this.dispatchMessage(msg, sessionKey)
    }, MSG_MERGE_WINDOW_MS)

    this.mergeBuffers.set(sessionKey, { msg, timer })
    log.debug('合并窗口已开启', { sessionKey, attachments: msg.attachments?.length ?? 0 })
  }

  /** 实际派发消息（原 onMessage 的后半段逻辑） */
  private async dispatchMessage(msg: InboundMessage, sessionKey: string): Promise<void> {
    // 双重检查：processingLocks（本层并发锁）和 session busy（LLM 执行中）
    const agentSessionId = this.imSessionMap.get(sessionKey)
    const sessionBusy = agentSessionId
      ? this.sessionManager.getSession(agentSessionId)?.info.status === 'busy'
      : false

    if (this.processingLocks.has(sessionKey) || sessionBusy) {
      // 如果队列里已有带附件的消息，且新消息是纯文字，则合并而不是覆盖
      const queued = this.pendingMessages.get(sessionKey)
      if (queued && (queued.attachments?.length ?? 0) > 0 && !(msg.attachments?.length) && msg.text.trim()) {
        const merged: InboundMessage = { ...queued, text: msg.text.trim(), messageId: msg.messageId }
        this.pendingMessages.set(sessionKey, merged)
        log.debug('排队消息合并：图片 + 文字', { sessionKey, text: msg.text.slice(0, 50) })
      } else {
        this.pendingMessages.set(sessionKey, msg)
        log.debug('消息排队等待', { sessionKey, sessionBusy })
      }
      return
    }

    await this.processMessage(msg, sessionKey)
  }

  /**
   * 统一消息处理骨架。
   *
   * 所有平台走同一套流程，差异由适配器能力声明驱动：
   *
   *   supportsMessageEdit=true  → 流式推送（边生成边编辑消息）
   *   supportsMessageEdit=false → 等待完整输出后一次性发送
   *
   *   supportsKeepTyping=true   → 持续续发 typing（keepTyping）
   *   supportsKeepTyping=false  → 单次 typing（sendTyping）
   */
  private async processMessage(msg: InboundMessage, sessionKey: string): Promise<void> {
    this.processingLocks.add(sessionKey)

    try {
      const agentSessionId = await this.getOrCreateAgentSession(msg, sessionKey)
      if (!agentSessionId) {
        log.error('无法获取 agent session', { sessionKey })
        return
      }

      const adapter = this.adapters.get(msg.source.platform)
      if (!adapter) return

      // ── IM 图片落盘 ────────────────────────────────────────────────────
      // 将 attachments 中的图片写入 sessions/<id>/uploads/，转换为 @filename 引用。
      // 落盘后两条路径（Web 上传 / IM 渠道）完全统一：
      //   - 历史存 @filename 文本
      //   - LLM 通过 extractMediaFromText 读取本地文件
      let effectiveText = msg.text
      let effectiveAttachments = msg.attachments

      if (msg.attachments && msg.attachments.length > 0) {
        const { writeFileSync, mkdirSync } = await import('fs')
        const { join: pathJoin, basename } = await import('path')
        const { getConfigDir } = await import('../../core/Config.js')

        const uploadsDir = pathJoin(getConfigDir(), 'sessions', agentSessionId, 'uploads')
        mkdirSync(uploadsDir, { recursive: true })

        const savedNames: string[] = []

        for (const att of msg.attachments) {
          try {
            const safeName = basename(att.name).replace(/[/\\]/g, '_')
            const absPath = pathJoin(uploadsDir, safeName)
            writeFileSync(absPath, Buffer.from(att.data, 'base64'))
            savedNames.push(safeName)
            log.debug('IM 图片已落盘', { name: att.name, safeName, path: absPath })
          } catch (err) {
            log.warn('IM 图片落盘失败，保留 base64 附件', { name: att.name, error: String(err) })
            // 落盘失败时保留原始 attachments，走 base64 路径
          }
        }

        if (savedNames.length > 0) {
          // 构建 @filename 引用，追加到消息文本
          const fileRefs = savedNames.map(n => `@${n}`).join(' ')
          const baseText = effectiveText.replace(/\[图片\]/g, '').trim()
          effectiveText = baseText ? `${baseText} ${fileRefs}` : fileRefs
          // 清空 attachments，走 @filename 路径（extractMediaFromText 会读取本地文件）
          effectiveAttachments = undefined

          // 广播 im_user_message 给 Web 界面实时显示
          this.sessionManager.broadcastToSession(agentSessionId, {
            type: 'im_user_message',
            text: baseText,
            images: savedNames,
            platform: msg.source.platform,
            timestamp: Date.now(),
          })
        }
      } else if (effectiveText.trim()) {
        // 纯文字消息：也广播给 Web 界面
        this.sessionManager.broadcastToSession(agentSessionId, {
          type: 'im_user_message',
          text: effectiveText,
          platform: msg.source.platform,
          timestamp: Date.now(),
        })
      }

      // IM 场景：每条消息独立处理，清空上一条消息遗留的 todo，
      // 避免 LLM 看到残留的 in_progress 任务后强制调工具继续执行。
      this.clearSessionTodos(agentSessionId)

      const { supportsMessageEdit, supportsKeepTyping } = adapter.capabilities

      // 支持编辑的平台：初始化流式缓冲器
      if (supportsMessageEdit) {
        this.streamBuffers.set(sessionKey, { text: '', lastEditAt: 0, done: false })
      }

      // 启动 agent，同时并行处理 typing
      const agentPromise = this.runAgentMessage(
        agentSessionId,
        effectiveText,
        sessionKey,
        adapter,
        msg.source.chatId,
        !supportsMessageEdit,  // 不支持编辑 → 跳过流式推送，等完整输出
        effectiveAttachments,
      )

      if (supportsKeepTyping) {
        // 持续续发 typing，直到 agent 完成（不阻塞主流程）
        void adapter.keepTyping(msg.source.chatId, agentPromise)
      } else {
        // 单次 typing，不等待
        void adapter.sendTyping(msg.source.chatId)
      }

      const fullText = await agentPromise

      // 清理 LLM 结束语（craft 模式注入的内部完成信号）
      const cleanedText = this.cleanCompletionSuffix(fullText)

      if (cleanedText.trim()) {
        const buffer = this.streamBuffers.get(sessionKey)
        // 支持编辑的平台：最终编辑去掉光标；不支持的平台：直接发送
        await this.sendFinalReply(adapter, msg, cleanedText, buffer?.sentMessageId)
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

      const pending = this.pendingMessages.get(sessionKey)
      if (pending) {
        this.pendingMessages.delete(sessionKey)
        void this.processMessage(pending, sessionKey)
      }
    }
  }

  /**
   * 通过 SessionManager 运行消息，收集完整的文本输出。
   *
   * @param skipStreaming true → 只累积文本，不触发流式推送（不支持编辑的平台）
   */
  private async runAgentMessage(
    agentSessionId: string,
    text: string,
    sessionKey: string,
    adapter: BasePlatformAdapter,
    chatId: string,
    skipStreaming: boolean,
    attachments?: Array<{ name: string; data: string; mediaType: string }>,
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
          if (!skipStreaming) {
            void this.onStreamDelta(sessionKey, adapter, chatId, ev.delta)
          }
        }
      },
      attachments,
    )

    await Promise.race([runPromise, timeoutPromise])
    return fullText
  }

  /**
   * 流式输出增量处理（仅 supportsMessageEdit=true 的平台使用）。
   * 首次输出时发送占位消息，后续定时编辑追加内容。
   *
   * adapter 和 chatId 由调用方直接传入，避免从 sessionKey 解析（脆弱且冗余）。
   */
  private async onStreamDelta(
    sessionKey: string,
    adapter: BasePlatformAdapter,
    chatId: string,
    delta: string,
  ): Promise<void> {
    const buffer = this.streamBuffers.get(sessionKey)
    if (!buffer) return

    buffer.text += delta
    const now = Date.now()

    // 首次输出：发送初始占位消息
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

  /**
   * 发送最终回复。
   * - 有流式占位消息 → 编辑它（去掉光标）
   * - 无占位消息 → 直接发送
   * - 编辑失败 → 降级为重新发送
   */
  private async sendFinalReply(
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

    if (existingMessageId) {
      const editResult = await adapter.editMessage(chatId, existingMessageId, text)
      if (editResult.success) return editResult
      log.warn('编辑消息失败，降级为重新发送', { platform: adapter.platformName, chatId })
    }

    return adapter.sendText(chatId, text, options)
  }

  /**
   * 清理 LLM 输出结尾的"任务已完成"类结束语。
   * craft 模式下 LLM 会在完成时输出这类信号文字，IM 场景不应展示给用户。
   */
  private cleanCompletionSuffix(text: string): string {
    return text
      .replace(/[\n\s]*(任务(已经?|全部|完全)?(已完成|完成了|结束了|执行完毕)|所有任务均已完成)[。！!.]*\s*$/g, '')
      .trimEnd()
  }

  /**
   * 清理指定 agent session 中残留的 in_progress todo。
   *
   * IM 场景下每条消息独立处理，不应保留上一条消息遗留的 in_progress 任务，
   * 否则 LLM 会误以为有未完成的任务而强制继续执行（如重复创建定时任务）。
   *
   * 只清除 in_progress 状态的条目，保留 completed/pending 条目，
   * 让 LLM 能通过 history 判断上一条消息已完成了什么，避免重复操作。
   */
  private clearSessionTodos(agentSessionId: string): void {
    const session = this.sessionManager.getSession(agentSessionId)
    if (!session) return
    const todoFile = resolve(session.info.cwd, '.hrids', 'tasks', 'todos.json')
    if (!existsSync(todoFile)) return
    try {
      const raw = readFileSync(todoFile, 'utf-8').trim()
      if (raw === '' || raw === '[]') return  // 已经是空的，跳过
      const todos = JSON.parse(raw) as Array<Record<string, unknown>>
      const hasInProgress = todos.some(t => t['status'] === 'in_progress')
      if (!hasInProgress) return  // 没有 in_progress，无需修改
      // 将 in_progress 改为 completed，而不是整体清空
      const updated = todos.map(t =>
        t['status'] === 'in_progress' ? { ...t, status: 'completed' } : t
      )
      const tmp = todoFile + '.tmp'
      writeFileSync(tmp, JSON.stringify(updated, null, 2), 'utf-8')
      renameSync(tmp, todoFile)
      log.debug('已将 IM 会话残留 in_progress todo 标记为 completed', { agentSessionId, count: updated.filter(t => t['status'] === 'completed').length })
    } catch (err) {
      log.warn('清理 IM 会话 in_progress todo 失败', { agentSessionId, error: String(err) })
    }
  }

  // ── 内置命令处理 ──────────────────────────────────────────────────────────

  private async handleBuiltinCommand(msg: InboundMessage, sessionKey: string): Promise<boolean> {
    const cmd = msg.text.trim().toLowerCase().split(/\s+/)[0]
    const adapter = this.adapters.get(msg.source.platform)
    if (!adapter) return false

    switch (cmd) {
      case '/new':
      case '/reset': {
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

  /**
   * 读取知了专属会话 ID（从磁盘持久化文件）。
   * 与 server.ts 的 GET /config/zhile-session 端点读取同一文件。
   */
  private getZhileSessionId(): string | null {
    const file = join(getConfigDir(), 'zhile-session.json')
    if (!existsSync(file)) return null
    try {
      const data = JSON.parse(readFileSync(file, 'utf-8')) as { sessionId?: string }
      return data.sessionId ?? null
    } catch {
      return null
    }
  }

  private async getOrCreateAgentSession(
    msg: InboundMessage,
    sessionKey: string,
  ): Promise<string | null> {
    // 1. 优先复用已映射的 session（内存中仍存活）
    const existingId = this.imSessionMap.get(sessionKey)
    if (existingId && this.sessionManager.getSession(existingId)) {
      return existingId
    }

    // 2. 微信平台：优先绑定到知了专属会话，让 web 端能看到微信聊天记录
    if (msg.source.platform === 'weixin') {
      const zhileId = this.getZhileSessionId()
      if (zhileId) {
        // 知了会话在内存中存活：直接复用
        if (this.sessionManager.getSession(zhileId)) {
          this.imSessionMap.set(sessionKey, zhileId)
          this.saveIMSessions()
          log.info('微信消息绑定到知了专属会话（内存）', { sessionKey, zhileId })
          return zhileId
        }
        // 知了会话已从内存卸载（空闲超时）：resume 恢复
        try {
          const session = await this.sessionManager.createSession({ resume: zhileId })
          this.imSessionMap.set(sessionKey, session.info.id)
          this.saveIMSessions()
          log.info('微信消息绑定到知了专属会话（resume）', { sessionKey, agentSessionId: session.info.id })
          return session.info.id
        } catch (err) {
          log.warn('resume 知了会话失败，将创建新会话', { zhileId, error: String(err) })
        }
      }
    }

    // 3. 其他平台或知了会话不存在：创建新 session
    try {
      const session = await this.sessionManager.createSession({
        title: `IM: ${msg.source.platform} / ${msg.source.chatName ?? msg.source.chatId}`,
        permissionMode: 'craft',
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
      const zhileId = this.getZhileSessionId()
      for (const [key, value] of Object.entries(data)) {
        // 微信平台：若旧映射指向的不是知了会话，清除旧映射，
        // 让下次消息时重新走知了绑定逻辑
        if (key.startsWith('im:weixin:') && zhileId && value !== zhileId) {
          log.debug('清除微信旧会话映射，将重新绑定到知了', { key, oldSessionId: value })
          continue
        }
        this.imSessionMap.set(key, value)
      }
      log.debug('已加载 IM 会话映射', { count: this.imSessionMap.size })
    } catch (err) {
      log.warn('IM 会话映射加载失败', { error: String(err) })
    }
  }

  private saveIMSessions(): void {
    try {
      const dir = getConfigDir()
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
