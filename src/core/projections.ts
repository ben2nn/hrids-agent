// 投影函数 — 从事件日志构建不同消费者所需的视图
//
// projectForDisplay: 前端展示用（用户气泡 + 工具卡片）
// projectForLLM:     LLM API 用（含 prune/budget 优化，provider 格式转换由 provider 自行处理）

import type {
  ConversationEvent,
  DisplayMessage,
  DisplayToolCard,
} from './ConversationStore.js'
import type { ContentBlock } from './QueryEngine.js'
import type { ChatMessage } from './providers/types.js'

// ── 常量 ────────────────────────────────────────────────────────

/** 单条 tool_result 内容截断上限 */
const MAX_TOOL_RESULT_CHARS = 12000
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
 * 将事件日志投影为前端展示消息。
 *
 * 规则：
 * - user_message → 用户气泡（含图片引用）
 * - assistant_message → 助手气泡 + 工具卡片（从 tool_result 事件匹配结果）
 * - compact → 压缩提示消息
 * - tool_result → 不直接生成展示消息
 */
export function projectForDisplay(events: readonly ConversationEvent[]): DisplayMessage[] {
  // 第一遍：建立 toolCallId → ToolResultEvent 映射
  const toolResultMap = new Map<string, { content: string; isError: boolean }>()
  for (const ev of events) {
    if (ev.type === 'tool_result') {
      toolResultMap.set(ev.toolCallId, { content: ev.content, isError: ev.isError })
    }
  }

  const messages: DisplayMessage[] = []

  for (const ev of events) {
    switch (ev.type) {
      case 'user_message': {
        const dm: DisplayMessage = {
          role: 'user',
          content: ev.content,
          timestamp: ev.timestamp,
        }
        if (ev.images && ev.images.length > 0) dm.images = ev.images
        if (ev.trigger === 'cron') dm.isCron = true
        if (ev.cronDescription) dm.cronDescription = ev.cronDescription
        if (ev.requestId) dm.requestId = ev.requestId
        messages.push(dm)
        break
      }

      case 'assistant_message': {
        // 助手文本
        if (ev.text.trim()) {
          const dm: DisplayMessage = {
            role: 'assistant',
            content: ev.text,
            timestamp: ev.timestamp,
          }
          if (ev.thinking) dm.thinking = ev.thinking
          if (ev.requestId) dm.requestId = ev.requestId
          messages.push(dm)
        }
        // 工具卡片
        if (ev.toolCalls) {
          for (const tc of ev.toolCalls) {
            const result = toolResultMap.get(tc.id)
            const card: DisplayToolCard = {
              id: tc.id,
              name: tc.name,
              input: tc.input,
              status: result ? (result.isError ? 'error' : 'success') : 'success',
              timestamp: ev.timestamp + 1,
            }
            if (result) card.result = result.content
            if (ev.requestId) card.requestId = ev.requestId

            // 作为独立的 tool 类型消息返回
            messages.push({
              role: 'assistant',
              content: '',
              timestamp: ev.timestamp + 1,
              requestId: ev.requestId,
              toolCards: [card],
            })
          }
        }
        break
      }

      case 'compact': {
        messages.push({
          role: 'user',
          content: `[上下文压缩] ${ev.summary}`,
          timestamp: ev.timestamp,
          requestId: ev.requestId,
        })
        messages.push({
          role: 'assistant',
          content: '已了解之前的对话内容，将基于摘要继续工作。',
          timestamp: ev.timestamp + 1,
          requestId: ev.requestId,
        })
        break
      }

      // tool_result 事件不直接生成展示消息（已通过 assistant_message 的 toolCalls 关联）
      case 'tool_result':
        break

      // request_complete 不生成展示消息（持久化用，不影响前端消息列表）
      case 'request_complete':
        break

      case 'system_event': {
        // cron_trigger 展示为 cron 用户消息
        if (ev.kind === 'cron_trigger') {
          const dm: DisplayMessage = {
            role: 'user',
            content: ev.content,
            timestamp: ev.timestamp,
            isCron: true,
          }
          if (ev.cronDescription) dm.cronDescription = ev.cronDescription
          if (ev.requestId) dm.requestId = ev.requestId
          messages.push(dm)
        }
        // 其他系统事件（error_recovery / turn_limit / user_abort）不展示
        break
      }

      // tool_execution 不生成展示消息（审计用）
      case 'tool_execution':
        break
    }
  }

  return messages
}

// ── LLM API 投影 ────────────────────────────────────────────────

interface LLMProjectionOptions {
  /** 最新用户消息的预处理结果（含 image block），替换原始文本 */
  latestPreprocessed?: ContentBlock[] | null
  /** 因 prune 被清除的 toolCallId 集合 */
  prunedToolCallIds?: Set<string>
}

