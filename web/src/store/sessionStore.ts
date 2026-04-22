import { create } from 'zustand'
import {
  listSessions,
  createSession as apiCreateSession,
  deleteSession as apiDeleteSession,
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

// ─── Store 类型定义 ────────────────────────────────────────────────────────

interface SessionState {
  /** 所有会话列表 */
  sessions: SessionInfo[]
  /** 当前活跃会话 ID */
  activeSessionId: string | null
  /** 每个会话对应的 WebSocket 客户端 */
  wsClients: Map<string, WsClient>
  /** 已超过最大重连次数的会话 ID 集合 */
  wsMaxRetriesExceeded: Set<string>

  /**
   * 从 Gateway 拉取会话列表，更新 sessions。
   */
  fetchSessions: () => Promise<void>

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
   */
  sendPermissionReply: (sessionId: string, key: string, granted: boolean) => void

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
  setPermissionMode: (sessionId: string, mode: 'ask' | 'auto' | 'plan') => void
}

// ─── Store 实现 ────────────────────────────────────────────────────────────

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  wsClients: new Map(),
  wsMaxRetriesExceeded: new Set(),

  async fetchSessions() {
    const sessions = await listSessions()
    set({ sessions })
  },

  async createSession(req: CreateSessionRequest) {
    // 1. 调用 REST API 创建会话
    const session = await apiCreateSession(req)

    // 2. 从服务端重新拉取列表（避免手动 push 导致重复）
    const sessions = await listSessions()
    set({ sessions })

    // 3. 建立 WebSocket 连接
    _connectWs(session.id, set, get)

    // 4. 设为活跃会话
    set({ activeSessionId: session.id })
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
      // 顺序执行避免竞态：WS 回放的消息会触发 loadHistoryMessages 的去重保护
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

    // 活跃会话（ready/busy）：先加载历史消息，再建立 WS 连接
    // 顺序执行避免竞态：WS 回放的 tool_start 会向 messages 追加数据，
    // 若 WS 先建立，loadHistoryMessages 的去重保护会误判为已有消息而跳过加载
    import('./messageStore.js').then(({ useMessageStore }) => {
      return useMessageStore.getState().loadHistoryMessages(id)
    }).then(() => {
      // 用户可能已切换到其他会话，但 WS 连接仍需建立（后台保持连接，切回时即用）
      if (!get().wsClients.has(id)) {
        _connectWs(id, set, get)
      }
    }).catch((err) => {
      console.error('[sessionStore] setActive loadHistoryMessages 失败:', err)
      if (!get().wsClients.has(id)) {
        _connectWs(id, set, get)
      }
    })
  },

  sendMessage(sessionId: string, content: string, attachments?: import('../lib/types.js').MessageAttachment[]) {
    const client = get().wsClients.get(sessionId)
    if (!client) {
      console.error('[sessionStore] sendMessage: 找不到 WsClient', { sessionId })
      return
    }
    console.debug('[sessionStore] sendMessage', { sessionId, contentLength: content.length, attachmentCount: attachments?.length ?? 0 })
    client.send({ type: 'message', content, ...(attachments && attachments.length > 0 ? { attachments } : {}) })
  },

  sendAbort(sessionId: string) {
    const client = get().wsClients.get(sessionId)
    client?.send({ type: 'abort' })
  },

  sendPermissionReply(sessionId: string, key: string, granted: boolean) {
    const client = get().wsClients.get(sessionId)
    client?.send({ type: 'permission_reply', key, granted })
  },

  sendUserReply(sessionId: string, answer: string) {
    const client = get().wsClients.get(sessionId)
    client?.send({ type: 'user_reply', answer })
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

  setPermissionMode(sessionId: string, mode: 'ask' | 'auto' | 'plan') {
    const client = get().wsClients.get(sessionId)
    client?.send({ type: 'set_permission_mode', mode })
    // 乐观更新本地状态
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, permissionMode: mode } : s,
      ),
    }))
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

  // 4. 根据消息类型更新会话 status
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

  if (msg.type === 'tool_start') {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, status: 'busy' as const } : s,
      ),
    }))
  }
}
