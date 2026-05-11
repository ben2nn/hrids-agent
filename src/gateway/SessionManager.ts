// 会话管理器 —— 管理 agent 进程的生命周期
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { createProvider, createProviderFromConfig, createVisionProviderFromConfig } from '../core/providers/index.js'
import { QueryEngine } from '../core/QueryEngine.js'
import type { Message, ContentBlock, ImageSource } from '../core/QueryEngine.js'
import { PermissionManager } from '../core/PermissionManager.js'
import { ALL_TOOLS } from '../tools/index.js'
import { createAgentTool } from '../tools/AgentTool.js'
import { loadMcpTools, disconnectAllMcp } from '../tools/McpTool.js'
import { TeamManager } from '../core/coordinator/TeamManager.js'
import { buildSystemContext, getSessionWorkDirPath } from '../core/ContextBuilder.js'
import { getCoordinatorSystemPrompt, classifyTask } from '../core/coordinator/coordinatorPrompt.js'
import { loadSessionEvents, loadSessionMeta, saveSessionMeta, generateSessionId, archiveSession } from '../core/SessionStore.js'
import { ConversationStore, JsonlEventStorage, createUserMessageEvent, createAssistantMessageEvent, createSystemEvent } from '../core/ConversationStore.js'
import { loadConfig, getConfigDir } from '../core/Config.js'
import { runWithCwd } from '../core/cwd.js'
import { runWithSession } from '../core/sessionContext.js'
import { resolveAskUser, setGatewayAskCallback } from '../tools/AskUserTool.js'
import { setTodosUpdatedCallback, setResetDecisionCallback, resolveResetDecision } from '../tools/TodoTool.js'
import { resolveDecision, setGatewayDecisionCallback } from '../tools/DecisionTool.js'
import { logger } from '../core/logger.js'
import { auditLog } from '../core/audit.js'
import { autoExtractMemories, autoDistillSkill } from '../core/postRunHooks.js'
import { destroyMemoryStackForSession, destroyMemoryStoreForSession } from '../memory/index.js'
import type { LLMProvider } from '../core/providers/types.js'
import type { CreateSessionRequest, SessionInfo } from './types.js'
import type WebSocket from 'ws'
import { resolve } from 'path'
import { loadMediaFromFile, extractMediaFromText } from '../core/MediaProcessor.js'
const log = logger.child({ component: 'gateway' })

// 事件回放缓冲区容量（每个 session 最多缓存多少条事件）
const REPLAY_BUFFER_SIZE = 200

export interface ManagedSession {
  info: SessionInfo
  engine: QueryEngine
  provider: LLMProvider
  permissions: PermissionManager
  subscribers: Set<WebSocket>
  idleTimer: ReturnType<typeof setTimeout> | null
  pendingPermissions: Map<string, (granted: boolean) => void>
  replayBuffer: object[]
  // 内部事件监听器（供 runMessageWithCallback 使用，避免 fake WebSocket）
  internalListeners: Set<(ev: { type: string; delta?: string; message?: string }) => void>
}

export interface SessionManagerConfig {
  idleTimeoutMs?: number   // 空闲超时（默认 30 分钟）
  maxSessions?: number     // 最大并发会话数（默认 20）
  authToken?: string       // Bearer token 鉴权（可选）
}

export class SessionManager {
  private sessions = new Map<string, ManagedSession>()
  private config: SessionManagerConfig
  /** cron 触发时推送到 IM 的回调（由 PlatformManager 注入） */
  private cronIMCallback: ((agentSessionId: string, text: string) => Promise<void>) | null = null

  constructor(config: SessionManagerConfig = {}) {
    this.config = {
      idleTimeoutMs: config.idleTimeoutMs ?? 30 * 60 * 1000,
      maxSessions: config.maxSessions ?? 20,
      authToken: config.authToken,
    }
  }

  /** 注册 cron → IM 推送回调（由 PlatformManager 在启动后调用） */
  setCronIMCallback(cb: (agentSessionId: string, text: string) => Promise<void>): void {
    this.cronIMCallback = cb
  }

  /**
   * 获取会话的工作目录
   */
  getSessionCwd(sessionId: string): string | null {
    const session = this.sessions.get(sessionId)
    return session?.info.cwd ?? null
  }

