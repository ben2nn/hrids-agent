import { create } from 'zustand'
import type {
  ServerMessage,
  DisplayMessage,
  ToolCardState,
  PermissionRequest,
  DecisionRequest,
  CostInfo,
} from '../lib/types.js'
import { getSessionMessages, getHistorySegments, getArchiveMessages } from '../lib/gateway.js'

// ─── 归档消息 ID 前缀生成 ──────────────────────────────────────────────────
function archivePrefix(messageId: string) {
  return `arc-msg-${messageId}-`
}

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
  /** 当前流式输出的 requestId，按 sessionId */
  currentRequestId: Map<string, string>
  /** 当前请求是否由定时任务触发，按 sessionId */
  currentIsCron: Map<string, boolean>
  /** 工具卡片状态，按 sessionId → toolId */
  toolCards: Map<string, Map<string, ToolCardState>>
  /** 等待用户回答的问题，按 sessionId */
  pendingAskUser: Map<string, AskUserState>
  /** 等待用户确认的权限请求，按 sessionId */
  pendingPermission: Map<string, PermissionRequest>
  /** 等待用户决策的请求，按 sessionId */
  pendingDecision: Map<string, DecisionRequest>
  /** 费用信息，按 sessionId */
  costInfo: Map<string, CostInfo>
  /** plan 模式下 LLM 表达了继续执行意图，等待用户确认的会话集合 */
  pendingContinuation: Set<string>
  /** 已加载过历史消息的会话集合（防止重复加载） */
  historyLoaded: Set<string>

  /**
   * 处理来自 WebSocket 的服务端消息，分发到对应状态。
   */
  handleServerMessage: (sessionId: string, msg: ServerMessage) => void

  /**
   * 追加一条用户消息到指定会话。
   * images 为可选的图片文件名列表（已上传到工作目录）。
   */
  appendUserMessage: (sessionId: string, content: string, images?: string[]) => void

  /**
   * 清空指定会话的所有状态。
   */
  clearSession: (sessionId: string) => void

  /**
   * 删除指定会话中的单条消息。
   */
  deleteMessage: (sessionId: string, messageId: string) => void

  /**
   * 切换指定工具卡片的展开/折叠状态。
   */
  toggleToolCard: (sessionId: string, toolId: string) => void

  /**
   * 切换指定归档分隔线的展开/折叠状态。
   * 展开时若尚未加载归档消息，则自动从后端拉取。
   */
  toggleCompact: (sessionId: string, messageId: string) => void

  /**
   * 按需加载指定归档段的实际历史消息，插入到分隔线之后。
   */
  loadArchiveMessages: (sessionId: string, messageId: string, filename: string) => Promise<void>

  /**
   * 清空指定会话的权限请求。
   */
  clearPermission: (sessionId: string) => void

  /**
   * 清空指定会话的决策请求。
   */
  clearDecision: (sessionId: string) => void

  /**
   * 清空指定会话的 ask_user 待回答状态。
   */
  clearAskUser: (sessionId: string) => void

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
  currentRequestId: new Map(),
  currentIsCron: new Map(),
  toolCards: new Map(),
  pendingAskUser: new Map(),
  pendingPermission: new Map(),
  pendingDecision: new Map(),
  costInfo: new Map(),
  pendingContinuation: new Set(),
  historyLoaded: new Set(),

  handleServerMessage(sessionId: string, msg: ServerMessage) {
    const state = get()

    switch (msg.type) {
      // ── request_start：新请求开始，记录 requestId ────────────────────
      case 'request_start': {
        const newCurrentRequestId = new Map(state.currentRequestId)
        newCurrentRequestId.set(sessionId, msg.requestId)
        const newCurrentIsCron = new Map(state.currentIsCron)
        newCurrentIsCron.set(sessionId, msg.trigger === 'cron')
        set({ currentRequestId: newCurrentRequestId, currentIsCron: newCurrentIsCron })
        break
      }

      // ── 流式文本追加 ──────────────────────────────────────────────────
      case 'text_delta': {
        const prev = state.streamingText.get(sessionId) ?? ''
        const newStreamingText = new Map(state.streamingText)
        newStreamingText.set(sessionId, prev + msg.delta)
        set({ streamingText: newStreamingText })
        break
      }

      // ── 工具开始：先固化当前流式文字，再创建 ToolCard + 追加 tool 消息 ──
      case 'tool_start': {
        // 去重：回放场景下同一 toolId 可能已存在
        const existingCards = getToolCards(state.toolCards, sessionId)
        if (existingCards.has(msg.toolId)) break

        // 创建新 ToolCard
        const newCard: ToolCardState = {
          toolId: msg.toolId,
          toolName: msg.toolName,
          input: msg.input,
          status: 'pending',
          logs: [],
          isExpanded: false,
        }

        const sessionCards = new Map(existingCards)
        sessionCards.set(msg.toolId, newCard)

        const newToolCards = new Map(state.toolCards)
        newToolCards.set(sessionId, sessionCards)

        // 有流式文字时，先固化为 assistant 消息，再追加工具消息
        // 这样消息列表就能保持"文字 → 工具"的真实交错顺序
        const pendingText = state.streamingText.get(sessionId) ?? ''
        const requestId = state.currentRequestId.get(sessionId) ?? msg.requestId
        const newStreamingText = new Map(state.streamingText)
        newStreamingText.delete(sessionId)

        const existingMsgs = getMessages(state.messages, sessionId)
        const msgsWithText: DisplayMessage[] = pendingText.trim().length > 0
          ? (() => {
              // 去重：避免回放时重复追加相同内容
              const lastMsg = existingMsgs[existingMsgs.length - 1]
              const isDuplicate = lastMsg?.type === 'assistant' && (lastMsg as { content: string }).content === pendingText && lastMsg.requestId === requestId
              if (isDuplicate) return existingMsgs
              const isCron = state.currentIsCron.get(sessionId) === true
              const assistantMsg: DisplayMessage = {
                id: genId(),
                type: 'assistant',
                requestId,
                content: pendingText,
                timestamp: Date.now(),
                ...(isCron ? { isCron: true } : {}),
              }
              return [...existingMsgs, assistantMsg]
            })()
          : existingMsgs

        // 追加 tool 类型消息（去重：避免回放时重复追加）
        const alreadyHasTool = msgsWithText.some(m => m.type === 'tool' && (m as { toolId?: string }).toolId === msg.toolId)
        const newMessages = new Map(state.messages)
        if (!alreadyHasTool) {
          const toolMsg: DisplayMessage = {
            id: genId(),
            type: 'tool',
            requestId,
            toolId: msg.toolId,
            toolName: msg.toolName,
            timestamp: Date.now(),
          }
          newMessages.set(sessionId, [...msgsWithText, toolMsg])
        } else {
          newMessages.set(sessionId, msgsWithText)
        }

        set({ toolCards: newToolCards, messages: newMessages, streamingText: newStreamingText })
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
        const requestId = state.currentRequestId.get(sessionId) ?? msg.requestId

        const newStreamingText = new Map(state.streamingText)
        newStreamingText.delete(sessionId)

        const newPendingAskUser = new Map(state.pendingAskUser)
        newPendingAskUser.delete(sessionId)

        // done 时清除 continuation 待确认状态
        const newPendingContinuation = new Set(state.pendingContinuation)
        newPendingContinuation.delete(sessionId)

        // 只有有内容时才追加消息
        if (text.trim().length > 0) {
          // 去重：若最后一条消息已是相同内容的 assistant 消息（重连回放场景），跳过追加
          const existingMsgs = getMessages(state.messages, sessionId)
          const lastMsg = existingMsgs[existingMsgs.length - 1]
          const isDuplicate = lastMsg?.type === 'assistant' && lastMsg.content === text && lastMsg.requestId === requestId

          if (!isDuplicate) {
            const isCron = state.currentIsCron.get(sessionId) === true
            // cron 触发时，从最近的 cron_trigger 消息中取 description
            const existingMsgsForCron = getMessages(state.messages, sessionId)
            let cronDescription: string | undefined
            if (isCron) {
              for (let i = existingMsgsForCron.length - 1; i >= 0; i--) {
                const m = existingMsgsForCron[i]
                if (m.type === 'cron_trigger' && (m as { requestId?: string }).requestId === requestId) {
                  cronDescription = (m as { description: string }).description
                  break
                }
              }
            }
            const assistantMsg: DisplayMessage = {
              id: genId(),
              type: 'assistant',
              requestId,
              content: text,
              timestamp: Date.now(),
              usage: state.costInfo.get(sessionId),
              ...(isCron ? { isCron: true } : {}),
              ...(cronDescription ? { cronDescription } : {}),
            }
            const newMessages = new Map(state.messages)
            newMessages.set(sessionId, [...existingMsgs, assistantMsg])
            set({ streamingText: newStreamingText, pendingAskUser: newPendingAskUser, pendingContinuation: newPendingContinuation, messages: newMessages })
          } else {
            set({ streamingText: newStreamingText, pendingAskUser: newPendingAskUser, pendingContinuation: newPendingContinuation })
          }
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
          isDestructive: msg.isDestructive,
          ruleContent: msg.ruleContent,
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
          options: Array.isArray(msg.options) ? msg.options : undefined,
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
          requestId: msg.requestId,
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

      // ── ready：清空流式状态，准备接收回放或新消息 ───────────────────
      case 'ready': {
        // 清空流式缓冲和进行中的工具卡片，避免重连后状态残留
        // 若 agent 正在运行（busy），后端会紧接着推送回放缓冲区重建流式状态
        const newStreamingText = new Map(state.streamingText)
        newStreamingText.delete(sessionId)

        // 清除 pending 状态的工具卡片（进行中的工具，重连后由回放重建）
        const sessionCards = getToolCards(state.toolCards, sessionId)
        const cleanedCards = new Map(sessionCards)
        for (const [toolId, card] of cleanedCards) {
          if (card.status === 'pending') cleanedCards.delete(toolId)
        }
        const newToolCards = new Map(state.toolCards)
        newToolCards.set(sessionId, cleanedCards)

        // 清除 pending 的权限请求和 ask_user（重连后由回放重建）
        const newPendingPermission = new Map(state.pendingPermission)
        newPendingPermission.delete(sessionId)
        const newPendingAskUser = new Map(state.pendingAskUser)
        newPendingAskUser.delete(sessionId)
        const newPendingDecision = new Map(state.pendingDecision)
        newPendingDecision.delete(sessionId)

        set({
          streamingText: newStreamingText,
          toolCards: newToolCards,
          pendingPermission: newPendingPermission,
          pendingAskUser: newPendingAskUser,
          pendingDecision: newPendingDecision,
        })
        // sessionStore 处理 session.status 更新，此处不重复处理
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

      // ── cron_trigger：定时任务触发，插入分隔标记 ─────────────────────────
      case 'cron_trigger': {
        const cronMsg: DisplayMessage = {
          id: genId(),
          type: 'cron_trigger',
          requestId: msg.requestId,
          description: msg.description,
          timestamp: Date.now(),
        }
        const newMessages = new Map(state.messages)
        newMessages.set(sessionId, [...getMessages(state.messages, sessionId), cronMsg])
        set({ messages: newMessages })
        break
      }

      // ── decision_request：决策请求，设置 pendingDecision ─────────────
      case 'decision_request': {
        const decisionReq: DecisionRequest = {
          title: msg.title,
          context: msg.context,
          options: msg.options,
          recommendation: msg.recommendation,
          deadline: msg.deadline,
          impact: msg.impact,
          requestedAt: Date.now(),
        }
        const newPendingDecision = new Map(state.pendingDecision)
        newPendingDecision.set(sessionId, decisionReq)
        set({ pendingDecision: newPendingDecision })
        break
      }
      // ── model_switched：模型切换通知 ─────────────────────────────────
      case 'model_switched': {
        // 可选：在消息列表中插入系统提示
        console.info('[messageStore] 模型已切换', { model: msg.model, reason: msg.reason })
        break
      }

      // ── history_cleared：后端清除了会话历史，前端同步清空 ─────────────
      case 'history_cleared': {
        get().clearSession(sessionId)
        break
      }
      default: {
        // 未知消息类型，忽略
        break
      }
    }
  },

  appendUserMessage(sessionId: string, content: string, images?: string[]) {
    const state = get()
    const userMsg: DisplayMessage = {
      id: genId(),
      type: 'user',
      content,
      timestamp: Date.now(),
      ...(images && images.length > 0 ? { images } : {}),
    }
    const newMessages = new Map(state.messages)
    newMessages.set(sessionId, [...getMessages(state.messages, sessionId), userMsg])
    set({ messages: newMessages })
  },

  clearSession(sessionId: string) {    const state = get()

    const newMessages = new Map(state.messages)
    newMessages.delete(sessionId)

    const newStreamingText = new Map(state.streamingText)
    newStreamingText.delete(sessionId)

    const newCurrentRequestId = new Map(state.currentRequestId)
    newCurrentRequestId.delete(sessionId)

    const newCurrentIsCron = new Map(state.currentIsCron)
    newCurrentIsCron.delete(sessionId)

    const newToolCards = new Map(state.toolCards)
    newToolCards.delete(sessionId)

    const newPendingAskUser = new Map(state.pendingAskUser)
    newPendingAskUser.delete(sessionId)

    const newPendingPermission = new Map(state.pendingPermission)
    newPendingPermission.delete(sessionId)

    const newPendingDecision = new Map(state.pendingDecision)
    newPendingDecision.delete(sessionId)

    const newCostInfo = new Map(state.costInfo)
    newCostInfo.delete(sessionId)

    const newPendingContinuation = new Set(state.pendingContinuation)
    newPendingContinuation.delete(sessionId)

    const newHistoryLoaded = new Set(state.historyLoaded)
    newHistoryLoaded.delete(sessionId)

    set({
      messages: newMessages,
      streamingText: newStreamingText,
      currentRequestId: newCurrentRequestId,
      currentIsCron: newCurrentIsCron,
      toolCards: newToolCards,
      pendingAskUser: newPendingAskUser,
      pendingPermission: newPendingPermission,
      pendingDecision: newPendingDecision,
      costInfo: newCostInfo,
      pendingContinuation: newPendingContinuation,
      historyLoaded: newHistoryLoaded,
    })
  },

  deleteMessage(sessionId: string, messageId: string) {
    const state = get()
    const msgs = getMessages(state.messages, sessionId)
    const newMsgs = msgs.filter(m => m.id !== messageId)
    const newMessages = new Map(state.messages)
    newMessages.set(sessionId, newMsgs)
    set({ messages: newMessages })
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
    const target = msgs.find(m => m.id === messageId && m.type === 'compact')
    if (!target || target.type !== 'compact') return

    const willExpand = !target.expanded

    const newMsgs = msgs.map(m =>
      m.id === messageId && m.type === 'compact'
        ? { ...m, expanded: !m.expanded }
        : m
    )
    const newMessages = new Map(state.messages)
    newMessages.set(sessionId, newMsgs)
    set({ messages: newMessages })

    // 展开时，若有 filename 且尚未加载过归档消息，则自动拉取
    if (willExpand && target.filename) {
      const prefix = archivePrefix(messageId)
      const alreadyLoaded = msgs.some(m => m.id.startsWith(prefix))
      if (!alreadyLoaded) {
        get().loadArchiveMessages(sessionId, messageId, target.filename)
      }
    }
  },

  async loadArchiveMessages(sessionId: string, messageId: string, filename: string) {
    try {
      const archiveMsgs = await getArchiveMessages(sessionId, filename)
      if (archiveMsgs.length === 0) return

      const state = get()
      const msgs = getMessages(state.messages, sessionId)

      // 找到分隔线位置，在其后插入归档消息（加前缀避免 id 冲突）
      const compactIdx = msgs.findIndex(m => m.id === messageId)
      if (compactIdx === -1) return

      // 避免重复插入
      const prefix = archivePrefix(messageId)
      if (msgs.some(m => m.id.startsWith(prefix))) return

      const prefixedMsgs = archiveMsgs.map(m =>
        m.type === 'tool'
          ? { ...m, id: `${prefix}${m.id}`, toolId: `${prefix}${(m as { toolId: string }).toolId}` }
          : { ...m, id: `${prefix}${m.id}` }
      )
      const newMsgs = [
        ...msgs.slice(0, compactIdx + 1),
        ...prefixedMsgs,
        ...msgs.slice(compactIdx + 1),
      ]
      const newMessages = new Map(state.messages)
      newMessages.set(sessionId, newMsgs)

      // 同时重建归档消息中的工具卡片
      const historyCards = new Map(getToolCards(state.toolCards, sessionId))
      for (const msg of archiveMsgs) {
        if (msg.type === 'tool') {
          const prefixedId = `${prefix}${msg.toolId}`
          historyCards.set(prefixedId, {
            toolId: prefixedId,
            toolName: msg.toolName,
            input: msg.toolInput ?? {},
            status: msg.toolStatus ?? 'success',
            logs: [],
            result: msg.toolResult,
            isExpanded: false,
          })
        }
      }
      const newToolCards = new Map(state.toolCards)
      newToolCards.set(sessionId, historyCards)

      set({ messages: newMessages, toolCards: newToolCards })
    } catch (err) {
      console.error('[messageStore] 加载归档消息失败:', err)
    }
  },

  clearPermission(sessionId: string) {
    const state = get()
    const newPendingPermission = new Map(state.pendingPermission)
    newPendingPermission.delete(sessionId)
    set({ pendingPermission: newPendingPermission })
  },

  clearDecision(sessionId: string) {
    const state = get()
    const newPendingDecision = new Map(state.pendingDecision)
    newPendingDecision.delete(sessionId)
    set({ pendingDecision: newPendingDecision })
  },

  clearAskUser(sessionId: string) {
    const state = get()
    const newPendingAskUser = new Map(state.pendingAskUser)
    newPendingAskUser.delete(sessionId)
    set({ pendingAskUser: newPendingAskUser })
  },

  clearContinuation(sessionId: string) {
    const state = get()
    const newPendingContinuation = new Set(state.pendingContinuation)
    newPendingContinuation.delete(sessionId)
    set({ pendingContinuation: newPendingContinuation })
  },

  async loadHistoryMessages(sessionId: string) {
    try {
      // 防止重复加载
      if (get().historyLoaded.has(sessionId)) return
      set((state) => ({ historyLoaded: new Set([...state.historyLoaded, sessionId]) }))

      const [messages, archives] = await Promise.all([
        getSessionMessages(sessionId),
        getHistorySegments(sessionId),
      ])
      if (messages.length === 0 && archives.length === 0) return
      const state = get()

      // 从 tool 类型消息中提取历史工具卡片状态（当前轮次）
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

      // 并发拉取所有归档段的实际消息
      const archiveMessagesList = await Promise.all(
        archives.map(arc => getArchiveMessages(sessionId, arc.filename))
      )

      // 构建完整消息列表：
      // 每个归档段 → compact 分隔线（已展开）+ 归档消息
      // 最后追加当前轮次消息
      const allMessages: DisplayMessage[] = []

      for (let i = 0; i < archives.length; i++) {
        const arc = archives[i]
        const compactId = `compact-${arc.filename}`
        const prefix = archivePrefix(compactId)

        // compact 分隔线（标记为已展开，消息直接显示在后面）
        allMessages.push({
          id: compactId,
          type: 'compact' as const,
          archivedAt: arc.archivedAt,
          messageCount: arc.messageCount,
          summary: arc.summary,
          filename: arc.filename,
          expanded: true,
          timestamp: new Date(arc.archivedAt).getTime(),
        })

        // 归档消息（加前缀避免 id 冲突）
        const arcMsgs = archiveMessagesList[i]
        for (const msg of arcMsgs) {
          // id 和 toolId 都加前缀，确保工具卡片能正确匹配
          const prefixedMsg = msg.type === 'tool'
            ? { ...msg, id: `${prefix}${msg.id}`, toolId: `${prefix}${msg.toolId}` }
            : { ...msg, id: `${prefix}${msg.id}` }
          allMessages.push(prefixedMsg)

          // 提取归档消息中的工具卡片
          if (msg.type === 'tool') {
            const prefixedId = `${prefix}${msg.toolId}`
            historyCards.set(prefixedId, {
              toolId: prefixedId,
              toolName: msg.toolName,
              input: msg.toolInput ?? {},
              status: msg.toolStatus ?? 'success',
              logs: [],
              result: msg.toolResult,
              isExpanded: false,
            })
          }
        }
      }

      // 追加当前轮次消息
      allMessages.push(...messages)

      // 已有的实时消息（如 compact_done 触发的分隔线）追加在最后
      const existingMsgs = getMessages(state.messages, sessionId)
      allMessages.push(...existingMsgs)

      const newMessages = new Map(state.messages)
      newMessages.set(sessionId, allMessages)

      if (historyCards.size > 0) {
        // 合并工具卡片，不覆盖已有的实时卡片
        const existingCards = getToolCards(state.toolCards, sessionId)
        const mergedCards = new Map([...historyCards, ...existingCards])
        const newToolCards = new Map(state.toolCards)
        newToolCards.set(sessionId, mergedCards)
        set({ messages: newMessages, toolCards: newToolCards })
      } else {
        set({ messages: newMessages })
      }
    } catch (err) {
      console.error('[messageStore] 加载历史消息失败:', err)
    }
  },
}))
