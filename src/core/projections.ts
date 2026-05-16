// 投影函数 — 从 ChatMessage[] 构建不同消费者所需的视图
//
// projectForDisplay: 前端展示用（用户气泡 + 工具卡片）
// projectForLLM:     LLM API 用（直接透传 + prune/budget 优化）

import type {
  ChatMessage,
  DisplayMessage,
  DisplayToolCard,
} from './ConversationStore.js'

// ── 常量 ────────────────────────────────────────────────────────

/** 单条 tool_result 内容截断上限 */
export const MAX_TOOL_RESULT_CHARS = 12000

/**
 * 截断工具结果：head+tail 策略
 * 保留前 90% 和尾部 1KB，确保错误信息（通常在末尾）不丢失。
 */
export function truncateToolResult(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content
  const tailReserve = 1024
  const headChars = maxChars - tailReserve
  const head = content.slice(0, headChars)
  const tail = content.slice(-tailReserve)
  return `${head}\n\n... [已截断 ${content.length - maxChars} 字符] ...\n\n${tail}`
}

/** 旧 tool_result 超过此字符数时替换为占位符 */
const PRUNE_THRESHOLD = 800
const PRUNED_PLACEHOLDER = '[旧工具输出已清除以节省上下文空间]'
/** 所有 tool_result 的总字符预算 */
const TOTAL_RESULT_BUDGET = 60000
/** 保护最近 N 条消息的 tool_result 不被 prune */
const PRUNE_PROTECT_COUNT = 40
/** 保护最近 N 条消息的图片不被替换 */
const IMAGE_PROTECT_COUNT = 4

// ── 前端展示投影 ────────────────────────────────────────────────

/**
 * 将 ChatMessage[] 投影为前端展示消息。
 *
 * 规则：
 * - user → 用户气泡（含图片引用）
 * - assistant → 助手气泡 + 工具卡片（从 tool_calls 关联 tool 消息结果）
 * - tool → 不直接生成展示消息（通过 assistant.tool_calls 关联）
 * - system → 系统消息
 */
export function projectForDisplay(messages: readonly ChatMessage[]): DisplayMessage[] {
  // 预建 tool_call_id → tool result 映射
  const toolResultMap = new Map<string, ChatMessage>()
  for (const msg of messages) {
    if (msg.role === 'tool' && msg.tool_call_id) {
      toolResultMap.set(msg.tool_call_id, msg)
    }
  }

  const result: DisplayMessage[] = []

  for (const msg of messages) {
    switch (msg.role) {
      case 'user': {
        const dm: DisplayMessage = {
          role: 'user',
          content: typeof msg.content === 'string' ? msg.content : extractTextContent(msg.content),
          timestamp: msg.timestamp ?? 0,
        }
        if (msg.images && msg.images.length > 0) dm.images = msg.images
        if (msg.trigger === 'cron') dm.isCron = true
        if (msg.cronDescription) dm.cronDescription = msg.cronDescription
        if (msg.requestId) dm.requestId = msg.requestId
        result.push(dm)
        break
      }

      case 'assistant': {
        const text = extractTextContent(msg.content)
        const toolCards: DisplayToolCard[] = []

        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            const tr = toolResultMap.get(tc.id)
            const card: DisplayToolCard = {
              id: tc.id,
              name: tc.name,
              input: tc.input,
              status: tr ? (tr.is_error ? 'error' : 'success') : 'unknown',
              timestamp: msg.timestamp ?? 0,
            }
            if (tr) card.result = tr.content
            if (msg.requestId) card.requestId = msg.requestId
            toolCards.push(card)
          }
        }

        if (text.trim() || toolCards.length > 0) {
          const dm: DisplayMessage = {
            role: 'assistant',
            content: text,
            timestamp: msg.timestamp ?? 0,
          }
          if (msg.thinking) dm.thinking = msg.thinking
          if (msg.requestId) dm.requestId = msg.requestId
          if (toolCards.length > 0) dm.toolCards = toolCards
          result.push(dm)
        }
        break
      }

      case 'tool':
        // 不直接生成展示消息（通过 assistant.tool_calls 关联）
        break

      case 'system': {
        result.push({
          role: 'system',
          content: typeof msg.content === 'string' ? msg.content : extractTextContent(msg.content),
          timestamp: msg.timestamp ?? 0,
          ...(msg.requestId ? { requestId: msg.requestId } : {}),
        })
        break
      }
    }
  }

  return result
}

// ── LLM API 投影 ────────────────────────────────────────────────

/**
 * 将 ChatMessage[] 投影为 LLM API 所需的格式。
 *
 * 新架构下 ChatMessage 已经是 LLM API 格式，直接透传。
 * 仅做 prune/budget 优化。
 */
export function projectForLLM(
  messages: readonly ChatMessage[],
): ChatMessage[] {
  // 直接返回，无需格式转换
  return messages as ChatMessage[]
}

// ── 工具结果预算管理 ─────────────────────────────────────────────

/**
 * 对 ChatMessage[] 应用 tool_result 预算优化。
 */