  async createSession(req: CreateSessionRequest): Promise<ManagedSession> {
    if (this.sessions.size >= this.config.maxSessions!) {
      throw new Error(`已达到最大会话数限制（${this.config.maxSessions}）`)
    }

    const agentConfig = loadConfig()
    const model = req.model ?? agentConfig.model
    // resume 时复用原会话 id，保持会话连续性；否则生成新 id
    const sessionId = req.resume ?? generateSessionId()

    // resume 时从磁盘读取原会话 title
    const resumeMeta = req.resume ? loadSessionMeta(req.resume) : null

    // 确定会话工作目录：优先使用请求中指定的 cwd，resume 时沿用原会话目录，否则新建独立目录
    const sessionCwd = req.cwd ?? resumeMeta?.workDir ?? getSessionWorkDirPath(sessionId)

    log.info('创建会话', { sessionId, model, autoMode: req.autoMode, cwd: sessionCwd })
    auditLog({ sessionId, action: 'session_create', resource: sessionId, result: 'allowed', details: { model } })

    // 创建 LLM 提供商
    // 若请求显式指定了 model/provider/apiKey，则用 createProvider 精确创建；
    // 否则走 config.yaml 的 llm.fallbacks / model 多模型 fallback 配置
    const provider = (req.model || req.provider || req.apiKey)
      ? createProvider({
          model,
          apiKey: req.apiKey ?? agentConfig.apiKey,
          baseUrl: req.baseUrl ?? agentConfig.baseUrl,
          provider: req.provider as never ?? agentConfig.provider,
          customProviders: agentConfig.customProviders,
        })
      : createProviderFromConfig(agentConfig)

    // 权限管理：permissionMode 优先；autoMode 兼容旧字段（映射到 craft）；否则读全局配置
    const permMode = req.permissionMode ?? (req.autoMode ? 'craft' : agentConfig.permissionMode)
    // 使用 provider 的实际模型名（createProviderFromEnv 时 model 变量可能是旧默认值）
    const actualModel = provider.model
    const session: ManagedSession = {
      info: {
        id: sessionId,
        status: 'ready',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        model: actualModel,
        cwd: sessionCwd,
        title: resumeMeta?.title ?? req.title,
        permissionMode: permMode as 'ask' | 'craft' | 'plan',
      },
      engine: null as unknown as QueryEngine, // 下方赋值
      provider,
      permissions: null as unknown as PermissionManager, // 下方赋值
      subscribers: new Set(),
      idleTimer: null,
      pendingPermissions: new Map(),
      replayBuffer: [],
      internalListeners: new Set(),
    }

    const permissions = new PermissionManager(
      permMode,
      async (permReq) => {
        // auto 模式：直接允许（PermissionManager 内部已处理，此回调不会被调用）
        // ask 模式：通过 WebSocket 广播权限询问，等待客户端回复
        const key = `${permReq.toolName}::${permReq.description}`

        // 广播权限询问给所有订阅者（携带 ruleContent 供前端展示和回传）
        this.broadcast(session, {
          type: 'permission_request',
          toolName: permReq.toolName,
          description: permReq.description,
          readonly: permReq.isReadonly,
          isDestructive: permReq.isDestructive,
          ruleContent: permReq.ruleContent,
          key,
        })

        log.info('权限询问', { sessionId, toolName: permReq.toolName, description: permReq.description })

        // 等待客户端回复（最多 5 分钟，超时默认拒绝）
        return new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => {
            session.pendingPermissions.delete(key)
            log.warn('权限询问超时，默认拒绝', { sessionId, toolName: permReq.toolName })
            auditLog({ sessionId, action: 'permission_denied', resource: permReq.toolName, result: 'denied', details: { reason: 'timeout' } })
            resolve(false)
          }, 5 * 60 * 1000)

          session.pendingPermissions.set(key, (granted) => {
            clearTimeout(timer)
            session.pendingPermissions.delete(key)
            auditLog({
              sessionId,
              action: 'permission_check',
              resource: permReq.toolName,
              result: granted ? 'allowed' : 'denied',
              details: { description: permReq.description },
            })
            resolve(granted)
          })
        })
      },
    )

    // 加载 MCP 工具（绑定到当前会话，避免跨会话共享连接）
    const mcpTools = agentConfig.mcpServers.length > 0
      ? await loadMcpTools(agentConfig.mcpServers, sessionId)
      : []

    const tools = [
      ...ALL_TOOLS,
      createAgentTool(),
      ...mcpTools,
    ]

    TeamManager.initForSession(sessionId, provider, tools)

    // 恢复已有会话或新建：加载事件日志
    let store: ConversationStore | undefined
    if (req.resume) {
      const sessionDir = join(getConfigDir(), 'sessions', req.resume)
      const eventStorage = new JsonlEventStorage(sessionDir)
      store = new ConversationStore(eventStorage)
      const events = loadSessionEvents(req.resume)
      if (events && events.length > 0) {
        store.appendEventsNoSave(...events)
      }
    }

    const systemPrompt = await buildSystemContext(getCoordinatorSystemPrompt(undefined, tools), sessionCwd, sessionId)

    session.engine = new QueryEngine({
      provider,
      systemPrompt,
      tools,
      permissions,
      maxTokens: agentConfig.maxTokens,
      maxTurns: agentConfig.maxTurns,
      maxBudgetUsd: agentConfig.maxBudgetUsd,
      autoCompactThreshold: agentConfig.autoCompactThreshold,
      sessionCwd,
      uploadsDir: join(getConfigDir(), 'sessions', sessionId, 'uploads'),
    }, store)
    session.permissions = permissions

    // 注册压缩前归档回调：保留完整历史，workDir 不变
    session.engine.onBeforeCompact = async (summary: string) => {
      session.engine.store.saveToDisk()
      archiveSession(sessionId, summary)
    }

    // 注册 todos_updated 推送回调（按 sessionId 隔离，避免多会话串流）
    // 传入 sessionId 确保只有当前会话的 todo 操作才触发此回调
    // todo 数据迁移到 sessions/<sessionId>/tasks/ 目录，不再依赖 workDir
    setTodosUpdatedCallback(() => {
      const s = this.sessions.get(sessionId)
      if (s) {
        const todoFile = join(getConfigDir(), 'sessions', sessionId, 'tasks', 'todos.json')
        let todos: unknown[] = []
        try {
          if (existsSync(todoFile)) {
            const raw = JSON.parse(readFileSync(todoFile, 'utf-8'))
            todos = Array.isArray(raw) ? raw : []
          }
        } catch { /* 读取失败时推送空数组，不阻断广播 */ }
        this.broadcast(s, { type: 'todos_updated', todos })
      }
    }, sessionId)

    // Gateway 模式：注册 ask_user 回调，将问题广播给前端（按 sessionId 隔离）
    setGatewayAskCallback((question, options) => {
      this.broadcast(session, { type: 'ask_user', question, options })
    }, sessionId)

    // Gateway 模式：注册 decision_request 回调，将决策请求广播给前端（按 sessionId 隔离）
    setGatewayDecisionCallback((payload) => {
      this.broadcast(session, payload)
    }, sessionId)

    // Gateway 模式：注册 todo_reset 决策推送回调，将重置请求广播给前端（按 sessionId 隔离）
    setResetDecisionCallback((payload) => {
      this.broadcast(session, payload)
    }, sessionId)

    this.sessions.set(sessionId, session)
    this.resetIdleTimer(session)
    return session
  }

  getSession(id: string): ManagedSession | undefined {
    return this.sessions.get(id)
  }

  /** 向指定 session 的所有 WebSocket 订阅者广播消息 */
  broadcastToSession(sessionId: string, msg: object): void {
    const session = this.sessions.get(sessionId)
    if (session) this.broadcast(session, msg)
  }

  listSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map(s => s.info)
  }

  async destroySession(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) return

    log.info('销毁会话', { sessionId: id })
    auditLog({ sessionId: id, action: 'session_destroy', resource: id, result: 'allowed' })

    if (session.idleTimer) clearTimeout(session.idleTimer)
    session.engine.abort()

    // 拒绝所有待处理的权限询问
    for (const resolve of session.pendingPermissions.values()) {
      resolve(false)
    }
    session.pendingPermissions.clear()

    // 通知所有订阅者会话已关闭
    const msg = JSON.stringify({ type: 'error', message: '会话已被销毁' })
    for (const ws of session.subscribers) {
      try { ws.send(msg) } catch { /* 忽略 */ }
    }
    session.subscribers.clear()

    await disconnectAllMcp(id)
    setTodosUpdatedCallback(null, id)
    setGatewayAskCallback(null, id)
    setGatewayDecisionCallback(null, id)
    setResetDecisionCallback(null, id)
    TeamManager.destroySession(id)
    // 清理会话级记忆实例（释放 SQLite 连接）
    destroyMemoryStackForSession(id)
    destroyMemoryStoreForSession(id)
    this.sessions.delete(id)
  }

  // 优雅关闭：等待所有进行中的任务完成后再销毁
  async gracefulShutdown(timeoutMs = 10000): Promise<void> {
    log.info('开始优雅关闭', { sessions: this.sessions.size })
    const ids = Array.from(this.sessions.keys())

    // 等待所有 busy 会话完成（最多 timeoutMs）
    const deadline = Date.now() + timeoutMs
    for (const id of ids) {
      const session = this.sessions.get(id)
      if (!session) continue
      while (session.info.status === 'busy' && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 200))
      }
      // 超时则强制中止
      if (session.info.status === 'busy') {
        log.warn('会话未在超时内完成，强制中止', { sessionId: id })
        session.engine.abort()
      }
    }

    // 保存所有会话事件到磁盘
    for (const [id, session] of this.sessions) {
      try {
        session.engine.store.saveToDisk()
        saveSessionMeta(id, { model: session.info.model, workDir: session.info.cwd, eventCount: session.engine.store.getEventCount() })
      } catch { /* 忽略 */ }
    }

    await Promise.all(ids.map(id => this.destroySession(id)))
    log.info('优雅关闭完成')
  }

  subscribe(sessionId: string, ws: WebSocket): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.subscribers.add(ws)
    log.debug('WS 订阅', { sessionId, subscriberCount: session.subscribers.size })

    // 只在 agent 正在运行时才回放缓冲区（busy 状态）
    // ready 状态下历史消息通过 REST API /sessions/:id/messages 加载，无需回放
    if (session.info.status === 'busy' && session.replayBuffer.length > 0) {
      log.debug('回放缓冲区（agent 运行中）', { sessionId, events: session.replayBuffer.length })
      for (const msg of session.replayBuffer) {
        try { ws.send(JSON.stringify(msg)) } catch { /* 忽略 */ }
      }
    }
  }

  unsubscribe(sessionId: string, ws: WebSocket): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.subscribers.delete(ws)
    log.debug('WS 取消订阅', { sessionId, subscriberCount: session.subscribers.size })
    // 注意：不重置空闲计时器 —— session 生命周期与订阅者数量无关
  }

  broadcast(session: ManagedSession, msg: object): void {
    const msgWithTs = { ...msg, timestamp: Date.now() }
    const text = JSON.stringify(msgWithTs)
    const msgType = (msg as Record<string, unknown>).type
    if (msgType !== 'text_delta' && msgType !== 'tool_log') {
      log.debug('广播消息', { sessionId: session.info.id, type: msgType, subscribers: session.subscribers.size })
    }

    // 触发内部监听器（供 runMessageWithCallback 使用）
    if (session.internalListeners.size > 0) {
      const ev = msg as { type: string; delta?: string; message?: string }
      for (const listener of session.internalListeners) {
        try { listener(ev) } catch { /* 忽略监听器异常 */ }
      }
    }

    if (msgType === 'done' || msgType === 'error' || msgType === 'interrupted') {
      session.replayBuffer.push(msgWithTs)
    } else if (msgType === 'message') {
      session.replayBuffer = [msgWithTs]
    } else {
      session.replayBuffer.push(msgWithTs)
      if (session.replayBuffer.length > REPLAY_BUFFER_SIZE) {
        session.replayBuffer.shift()
      }
    }

    for (const ws of session.subscribers) {
      try { ws.send(text) } catch { /* 忽略断开的连接 */ }
    }
  }

  // 定时任务触发：直接发送提醒消息，不经过 LLM
  async sendCronReminder(sessionId: string, cronJob: { id: string; description: string; task: string }): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`会话不存在: ${sessionId}`)

    // 生成本次请求的唯一 ID
    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

    session.info.status = 'busy'
    session.info.lastActiveAt = Date.now()
    this.resetIdleTimer(session)

    log.info('定时任务触发，发送提醒', { sessionId, requestId, jobId: cronJob.id, description: cronJob.description })

    try {
      // 广播请求开始事件
      this.broadcast(session, {
        type: 'request_start',
        requestId,
        trigger: 'cron',
        description: cronJob.description,
      })

      // 广播定时任务分隔标记
      this.broadcast(session, {
        type: 'cron_trigger',
        requestId,
        description: cronJob.description,
      })

      // 直接广播 assistant 消息（提醒内容）
      this.broadcast(session, {
        type: 'text_delta',
        requestId,
        delta: cronJob.task,
      })

      // 广播完成事件
      this.broadcast(session, {
        type: 'done',
        requestId,
      })

      // 将提醒消息写入事件日志（作为系统事件），并持久化
      session.engine.store.appendEvents(
        createSystemEvent(
          'cron_trigger',
          `[定时任务触发: ${cronJob.description}]\n${cronJob.task}`,
          requestId,
          cronJob.description,
        ),
      )
      saveSessionMeta(sessionId, { model: session.info.model, workDir: session.info.cwd, eventCount: session.engine.store.getEventCount() })

      // 推送到 IM 平台（如果有绑定的 IM 会话）
      if (this.cronIMCallback) {
        void this.cronIMCallback(sessionId, cronJob.task).catch(err => {
          log.warn('cron 推送到 IM 失败', { sessionId, error: String(err) })
        })
      }

    } catch (err) {
      log.error('定时任务提醒失败', { sessionId, error: String(err) })
      this.broadcast(session, {
        type: 'error',
        requestId,
        message: `定时任务提醒失败: ${String(err)}`,
      })
    } finally {
      session.info.status = 'ready'
    }
  }

  /**
   * 执行用户消息，通过回调接收事件流（供 IM 平台等非 WebSocket 场景使用）。
   * 避免 fake WebSocket 的类型不安全和内存泄漏问题。
   *
   * @param onEvent 事件回调，接收 { type, delta?, message? } 格式的事件
   */
  async runMessageWithCallback(
    sessionId: string,
    content: string,
    onEvent: (ev: { type: string; delta?: string; message?: string }) => void,
    attachments?: Array<{ name: string; data: string; mediaType: string }>,
  ): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`会话不存在: ${sessionId}`)
    if (session.info.status === 'busy') throw new Error('会话正忙，请等待当前任务完成')

    // 注册内部监听器，broadcast 时会同步触发
    session.internalListeners.add(onEvent)
    try {
      await runWithCwd(session.info.cwd, () =>
        runWithSession(sessionId, () =>
          this._runMessageInContext(session, sessionId, content, attachments, undefined)
        )
      )
    } finally {
      session.internalListeners.delete(onEvent)
    }
  }

  // 执行用户消息，流式广播事件
  async runMessage(sessionId: string, content: string, attachments?: Array<{ name: string; data: string; mediaType: string }>, cronJob?: { id: string; description: string }): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`会话不存在: ${sessionId}`)
    if (session.info.status === 'busy') throw new Error('会话正忙，请等待当前任务完成')

    // 在会话自己的 cwd 上下文中运行，与其他并发会话完全隔离
    // 同时注入 sessionId 上下文，供工具层获取会话级 TeamManager
    return runWithCwd(session.info.cwd, () =>
      runWithSession(sessionId, () =>
        this._runMessageInContext(session, sessionId, content, attachments, cronJob)
      )
    )
  }

  // 实际执行逻辑（已在正确的 cwd 上下文中）
  private async _runMessageInContext(session: ManagedSession, sessionId: string, content: string, attachments?: Array<{ name: string; data: string; mediaType: string }>, cronJob?: { id: string; description: string }, systemContinuation = false): Promise<void> {
    // 生成本次请求的唯一 ID，用于前端消息分组
    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    
    // 设置 QueryEngine 的 requestId，用于 tool_result 关联
    session.engine.setRequestId(requestId)
    // 设置触发来源，用于历史消息标记
    session.engine.setTrigger(cronJob ? 'cron' : 'user', cronJob?.description)
    
    session.info.status = 'busy'
    session.info.lastActiveAt = Date.now()
    this.resetIdleTimer(session)

    // 新一轮开始：清空上一轮的回放缓冲区，避免新客户端看到旧轮次的输出
    session.replayBuffer = []

    log.debug('处理消息', { sessionId, requestId, contentLength: content.length, attachmentCount: attachments?.length ?? 0 })
    log.info('开始执行消息', { sessionId, requestId, model: session.info.model, permissionMode: session.permissions.getMode(), contentPreview: content.slice(0, 100) })

    // 广播请求开始事件，携带 requestId 和触发类型
    // systemContinuation（轮次上限自动续跑）不广播，避免前端出现系统内部消息
    if (!systemContinuation) {
      this.broadcast(session, {
        type: 'request_start',
        requestId,
        trigger: cronJob ? 'cron' : 'user',
        description: cronJob?.description,
      })
    }

    // 定时任务触发时，额外发送独立的分隔标记事件
    if (cronJob) {
      this.broadcast(session, {
        type: 'cron_trigger',
        requestId,
        description: cronJob.description,
      })
    }

    // 记录最近一条用户消息（跳过系统内部注入的消息和自动续跑）
    if (!systemContinuation && !content.startsWith('[系统') && !content.startsWith('[上下文压缩]')) {
      session.info.lastUserMessage = content.slice(0, 80)
    }

    // 检测是否包含图片或 PDF 附件
    const visionMediaTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf']
    const hasVisionAttachment = attachments?.some(a => visionMediaTypes.includes(a.mediaType)) ?? false

    log.info('[图片诊断] 入口', {
      sessionId,
      attachmentsCount: attachments?.length ?? 0,
      attachmentMimeTypes: attachments?.map(a => a.mediaType) ?? [],
      hasVisionAttachment,
      contentPreview: content.slice(0, 80),
    })

    // 如果没有显式附件，尝试从消息文本中提取 @引用的媒体（本地文件 / URL）
    // 委托给 MediaProcessor：支持压缩、缓存、URL fetch、PDF
    const inlineAttachments: Array<{ name: string; data: string; mediaType: string }> = []
    let processedContent = content  // 去掉 @引用后的干净文本
    if (!hasVisionAttachment) {
      const cwd = session.info.cwd
      const uploadsDir = join(getConfigDir(), 'sessions', sessionId, 'uploads')
      const { attachments: extracted, cleanText, errors } = await extractMediaFromText(content, cwd, uploadsDir)
      if (extracted.length > 0) {
        inlineAttachments.push(...extracted)
        processedContent = cleanText
        if (errors.length > 0) {
          processedContent += `\n\n[媒体加载失败]\n${errors.join('\n')}`
        }
        log.info('从消息文本提取媒体附件', { sessionId, count: extracted.length, errors: errors.length })
      }
    }

    // 如果仍然没有附件，检测消息是否有视觉意图，并从历史中找最近上传的图片
    if (!hasVisionAttachment && inlineAttachments.length === 0) {
      const hasVisionIntent = isVisionIntent(content)
      if (hasVisionIntent) {
        const uploadsDir = join(getConfigDir(), 'sessions', sessionId, 'uploads')
        const recentImages = await extractRecentImagesFromHistory(session.engine.store.getEventLog(), session.info.cwd, uploadsDir)
        inlineAttachments.push(...recentImages)
        if (recentImages.length > 0) {
          log.info('检测到视觉意图，从历史中提取最近图片', { sessionId, count: recentImages.length, files: recentImages.map(a => a.name) })
        }
      }
    }

    const effectiveAttachments = attachments ?? inlineAttachments
    const hasEffectiveVision = effectiveAttachments.some(a => visionMediaTypes.includes(a.mediaType))

    log.info('[图片诊断] effectiveAttachments', {
      sessionId,
      effectiveCount: effectiveAttachments.length,
      hasEffectiveVision,
      mimeTypes: effectiveAttachments.map(a => a.mediaType),
      inlineCount: inlineAttachments.length,
    })

    // 如果有视觉内容，尝试切换到视觉模型
    let originalProvider: LLMProvider | null = null
    let visionProvider: LLMProvider | null = null
    if (hasEffectiveVision) {
      const agentConfig = loadConfig()
      visionProvider = createVisionProviderFromConfig(agentConfig)
      log.info('[图片诊断] 视觉模型创建', {
        sessionId,
        hasVisionConfig: !!agentConfig.vision,
        visionFallbacks: (agentConfig.vision as { fallbacks?: unknown[] } | undefined)?.fallbacks?.length ?? 0,
        providerCreated: !!visionProvider,
        providerModel: visionProvider?.model ?? null,
      })
      if (visionProvider) {
        log.info('检测到图片/PDF，切换到视觉模型', { sessionId, model: visionProvider.model })
        originalProvider = session.provider
        session.engine.setProvider(visionProvider)
        this.broadcast(session, { type: 'model_switched', requestId, model: visionProvider.model, reason: 'vision_content' })
      } else {
        log.warn('检测到图片/PDF，但未配置视觉模型（config.yaml 的 vision 字段），使用当前模型', { sessionId })
      }
    }

    // 构建用户消息（支持多模态内容块）
    // processedContent：去掉 @引用后的干净文本（inlineAttachments 场景），或原始 content
    const textForMsg = inlineAttachments.length > 0 ? processedContent : content
    let userMsg: Message | string
    if (effectiveAttachments.length > 0) {
      const contentBlocks: ContentBlock[] = []
      // 先添加文本内容
      if (textForMsg.trim()) {
        contentBlocks.push({ type: 'text', text: textForMsg })
      }
      // 添加附件内容块
      for (const att of effectiveAttachments) {
        if (visionMediaTypes.includes(att.mediaType)) {
          contentBlocks.push({
            type: 'image',
            source: {
              type: 'base64',
              mediaType: att.mediaType as ImageSource['mediaType'],
              data: att.data,
            },
          })
        }
      }
      log.info('[图片诊断] 构建 ContentBlock', { sessionId, blockTypes: contentBlocks.map(b => b.type) })
      userMsg = { role: 'user', content: contentBlocks }
    } else {
      log.info('[图片诊断] 无附件，纯文本消息', { sessionId })
      userMsg = content
    }

    // ── 视觉模型：精简调用（不走 QueryEngine，避免携带工具和无关历史）──────────
    if (hasEffectiveVision && visionProvider) {
      // system prompt 精简为一句话，不注入工具规范、记忆等无关内容
      const visionSystemPrompt = ['你是一个图像分析助手，请根据用户提供的图片和问题给出准确、详细的回答。']

      // 只传图片消息，不传历史（视觉模型无需上下文）
      const visionMessages = [userMsg as Message]

      log.info('视觉模型精简调用', { sessionId, model: visionProvider.model })

      let visionText = ''
      const VISION_TIMEOUT_MS = 60_000  // 视觉调用超时 60 秒
      const visionAbort = new AbortController()
      const visionTimer = setTimeout(() => visionAbort.abort(), VISION_TIMEOUT_MS)

      try {
        for await (const chunk of visionProvider.stream(
          visionMessages as never,
          [],           // 不传工具
          visionSystemPrompt,
          4096,
          visionAbort.signal,
        )) {
          if (visionAbort.signal.aborted) break
          if (chunk.type === 'text_delta' && chunk.delta) {
            visionText += chunk.delta
            const clientMsg = toClientMessage({ type: 'text_delta', delta: chunk.delta }, requestId, visionProvider.model)
            if (clientMsg) this.broadcast(session, clientMsg)
          } else if (chunk.type === 'usage' && chunk.usage) {
            const clientMsg = toClientMessage({ type: 'usage', inputTokens: chunk.usage.inputTokens, outputTokens: chunk.usage.outputTokens, costUsd: 0 }, requestId, visionProvider.model)
            if (clientMsg) this.broadcast(session, clientMsg)
          }
        }
      } catch (err) {
        const isTimeout = visionAbort.signal.aborted
        log.error('视觉模型调用失败', { sessionId, error: String(err), isTimeout })
        this.broadcast(session, { type: 'error', requestId, message: isTimeout ? '视觉模型响应超时（60s）' : `视觉模型调用失败: ${String(err)}` })
      } finally {
        clearTimeout(visionTimer)
      }

      // 将视觉模型的回答写入事件日志，供后续对话引用
      if (visionText.trim()) {
        const userText = inlineAttachments.length > 0 ? processedContent : content
        session.engine.store.appendEvents(
          createUserMessageEvent(typeof userText === 'string' ? userText : String(userText), requestId),
          createAssistantMessageEvent(visionText, undefined, requestId),
        )
        saveSessionMeta(sessionId, { model: session.info.model, workDir: session.info.cwd, eventCount: session.engine.store.getEventCount() })
      }

      this.broadcast(session, toClientMessage({ type: 'done' }, requestId, visionProvider.model) ?? { type: 'done', requestId })
      // 视觉调用完成，恢复原始 provider 和 session 状态
      if (originalProvider) session.engine.setProvider(originalProvider)
      session.info.status = 'ready'
      session.info.lastActiveAt = Date.now()
      this.resetIdleTimer(session)
      return
    }
    // 根据消息内容动态注入任务相关扩展（skill 沉淀、爬虫、代码开发等规范）
    const types = classifyTask(content)
    session.engine.setChatMode(types.includes('chat'))

    const allTools = session.engine.getTools()
    const coordinatorPrompt = getCoordinatorSystemPrompt(content, allTools)

    // 追加动态层（记忆、环境信息），确保每条消息都能看到最新的记忆和 Git 状态
    const fullPrompt = await buildSystemContext(coordinatorPrompt, session.info.cwd, sessionId)

    // plan 模式：动态注入规划模式系统提示，让 LLM 知道文档类文件可写，代码文件不可写
    if (session.permissions.getMode() === 'plan') {
      const readonlyTools = allTools.filter(t => t.readonly).map(t => t.name)
      const writeTools = allTools.filter(t => !t.readonly).map(t => t.name)

      const planModeAppendix = `## 当前模式：Plan（规划模式）
你现在处于规划模式，所有写操作均被系统禁止。只读工具可以正常使用，包括 ask_user（询问用户）和 web_search（搜索信息）。

### 可用工具（只读，可正常调用）
${readonlyTools.join('、')}

### 不可用工具（写操作，调用将被拒绝）
${writeTools.join('、')}

### 你的任务
1. 使用只读工具充分了解现状：可以读文件、搜索代码、搜索网络信息、询问用户等
2. 制定详细的执行计划：列出每一步要做什么、修改哪些文件、执行什么命令
3. 不要尝试调用写操作工具，即使调用也会被系统拒绝
4. 计划完成后，告知用户"已完成规划，请切换到执行模式后继续"

用户确认计划后，会将模式切换为 ask 或 craft，届时写操作将可用。`
      session.engine.setSystemPrompt([...fullPrompt, planModeAppendix])
    } else {
      session.engine.setSystemPrompt(fullPrompt)
    }

    const msgWithCtx = userMsg

    // 保存 generator 引用，以便在异常时显式关闭，确保 QueryEngine 内部 finally 执行
    const gen = session.engine.send(msgWithCtx)
    let hitTurnLimit = false
    try {
      for await (const ev of gen) {
        // 检测轮次上限，标记后根据 todo 状态决定处理方式
        if (ev.type === 'turn_limit') {
          hitTurnLimit = true
        }
        // 将 QueryEngine 内部事件格式转换为前端协议格式
        const clientMsg = toClientMessage(ev, requestId, session.info.model)
        if (clientMsg) {
          // 过滤高频事件，避免日志爆炸
          if (ev.type !== 'text_delta' && ev.type !== 'tool_log') {
            log.debug('QueryEngine 事件 → 广播', { sessionId, requestId, evType: ev.type })
          }
          this.broadcast(session, clientMsg)
        } else if (ev.type !== 'text_delta' && ev.type !== 'tool_log') {
          log.debug('QueryEngine 事件（无对应客户端消息，跳过广播）', { sessionId, requestId, evType: ev.type })
        }

        // 每次工具调用结束后增量保存元数据（事件已由 appendEvents 自动持久化）
        if (ev.type === 'done') {
          saveSessionMeta(sessionId, { model: session.info.model, workDir: session.info.cwd, eventCount: session.engine.store.getEventCount() })
        }
      }
    } catch (err) {
      log.error('runMessage 事件循环异常', { sessionId, error: String(err) })
      // 显式关闭 generator，触发 QueryEngine.send() 的 finally 块，释放 running 锁
      await gen.return(undefined)
      throw err
    } finally {
      // 视觉模型切换后恢复原始 provider
      if (originalProvider) {
        session.engine.setProvider(originalProvider)
        log.debug('视觉模型任务完成，恢复原始模型', { sessionId, model: originalProvider.model })
      }
      session.info.status = 'ready'
      session.info.lastActiveAt = Date.now()
      // 任务完成后重置空闲计时器，从此刻开始计算空闲时间
      this.resetIdleTimer(session)
      log.debug('runMessage 完成', { sessionId })
    }

    // 达到轮次上限：仅 ask/plan 模式会触发（craft 模式 QueryEngine 内部无限制）
    // 无论是否有 todo，都自动续跑——用户选 ask/plan 是为了控制写操作权限，
    // 不是为了每 N 轮被打断。continuation_needed 只用于 LLM 主动停下的场景。
    if (hitTurnLimit) {
      log.info('轮次上限，自动续跑', { sessionId, permMode: session.permissions.getMode() })
      // 以系统身份续跑：不广播 request_start，不记录 lastUserMessage，不在前端显示为用户消息
      // QueryEngine 在 turn_limit 时已往 history 注入了 [系统提示]，此处直接触发下一轮执行
      void runWithCwd(session.info.cwd, () =>
        runWithSession(sessionId, () =>
          this._runMessageInContext(session, sessionId, '[系统提示] 请继续执行之前未完成的任务，从中断处接着做。', undefined, undefined, true)
        )
      ).catch((err) => {
        log.error('轮次上限续跑失败', { sessionId, error: String(err) })
        this.broadcast(session, { type: 'error', requestId, message: `自动续跑失败: ${String(err)}` })
      })
      return
    }

    // 后台钩子：记忆提炼 + Skill 自动沉淀（不阻塞响应）
    const memoryCondense = loadConfig().memoryCondense ?? false
    const skillDistill = loadConfig().autoDistillSkill ?? false
    void autoExtractMemories(session.engine, sessionId, session.provider, memoryCondense)
    void autoDistillSkill(session.engine, session.provider, skillDistill)
  }

  // 处理客户端发来的控制消息
  handleClientMessage(sessionId: string, raw: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    let msg: Record<string, unknown>
    try { msg = JSON.parse(raw) } catch { return }

    log.debug('收到客户端消息', { sessionId, type: msg.type, contentLength: typeof msg.content === 'string' ? msg.content.length : undefined })

    switch (msg.type) {
      case 'message': {
        // 支持附件（图片/PDF）：attachments 为 Array<{ name, data, mediaType }>
        const attachments = Array.isArray(msg.attachments)
          ? (msg.attachments as Array<{ name: string; data: string; mediaType: string }>)
          : undefined
        void this.runMessage(sessionId, String(msg.content ?? ''), attachments).catch((err) => {
          log.error('runMessage 未捕获异常', { sessionId, error: String(err) })
          this.broadcast(session, { type: 'error', message: `执行失败: ${String(err)}` })
          session.info.status = 'ready'
        })
        break
      }
      // 恢复中断的任务：直接注入"继续执行"指令，history 里已有中断上下文
      case 'resume':
        void this.runMessage(sessionId, String(msg.content ?? '请继续执行之前未完成的任务，从中断处接着做。')).catch((err) => {
          log.error('resume runMessage 未捕获异常', { sessionId, error: String(err) })
          this.broadcast(session, { type: 'error', message: `恢复执行失败: ${String(err)}` })
          session.info.status = 'ready'
        })
        break
      case 'abort':
        session.engine.abort()
        break
      case 'user_reply':
        resolveAskUser(String(msg.answer ?? ''), sessionId)
        break
      case 'decision_reply':
        resolveDecision(String(msg.answer ?? ''), sessionId)
        break
      case 'todo_reset_reply':
        resolveResetDecision(String(msg.answer ?? ''), sessionId)
        break
      // 客户端回复权限询问
      case 'permission_reply': {
        const key = String(msg.key ?? '')
        const granted = msg.granted === true
        // permanent=true 时持久化规则；session=true 时会话内批准（含内容级）
        const permanent = msg.permanent === true
        const sessionApprove = msg.session === true
        const resolve = session.pendingPermissions.get(key)
        if (resolve) {
          log.info('收到权限回复', { sessionId, key, granted, permanent, sessionApprove })
          if (granted) {
            // 解析 key 中的 toolName 和 ruleContent（key = "toolName::description"）
            // ruleContent 由前端从 permission_request 的 ruleContent 字段回传
            const ruleContent = msg.ruleContent ? String(msg.ruleContent) : undefined
            const toolName = key.split('::')[0]
            if (permanent) {
              // 永久批准：持久化到磁盘
              const rule = ruleContent ? `${toolName}(${ruleContent})` : toolName
              session.permissions.approvePermanent(rule)
            } else if (sessionApprove) {
              // 会话内批准：精确到内容级
              session.permissions.approveSession(toolName, ruleContent)
            }
          }
          resolve(granted)
        }
        break
      }
      case 'set_cwd': {
        const cwd = String(msg.cwd ?? '')
        if (cwd) {
          // 只更新会话自己的 cwd，不修改全局变量
          // 下次 runMessage 时 runWithCwd 会用 session.info.cwd 建立新的上下文
          session.info.cwd = cwd
          this.broadcast(session, { type: 'cwd_changed', cwd })
        }
        break
      }
      case 'set_permission_mode': {
        const mode = msg.mode as string
        if (mode === 'ask' || mode === 'craft' || mode === 'plan') {
          session.permissions.setMode(mode)
          session.info.permissionMode = mode
          this.broadcast(session, { type: 'permission_mode_changed', mode })
          log.info('权限模式已切换', { sessionId, mode })
        }
        break
      }
      case 'clear_history': {
        // 清除会话历史：中止当前任务，清空 engine 历史，通知前端
        try {
          if (session.info.status === 'busy') {
            session.engine.abort()
          }
          session.engine.clearHistory()
          saveSessionMeta(sessionId, { model: session.info.model, workDir: session.info.cwd, eventCount: 0 })
          this.broadcast(session, { type: 'history_cleared' })
          log.info('会话历史已清除', { sessionId })
        } catch (err) {
          log.error('清除会话历史失败', { sessionId, error: String(err) })
          this.broadcast(session, { type: 'error', message: `清除历史失败: ${String(err)}` })
        }
        break
      }
    }
  }

  private resetIdleTimer(session: ManagedSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer)
    if (!this.config.idleTimeoutMs) return

    const timeoutMs = this.config.idleTimeoutMs
    session.idleTimer = setTimeout(() => {
      // 空闲超时：基于 lastActiveAt，与订阅者数量无关
      // agent 运行中（busy）不销毁，等任务完成后下一次计时器触发再判断
      if (session.info.status === 'busy') {
        this.resetIdleTimer(session)
        return
      }
      const idleMs = Date.now() - session.info.lastActiveAt
      if (idleMs >= timeoutMs) {
        log.info('会话空闲超时，自动销毁', { sessionId: session.info.id, idleMs })
        void this.destroySession(session.info.id)
      } else {
        // 还没到超时时间（可能 lastActiveAt 被更新过），重新调度
        session.idleTimer = setTimeout(() => {
          log.info('会话空闲超时，自动销毁', { sessionId: session.info.id })
          void this.destroySession(session.info.id)
        }, timeoutMs - idleMs)
      }
    }, timeoutMs)
  }
}