/**
 * 将事件日志投影为 LLM API 所需的 ChatMessage[]。
 *
 * 优化策略（按优先级从低到高，在投影时执行，不修改原始事件）：
 * 1. 旧图片 block 替换为占位符（保护最近 N 条）
 * 2. 旧 tool_result 内容截断（保护最近 N 条）
 * 3. tool_result 总量预算截断（从最旧开始）
 *
 * 特殊处理：
 * - compact 事件：仅保留 summary 作为上下文，之前的事件不再投影
 * - 最新用户消息使用预处理版本（含 image block）
 * - 被 prune 的 tool_use 跳过投影（避免孤立 tool_use 导致 API 报错）
 */
export function projectForLLM(
  events: readonly ConversationEvent[],
  options: LLMProjectionOptions = {},
): ChatMessage[] {
  const { latestPreprocessed, prunedToolCallIds } = options

  // 找到最后一个 compact 事件的位置，只投影其后的事件
  let startIdx = 0
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'compact') {
      startIdx = i
      break
    }
  }

  const relevantEvents = events.slice(startIdx)
  const messages: ChatMessage[] = []

  // 如果有 compact 事件，先注入摘要
  if (startIdx > 0 && events[startIdx].type === 'compact') {
    const compactEv = events[startIdx] as import('./ConversationStore.js').CompactEvent
    messages.push({
      role: 'user',
      content: `[上下文压缩] ${compactEv.summary}`,
    })
    messages.push({
      role: 'assistant',
      content: '已了解之前的对话内容，将基于摘要继续工作。',
    })
  }

  // 建立 toolCallId → ToolResultEvent 映射
  const toolResultMap = new Map<string, import('./ConversationStore.js').ToolResultEvent>()
  for (const ev of relevantEvents) {
    if (ev.type === 'tool_result') {
      toolResultMap.set(ev.toolCallId, ev)
    }
  }

  // 按顺序构建消息
  let userEventIdx = 0
  let totalUserEvents = 0
  for (const ev of relevantEvents) {
    if (ev.type === 'user_message') totalUserEvents++
  }

  for (const ev of relevantEvents) {
    switch (ev.type) {
      case 'user_message': {
        userEventIdx++
        const isLatest = userEventIdx === totalUserEvents

        // 最新用户消息使用预处理版本（含 image block）
        if (isLatest && latestPreprocessed) {
          messages.push({
            role: 'user',
            content: latestPreprocessed,
          })
        } else {
          messages.push({
            role: 'user',
            content: ev.content,
          })
        }
        break
      }

      case 'assistant_message': {
        const content: ContentBlock[] = []

        if (ev.text) {
          content.push({ type: 'text', text: ev.text })
        }

        if (ev.toolCalls) {
          for (const tc of ev.toolCalls) {
            // 跳过被 prune 的 tool_use
            if (prunedToolCallIds?.has(tc.id)) continue
            content.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input: tc.input,
            })
          }
        }

        if (content.length > 0) {
          messages.push({
            role: 'assistant',
            content,
          })
        }
        break
      }

      case 'tool_result': {
        // 跳过被 prune 的 tool_result
        if (prunedToolCallIds?.has(ev.toolCallId)) break

        messages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: ev.toolCallId,
            content: ev.content,
            is_error: ev.isError,
          }],
        })
        break
      }

      // compact 已在上面处理
      case 'compact':
        break

      // request_complete 不参与 LLM 投影
      case 'request_complete':
        break

      // system_event 注入为 user 消息，LLM 需要感知这些上下文
      case 'system_event':
        messages.push({ role: 'user', content: ev.content })
        break

      // tool_execution 不参与 LLM 投影（审计用）
      case 'tool_execution':
        break
    }
  }

  return messages
}

// ── 工具结果预算管理（在 LLM 投影中执行）────────────────────────

/**
 * 对投影后的 ChatMessage[] 应用 tool_result 预算优化。
 *
 * 返回优化后的消息列表（不修改原始事件）。
 * 同时返回被 prune 的 toolCallId 集合，供后续投影跳过对应的 tool_use。
 */
