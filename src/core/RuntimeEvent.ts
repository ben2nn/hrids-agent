// 运行时事件类型 — 给 UI/WS 消费
//
// 类型名与旧 StreamEvent 完全一致，确保 CLI UI 和后续 Gateway 重构时无需改名。

import type { ToolResult } from './Tool.js'
import type { ContentBlock } from './ConversationStore.js'

export type RuntimeEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'tool_start'; id: string; name: string; input: unknown; description: string }
  | { type: 'tool_log'; id: string; name: string; line: string }
  | { type: 'tool_end'; id: string; name: string; result: ToolResult }
  | { type: 'permission_request'; toolName: string; description: string; isReadonly: boolean; isDestructive?: boolean; ruleContent?: string; key: string }
  | { type: 'permission_denied'; id: string; toolName: string; description: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; costUsd: number }
  | { type: 'turn_limit'; turns: number }
  | { type: 'budget_exceeded'; costUsd: number; limitUsd: number }
  | { type: 'compact_start' }
  | { type: 'compact_done'; summary: string }
  | { type: 'interrupted'; reason: InterruptReason; message: string }
  | { type: 'continuation_needed' }
  | { type: 'fallback_status'; status: 'retrying' | 'switching' | 'rate_limited'; provider: string; model: string; delayMs?: number; reason?: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

export type InterruptReason =
  | 'user_abort'
  | 'budget_exceeded'
  | 'turn_limit'
  | 'error'
  | 'storm_breaker'
