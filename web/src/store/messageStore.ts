import { create } from 'zustand'
import type {
  ServerMessage,
  DisplayMessage,
  ToolCardState,
  PermissionRequest,
  CostInfo,
} from '../lib/types.js'
import { getSessionMessages, getHistorySegments } from '../lib/gateway.js'

// ─── pendingAskUser 存储格式 ───────────────────────────────────────────────

export interface AskUserState {
  question: string
  options?: string[]
}

// ─── Store 类型定义 ────────────────────────────────────────────────────────

interface MessageState {
  /** 按 sessionId 分组的消息列表 */
  messages: Map<string, DisplayMessage[]>
  /** 流式输出缓冲，按 sessionId */
  streamingText: Map<string, string>
  /** 工具卡片状态，按 sessionId → toolId */
  toolCards: Map<string, Map<string, ToolCardState>>
  /** 等待用户回答的问题，按 sessionId */
  pendingAskUser: Map<string, AskUserState>
  /** 等待用户确认的权限请求，按 sessionId */
  pendingPermission: Map<string, PermissionRequest>
  /** 费用信息，按 sessionId */
  costInfo: Map<string, CostInfo>
  /** plan 模式下 LLM 表达了继续执行意图，等待用户确认的会话集合 */
  pendingContinuation: Set<string>

  /**
   * 处理来自 WebSocket 的服务端消息，分发到对应状态。
   */
  handleServerMessage: (sessionId: string, msg: ServerMessage) => void

  /**
   * 追加一条用户消息到指定会话。
   */
  appendUserMessage: (sessionId: string, content: string) => void

  /**
   * 清空指定会话的所有状态。
   */
  clearSession: (sessionId: string) => void

  /**
   * 切换指定工具卡片的展开/折叠状态。
   */
  toggleToolCard: (sessionId: string, toolId: string) => void

  /**
   * 切换指定归档分隔线的展开/折叠状态。
   */
  toggleCompact: (sessionId: string, messageId: string) => void

  /**
   * 清空指定会话的权限请求。
   */
  clearPermission: (sessionId: string) => void

  /**
   * 清除指定会话的 continuation 待确认状态。
   */
  clearContinuation: (sessionId: string) => void

  /**
   * 从后端拉取指定会话的历史消息，填充到 messages 中。
   * 用于 resume 历史 session 后恢复消息列表。
   */
  loadHistoryMessages: (sessionId: string) => Promise<void>
}

// ─── 辅助函数 ──────────────────────────────────────────────────────────────

/** 生成唯一消息 ID */
function genId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/** 获取或初始化某个 sessionId 的消息列表 */
function getMessages(
  messages: Map<string, DisplayMessage[]>,
  sessionId: string,
): DisplayMessage[] {
  return messages.get(sessionId) ?? []
}

/** 获取或初始化某个 sessionId 的工具卡片 Map */
function getToolCards(
  toolCards: Map<string, Map<string, ToolCardState>>,
  sessionId: string,
): Map<string, ToolCardState> {
  return toolCards.get(sessionId) ?? new Map()
}

// ─── Store 实现 ────────────────────────────────────────────────────────────

