import { create } from 'zustand'
import {
  listSessions,
  createSession as apiCreateSession,
  deleteSession as apiDeleteSession,
  getZhileSessionId,
  setZhileSessionId,
} from '../lib/gateway.js'
import { WsClient } from '../lib/wsClient.js'
import { useConnectionStore } from './connectionStore.js'
import type { SessionInfo, CreateSessionRequest, ServerMessage } from '../lib/types.js'

// ─── 辅助函数 ──────────────────────────────────────────────────────────────

/**
 * 将 HTTP(S) URL 转换为 WS(S) URL。
 * 例：http://localhost:3282 → ws://localhost:3282
 *     https://example.com  → wss://example.com
 */
function httpToWs(url: string): string {
  return url.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://')
}

// 乐观 busy 超时：发送消息后若后端 30s 内无任何响应，自动回退到 ready
const OPTIMISTIC_BUSY_TIMEOUT_MS = 2 * 60_000
const _optimisticTimers = new Map<string, ReturnType<typeof setTimeout>>()

function _startOptimisticTimer(sessionId: string, set: SetFn): void {
  _clearOptimisticTimer(sessionId)
  const timer = setTimeout(() => {
    _optimisticTimers.delete(sessionId)
    console.warn('[sessionStore] 乐观 busy 超时，回退到 ready', { sessionId })
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId && s.status === 'busy' ? { ...s, status: 'ready' as const } : s,
      ),
    }))
  }, OPTIMISTIC_BUSY_TIMEOUT_MS)
  _optimisticTimers.set(sessionId, timer)
}

function _clearOptimisticTimer(sessionId: string): void {
  const t = _optimisticTimers.get(sessionId)
  if (t !== undefined) {
    clearTimeout(t)
    _optimisticTimers.delete(sessionId)
  }
}

// ─── Store 类型定义 ────────────────────────────────────────────────────────

interface SessionState {
  /** 所有会话列表 */
  sessions: SessionInfo[]
  /** 当前活跃会话 ID */
  activeSessionId: string | null
  /** 知了专属会话 ID */
  zhileSessionId: string | null
  /** 每个会话对应的 WebSocket 客户端 */
  wsClients: Map<string, WsClient>
  /** 已超过最大重连次数的会话 ID 集合 */
  wsMaxRetriesExceeded: Set<string>
  /** 下次创建会话时使用的模型（null = Auto，走后端 fallback 链） */
  pendingModel: string | null

  /**
   * 从 Gateway 拉取会话列表，更新 sessions。
   */
  fetchSessions: () => Promise<void>

  /**
   * 初始化知了专属会话：从后端读取 ID，若不存在或已删除则自动创建。
   */
  initZhileSession: () => Promise<void>

  /**
   * 创建新会话：调用 REST API，成功后建立 WS 连接，并设为活跃会话。
   */
  createSession: (req: CreateSessionRequest) => Promise<void>

  /**
   * 删除会话：关闭对应 WS 连接，调用 REST API，从列表移除。
   * 若删除的是活跃会话，则清空 activeSessionId。
   */
  deleteSession: (id: string) => Promise<void>

  /**
   * 设置活跃会话 ID。
   */
  setActive: (id: string) => void

  /**
   * 设置下次创建会话时使用的模型（null = Auto）。
   */
  setPendingModel: (model: string | null) => void

  /**
   * 通过对应会话的 WS 发送用户消息。
   * attachments 为可选的图片/PDF 附件列表（base64 编码）。
   */
  sendMessage: (sessionId: string, content: string, attachments?: import('../lib/types.js').MessageAttachment[]) => void

  /**
   * 通过对应会话的 WS 发送中止指令。
   */
  sendAbort: (sessionId: string) => void

  /**
   * 通过对应会话的 WS 发送权限回复。
   * options.permanent=true 时持久化规则；options.session=true 时会话内批准（含内容级）
   */
  sendPermissionReply: (sessionId: string, key: string, granted: boolean, options?: { permanent?: boolean; session?: boolean; ruleContent?: string }) => void

  /**
   * 通过对应会话的 WS 发送用户回答（ask_user 场景）。
   */
  sendUserReply: (sessionId: string, answer: string) => void

  /**
   * 恢复历史会话：以 resume 模式创建新 session，保留对话历史。
   */
  resumeSession: (id: string) => Promise<void>

  /**
   * 清除指定会话的最大重连超限标记。
   */
  clearWsMaxRetries: (sessionId: string) => void

  /**
   * 手动触发指定会话的 WS 重连（重置重连计数）。
   */
  manualReconnect: (sessionId: string) => void

