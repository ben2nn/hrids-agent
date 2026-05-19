// EventBridge — 统一事件发射层
//
// 自动注入 requestId/ts，处理 Runtime/Kernel 双写逻辑。
// 各模块通过 events.xxx() 方法发射事件，EventBridge 内部处理 store 写入和 RuntimeEvent 推送。

import type { ConversationStore } from './conversation-store.js'
import type { RuntimeEvent, InterruptReason } from './runtime-event.js'
import type { ToolResult } from './tool.js'
import {
  createSessionOpenedEvent,
  createRequestStartedEvent,
  createRequestEndedEvent,
  createUserMessageEvent,
  createAssistantMessageEvent,
  createModelTurnStartedEvent,
  createModelTurnEndedEvent,
  createToolIntentEvent,
  createToolConfirmEvent,
  createToolDispatchedEvent,
  createToolProgressEvent,
  createToolResultEvent,
  createFileTouchedEvent,
  createMemoryWrittenEvent,
  createBudgetWarnEvent,
  createBudgetBlockedEvent,
  createPolicyStormBlockedEvent,
  createPolicyPlanBlockedEvent,
  createPolicyTurnLimitEvent,
  createSessionCompactedEvent,
  createRecoveryMaxOutputEvent,
  createCapabilityRegisteredEvent,
  createCapabilityRemovedEvent,
  createHookFiredEvent,
  createModelEscalatedEvent,
  createErrorEvent,
} from './kernel-event.js'

export class EventBridge {
  constructor(
    private store: ConversationStore,
    private runtimeBuffer: RuntimeEvent[],
    private requestId?: string,
  ) {}

  // ── 仅写 store（审计）──────────────────────────────────────────

  sessionOpened(sessionId: string, resumed: boolean): void {
    this.store.appendEvents(createSessionOpenedEvent(sessionId, resumed))
  }

  userMessage(content: string, trigger?: 'user' | 'cron', cronDescription?: string): void {
    this.store.appendEvents(createUserMessageEvent(content, this.requestId, trigger, cronDescription))
  }

  requestStarted(mode: string, model: string): void {
    this.store.appendEvents(createRequestStartedEvent(this.requestId, mode, model))
  }

  requestEnded(
    status: string,
    totalTurns: number,
    totalToolCalls: number,
    durationMs: number,
    inputTokens: number,
    outputTokens: number,
    costUsd: number,
  ): void {
    this.store.appendEvents(createRequestEndedEvent(
      this.requestId, status, totalTurns, totalToolCalls,
      durationMs, inputTokens, outputTokens, costUsd,
    ))
  }

  modelTurnStarted(model: string, provider: string): void {
    this.store.appendEvents(createModelTurnStartedEvent(this.requestId, model, provider))
  }

  modelTurnEnded(durationMs: number, inputTokens: number, outputTokens: number): void {
    this.store.appendEvents(createModelTurnEndedEvent(this.requestId, durationMs, inputTokens, outputTokens))
  }

  assistantMessage(text: string, thinking?: string, toolCount?: number): void {
    this.store.appendEvents(createAssistantMessageEvent(text, this.requestId, thinking, toolCount))
  }

  toolIntent(toolCallId: string, toolName: string, input: unknown, description?: string): void {
    this.store.appendEvents(createToolIntentEvent(this.requestId, toolCallId, toolName, input, description))
  }

  toolConfirm(
    toolCallId: string,
    toolName: string,
    decision: 'allow' | 'deny' | 'always_allow' | 'session_allow',
    mode: string,
    isReadonly: boolean,
    isDestructive: boolean,
    reason?: string,
  ): void {
    this.store.appendEvents(createToolConfirmEvent(
      this.requestId, toolCallId, toolName, decision, mode, isReadonly, isDestructive, reason,
    ))
  }

  toolDispatched(toolCallId: string, toolName: string): void {
    this.store.appendEvents(createToolDispatchedEvent(this.requestId, toolCallId, toolName))
  }

  toolResult(
    toolCallId: string,
    toolName: string,
    durationMs: number,
    status: 'ok' | 'err' | 'denied' | 'timeout' | 'abort',
    outputPreview?: string,
    errorSummary?: string,
  ): void {
    this.store.appendEvents(createToolResultEvent(
      this.requestId, toolCallId, toolName, durationMs, status, outputPreview, errorSummary,
    ))
  }

  fileTouched(path: string, mode: 'create' | 'edit' | 'delete', bytes: number): void {
    this.store.appendEvents(createFileTouchedEvent(this.requestId, path, mode, bytes))
  }

  memoryWritten(scope: string, key: string): void {
    this.store.appendEvents(createMemoryWrittenEvent(scope, key))
  }

  budgetWarn(spentUsd: number, capUsd: number, percentage: number): void {
    this.store.appendEvents(createBudgetWarnEvent(spentUsd, capUsd, percentage))
  }