export function applyToolResultBudget(
  messages: ChatMessage[],
): { messages: ChatMessage[]; prunedIds: Set<string> } {
  const prunedIds = new Set<string>()

  // Phase 1: 截断单条过大的 tool_result
  const phase1 = messages.map(msg => {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) return msg
    let changed = false
    const newContent = (msg.content as ContentBlock[]).map(block => {
      if (block.type !== 'tool_result') return block
      if (block.content.length <= MAX_TOOL_RESULT_CHARS) return block
      changed = true
      return { ...block, content: block.content.slice(0, MAX_TOOL_RESULT_CHARS) + '\n...[已截断]' }
    })
    return changed ? { ...msg, content: newContent } : msg
  })

  // Phase 2: 总量预算截断（从最旧的开始）
  let totalChars = 0
  for (const msg of phase1) {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
    for (const block of msg.content as ContentBlock[]) {
      if (block.type === 'tool_result' && block.content !== PRUNED_PLACEHOLDER) {
        totalChars += block.content.length
      }
    }
  }

  if (totalChars <= TOTAL_RESULT_BUDGET) {
    return { messages: phase1, prunedIds }
  }

  // 从最旧的开始截断，保护最近的
  const toolResultPositions: Array<{ msgIdx: number; blockIdx: number; toolCallId: string; len: number }> = []
  for (let mi = 0; mi < phase1.length; mi++) {
    const msg = phase1[mi]
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
    const content = msg.content as ContentBlock[]
    for (let bi = 0; bi < content.length; bi++) {
      const block = content[bi]
      if (block.type === 'tool_result' && block.content !== PRUNED_PLACEHOLDER) {
        toolResultPositions.push({
          msgIdx: mi,
          blockIdx: bi,
          toolCallId: block.tool_use_id,
          len: block.content.length,
        })
      }
    }
  }

  // 保护最后 PRUNE_PROTECT_COUNT 个 tool_result
  const pruneUpTo = Math.max(0, toolResultPositions.length - PRUNE_PROTECT_COUNT)
  const phase2 = [...phase1.map(msg => ({ ...msg }))]

  for (let i = 0; i < pruneUpTo && totalChars > TOTAL_RESULT_BUDGET; i++) {
    const pos = toolResultPositions[i]
    const msg = phase2[pos.msgIdx]
    if (!Array.isArray(msg.content)) continue
    const content = [...(msg.content as ContentBlock[])]
    const block = content[pos.blockIdx]
    if (block.type === 'tool_result') {
      totalChars -= pos.len
      content[pos.blockIdx] = { ...block, content: PRUNED_PLACEHOLDER }
      prunedIds.add(block.tool_use_id)
      msg.content = content
    }
  }

  return { messages: phase2, prunedIds }
}

/**
 * 对投影后的 ChatMessage[] 应用旧结果 prune（不调用 LLM 的廉价优化）。
 * 超过阈值的旧 tool_result 替换为占位符。
 */
export function pruneOldToolResults(
  messages: ChatMessage[],
  protectCount = PRUNE_PROTECT_COUNT,
): { messages: ChatMessage[]; prunedIds: Set<string> } {
  const prunedIds = new Set<string>()
  const boundary = Math.max(0, messages.length - protectCount)

  const result = messages.map((msg, idx) => {
    if (idx >= boundary) return msg
    if (msg.role !== 'user' || !Array.isArray(msg.content)) return msg

    let changed = false
    const newContent = (msg.content as ContentBlock[]).map(block => {
      if (block.type !== 'tool_result') return block
      if (block.content === PRUNED_PLACEHOLDER) return block
      if (block.content.length <= PRUNE_THRESHOLD) return block
      changed = true
      prunedIds.add(block.tool_use_id)
      return { ...block, content: PRUNED_PLACEHOLDER }
    })

    return changed ? { ...msg, content: newContent } : msg
  })

  return { messages: result, prunedIds }
}

/**
 * 对投影后的 ChatMessage[] 应用旧图片 prune。
 * 历史中旧的 image block 替换为文字占位符，节省 token 和带宽。
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
    const newContent = (msg.content as ContentBlock[]).map(block => {
      if (block.type !== 'image') return block
      changed = true
      return { type: 'text' as const, text: '[图片已从上下文中移除以节省空间]' }
    })

    return changed ? { ...msg, content: newContent } : msg
  })
}

// ── Token 估算 ──────────────────────────────────────────────────

/**
 * 估算事件日志的 token 数量（用于自动压缩判断）。
 * 不含图片的 token（图片在 prune 后已被替换为文本占位符）。
 */
export function estimateEventTokens(events: readonly ConversationEvent[]): number {
  let tokens = 0
  for (const ev of events) {
    switch (ev.type) {
      case 'user_message':
        tokens += estimateStringTokens(ev.content)
        break
      case 'assistant_message':
        if (ev.text) tokens += estimateStringTokens(ev.text)
        if (ev.toolCalls) {
          for (const tc of ev.toolCalls) {
            tokens += estimateStringTokens(JSON.stringify(tc.input))
          }
        }
        break
      case 'tool_result':
        tokens += estimateStringTokens(ev.content)
        break
      case 'compact':
        tokens += estimateStringTokens(ev.summary)
        break
      case 'system_event':
        tokens += estimateStringTokens(ev.content)
        break
      case 'tool_execution':
        if (ev.outputPreview) tokens += estimateStringTokens(ev.outputPreview)
        if (ev.errorSummary) tokens += estimateStringTokens(ev.errorSummary)
        break
    }
  }
  return tokens
}

function estimateStringTokens(s: string): number {
  let tokens = 0
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0
    if (code > 0x2E7F) {
      tokens += 6  // CJK: ~1.5 token/字
    } else {
      tokens += 1  // ASCII/Latin: ~0.25 token/字符
    }
  }
  return Math.ceil(tokens / 4)
}