  /**
   * 切换当前会话的权限模式，通过 WS 发送给后端。
   */
  setPermissionMode: (sessionId: string, mode: 'ask' | 'craft' | 'plan') => void

  /**
   * 清除指定会话的所有历史消息（通过 WS 通知后端同步清除）。
   */
  sendClearHistory: (sessionId: string) => void
}

// ─── Store 实现 ────────────────────────────────────────────────────────────

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  zhileSessionId: null,
  wsClients: new Map(),
  wsMaxRetriesExceeded: new Set(),
  pendingModel: null,

  async fetchSessions() {
    const sessions = await listSessions()
    set({ sessions })
  },

  async initZhileSession() {
    // 1. 从后端读取持久化的知了会话 ID
    const savedId = await getZhileSessionId()

    // 2. 检查该会话是否还在列表里（可能已被删除）
    const { sessions } = get()
    const exists = savedId && sessions.some(s => s.id === savedId)

    if (exists) {
      set({ zhileSessionId: savedId })
      const zhileSession = sessions.find(s => s.id === savedId)
      if (zhileSession?.status === 'stopped') {
        // 历史会话：先 resume 再建立 WS（resume 内部会建立 WS）
        await get().resumeSession(savedId)
      } else if (!get().wsClients.has(savedId)) {
        // 活跃会话：立即建立 WS 连接，确保 cron 触发时能实时收到消息
        _connectWs(savedId, set, get)
      }
      return
    }

    // 3. 不存在则创建新的知了专属会话
    try {
      const session = await apiCreateSession({ title: '知了' } as Parameters<typeof apiCreateSession>[0])
      await setZhileSessionId(session.id)
      // 刷新会话列表
      const updated = await listSessions()
      set({ sessions: updated, zhileSessionId: session.id })
      // 立即建立 WS 连接
      _connectWs(session.id, set, get)
    } catch (err) {
      console.error('[sessionStore] initZhileSession 创建失败:', err)
    }
  },

  async createSession(req: CreateSessionRequest) {
    // 若调用方没有指定 model，自动带入用户选择的 pendingModel
    const { pendingModel } = get()
    const mergedReq: CreateSessionRequest = {
      ...req,
      model: req.model ?? (pendingModel ?? undefined),
    }

    // 1. 调用 REST API 创建会话
    const session = await apiCreateSession(mergedReq)

    // 2. 从服务端重新拉取列表（避免手动 push 导致重复）
    const sessions = await listSessions()
    set({ sessions })

    // 3. 建立 WebSocket 连接
    _connectWs(session.id, set, get)

    // 4. 设为活跃会话
    set({ activeSessionId: session.id })
  },

  setPendingModel(model: string | null) {
    set({ pendingModel: model })
  },

  async resumeSession(id: string) {
    try {
      // 后端用原 id 重新激活会话（createSession resume 模式复用原 id）
      const session = await apiCreateSession({ resume: id })

      // 更新列表中该会话的状态（stopped → ready），不新增条目
      set((state) => ({
        sessions: state.sessions.map(s =>
          s.id === session.id ? { ...s, status: 'ready' as const, model: session.model } : s
        ),
      }))

      // 建立 WS 连接
      _connectWs(session.id, set, get)

      // 只在仍是活跃会话时才设置 activeSessionId（避免快速切换后被强制跳回）
      if (get().activeSessionId === id) {
        set({ activeSessionId: session.id })
      }
    } catch (err) {
      console.error('[sessionStore] resumeSession 失败', { id, error: String(err) })
      // 会话不存在或恢复失败时，从列表中移除该条目
      set((state) => ({
        sessions: state.sessions.filter(s => s.id !== id),
        activeSessionId: state.activeSessionId === id ? null : state.activeSessionId,
      }))
    }
  },

  async deleteSession(id: string) {
    const { wsClients } = get()

    // 1. 关闭对应 WS 连接
    const client = wsClients.get(id)
    if (client) {
      client.close()
      // 创建新 Map，移除该条目
      const newClients = new Map(wsClients)
      newClients.delete(id)
      set({ wsClients: newClients })
    }

    // 2. 调用 REST API 删除会话
    await apiDeleteSession(id)

    // 3. 从列表移除，若是活跃会话则清空 activeSessionId
    set((state) => ({
      sessions: state.sessions.filter((s) => s.id !== id),
      activeSessionId: state.activeSessionId === id ? null : state.activeSessionId,
    }))

    // 若删除的是活跃会话，activeSessionId 已在上面的 set 中清空
  },

  setActive(id: string) {
    const session = get().sessions.find(s => s.id === id)

    // 立即设为活跃会话，无论是否需要 resume，界面立刻切换
    set({ activeSessionId: id })
    // 持久化到 localStorage，页面刷新后可恢复
    try { localStorage.setItem('hrids_active_session_id', id) } catch { /* 忽略 */ }

    if (session?.status === 'stopped') {
      // 历史会话：先加载历史消息，再后台 resume（resume 内部会建立 WS 连接）
      import('./messageStore.js').then(({ useMessageStore }) => {
        return useMessageStore.getState().loadHistoryMessages(id)
      }).then(() => {
        // 用户可能已切换到其他会话，只在仍是活跃会话时才 resume
        if (get().activeSessionId !== id) return
        void get().resumeSession(id)
      }).catch((err) => {
        console.error('[sessionStore] setActive loadHistoryMessages 失败:', err)
        if (get().activeSessionId !== id) return
        void get().resumeSession(id)
      })
      return
    }

    // 活跃会话（ready/busy）：加载历史消息。
    // busy 会话立即建立 WS 连接，确保能收到流式消息和发出 abort 指令。
    // ready 会话采用懒连接：用户发消息时再建立，消息进入 pendingQueue 等连接就绪后发送。
    if (session?.status === 'busy' && !get().wsClients.has(id)) {
      _connectWs(id, set, get)
    }
    import('./messageStore.js').then(({ useMessageStore }) => {
      return useMessageStore.getState().loadHistoryMessages(id)
    }).catch((err) => {
      console.error('[sessionStore] setActive loadHistoryMessages 失败:', err)
    })
  },

  sendMessage(sessionId: string, content: string, attachments?: import('../lib/types.js').MessageAttachment[]) {
    // 乐观更新：立即标记为 busy，不等后端推事件，消除发送到显示"运行中"的延迟
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, status: 'busy' as const } : s,
      ),
    }))
    // 启动超时保护：30s 内后端无响应则回退到 ready
    _startOptimisticTimer(sessionId, set)
    // 懒建立 WS 连接：没有 client 时自动创建，消息进入 pendingQueue 等连接就绪后发送
    const client = _ensureWs(sessionId, set, get)
    console.debug('[sessionStore] sendMessage', { sessionId, contentLength: content.length, attachmentCount: attachments?.length ?? 0 })
    client.send({ type: 'message', content, ...(attachments && attachments.length > 0 ? { attachments } : {}) })
  },

  sendAbort(sessionId: string) {
    // abort 需要确保连接存在才能发出去（切换回 busy 会话时可能没有 WS 连接）
    _ensureWs(sessionId, set, get).send({ type: 'abort' })
  },

  sendPermissionReply(sessionId: string, key: string, granted: boolean, options?: { permanent?: boolean; session?: boolean; ruleContent?: string }) {
    // 权限回复需要确保连接存在（WS 断线重连后可能需要重新发送）
    _ensureWs(sessionId, set, get).send({
      type: 'permission_reply',
      key,
      granted,
      ...(options?.permanent ? { permanent: true } : {}),
      ...(options?.session ? { session: true } : {}),
      ...(options?.ruleContent ? { ruleContent: options.ruleContent } : {}),
    })
  },

  sendUserReply(sessionId: string, answer: string) {
    _ensureWs(sessionId, set, get).send({ type: 'user_reply', answer })
  },

  clearWsMaxRetries(sessionId: string) {
    set((state) => {
      const next = new Set(state.wsMaxRetriesExceeded)
      next.delete(sessionId)
      return { wsMaxRetriesExceeded: next }
    })
  },

  manualReconnect(sessionId: string) {
    // 调用 WsClient 的手动重连方法，并清除超限标记
    get().wsClients.get(sessionId)?.reconnect()
    set((state) => {
      const next = new Set(state.wsMaxRetriesExceeded)
      next.delete(sessionId)
      return { wsMaxRetriesExceeded: next }
    })
  },

  setPermissionMode(sessionId: string, mode: 'ask' | 'craft' | 'plan') {
    const client = get().wsClients.get(sessionId)
    client?.send({ type: 'set_permission_mode', mode })
    // 乐观更新本地状态
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, permissionMode: mode } : s,
      ),
    }))
  },

  sendClearHistory(sessionId: string) {
    _ensureWs(sessionId, set, get).send({ type: 'clear_history' })
  },
}))

