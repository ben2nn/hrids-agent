// 会话管理器 —— 管理 agent 进程的生命周期
import { createProvider, createProviderFromEnv } from '../core/providers/index.js'
import { QueryEngine } from '../core/QueryEngine.js'
import { PermissionManager } from '../core/PermissionManager.js'
import { ALL_TOOLS } from '../tools/index.js'
import { createAgentTool } from '../tools/AgentTool.js'
import { loadMcpTools, disconnectAllMcp } from '../tools/McpTool.js'
import { TeamManager } from '../core/coordinator/TeamManager.js'
import { buildSystemContext, getSessionWorkDir } from '../core/ContextBuilder.js'
import { getCoordinatorSystemPrompt } from '../core/coordinator/coordinatorPrompt.js'
import { loadSession, loadSessionMeta, saveSession, generateSessionId } from '../core/SessionStore.js'
import { loadConfig } from '../core/Config.js'
import { setGlobalCwd, getGlobalCwd } from '../tools/BashTool.js'
import { resolveAskUser, setGatewayAskCallback } from '../tools/AskUserTool.js'
import { setTodoSessionId, setTodosUpdatedCallback } from '../tools/TodoWriteTool.js'
import { logger } from '../core/logger.js'
import { auditLog } from '../core/audit.js'
import { autoExtractMemories, autoDistillSkill } from '../core/postRunHooks.js'
import type { LLMProvider } from '../core/providers/types.js'
import type { CreateSessionRequest, SessionInfo } from './types.js'
import type WebSocket from 'ws'

const log = logger.child({ component: 'gateway' })

export interface ManagedSession {
  info: SessionInfo
  engine: QueryEngine
  provider: LLMProvider
  permissions: PermissionManager
  // 当前连接的 WebSocket 客户端（同一会话可被多个客户端订阅）
  subscribers: Set<WebSocket>
  // 空闲超时计时器
  idleTimer: ReturnType<typeof setTimeout> | null
  // 待处理的权限询问（key = toolName+description，value = resolve 函数）
  pendingPermissions: Map<string, (granted: boolean) => void>
}

export interface SessionManagerConfig {
  idleTimeoutMs?: number   // 空闲超时（默认 30 分钟）
  maxSessions?: number     // 最大并发会话数（默认 20）
  authToken?: string       // Bearer token 鉴权（可选）
}

export class SessionManager {
  private sessions = new Map<string, ManagedSession>()
  private config: SessionManagerConfig

