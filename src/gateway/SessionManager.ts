// 会话管理器 —— 管理 agent 进程的生命周期
import { randomUUID } from 'crypto'
import { createProvider } from '../core/providers/index.js'
import { QueryEngine } from '../core/QueryEngine.js'
import { PermissionManager } from '../core/PermissionManager.js'
import { ALL_TOOLS } from '../tools/index.js'
import { createAgentTool } from '../tools/AgentTool.js'
import { loadMcpTools, disconnectAllMcp } from '../tools/McpTool.js'
import { TeamManager } from '../core/coordinator/TeamManager.js'
import { buildSystemContext, getDynamicContext, getDefaultAgentCwd } from '../core/ContextBuilder.js'
import { loadSession, saveSession } from '../core/SessionStore.js'
import { loadConfig } from '../core/Config.js'
import { setGlobalCwd, getGlobalCwd } from '../tools/BashTool.js'
import { resolveAskUser } from '../tools/AskUserTool.js'
import { logger } from '../core/logger.js'
import { auditLog } from '../core/audit.js'
import type { CreateSessionRequest, SessionInfo } from './types.js'
import type WebSocket from 'ws'

const log = logger.child({ component: 'gateway' })

const BASE_SYSTEM_PROMPT = `你是一个智能编程助手，可以帮助用户完成代码编写、文件操作、命令执行等任务。

## 工作原则
1. 优先用只读工具（file_read, glob, grep）了解情况，再执行写操作
2. 执行破坏性操作前先说明意图
3. 遇到错误时分析原因并尝试修复
4. 使用 todo_write 追踪复杂任务的进度
5. 对于需要多步骤的复杂任务，考虑使用 agent 工具派生子智能体
6. 需要用户提供信息时，使用 ask_user 工具

## 回复规范
- 使用中文回复
- 代码块使用 markdown 格式
- 操作完成后给出简洁的结果摘要`

export interface ManagedSession {
  info: SessionInfo
  engine: QueryEngine
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
    const sessionId = randomUUID()

    log.info('创建会话', { sessionId, model, autoMode: req.autoMode })
    auditLog({ sessionId, action: 'session_create', resource: sessionId, result: 'allowed', details: { model } })

    // 创建 LLM 提供商
    const provider = createProvider({
      model,
      apiKey: req.apiKey ?? agentConfig.apiKey,
      baseUrl: req.baseUrl ?? agentConfig.baseUrl,
      provider: req.provider as never ?? agentConfig.provider,
    })

    // 权限管理：auto 模式直接允许；非 auto 模式通过 WebSocket 协议询问客户端
    const permMode = req.autoMode ? 'auto' : agentConfig.permissionMode
    const session: ManagedSession = {
      info: {
        id: sessionId,
        status: 'ready',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        model,
        cwd: req.cwd ?? getDefaultAgentCwd(),
      },
      engine: null as unknown as QueryEngine, // 下方赋值
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
      createAgentTool(req.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '', model),
      ...mcpTools,
    ]

    TeamManager.init(provider, tools)

    // 恢复已有会话或新建
    const initialMessages = req.resume ? loadSession(req.resume) ?? [] : []

    const systemPrompt = await buildSystemContext(BASE_SYSTEM_PROMPT, req.cwd)

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

    if (req.cwd) setGlobalCwd(req.cwd)
    else setGlobalCwd(getDefaultAgentCwd())

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
        saveSession(id, session.engine.getHistory(), session.info.model)
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

    const msgWithCtx = content + getDynamicContext(session.info.cwd)

    try {
      for await (const ev of session.engine.send(msgWithCtx)) {
        this.broadcast(session, ev)
        if (ev.type === 'done') {
          saveSession(sessionId, session.engine.getHistory(), session.info.model)
        }
      }
    } finally {
      session.info.status = 'ready'
      session.info.lastActiveAt = Date.now()
    }
  }

  // 处理客户端发来的控制消息
  handleClientMessage(sessionId: string, raw: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    let msg: Record<string, unknown>
    try { msg = JSON.parse(raw) } catch { return }

    switch (msg.type) {
      case 'message':
        void this.runMessage(sessionId, String(msg.content ?? ''))
        break
      // 恢复中断的任务：直接注入"继续执行"指令，history 里已有中断上下文
      case 'resume':
        void this.runMessage(sessionId, String(msg.content ?? '请继续执行之前未完成的任务，从中断处接着做。'))
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