export function applyToolResultBudget(
  messages: ChatMessage[],
): { messages: ChatMessage[]; prunedIds: Set<string> } {
  const prunedIds = new Set<string>()

  // Phase 1: 截断单条过大的 tool_result
  const phase1 = messages.map(msg => {
    if (msg.role !== 'tool' || typeof msg.content !== 'string') return msg
    if (msg.content.length <= MAX_TOOL_RESULT_CHARS) return msg
    return { ...msg, content: truncateToolResult(msg.content, MAX_TOOL_RESULT_CHARS) }
  })

  // Phase 2: 总量预算截断（从最旧的开始）
  let totalChars = 0
  for (const msg of phase1) {
    if (msg.role === 'tool' && typeof msg.content === 'string' && msg.content !== PRUNED_PLACEHOLDER) {
      totalChars += msg.content.length
    }
  }

  if (totalChars <= TOTAL_RESULT_BUDGET) {
    return { messages: phase1, prunedIds }
  }

  // 从最旧的开始截断，保护最近的
  const toolResultPositions: Array<{ msgIdx: number; toolCallId: string; len: number }> = []
  for (let mi = 0; mi < phase1.length; mi++) {
    const msg = phase1[mi]
    if (msg.role === 'tool' && typeof msg.content === 'string' && msg.content !== PRUNED_PLACEHOLDER) {
      toolResultPositions.push({
        msgIdx: mi,
        toolCallId: msg.tool_call_id ?? '',
        len: msg.content.length,
      })
    }
  }

  // 保护最后 PRUNE_PROTECT_COUNT 个 tool_result
  const pruneUpTo = Math.max(0, toolResultPositions.length - PRUNE_PROTECT_COUNT)
  const phase2 = [...phase1.map(msg => ({ ...msg }))]

  for (let i = 0; i < pruneUpTo && totalChars > TOTAL_RESULT_BUDGET; i++) {
    const pos = toolResultPositions[i]
    const msg = phase2[pos.msgIdx]
    if (msg.role === 'tool') {
      totalChars -= pos.len
      phase2[pos.msgIdx] = { ...msg, content: PRUNED_PLACEHOLDER }
      prunedIds.add(pos.toolCallId)
    }
  }

  return { messages: phase2, prunedIds }
}

/**
 * 对 ChatMessage[] 应用旧结果 prune。
 */
export function pruneOldToolResults(
  messages: ChatMessage[],
  protectCount = PRUNE_PROTECT_COUNT,
): { messages: ChatMessage[]; prunedIds: Set<string> } {
  const prunedIds = new Set<string>()
  const boundary = Math.max(0, messages.length - protectCount)

  const result = messages.map((msg, idx) => {
    if (idx >= boundary) return msg
    if (msg.role !== 'tool' || typeof msg.content !== 'string') return msg
    if (msg.content === PRUNED_PLACEHOLDER) return msg
    if (msg.content.length <= PRUNE_THRESHOLD) return msg

    prunedIds.add(msg.tool_call_id ?? '')
    return { ...msg, content: PRUNED_PLACEHOLDER }
  })

  return { messages: result, prunedIds }
}

/**
 * 对 ChatMessage[] 应用旧图片 prune。
 */
export function pruneOldImageBlocks(
  messages: ChatMessage[],
  protectCount = IMAGE_PROTECT_COUNT,
): ChatMessage[] {
  const boundary = Math.max(0, messages.length - protectCount)

  return messages.map((msg, idx) => {
    if (idx >= boundary) return msg
    if (msg.role !== 'user' || !Array.isArray(msg.content)) return msg

    let changed = false
    const newContent = msg.content.map(block => {
      if (block.type !== 'image') return block
      changed = true
      return { type: 'text' as const, text: '[图片已从上下文中移除以节省空间]' }
    })

    return changed ? { ...msg, content: newContent } : msg
  })
}

// ── Token 估算 ──────────────────────────────────────────────────

/**
 * 估算 ChatMessage[] 的 token 数量。
 */
export function estimateEventTokens(messages: readonly ChatMessage[]): number {
  let tokens = 0
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      tokens += estimateStringTokens(msg.content)
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text') tokens += estimateStringTokens(block.text)
        if (block.type === 'thinking') tokens += estimateStringTokens(block.thinking)
        if (block.type === 'tool_result') tokens += estimateStringTokens(block.content)
      }
    }
    if (msg.thinking) tokens += estimateStringTokens(msg.thinking)
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        tokens += estimateStringTokens(JSON.stringify(tc.input))
      }
    }
  }
  return tokens
}

function estimateStringTokens(s: string): number {
  let tokens = 0
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0
    if (code > 0x2E7F) {
      tokens += 4  // CJK
    } else {
      tokens += 1  // ASCII/Latin
    }
  }
  return Math.ceil(tokens / 4)
}

// ── 辅助函数 ────────────────────────────────────────────────────

function extractTextContent(content: string | unknown[] | null | undefined): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b: unknown): b is { type: 'text'; text: string } =>
      typeof b === 'object' && b !== null && (b as { type: string }).type === 'text')
    .map(b => b.text)
    .join('')
}
