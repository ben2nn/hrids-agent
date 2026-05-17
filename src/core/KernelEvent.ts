// 持久化事件类型 — 给 events.jsonl 审计
//
// 使用下划线分隔命名空间，包含完整审计字段。
// schema marker: hrids-events/v1

import { randomUUID } from 'crypto'

// ══════════════════════════════════════════════════════════════════
// KernelEvent — 持久化事件（给 events.jsonl 审计）
// ══════════════════════════════════════════════════════════════════

export type KernelEvent =
  | { type: 'session_opened'; ts: number; sessionId: string; resumed: boolean }
  | { type: 'request_started'; ts: number; requestId?: string; mode: string; model: string }
  | { type: 'request_ended'; ts: number; requestId?: string; status: string; totalTurns: number; totalToolCalls: number; durationMs: number; inputTokens: number; outputTokens: number; costUsd: number }
  | { type: 'user_message'; ts: number; requestId?: string; content: string; trigger?: 'user' | 'cron'; cronDescription?: string }
  | { type: 'assistant_message'; ts: number; requestId?: string; text: string; thinking?: string; toolCount?: number }
  | { type: 'model_turn_started'; ts: number; requestId?: string; model: string; provider: string }
  | { type: 'model_turn_ended'; ts: number; requestId?: string; durationMs: number; inputTokens: number; outputTokens: number }
  | { type: 'tool_intent'; ts: number; requestId?: string; toolCallId: string; toolName: string; input: unknown; description?: string }
  | { type: 'tool_confirm'; ts: number; requestId?: string; toolCallId: string; toolName: string; decision: 'allow' | 'deny' | 'always_allow' | 'session_allow'; mode: string; isReadonly: boolean; isDestructive: boolean; reason?: string }
  | { type: 'tool_dispatched'; ts: number; requestId?: string; toolCallId: string; toolName: string }
  | { type: 'tool_progress'; ts: number; requestId?: string; toolCallId: string; line: string }
  | { type: 'tool_result'; ts: number; requestId?: string; toolCallId: string; toolName: string; durationMs: number; status: 'ok' | 'err' | 'denied' | 'timeout' | 'abort'; outputPreview?: string; errorSummary?: string }
  | { type: 'effect_file_touched'; ts: number; requestId?: string; path: string; mode: 'create' | 'edit' | 'delete'; bytes: number }
  | { type: 'effect_memory_written'; ts: number; scope: string; key: string }
  | { type: 'policy_budget_warn'; ts: number; spentUsd: number; capUsd: number; percentage: number }
  | { type: 'policy_budget_blocked'; ts: number; spentUsd: number; capUsd: number }
  | { type: 'policy_storm_blocked'; ts: number; requestId?: string; toolCallId: string; toolName: string; input: unknown; recentCount: number; windowSize: number }
  | { type: 'policy_plan_blocked'; ts: number; requestId?: string; toolCallId: string; toolName: string; reason: string }
  | { type: 'policy_turn_limit'; ts: number; totalTurns: number; limit: number }
  | { type: 'session_compacted'; ts: number; requestId?: string; summary: string }
  | { type: 'recovery_max_output'; ts: number; attempt: number; maxAttempts: number }
  | { type: 'capability_registered'; ts: number; toolName: string; permission: string }
  | { type: 'capability_removed'; ts: number; toolName: string }
  | { type: 'hook_fired'; ts: number; hookName: string; phase: string; outcome: string }
  | { type: 'model_escalated'; ts: number; fromModel: string; toModel: string; reason: string; rationale?: string }
  | { type: 'error'; ts: number; requestId?: string; message: string; recoverable: boolean }

// ══════════════════════════════════════════════════════════════════
// 事件工厂函数
// ══════════════════════════════════════════════════════════════════

export function createSessionOpenedEvent(sessionId: string, resumed: boolean): KernelEvent {
  return { type: 'session_opened', ts: Date.now(), sessionId, resumed }
}

export function createRequestStartedEvent(requestId: string | undefined, mode: string, model: string): KernelEvent {
  return { type: 'request_started', ts: Date.now(), requestId, mode, model }
}

export function createRequestEndedEvent(
  requestId: string | undefined,
  status: string,
  totalTurns: number,
  totalToolCalls: number,
  durationMs: number,
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
): KernelEvent {
  return { type: 'request_ended', ts: Date.now(), requestId, status, totalTurns, totalToolCalls, durationMs, inputTokens, outputTokens, costUsd }
}

export function createUserMessageEvent(content: string, requestId?: string, trigger?: 'user' | 'cron', cronDescription?: string): KernelEvent {
  return { type: 'user_message', ts: Date.now(), requestId, content, ...(trigger ? { trigger } : {}), ...(cronDescription ? { cronDescription } : {}) }
}

export function createAssistantMessageEvent(text: string, requestId?: string, thinking?: string, toolCount?: number): KernelEvent {
  return { type: 'assistant_message', ts: Date.now(), requestId, text, ...(thinking ? { thinking } : {}), ...(toolCount !== undefined ? { toolCount } : {}) }
}