  constructor(config: SessionManagerConfig = {}) {
    this.config = {
      idleTimeoutMs: config.idleTimeoutMs ?? 30 * 60 * 1000,
      maxSessions: config.maxSessions ?? 20,
      authToken: config.authToken,
    }
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
    const sessionCwd = req.cwd ?? resumeMeta?.workDir ?? getSessionWorkDir(sessionId)

    log.info('创建会话', { sessionId, model, autoMode: req.autoMode, cwd: sessionCwd })
    auditLog({ sessionId, action: 'session_create', resource: sessionId, result: 'allowed', details: { model } })

    // 创建 LLM 提供商
    // 若请求显式指定了 model/provider/apiKey，则用 createProvider 精确创建；
    // 否则走 .env 的 LLM_FALLBACK_N / DEFAULT_MODEL 多模型 fallback 配置
    const provider = (req.model || req.provider || req.apiKey)
      ? createProvider({
          model,
          apiKey: req.apiKey ?? agentConfig.apiKey,
          baseUrl: req.baseUrl ?? agentConfig.baseUrl,
          provider: req.provider as never ?? agentConfig.provider,
        })
      : createProviderFromEnv()

    // 权限管理：permissionMode 优先；autoMode 兼容旧字段；否则读全局配置
    const permMode = req.permissionMode ?? (req.autoMode ? 'auto' : agentConfig.permissionMode)
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
        title: resumeMeta?.title,
        permissionMode: permMode as 'ask' | 'auto' | 'plan',
      },
      engine: null as unknown as QueryEngine, // 下方赋值
      provider,
      permissions: null as unknown as PermissionManager, // 下方赋值
      subscribers: new Set(),
      idleTimer: null,
      pendingPermissions: new Map(),
    }

    const permissions = new PermissionManager(
      permMode,
      async (permReq) => {
        // auto 模式：直接允许（PermissionManager 内部已处理，此回调不会被调用）
        // ask 模式：通过 WebSocket 广播权限询问，等待客户端回复
        const key = `${permReq.toolName}::${permReq.description}`

        // 广播权限询问给所有订阅者
        this.broadcast(session, {
          type: 'permission_request',
          toolName: permReq.toolName,
          description: permReq.description,
          isReadonly: permReq.isReadonly,
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

    // 加载 MCP 工具
    const mcpTools = agentConfig.mcpServers.length > 0
      ? await loadMcpTools(agentConfig.mcpServers)
      : []

    const tools = [
      ...ALL_TOOLS,
      createAgentTool(req.apiKey ?? agentConfig.apiKey ?? '', actualModel),
      ...mcpTools,
    ]

    TeamManager.init(provider, tools)

    // 恢复已有会话或新建
    const initialMessages = req.resume ? loadSession(req.resume) ?? [] : []

    const systemPrompt = await buildSystemContext(getCoordinatorSystemPrompt(), sessionCwd)

    session.engine = new QueryEngine({
      provider,
      systemPrompt,
      tools,
      permissions,
      maxTokens: agentConfig.maxTokens,
      maxTurns: agentConfig.maxTurns,
      maxBudgetUsd: agentConfig.maxBudgetUsd,
      autoCompactThreshold: agentConfig.autoCompactThreshold,
      initialMessages,
    })
    session.permissions = permissions

    setGlobalCwd(sessionCwd)

    setTodoSessionId(sessionId)
    setTodosUpdatedCallback((sid, todos) => {
      const s = this.sessions.get(sid)
      if (s) {
        this.broadcast(s, { type: 'todos_updated', todos })
      }
    })

    // Gateway 模式：注册 ask_user 回调，将问题广播给前端
    setGatewayAskCallback((question, options) => {
      this.broadcast(session, { type: 'ask_user', question, options })
    })

    this.sessions.set(sessionId, session)
    this.resetIdleTimer(session)
    return session
  }

  getSession(id: string): ManagedSession | undefined {
    return this.sessions.get(id)
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

    await disconnectAllMcp()
    setTodoSessionId(null)
    setGatewayAskCallback(null)
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

    // 保存所有会话历史
    for (const [id, session] of this.sessions) {
      try {
        saveSession(id, session.engine.getHistory(), session.info.model, session.info.cwd)
      } catch { /* 忽略 */ }
    }

    await Promise.all(ids.map(id => this.destroySession(id)))
    log.info('优雅关闭完成')
  }

  subscribe(sessionId: string, ws: WebSocket): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.subscribers.add(ws)
    this.resetIdleTimer(session)
  }

  unsubscribe(sessionId: string, ws: WebSocket): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.subscribers.delete(ws)
    this.resetIdleTimer(session)
  }

  // 向会话的所有订阅者广播消息
  broadcast(session: ManagedSession, msg: object): void {
    const text = JSON.stringify(msg)
    for (const ws of session.subscribers) {
      try { ws.send(text) } catch { /* 忽略断开的连接 */ }
    }
  }

  // 执行用户消息，流式广播事件
  async runMessage(sessionId: string, content: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`会话不存在: ${sessionId}`)
    if (session.info.status === 'busy') throw new Error('会话正忙，请等待当前任务完成')

    session.info.status = 'busy'
    session.info.lastActiveAt = Date.now()
    this.resetIdleTimer(session)

    log.debug('处理消息', { sessionId, contentLength: content.length })

    // 根据消息内容动态注入任务相关扩展（skill 沉淀、爬虫、代码开发等规范）
    const coordinatorPrompt = getCoordinatorSystemPrompt(content)

    // plan 模式：动态注入规划模式系统提示，让 LLM 知道只做分析不执行写操作
    if (session.permissions.getMode() === 'plan') {
      const planModeAppendix = `

## 当前模式：Plan（规划模式）
你现在处于规划模式。在此模式下，所有写操作（文件写入、命令执行等）均被禁止。
你的任务是：
1. 使用只读工具（file_read、glob、grep 等）充分了解现状
2. 制定详细的执行计划，列出每一步要做什么、修改哪些文件、执行什么命令
3. 不要尝试调用任何写操作工具，调用了也会被系统拒绝
用户确认计划后，会切换到执行模式。`
      session.engine.setSystemPrompt(coordinatorPrompt + planModeAppendix)
    } else {
      // 非 plan 模式：使用动态注入了任务扩展的 coordinator prompt
      session.engine.setSystemPrompt(coordinatorPrompt)
    }

    const msgWithCtx = content

    try {
      for await (const ev of session.engine.send(msgWithCtx)) {
        // 将 QueryEngine 内部事件格式转换为前端协议格式
        const clientMsg = toClientMessage(ev)
        if (clientMsg) this.broadcast(session, clientMsg)

        // 每次工具调用结束后增量保存，减少崩溃时的数据丢失
        if (ev.type === 'tool_end' || ev.type === 'done') {
          saveSession(sessionId, session.engine.getHistory(), session.info.model, session.info.cwd)
        }
      }
    } finally {
      session.info.status = 'ready'
      session.info.lastActiveAt = Date.now()
    }

    // 后台钩子：记忆提炼 + Skill 自动沉淀（不阻塞响应）
    const memoryCondense = loadConfig().memoryCondense ?? false
    void autoExtractMemories(session.engine, sessionId, session.provider, memoryCondense)
    void autoDistillSkill(session.engine, session.provider)
  }

  // 处理客户端发来的控制消息
  handleClientMessage(sessionId: string, raw: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    let msg: Record<string, unknown>
    try { msg = JSON.parse(raw) } catch { return }

    switch (msg.type) {
      case 'message':
        void this.runMessage(sessionId, String(msg.content ?? '')).catch((err) => {
          log.error('runMessage 未捕获异常', { sessionId, error: String(err) })
          this.broadcast(session, { type: 'error', message: `执行失败: ${String(err)}` })
          session.info.status = 'ready'
        })
        break
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
        resolveAskUser(String(msg.answer ?? ''))
        break
      // 客户端回复权限询问
      case 'permission_reply': {
        const key = String(msg.key ?? '')
        const granted = msg.granted === true
        const resolve = session.pendingPermissions.get(key)
        if (resolve) {
          log.info('收到权限回复', { sessionId, key, granted })
          resolve(granted)
        }
        break
      }
      case 'set_cwd': {
        const cwd = String(msg.cwd ?? '')
        if (cwd) {
          setGlobalCwd(cwd)
          session.info.cwd = cwd
          this.broadcast(session, { type: 'cwd_changed', cwd })
        }
        break
      }
      case 'set_permission_mode': {
        const mode = msg.mode as string
        if (mode === 'ask' || mode === 'auto' || mode === 'plan') {
          session.permissions.setMode(mode)
          session.info.permissionMode = mode
          this.broadcast(session, { type: 'permission_mode_changed', mode })
          log.info('权限模式已切换', { sessionId, mode })
        }
        break
      }
    }
  }

  private resetIdleTimer(session: ManagedSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer)
    if (this.config.idleTimeoutMs === 0) return

    session.idleTimer = setTimeout(() => {
      if (session.subscribers.size === 0) {
        log.info('会话空闲超时，自动销毁', { sessionId: session.info.id })
        void this.destroySession(session.info.id)
      }
    }, this.config.idleTimeoutMs)
  }
}