// ── QueryEngine StreamEvent → 前端 WebSocket 协议转换 ──────────────────────
// QueryEngine 使用内部字段名（id/name/line/costUsd），前端期望不同的字段名
import type { StreamEvent } from '../core/QueryEngine.js'

function toClientMessage(ev: StreamEvent, requestId: string, model = ''): object | null {
  switch (ev.type) {
    case 'text_delta':
      return { type: 'text_delta', requestId, delta: ev.delta }

    case 'tool_start':
      return { type: 'tool_start', requestId, toolId: ev.id, toolName: ev.name, input: ev.input }

    case 'tool_log':
      return { type: 'tool_log', requestId, toolId: ev.id, log: ev.line }

    case 'tool_end': {
      // result.type: 'success' | 'error' → status; 'denied' 由 permission_denied 事件处理
      const status = ev.result.type === 'success' ? 'success' : 'error'
      const result = ev.result.type === 'success' ? ev.result.output : ev.result.message
      return { type: 'tool_end', requestId, toolId: ev.id, toolName: ev.name, status, result }
    }

    case 'permission_denied':
      // 权限拒绝：以 tool_end denied 状态通知前端
      return { type: 'tool_end', requestId, toolId: ev.id, toolName: ev.toolName, status: 'denied' }

    case 'usage':
      return {
        type: 'usage',
        requestId,
        inputTokens: ev.inputTokens,
        outputTokens: ev.outputTokens,
        cost: ev.costUsd,
        model,
      }

    case 'budget_exceeded':
      return { type: 'budget_exceeded', message: `已超出预算上限（$${ev.limitUsd}），当前花费 $${ev.costUsd.toFixed(4)}` }

    case 'done':
      return { type: 'done', requestId }

    case 'error':
      return { type: 'error', requestId, message: ev.message }

    case 'interrupted':
      return { type: 'error', requestId, message: ev.message }

    // 以下事件不需要推送给前端
    case 'turn_limit':
    case 'compact_start':
      return null

    case 'compact_done':
      return { type: 'compact_done', summary: ev.summary }

    case 'continuation_needed':
      return { type: 'continuation_needed', requestId }

    default:
      return null
  }
}