export const useMessageStore = create<MessageState>((set, get) => ({
  messages: new Map(),
  streamingText: new Map(),
  toolCards: new Map(),
  pendingAskUser: new Map(),
  pendingPermission: new Map(),
  costInfo: new Map(),
  pendingContinuation: new Set(),

  handleServerMessage(sessionId: string, msg: ServerMessage) {
    const state = get()

    switch (msg.type) {
      // ── 流式文本追加 ──────────────────────────────────────────────────
      case 'text_delta': {
        const prev = state.streamingText.get(sessionId) ?? ''
        const newStreamingText = new Map(state.streamingText)
        newStreamingText.set(sessionId, prev + msg.delta)
        set({ streamingText: newStreamingText })
        break
      }

      // ── 工具开始：创建 ToolCard + 追加 tool 类型消息 ─────────────────
      case 'tool_start': {
        // 创建新 ToolCard
        const newCard: ToolCardState = {
          toolId: msg.toolId,
          toolName: msg.toolName,
          input: msg.input,
          status: 'pending',
          logs: [],
          isExpanded: false,
        }

        const sessionCards = new Map(getToolCards(state.toolCards, sessionId))
        sessionCards.set(msg.toolId, newCard)

        const newToolCards = new Map(state.toolCards)
        newToolCards.set(sessionId, sessionCards)

        // 追加 tool 类型消息到消息列表
        const toolMsg: DisplayMessage = {
          id: genId(),
          type: 'tool',
          toolId: msg.toolId,
          toolName: msg.toolName,
          timestamp: Date.now(),
        }
        const newMessages = new Map(state.messages)
        newMessages.set(sessionId, [...getMessages(state.messages, sessionId), toolMsg])

        set({ toolCards: newToolCards, messages: newMessages })
        break
      }

      // ── 工具日志：追加到对应 ToolCard 的 logs ────────────────────────
      case 'tool_log': {
        const sessionCards = getToolCards(state.toolCards, sessionId)
        const card = sessionCards.get(msg.toolId)
        if (!card) break

        const updatedCard: ToolCardState = {
          ...card,
          logs: [...card.logs, msg.log],
        }

        const newSessionCards = new Map(sessionCards)
        newSessionCards.set(msg.toolId, updatedCard)

        const newToolCards = new Map(state.toolCards)
        newToolCards.set(sessionId, newSessionCards)

        set({ toolCards: newToolCards })
        break
      }

      // ── 工具结束：更新 ToolCard 状态和结果 ───────────────────────────
      case 'tool_end': {
        const sessionCards = getToolCards(state.toolCards, sessionId)
        const card = sessionCards.get(msg.toolId)
        if (!card) break

        const updatedCard: ToolCardState = {
          ...card,
          status: msg.status,
          result: msg.result,
        }

        const newSessionCards = new Map(sessionCards)
        newSessionCards.set(msg.toolId, updatedCard)

        const newToolCards = new Map(state.toolCards)
        newToolCards.set(sessionId, newSessionCards)

        set({ toolCards: newToolCards })
        break
      }

      // ── 完成：固化流式文本为 assistant 消息，清空缓冲和 pendingAskUser ─
      case 'done': {
        const text = state.streamingText.get(sessionId) ?? ''

        const newStreamingText = new Map(state.streamingText)
        newStreamingText.delete(sessionId)

        const newPendingAskUser = new Map(state.pendingAskUser)
        newPendingAskUser.delete(sessionId)

        // done 时清除 continuation 待确认状态
        const newPendingContinuation = new Set(state.pendingContinuation)
        newPendingContinuation.delete(sessionId)

        // 只有有内容时才追加消息
        if (text.trim().length > 0) {
          const assistantMsg: DisplayMessage = {
            id: genId(),
            type: 'assistant',
            content: text,
            timestamp: Date.now(),
            usage: state.costInfo.get(sessionId),
          }
          const newMessages = new Map(state.messages)
          newMessages.set(sessionId, [...getMessages(state.messages, sessionId), assistantMsg])
          set({ streamingText: newStreamingText, pendingAskUser: newPendingAskUser, pendingContinuation: newPendingContinuation, messages: newMessages })
        } else {
          set({ streamingText: newStreamingText, pendingAskUser: newPendingAskUser, pendingContinuation: newPendingContinuation })
        }
        break
      }

      // ── 用量：累加 token 和费用，更新模型 ────────────────────────────
      case 'usage': {
        const prev = state.costInfo.get(sessionId)
        const updated: CostInfo = {
          inputTokens: (prev?.inputTokens ?? 0) + msg.inputTokens,
          outputTokens: (prev?.outputTokens ?? 0) + msg.outputTokens,
          cost: (prev?.cost ?? 0) + msg.cost,
          model: msg.model,
        }
        const newCostInfo = new Map(state.costInfo)
        newCostInfo.set(sessionId, updated)
        set({ costInfo: newCostInfo })
        break
      }

      // ── 权限请求：设置 pendingPermission ─────────────────────────────
      case 'permission_request': {
        const permReq: PermissionRequest = {
          key: msg.key,
          toolName: msg.toolName,
          description: msg.description,
          readonly: msg.readonly,
          requestedAt: Date.now(),
        }
        const newPendingPermission = new Map(state.pendingPermission)
        newPendingPermission.set(sessionId, permReq)
        set({ pendingPermission: newPendingPermission })
        break
      }

      // ── 询问用户：设置 pendingAskUser ─────────────────────────────────
      case 'ask_user': {
        const askState: AskUserState = {
          question: msg.question,
          options: msg.options,
        }
        const newPendingAskUser = new Map(state.pendingAskUser)
        newPendingAskUser.set(sessionId, askState)
        set({ pendingAskUser: newPendingAskUser })
        break
      }

      // ── todos_updated：不处理（由 todoStore 处理） ────────────────────
      case 'todos_updated': {
        // 由 sessionStore 转发给 todoStore 处理，此处忽略
        break
      }

      // ── cwd_changed：不处理（由 fileTreeStore 处理） ──────────────────
      case 'cwd_changed': {
        // 由 sessionStore 转发给 fileTreeStore 处理，此处忽略
        break
      }

      // ── 错误：追加 error 类型消息 ─────────────────────────────────────
      case 'error': {
        const errorMsg: DisplayMessage = {
          id: genId(),
          type: 'error',
          content: msg.message,
          timestamp: Date.now(),
        }
        const newMessages = new Map(state.messages)
        newMessages.set(sessionId, [...getMessages(state.messages, sessionId), errorMsg])
        set({ messages: newMessages })
        break
      }

      // ── 预算超出：追加 error 类型消息（含 budget_exceeded 提示） ──────
      case 'budget_exceeded': {
        const budgetMsg: DisplayMessage = {
          id: genId(),
          type: 'error',
          content: `[budget_exceeded] ${msg.message}`,
          timestamp: Date.now(),
        }
        const newMessages = new Map(state.messages)
        newMessages.set(sessionId, [...getMessages(state.messages, sessionId), budgetMsg])
        set({ messages: newMessages })
        break
      }

      // ── ready：不处理（由 sessionStore 处理） ─────────────────────────
      case 'ready': {
        // 由 sessionStore 处理会话状态更新，此处忽略
        break
      }

      // ── compact_done：插入归档分隔线消息 ─────────────────────────────
      case 'compact_done': {
        const compactMsg: DisplayMessage = {
          id: genId(),
          type: 'compact',
          archivedAt: new Date().toISOString(),
          messageCount: 0, // 实时压缩时消息数未知，显示为 0
          summary: msg.summary,
          expanded: false,
          timestamp: Date.now(),
        }
        const newMessages = new Map(state.messages)
        newMessages.set(sessionId, [...getMessages(state.messages, sessionId), compactMsg])
        set({ messages: newMessages })
        break
      }

      // ── continuation_needed：LLM 有继续执行意图，等待用户确认 ─────────
      case 'continuation_needed': {
        const newPendingContinuation = new Set(state.pendingContinuation)
        newPendingContinuation.add(sessionId)
        set({ pendingContinuation: newPendingContinuation })
        break
      }
      default: {
        // 未知消息类型，忽略
        break
      }
    }
  },

  appendUserMessage(sessionId: string, content: string) {
    const state = get()
    const userMsg: DisplayMessage = {
      id: genId(),
      type: 'user',
      content,
      timestamp: Date.now(),
    }
    const newMessages = new Map(state.messages)
    newMessages.set(sessionId, [...getMessages(state.messages, sessionId), userMsg])
    set({ messages: newMessages })
  },

  clearSession(sessionId: string) {
    const state = get()

    const newMessages = new Map(state.messages)
    newMessages.delete(sessionId)

    const newStreamingText = new Map(state.streamingText)
    newStreamingText.delete(sessionId)

    const newToolCards = new Map(state.toolCards)
    newToolCards.delete(sessionId)

    const newPendingAskUser = new Map(state.pendingAskUser)
    newPendingAskUser.delete(sessionId)

    const newPendingPermission = new Map(state.pendingPermission)
    newPendingPermission.delete(sessionId)

    const newCostInfo = new Map(state.costInfo)
    newCostInfo.delete(sessionId)

    const newPendingContinuation = new Set(state.pendingContinuation)
    newPendingContinuation.delete(sessionId)

    set({
      messages: newMessages,
      streamingText: newStreamingText,
      toolCards: newToolCards,
      pendingAskUser: newPendingAskUser,
      pendingPermission: newPendingPermission,
      costInfo: newCostInfo,
      pendingContinuation: newPendingContinuation,
    })
  },

  toggleToolCard(sessionId: string, toolId: string) {
    const state = get()
    const sessionCards = getToolCards(state.toolCards, sessionId)
    const card = sessionCards.get(toolId)
    if (!card) return

    const updatedCard: ToolCardState = {
      ...card,
      isExpanded: !card.isExpanded,
    }

    const newSessionCards = new Map(sessionCards)
    newSessionCards.set(toolId, updatedCard)

    const newToolCards = new Map(state.toolCards)
    newToolCards.set(sessionId, newSessionCards)

    set({ toolCards: newToolCards })
  },

  toggleCompact(sessionId: string, messageId: string) {
    const state = get()
    const msgs = getMessages(state.messages, sessionId)
    const newMsgs = msgs.map(m =>
      m.id === messageId && m.type === 'compact'
        ? { ...m, expanded: !m.expanded }
        : m
    )
    const newMessages = new Map(state.messages)
    newMessages.set(sessionId, newMsgs)
    set({ messages: newMessages })
  },

  clearPermission(sessionId: string) {
    const state = get()
    const newPendingPermission = new Map(state.pendingPermission)
    newPendingPermission.delete(sessionId)
    set({ pendingPermission: newPendingPermission })
  },

  clearContinuation(sessionId: string) {
    const state = get()
    const newPendingContinuation = new Set(state.pendingContinuation)
    newPendingContinuation.delete(sessionId)
    set({ pendingContinuation: newPendingContinuation })
  },

  async loadHistoryMessages(sessionId: string) {
    try {
      const [messages, archives] = await Promise.all([
        getSessionMessages(sessionId),
        getHistorySegments(sessionId),
      ])
      if (messages.length === 0 && archives.length === 0) return
      const state = get()
      // 只在该 session 还没有消息时才填充（避免覆盖实时消息）
      if (state.messages.has(sessionId) && (state.messages.get(sessionId)?.length ?? 0) > 0) return

      // 从 tool 类型消息中提取历史工具卡片状态
      const historyCards = new Map<string, ToolCardState>()
      for (const msg of messages) {
        if (msg.type === 'tool') {
          historyCards.set(msg.toolId, {
            toolId: msg.toolId,
            toolName: msg.toolName,
            input: msg.toolInput ?? {},
            status: msg.toolStatus ?? 'success',
            logs: [],
            result: msg.toolResult,
            isExpanded: false,
          })
        }
      }

      // 在消息列表头部插入归档分隔线（按时间升序，最早的在最前）
      const archiveMsgs: DisplayMessage[] = archives.map((arc) => ({
        id: `compact-${arc.filename}`,
        type: 'compact' as const,
        archivedAt: arc.archivedAt,
        messageCount: arc.messageCount,
        summary: arc.summary,
        expanded: false,
        timestamp: new Date(arc.archivedAt).getTime(),
      }))

      const allMessages: DisplayMessage[] = [...archiveMsgs, ...messages]

      const newMessages = new Map(state.messages)
      newMessages.set(sessionId, allMessages)

      if (historyCards.size > 0) {
        const newToolCards = new Map(state.toolCards)
        newToolCards.set(sessionId, historyCards)
        set({ messages: newMessages, toolCards: newToolCards })
      } else {
        set({ messages: newMessages })
      }
    } catch (err) {
      console.error('[messageStore] 加载历史消息失败:', err)
    }
  },
}))