// ─── WS 连接建立（模块级辅助函数，避免 store 内部过于臃肿） ──────────────

type SetFn = (
  partial:
    | SessionState
    | Partial<SessionState>
    | ((state: SessionState) => SessionState | Partial<SessionState>),
  replace?: false,
) => void
type GetFn = () => SessionState

/**
 * 确保指定会话有 WsClient，没有则自动建立（懒连接）。
 * 返回 WsClient 实例，调用方可直接 .send()，消息会进入 pendingQueue 等连接就绪后发送。
 */
function _ensureWs(sessionId: string, set: SetFn, get: GetFn): WsClient {
  const existing = get().wsClients.get(sessionId)
  if (existing) return existing
  console.debug('[sessionStore] _ensureWs: 懒建立 WS 连接', { sessionId })
  _connectWs(sessionId, set, get)
  // _connectWs 同步写入 wsClients，此处一定能取到
  return get().wsClients.get(sessionId)!
}

/**
 * 为指定会话建立 WebSocket 连接，并注册消息处理回调。
 */
function _connectWs(sessionId: string, set: SetFn, get: GetFn): void {
  const { gatewayUrl, authToken } = useConnectionStore.getState()

  // 将 HTTP URL 转换为 WS URL，拼接会话流地址
  const wsBase = httpToWs(gatewayUrl.replace(/\/$/, ''))
  const wsUrl = `${wsBase}/sessions/${encodeURIComponent(sessionId)}/stream`
  console.log('[sessionStore] _connectWs 建立连接', { wsUrl })

  const client = new WsClient(wsUrl, authToken, (msg: ServerMessage) => {
    _handleWsMessage(sessionId, msg, set)
  }, undefined, () => {
    // 超过最大重连次数时，将 sessionId 加入超限集合
    set((state) => {
      const next = new Set(state.wsMaxRetriesExceeded)
      next.add(sessionId)
      return { wsMaxRetriesExceeded: next }
    })
  })

  // 将新客户端加入 Map（创建新 Map 实例，触发 Zustand 更新）
  const newClients = new Map(get().wsClients)
  newClients.set(sessionId, client)
  set({ wsClients: newClients })
}