// ── 视觉意图检测 ──────────────────────────────────────────────────────────────
// 判断用户消息是否在请求分析/查看图片或 PDF
function isVisionIntent(message: string): boolean {
  const VISION_PATTERNS = [
    // 中文：分析/解析/识别/描述/看/读/理解 + 图片/图像/照片/截图/PDF
    /分析.{0,10}(图|照片|截图|图片|图像|pdf)/i,
    /解析.{0,10}(图|照片|截图|图片|图像|pdf)/i,
    /识别.{0,10}(图|照片|截图|图片|图像)/i,
    /描述.{0,10}(图|照片|截图|图片|图像)/i,
    /(看|读|理解|查看|检查).{0,10}(图|照片|截图|图片|图像|pdf)/i,
    /这(张|幅|个|份).{0,5}(图|照片|截图|图片|图像|pdf)/i,
    /图(片|像|中|上|里).{0,20}(是|有|写|显示|包含)/i,
    /图(片|像)是什么/i,
    /图(片|像)里/i,
    /照片(里|中|上)/i,
    /截图(里|中|上)/i,
    /pdf(里|中|内容)/i,
    // 英文
    /analyze.{0,10}(image|photo|picture|screenshot|pdf)/i,
    /describe.{0,10}(image|photo|picture|screenshot)/i,
    /what.{0,10}(image|photo|picture|screenshot)/i,
    /read.{0,10}(image|photo|picture|pdf)/i,
    /this (image|photo|picture|screenshot|pdf)/i,
  ]
  return VISION_PATTERNS.some(p => p.test(message))
}