  stormBlocked(
    toolCallId: string,
    toolName: string,
    input: unknown,
    recentCount: number,
    windowSize: number,
  ): void {
    this.store.appendEvents(createPolicyStormBlockedEvent(
      this.requestId, toolCallId, toolName, input, recentCount, windowSize,
    ))
  }

  planBlocked(toolCallId: string, toolName: string, reason: string): void {
    this.store.appendEvents(createPolicyPlanBlockedEvent(this.requestId, toolCallId, toolName, reason))
  }

  sessionCompacted(summary: string): void {
    this.store.appendEvents(createSessionCompactedEvent(this.requestId, summary))
  }

  recoveryMaxOutput(attempt: number, maxAttempts: number): void {
    this.store.appendEvents(createRecoveryMaxOutputEvent(attempt, maxAttempts))
  }

  capabilityRegistered(toolName: string, permission: string): void {
    this.store.appendEvents(createCapabilityRegisteredEvent(toolName, permission))
  }

  capabilityRemoved(toolName: string): void {
    this.store.appendEvents(createCapabilityRemovedEvent(toolName))
  }

  hookFired(hookName: string, phase: string, outcome: string): void {
    this.store.appendEvents(createHookFiredEvent(hookName, phase, outcome))
  }

  modelEscalated(fromModel: string, toModel: string, reason: string, rationale?: string): void {
    this.store.appendEvents(createModelEscalatedEvent(fromModel, toModel, reason, rationale))
  }

  // ── 仅推送 Runtime（UI）────────────────────────────────────────

  textDelta(delta: string): void {
    this.runtimeBuffer.push({ type: 'text_delta', delta })
  }

  thinkingDelta(delta: string): void {
    this.runtimeBuffer.push({ type: 'thinking_delta', delta })
  }

  toolStart(id: string, name: string, input: unknown, description: string): void {
    this.runtimeBuffer.push({ type: 'tool_start', id, name, input, description })
  }

  toolEnd(id: string, name: string, result: ToolResult): void {
    this.runtimeBuffer.push({ type: 'tool_end', id, name, result })
  }

  permissionRequest(
    toolName: string,
    description: string,
    isReadonly: boolean,
    key: string,
    isDestructive?: boolean,
    ruleContent?: string,
  ): void {
    this.runtimeBuffer.push({
      type: 'permission_request',
      toolName, description, isReadonly, key,
      ...(isDestructive !== undefined ? { isDestructive } : {}),
      ...(ruleContent ? { ruleContent } : {}),
    })
  }

  permissionDenied(id: string, toolName: string, description: string): void {
    this.runtimeBuffer.push({ type: 'permission_denied', id, toolName, description })
  }

  usage(inputTokens: number, outputTokens: number, costUsd: number): void {
    this.runtimeBuffer.push({ type: 'usage', inputTokens, outputTokens, costUsd })
  }

  compactStart(): void {
    this.runtimeBuffer.push({ type: 'compact_start' })
  }

  done(): void {
    this.runtimeBuffer.push({ type: 'done' })
  }

  interrupted(reason: InterruptReason, message: string): void {
    this.runtimeBuffer.push({ type: 'interrupted', reason, message })
  }

  continuationNeeded(): void {
    this.runtimeBuffer.push({ type: 'continuation_needed' })
  }

  fallbackStatus(
    status: 'retrying' | 'switching' | 'rate_limited',
    provider: string,
    model: string,
    delayMs?: number,
    reason?: string,
  ): void {
    this.runtimeBuffer.push({
      type: 'fallback_status',
      status, provider, model,
      ...(delayMs !== undefined ? { delayMs } : {}),
      ...(reason ? { reason } : {}),
    })
  }

  // ── 双写（store + Runtime）────────────────────────────────────

  error(message: string, recoverable = true): void {
    this.runtimeBuffer.push({ type: 'error', message })
    this.store.appendEvents(createErrorEvent(message, recoverable))
  }

  budgetExceeded(costUsd: number, limitUsd: number): void {
    this.runtimeBuffer.push({ type: 'budget_exceeded', costUsd, limitUsd })
    this.store.appendEvents(createBudgetBlockedEvent(costUsd, limitUsd))
  }

  turnLimit(turns: number, limit: number): void {
    this.runtimeBuffer.push({ type: 'turn_limit', turns })
    this.store.appendEvents(createPolicyTurnLimitEvent(turns, limit))
  }

  compactDone(summary: string): void {
    this.runtimeBuffer.push({ type: 'compact_done', summary })
    this.store.appendEvents(createSessionCompactedEvent(this.requestId, summary))
  }

  toolProgress(toolCallId: string, name: string, line: string): void {
    this.runtimeBuffer.push({ type: 'tool_log', id: toolCallId, name, line })
    this.store.appendEvents(createToolProgressEvent(this.requestId, toolCallId, line))
  }
}