// ── QueryEngine StreamEvent → 前端 WebSocket 协议转换 ──────────────────────
// QueryEngine 使用内部字段名（id/name/line/costUsd），前端期望不同的字段名
import type { StreamEvent } from '../core/QueryEngine.js'

function toClientMessage(ev: StreamEvent): object | null {
  switch (ev.type) {
    case 'text_delta':
      return { type: 'text_delta', delta: ev.delta }

    case 'tool_start':
      return { type: 'tool_start', toolId: ev.id, toolName: ev.name, input: ev.input }

    case 'tool_log':
      return { type: 'tool_log', toolId: ev.id, log: ev.line }

    case 'tool_end': {
      // result.type: 'success' | 'error' → status; 'denied' 由 permission_denied 事件处理
      const status = ev.result.type === 'success' ? 'success' : 'error'
      const result = ev.result.type === 'success' ? ev.result.output : ev.result.message
      return { type: 'tool_end', toolId: ev.id, toolName: ev.name, status, result }
    }

    case 'permission_denied':
      // 权限拒绝：以 tool_end denied 状态通知前端
      return { type: 'tool_end', toolId: ev.id, toolName: ev.toolName, status: 'denied' }

    case 'usage':
      return {
        type: 'usage',
        inputTokens: ev.inputTokens,
        outputTokens: ev.outputTokens,
        cost: ev.costUsd,
        model: '',
      }

    case 'budget_exceeded':
      return { type: 'budget_exceeded', message: `已超出预算上限（$${ev.limitUsd}），当前花费 $${ev.costUsd.toFixed(4)}` }

    case 'done':
      return { type: 'done' }

    case 'error':
      return { type: 'error', message: ev.message }

    case 'interrupted':
      return { type: 'error', message: ev.message }

    // 以下事件不需要推送给前端
    case 'turn_limit':
    case 'compact_start':
    case 'compact_done':
      return null

    case 'continuation_needed':
      return { type: 'continuation_needed' }

    default:
      return null
  }
}