// ── 从事件日志中提取最近上传的图片文件 ──────────────────────────────────────
// 扫描事件日志中最近的用户消息：
//   1. 优先从 UserMessageEvent.images 字段取已保存的图片路径（IM 图片走这条路）
//   2. 其次扫描文本中的 @filename 引用（Web 上传走这条路）
async function extractRecentImagesFromHistory(
  eventLog: readonly import('../core/ConversationStore.js').ConversationEvent[],
  cwd: string,
  uploadsDir?: string,
): Promise<Array<{ name: string; data: string; mediaType: string }>> {
  const imagePattern = /@([^\s@]+\.(?:jpg|jpeg|png|gif|webp|bmp|tiff?|avif|pdf))/gi

  // 从最新事件往前扫描，找到第一批图片（最近一次上传的那批）
  const result: Array<{ name: string; data: string; mediaType: string }> = []
  const seen = new Set<string>()

  // 只扫描最近的用户消息事件
  const userEvents = eventLog
    .filter((e): e is import('../core/ConversationStore.js').UserMessageEvent => e.type === 'user_message')
    .slice(-20)

  for (let i = userEvents.length - 1; i >= 0; i--) {
    const ev = userEvents[i]

    // 路径 1：UserMessageEvent.images 字段（IM 图片已保存为文件路径）
    if (ev.images && ev.images.length > 0) {
      for (const imgPath of ev.images) {
        const key = imgPath
        if (seen.has(key)) continue
        seen.add(key)
        const attachment = await loadMediaFromFile(resolve(cwd, imgPath), imgPath)
        if (attachment) result.push(attachment)
      }
      if (result.length > 0) break
    }

    // 路径 2：文本中的 @filename 引用（Web 上传）
    const text = ev.content

    let match: RegExpExecArray | null
    imagePattern.lastIndex = 0
    while ((match = imagePattern.exec(text)) !== null) {
      const filename = match[1]
      if (seen.has(filename)) continue
      seen.add(filename)

      // 搜索顺序：cwd → uploadsDir
      let attachment = await loadMediaFromFile(resolve(cwd, filename), filename)
      if (!attachment && uploadsDir) {
        attachment = await loadMediaFromFile(resolve(uploadsDir, filename), filename)
      }
      if (attachment) result.push(attachment)
    }

    // 找到图片就停止（只取最近一次上传的那批）
    if (result.length > 0) break
  }

  return result
}