export function createModelTurnStartedEvent(requestId: string | undefined, model: string, provider: string): KernelEvent {
  return { type: 'model_turn_started', ts: Date.now(), requestId, model, provider }
}

export function createModelTurnEndedEvent(requestId: string | undefined, durationMs: number, inputTokens: number, outputTokens: number): KernelEvent {
  return { type: 'model_turn_ended', ts: Date.now(), requestId, durationMs, inputTokens, outputTokens }
}

export function createToolIntentEvent(requestId: string | undefined, toolCallId: string, toolName: string, input: unknown, description?: string): KernelEvent {
  return { type: 'tool_intent', ts: Date.now(), requestId, toolCallId, toolName, input, ...(description ? { description } : {}) }
}

export function createToolConfirmEvent(
  requestId: string | undefined,
  toolCallId: string,
  toolName: string,
  decision: 'allow' | 'deny' | 'always_allow' | 'session_allow',
  mode: string,
  isReadonly: boolean,
  isDestructive: boolean,
  reason?: string,
): KernelEvent {
  return { type: 'tool_confirm', ts: Date.now(), requestId, toolCallId, toolName, decision, mode, isReadonly, isDestructive, ...(reason ? { reason } : {}) }
}

export function createToolDispatchedEvent(requestId: string | undefined, toolCallId: string, toolName: string): KernelEvent {
  return { type: 'tool_dispatched', ts: Date.now(), requestId, toolCallId, toolName }
}

export function createToolProgressEvent(requestId: string | undefined, toolCallId: string, line: string): KernelEvent {
  return { type: 'tool_progress', ts: Date.now(), requestId, toolCallId, line }
}

export function createToolResultEvent(
  requestId: string | undefined,
  toolCallId: string,
  toolName: string,
  durationMs: number,
  status: 'ok' | 'err' | 'denied' | 'timeout' | 'abort',
  outputPreview?: string,
  errorSummary?: string,
): KernelEvent {
  return { type: 'tool_result', ts: Date.now(), requestId, toolCallId, toolName, durationMs, status, ...(outputPreview ? { outputPreview } : {}), ...(errorSummary ? { errorSummary } : {}) }
}

export function createFileTouchedEvent(requestId: string | undefined, path: string, mode: 'create' | 'edit' | 'delete', bytes: number): KernelEvent {
  return { type: 'effect_file_touched', ts: Date.now(), requestId, path, mode, bytes }
}

export function createMemoryWrittenEvent(scope: string, key: string): KernelEvent {
  return { type: 'effect_memory_written', ts: Date.now(), scope, key }
}

export function createBudgetWarnEvent(spentUsd: number, capUsd: number, percentage: number): KernelEvent {
  return { type: 'policy_budget_warn', ts: Date.now(), spentUsd, capUsd, percentage }
}

export function createBudgetBlockedEvent(spentUsd: number, capUsd: number): KernelEvent {
  return { type: 'policy_budget_blocked', ts: Date.now(), spentUsd, capUsd }
}

export function createPolicyStormBlockedEvent(requestId: string | undefined, toolCallId: string, toolName: string, input: unknown, recentCount: number, windowSize: number): KernelEvent {
  return { type: 'policy_storm_blocked', ts: Date.now(), requestId, toolCallId, toolName, input, recentCount, windowSize }
}

export function createPolicyPlanBlockedEvent(requestId: string | undefined, toolCallId: string, toolName: string, reason: string): KernelEvent {
  return { type: 'policy_plan_blocked', ts: Date.now(), requestId, toolCallId, toolName, reason }
}

export function createPolicyTurnLimitEvent(totalTurns: number, limit: number): KernelEvent {
  return { type: 'policy_turn_limit', ts: Date.now(), totalTurns, limit }
}

export function createSessionCompactedEvent(requestId: string | undefined, summary: string): KernelEvent {
  return { type: 'session_compacted', ts: Date.now(), requestId, summary }
}

export function createRecoveryMaxOutputEvent(attempt: number, maxAttempts: number): KernelEvent {
  return { type: 'recovery_max_output', ts: Date.now(), attempt, maxAttempts }
}

export function createCapabilityRegisteredEvent(toolName: string, permission: string): KernelEvent {
  return { type: 'capability_registered', ts: Date.now(), toolName, permission }
}

export function createCapabilityRemovedEvent(toolName: string): KernelEvent {
  return { type: 'capability_removed', ts: Date.now(), toolName }
}

export function createHookFiredEvent(hookName: string, phase: string, outcome: string): KernelEvent {
  return { type: 'hook_fired', ts: Date.now(), hookName, phase, outcome }
}

export function createModelEscalatedEvent(fromModel: string, toModel: string, reason: string, rationale?: string): KernelEvent {
  return { type: 'model_escalated', ts: Date.now(), fromModel, toModel, reason, ...(rationale ? { rationale } : {}) }
}

export function createErrorEvent(message: string, recoverable: boolean, requestId?: string): KernelEvent {
  return { type: 'error', ts: Date.now(), requestId, message, recoverable }
}