/**
 * 处理 WebSocket 收到的服务端消息，分发到各 store。
 */
function _handleWsMessage(
  sessionId: string,
  msg: ServerMessage,
  set: SetFn,
): void {
  // 只对关键消息打 debug（text_delta 太频繁，跳过）
  if (msg.type !== 'text_delta' && msg.type !== 'tool_log') {
    console.debug('[sessionStore] _handleWsMessage', { sessionId, type: msg.type })
  }

  // 收到后端任何消息，说明连接正常、后端已响应，清除乐观 busy 超时计时器
  _clearOptimisticTimer(sessionId)

  // 1. 所有消息都转发给 messageStore（懒加载，避免循环依赖）
  import('./messageStore.js').then(({ useMessageStore }) => {
    useMessageStore.getState().handleServerMessage(sessionId, msg)
  }).catch((err) => {
    console.error('[sessionStore] messageStore 加载失败:', err)
  })

  // 2. todos_updated → todoStore
  if (msg.type === 'todos_updated') {
    const todos = msg.todos
    import('./todoStore.js').then(({ useTodoStore }) => {
      useTodoStore.getState().handleTodosUpdated(sessionId, todos)
    }).catch((err) => {
      console.error('[sessionStore] todoStore 加载失败:', err)
    })
  }

  // 3. cwd_changed → fileTreeStore
  if (msg.type === 'cwd_changed') {
    import('./fileTreeStore.js').then(({ useFileTreeStore }) => {
      useFileTreeStore.getState().refresh(sessionId)
    }).catch((err) => {
      console.error('[sessionStore] fileTreeStore 加载失败:', err)
    })
  }

  // 4. permission_mode_changed → 同步 session 状态
  if (msg.type === 'permission_mode_changed') {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, permissionMode: msg.mode } : s,
      ),
    }))
  }

  // 5. 根据消息类型更新会话 status
  if (msg.type === 'ready' || msg.type === 'done') {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, status: 'ready' as const } : s,
      ),
    }))
  }

  // error / budget_exceeded 也要重置为 ready（任务已终止）
  if (msg.type === 'error' || msg.type === 'budget_exceeded') {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, status: 'ready' as const } : s,
      ),
    }))
  }

  if (msg.type === 'tool_start' || msg.type === 'text_delta') {
    // text_delta 高频，已是 busy 时跳过，避免无效 re-render
    set((state) => {
      const current = state.sessions.find(s => s.id === sessionId)
      if (current?.status === 'busy') return state
      return {
        sessions: state.sessions.map((s) =>
          s.id === sessionId ? { ...s, status: 'busy' as const } : s,
        ),
      }
    })
  }
}
