// 双存储对话架构 — ChatMessage[] 主存储 + 全生命周期事件日志
//
// 架构：
//   messages.jsonl (ChatMessage[]) ──┬──► projectForDisplay() ──► DisplayMessage[]
//                                    └──► projectForLLM()     ──► ChatMessage[]（直接透传）
//
//   events.jsonl (ConversationEvent[]) ──► 审计 / Gateway 推送 / 可观测性

import { randomUUID } from 'crypto'
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync } from 'fs'
import { join } from 'path'

// ══════════════════════════════════════════════════════════════════
// 主存储类型：ChatMessage（与 LLM API 格式一致）
// ══════════════════════════════════════════════════════════════════

export interface ToolCall {
  id: string
  name: string
  input: unknown
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string | ContentBlock[] | null
  thinking?: string
  tool_calls?: ToolCall[]
  tool_call_id?: string
  is_error?: boolean
  name?: string
  timestamp?: number
  requestId?: string
  images?: string[]
  trigger?: 'user' | 'cron'
  cronDescription?: string
}

export type ContentBlock =
  | { type: 'thinking'; thinking: string }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | { type: 'image'; source: ImageSource }

export interface ImageSource {
  type: 'base64' | 'url'
  mediaType?: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | 'application/pdf'
  data?: string
  url?: string
}

// ══════════════════════════════════════════════════════════════════
// 旁路日志类型：全生命周期事件（完整字段名）
// ══════════════════════════════════════════════════════════════════

interface BaseEvent {
  type: string
  id: string
  ts: number
  requestId?: string
}

// ── 请求生命周期 ──────────────────────────────────────────────────

export interface ReqStartEvent extends BaseEvent {
  type: 'req_start'
  mode: 'ask' | 'craft' | 'plan'
  model: string
}

export interface ReqEndEvent extends BaseEvent {
  type: 'req_end'
  status: 'ok' | 'err' | 'abort' | 'turn' | 'budget'
  totalTurns: number
  totalToolCalls: number
  durationMs: number
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
}

// ── 消息事件 ──────────────────────────────────────────────────────

export interface UserEvent extends BaseEvent {
  type: 'user'
  content: string
  images?: string[]
  trigger?: 'user' | 'cron'
  cronDescription?: string
}

export interface AssistantEvent extends BaseEvent {
  type: 'assistant'
  text: string
  thinking?: string
  toolCount?: number
}

export interface CompactEvent extends BaseEvent {
  type: 'compact'
  summary: string
  tokensBefore?: number
  tokensAfter?: number
}

// ── 工具全生命周期 ────────────────────────────────────────────────

/** 模型决定调用什么工具（tool.intent） */
export interface ToolIntentEvent extends BaseEvent {
  type: 'tool_intent'
  toolCallId: string
  toolName: string
  input: unknown
  description?: string
}

/** 权限决策结果（tool.confirm.*） */
export interface ToolConfirmEvent extends BaseEvent {
  type: 'tool_confirm'
  toolCallId: string
  toolName: string
  decision: 'allow' | 'deny' | 'always_allow' | 'session_allow'
  mode: 'ask' | 'craft' | 'plan'
  isReadonly: boolean
  isDestructive: boolean
  reason?: string
}

export interface ToolStartEvent extends BaseEvent {
  type: 'tool_start'
  toolCallId: string
  toolName: string
  input: unknown
  description?: string
}

export interface ToolLogEvent extends BaseEvent {
  type: 'tool_log'
  toolCallId: string
  line: string
}

export interface ToolEndEvent extends BaseEvent {
  type: 'tool_end'
  toolCallId: string
  toolName: string
  durationMs: number
  status: 'ok' | 'err' | 'denied' | 'timeout' | 'abort'
  outputPreview?: string
  errorSummary?: string
  truncated?: boolean
  originalLength?: number
}

// ── 副作用事件 ────────────────────────────────────────────────────

export interface FileTouchedEvent extends BaseEvent {
  type: 'file_touched'
  path: string
  mode: 'create' | 'edit' | 'delete'
  bytes: number
}

export interface MemoryWrittenEvent extends BaseEvent {
  type: 'memory_written'
  scope: 'user' | 'project' | 'global'
  key: string
}

// ── 策略事件 ──────────────────────────────────────────────────────

export interface BudgetWarnEvent extends BaseEvent {
  type: 'budget_warn'
  spentUsd: number
  capUsd: number
  percentage: number
}

export interface BudgetExceededEvent extends BaseEvent {
  type: 'budget_exceeded'
  spentUsd: number
  capUsd: number
}

export interface StormBlockedEvent extends BaseEvent {
  type: 'storm_blocked'
  toolCallId: string
  toolName: string
  input: unknown
  recentCount: number
  windowSize: number
}

export interface TurnLimitEvent extends BaseEvent {
  type: 'turn_limit'
  totalTurns: number
  limit: number
}

export interface PlanBlockedEvent extends BaseEvent {
  type: 'plan_blocked'
  toolCallId: string
  toolName: string
  reason: string
}

export interface ModelEscalatedEvent extends BaseEvent {
  type: 'model_escalated'
  fromModel: string
  toModel: string
  reason: 'self_report' | 'failure_threshold' | 'user_request'
  rationale?: string
}

// ── 会话事件 ──────────────────────────────────────────────────────

export interface SessionOpenEvent extends BaseEvent {
  type: 'session_open'
  sessionName: string
  resumed: boolean
  resumedFromTurn?: number
}

// ── 能力事件 ──────────────────────────────────────────────────────

export interface CapRegisteredEvent extends BaseEvent {
  type: 'cap_registered'
  toolName: string
  permission: 'ask' | 'allow' | 'deny'
}

export interface CapRemovedEvent extends BaseEvent {
  type: 'cap_removed'
  toolName: string
}

// ── 系统事件 ──────────────────────────────────────────────────────

export interface ErrorRecoveryEvent extends BaseEvent {
  type: 'error_recovery'
  errorType: string
  attempt: number
  maxAttempts: number
}

export interface MaxOutputRecoveryEvent extends BaseEvent {
  type: 'max_output_recovery'
  attempt: number
  maxAttempts: number
}

export interface CronTriggerEvent extends BaseEvent {
  type: 'cron_trigger'
  content: string
  cronDescription?: string
}

export interface LlmStartEvent extends BaseEvent {
  type: 'llm_start'
  model: string
  provider: string
}

export interface LlmEndEvent extends BaseEvent {
  type: 'llm_end'
  durationMs: number
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface HookFiredEvent extends BaseEvent {
  type: 'hook_fired'
  hookName: string
  phase: 'pre_tool' | 'post_tool' | 'pre_send' | 'post_send' | 'compact'
  outcome: 'ok' | 'blocked' | 'modified' | 'err'
}

export interface ErrorEvent extends BaseEvent {
  type: 'error'
  message: string
  recoverable: boolean
}

// ── 联合类型 ──────────────────────────────────────────────────────

export type ConversationEvent =
  | ReqStartEvent | ReqEndEvent
  | UserEvent | AssistantEvent | CompactEvent
  | ToolIntentEvent | ToolConfirmEvent | ToolStartEvent | ToolLogEvent | ToolEndEvent
  | FileTouchedEvent | MemoryWrittenEvent
  | BudgetWarnEvent | BudgetExceededEvent | StormBlockedEvent | TurnLimitEvent | PlanBlockedEvent | ModelEscalatedEvent
  | SessionOpenEvent
  | CapRegisteredEvent | CapRemovedEvent
  | ErrorRecoveryEvent | MaxOutputRecoveryEvent | CronTriggerEvent
  | LlmStartEvent | LlmEndEvent
  | HookFiredEvent | ErrorEvent

// ══════════════════════════════════════════════════════════════════
// 事件工厂函数
// ══════════════════════════════════════════════════════════════════

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${randomUUID().slice(0, 8)}`
}

export function createReqStartEvent(requestId: string, mode: ReqStartEvent['mode'], model: string): ReqStartEvent {
  return { type: 'req_start', id: genId('rs'), ts: Date.now(), requestId, mode, model }
}

export function createReqEndEvent(
  requestId: string | undefined,
  status: ReqEndEvent['status'],
  totalTurns: number,
  totalToolCalls: number,
  durationMs: number,
  inputTokens?: number,
  outputTokens?: number,
  costUsd?: number,
): ReqEndEvent {
  return {
    type: 'req_end', id: genId('re'), ts: Date.now(), requestId,
    status, totalTurns, totalToolCalls, durationMs,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  }
}

export function createUserEvent(
  content: string,
  requestId?: string,
  trigger?: 'user' | 'cron',
  cronDescription?: string,
  images?: string[],
): UserEvent {
  return {
    type: 'user', id: genId('usr'), ts: Date.now(), requestId, content,
    ...(trigger ? { trigger } : {}),
    ...(cronDescription ? { cronDescription } : {}),
    ...(images && images.length > 0 ? { images } : {}),
  }
}

export function createAssistantEvent(
  text: string,
  requestId?: string,
  thinking?: string,
  toolCount?: number,
): AssistantEvent {
  return {
    type: 'assistant', id: genId('asst'), ts: Date.now(), requestId, text,
    ...(thinking ? { thinking } : {}),
    ...(toolCount !== undefined ? { toolCount } : {}),
  }
}

export function createCompactEvent(summary: string, requestId?: string): CompactEvent {
  return { type: 'compact', id: genId('comp'), ts: Date.now(), requestId, summary }
}

export function createToolIntentEvent(
  requestId: string | undefined,
  toolCallId: string,
  toolName: string,
  input: unknown,
  description?: string,
): ToolIntentEvent {
  return {
    type: 'tool_intent', id: genId('ti'), ts: Date.now(), requestId,
    toolCallId, toolName, input,
    ...(description ? { description } : {}),
  }
}

export function createToolConfirmEvent(
  requestId: string | undefined,
  toolCallId: string,
  toolName: string,
  decision: ToolConfirmEvent['decision'],
  mode: ToolConfirmEvent['mode'],
  isReadonly: boolean,
  isDestructive: boolean,
  reason?: string,
): ToolConfirmEvent {
  return {
    type: 'tool_confirm', id: genId('tc'), ts: Date.now(), requestId,
    toolCallId, toolName, decision, mode, isReadonly, isDestructive,
    ...(reason ? { reason } : {}),
  }
}

export function createToolStartEvent(
  requestId: string | undefined,
  toolCallId: string,
  toolName: string,
  input: unknown,
  description?: string,
): ToolStartEvent {
  return {
    type: 'tool_start', id: genId('ts'), ts: Date.now(), requestId,
    toolCallId, toolName, input,
    ...(description ? { description } : {}),
  }
}

export function createToolLogEvent(requestId: string | undefined, toolCallId: string, line: string): ToolLogEvent {
  return { type: 'tool_log', id: genId('tl'), ts: Date.now(), requestId, toolCallId, line }
}

export function createToolEndEvent(
  requestId: string | undefined,
  toolCallId: string,
  toolName: string,
  durationMs: number,
  status: ToolEndEvent['status'],
  outputPreview?: string,
  errorSummary?: string,
  truncated?: boolean,
  originalLength?: number,
): ToolEndEvent {
  return {
    type: 'tool_end', id: genId('te'), ts: Date.now(), requestId,
    toolCallId, toolName, durationMs, status,
    ...(outputPreview ? { outputPreview } : {}),
    ...(errorSummary ? { errorSummary } : {}),
    ...(truncated !== undefined ? { truncated } : {}),
    ...(originalLength !== undefined ? { originalLength } : {}),
  }
}

export function createFileTouchedEvent(
  requestId: string | undefined,
  path: string,
  mode: FileTouchedEvent['mode'],
  bytes: number,
): FileTouchedEvent {
  return { type: 'file_touched', id: genId('ft'), ts: Date.now(), requestId, path, mode, bytes }
}

export function createMemoryWrittenEvent(
  requestId: string | undefined,
  scope: MemoryWrittenEvent['scope'],
  key: string,
): MemoryWrittenEvent {
  return { type: 'memory_written', id: genId('mw'), ts: Date.now(), requestId, scope, key }
}

export function createBudgetWarnEvent(spentUsd: number, capUsd: number, percentage: number): BudgetWarnEvent {
  return { type: 'budget_warn', id: genId('bw'), ts: Date.now(), spentUsd, capUsd, percentage }
}

export function createBudgetExceededEvent(spentUsd: number, capUsd: number): BudgetExceededEvent {
  return { type: 'budget_exceeded', id: genId('be'), ts: Date.now(), spentUsd, capUsd }
}

export function createStormBlockedEvent(
  requestId: string | undefined,
  toolCallId: string,
  toolName: string,
  input: unknown,
  recentCount: number,
  windowSize: number,
): StormBlockedEvent {
  return {
    type: 'storm_blocked', id: genId('sb'), ts: Date.now(), requestId,
    toolCallId, toolName, input, recentCount, windowSize,
  }
}

export function createTurnLimitEvent(totalTurns: number, limit: number): TurnLimitEvent {
  return { type: 'turn_limit', id: genId('tlmt'), ts: Date.now(), totalTurns, limit }
}

export function createPlanBlockedEvent(
  requestId: string | undefined,
  toolCallId: string,
  toolName: string,
  reason: string,
): PlanBlockedEvent {
  return { type: 'plan_blocked', id: genId('pb'), ts: Date.now(), requestId, toolCallId, toolName, reason }
}

export function createModelEscalatedEvent(
  requestId: string | undefined,
  fromModel: string,
  toModel: string,
  reason: ModelEscalatedEvent['reason'],
  rationale?: string,
): ModelEscalatedEvent {
  return {
    type: 'model_escalated', id: genId('me'), ts: Date.now(), requestId,
    fromModel, toModel, reason,
    ...(rationale ? { rationale } : {}),
  }
}

export function createSessionOpenEvent(sessionName: string, resumed: boolean, resumedFromTurn?: number): SessionOpenEvent {
  return {
    type: 'session_open', id: genId('so'), ts: Date.now(),
    sessionName, resumed,
    ...(resumedFromTurn !== undefined ? { resumedFromTurn } : {}),
  }
}

export function createCapRegisteredEvent(toolName: string, permission: CapRegisteredEvent['permission']): CapRegisteredEvent {
  return { type: 'cap_registered', id: genId('cr'), ts: Date.now(), toolName, permission }
}

export function createCapRemovedEvent(toolName: string): CapRemovedEvent {
  return { type: 'cap_removed', id: genId('crt'), ts: Date.now(), toolName }
}

export function createErrorRecoveryEvent(errorType: string, attempt: number, maxAttempts: number): ErrorRecoveryEvent {
  return { type: 'error_recovery', id: genId('er'), ts: Date.now(), errorType, attempt, maxAttempts }
}

export function createMaxOutputRecoveryEvent(attempt: number, maxAttempts: number): MaxOutputRecoveryEvent {
  return { type: 'max_output_recovery', id: genId('mor'), ts: Date.now(), attempt, maxAttempts }
}

export function createCronTriggerEvent(content: string, cronDescription?: string): CronTriggerEvent {
  return {
    type: 'cron_trigger', id: genId('ct'), ts: Date.now(), content,
    ...(cronDescription ? { cronDescription } : {}),
  }
}

export function createLlmStartEvent(requestId: string | undefined, model: string, provider: string): LlmStartEvent {
  return { type: 'llm_start', id: genId('ls'), ts: Date.now(), requestId, model, provider }
}

export function createLlmEndEvent(
  requestId: string | undefined,
  durationMs: number,
  inputTokens?: number,
  outputTokens?: number,
  cacheReadTokens?: number,
  cacheWriteTokens?: number,
): LlmEndEvent {
  return {
    type: 'llm_end', id: genId('le'), ts: Date.now(), requestId, durationMs,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
  }
}

export function createHookFiredEvent(
  hookName: string,
  phase: HookFiredEvent['phase'],
  outcome: HookFiredEvent['outcome'],
): HookFiredEvent {
  return { type: 'hook_fired', id: genId('hf'), ts: Date.now(), hookName, phase, outcome }
}

export function createErrorEvent(message: string, recoverable: boolean, requestId?: string): ErrorEvent {
  return { type: 'error', id: genId('err'), ts: Date.now(), requestId, message, recoverable }
}

// ══════════════════════════════════════════════════════════════════
// 投影类型
// ══════════════════════════════════════════════════════════════════

export interface DisplayToolCard {
  id: string
  name: string
  input: unknown
  status: 'success' | 'error' | 'unknown'
  result?: unknown
  requestId?: string
  timestamp: number
}

export interface DisplayMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  thinking?: string
  images?: string[]
  isCron?: boolean
  cronDescription?: string
  requestId?: string
  timestamp: number
  toolCards?: DisplayToolCard[]
  usage?: {
    inputTokens: number
    outputTokens: number
    costUsd: number
  }
}

// ══════════════════════════════════════════════════════════════════
// 存储实现
// ══════════════════════════════════════════════════════════════════

const MSG_SCHEMA = 'hrids-messages/v1'
const EVT_SCHEMA = 'hrids-events/v2'
const MSG_MARKER = JSON.stringify({ $schema: MSG_SCHEMA }) + '\n'
const EVT_MARKER = JSON.stringify({ $schema: EVT_SCHEMA }) + '\n'

/** messages.jsonl 存储 */
class JsonlMessageStorage {
  private path: string
  private dir: string

  constructor(sessionDir: string) {
    this.dir = sessionDir
    this.path = join(sessionDir, 'messages.jsonl')
  }

  private ensureDir(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
  }

  append(messages: ChatMessage[]): void {
    this.ensureDir()
    const lines = messages.map(m => JSON.stringify(m)).join('\n') + '\n'
    if (!existsSync(this.path)) {
      appendFileSync(this.path, MSG_MARKER + lines, 'utf-8')
      return
    }
    appendFileSync(this.path, lines, 'utf-8')
  }

  load(): ChatMessage[] {
    if (!existsSync(this.path)) return []
    const content = readFileSync(this.path, 'utf-8')
    if (!content.trim()) return []
    const lines = content.split('\n')
    const messages: ChatMessage[] = []
    let startIdx = 0
    const firstLine = lines[0]?.trim()
    if (firstLine) {
      try {
        const marker = JSON.parse(firstLine)
        if (marker.$schema) startIdx = 1
      } catch { /* not a marker */ }
    }
    for (let i = startIdx; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue
      try {
        messages.push(JSON.parse(line) as ChatMessage)
      } catch {
        process.stderr.write(`[messages.jsonl] 第 ${i + 1} 行解析失败，已跳过\n`)
      }
    }
    return messages
  }

  rewrite(messages: ChatMessage[]): void {
    this.ensureDir()
    const tmp = this.path + '.tmp'
    const body = messages.map(m => JSON.stringify(m)).join('\n') + '\n'
    writeFileSync(tmp, MSG_MARKER + body, 'utf-8')
    renameSync(tmp, this.path)
  }
}

/** events.jsonl 存储 */
class JsonlEventStorage {
  private path: string
  private dir: string

  constructor(sessionDir: string) {
    this.dir = sessionDir
    this.path = join(sessionDir, 'events.jsonl')
  }

  private ensureDir(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
  }

  append(events: ConversationEvent[]): void {
    this.ensureDir()
    const lines = events.map(e => JSON.stringify(e)).join('\n') + '\n'
    if (!existsSync(this.path)) {
      appendFileSync(this.path, EVT_MARKER + lines, 'utf-8')
      return
    }
    appendFileSync(this.path, lines, 'utf-8')
  }

  load(): ConversationEvent[] {
    if (!existsSync(this.path)) return []
    const content = readFileSync(this.path, 'utf-8')
    if (!content.trim()) return []
    const lines = content.split('\n')
    const events: ConversationEvent[] = []
    let startIdx = 0
    const firstLine = lines[0]?.trim()
    if (firstLine) {
      try {
        const marker = JSON.parse(firstLine)
        if (marker.$schema) startIdx = 1
      } catch { /* not a marker */ }
    }
    for (let i = startIdx; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue
      try {
        events.push(JSON.parse(line) as ConversationEvent)
      } catch {
        process.stderr.write(`[events.jsonl] 第 ${i + 1} 行解析失败，已跳过\n`)
      }
    }
    return events
  }

  rewrite(events: ConversationEvent[]): void {
    this.ensureDir()
    const tmp = this.path + '.tmp'
    const body = events.map(e => JSON.stringify(e)).join('\n') + '\n'
    writeFileSync(tmp, EVT_MARKER + body, 'utf-8')
    renameSync(tmp, this.path)
  }
}

// ══════════════════════════════════════════════════════════════════
// 对话存储（双存储核心）
// ══════════════════════════════════════════════════════════════════

export class ConversationStore {
  // 主存储：ChatMessage[]（直接用于 LLM API）
  private messages: ChatMessage[] = []
  private msgStorage: JsonlMessageStorage | null = null
  private savedMsgCount = 0

  // 旁路日志：ConversationEvent[]（审计 + Gateway）
  private events: ConversationEvent[] = []
  private evtStorage: JsonlEventStorage | null = null
  private savedEvtCount = 0

  // LLM 投影预处理状态
  private latestPreprocessed: ContentBlock[] | null = null
  private prunedToolCallIds = new Set<string>()

  constructor(sessionDir?: string) {
    if (sessionDir) {
      this.msgStorage = new JsonlMessageStorage(sessionDir)
      this.evtStorage = new JsonlEventStorage(sessionDir)
    }
  }

  // ── 消息追加（主存储）──────────────────────────────────────────

  /** 追加 ChatMessage 到主存储 */
  appendMessage(...msgs: ChatMessage[]): void {
    if (msgs.length === 0) return
    this.messages.push(...msgs)
    this.saveMessages()
  }

  /** 追加消息但不持久化 */
  appendMessageNoSave(...msgs: ChatMessage[]): void {
    if (msgs.length === 0) return
    const BATCH = 5000
    for (let i = 0; i < msgs.length; i += BATCH) {
      this.messages.push(...msgs.slice(i, i + BATCH))
    }
  }

  // ── 事件追加（旁路日志）────────────────────────────────────────

  /** 追加事件到旁路日志 */
  appendEvents(...events: ConversationEvent[]): void {
    if (events.length === 0) return
    this.events.push(...events)
    this.saveEvents()
  }

  /** 追加事件但不持久化 */
  appendEventsNoSave(...events: ConversationEvent[]): void {
    if (events.length === 0) return
    const BATCH = 5000
    for (let i = 0; i < events.length; i += BATCH) {
      this.events.push(...events.slice(i, i + BATCH))
    }
  }

  // ── 替换（会话切换）────────────────────────────────────────────

  /** 替换整个消息日志（会话切换） */
  replaceMessages(messages: ChatMessage[]): void {
    if (!Array.isArray(messages)) {
      process.stderr.write('[ConversationStore] replaceMessages 收到非数组参数，已忽略\n')
      return
    }
    this.messages = [...messages]
    this.latestPreprocessed = null
    this.prunedToolCallIds.clear()
    this.savedMsgCount = 0
    this.forceRewriteMessages()
  }

  /** 替换整个事件日志 */
  replaceEvents(events: ConversationEvent[]): void {
    if (!Array.isArray(events)) {
      process.stderr.write('[ConversationStore] replaceEvents 收到非数组参数，已忽略\n')
      return
    }
    this.events = [...events]
    this.savedEvtCount = 0
    this.forceRewriteEvents()
  }

  // ── 访问器 ─────────────────────────────────────────────────────

  /** 获取完整消息日志（只读） */
  getMessages(): readonly ChatMessage[] {
    return this.messages
  }

  /** 获取完整事件日志（只读） */
  getEventLog(): readonly ConversationEvent[] {
    return this.events
  }

  /** 消息总数 */
  getMessageCount(): number {
    return this.messages.length
  }

  /** 事件总数 */
  getEventCount(): number {
    return this.events.length
  }

  /** 清空所有数据 */
  clear(): void {
    this.messages = []
    this.events = []
    this.latestPreprocessed = null
    this.prunedToolCallIds.clear()
    this.savedMsgCount = 0
    this.savedEvtCount = 0
    this.forceRewriteMessages()
    this.forceRewriteEvents()
  }

  // ── LLM 投影预处理状态 ────────────────────────────────────────

  setLatestPreprocessed(blocks: ContentBlock[] | null): void {
    this.latestPreprocessed = blocks
  }

  getLatestPreprocessed(): ContentBlock[] | null {
    return this.latestPreprocessed
  }

  markToolCallPruned(toolCallId: string): void {
    this.prunedToolCallIds.add(toolCallId)
  }

  isToolCallPruned(toolCallId: string): boolean {
    return this.prunedToolCallIds.has(toolCallId)
  }

  getPrunedToolCallIds(): Set<string> {
    return this.prunedToolCallIds
  }

  // ── 持久化 ────────────────────────────────────────────────────

  /** 从磁盘加载（messages.jsonl + events.jsonl） */
  loadFromDisk(sessionDir: string): void {
    if (!this.msgStorage) this.msgStorage = new JsonlMessageStorage(sessionDir)
    if (!this.evtStorage) this.evtStorage = new JsonlEventStorage(sessionDir)
    this.messages = this.msgStorage.load()
    this.events = this.evtStorage.load()
    this.savedMsgCount = this.messages.length
    this.savedEvtCount = this.events.length
  }

  /** 切换存储后端 */
  switchStorage(sessionDir: string): void {
    this.msgStorage = new JsonlMessageStorage(sessionDir)
    this.evtStorage = new JsonlEventStorage(sessionDir)
    this.messages = this.msgStorage.load()
    this.events = this.evtStorage.load()
    this.savedMsgCount = this.messages.length
    this.savedEvtCount = this.events.length
  }

  /** 增量保存消息到磁盘 */
  private saveMessages(): void {
    if (!this.msgStorage) return
    const newMsgs = this.messages.slice(this.savedMsgCount)
    if (newMsgs.length > 0) {
      this.msgStorage.append(newMsgs)
      this.savedMsgCount = this.messages.length
    }
  }

  /** 增量保存事件到磁盘 */
  private saveEvents(): void {
    if (!this.evtStorage) return
    const newEvts = this.events.slice(this.savedEvtCount)
    if (newEvts.length > 0) {
      this.evtStorage.append(newEvts)
      this.savedEvtCount = this.events.length
    }
  }

  /** 强制全量重写 messages.jsonl */
  private forceRewriteMessages(): void {
    if (!this.msgStorage) return
    this.msgStorage.rewrite(this.messages)
    this.savedMsgCount = this.messages.length
  }

  /** 强制全量重写 events.jsonl */
  private forceRewriteEvents(): void {
    if (!this.evtStorage) return
    this.evtStorage.rewrite(this.events)
    this.savedEvtCount = this.events.length
  }

  /**
   * 强制全量重写磁盘（兼容旧接口，clear/compact 后调用）
   */
  forceRewriteDisk(): void {
    this.forceRewriteMessages()
    this.forceRewriteEvents()
  }

  /** 保存到磁盘（兼容旧接口） */
  saveToDisk(): void {
    this.saveMessages()
    this.saveEvents()
  }
}

// ══════════════════════════════════════════════════════════════════
// 旧事件类型兼容（加载旧 events.jsonl 时使用）
// ══════════════════════════════════════════════════════════════════

/** 旧格式的事件类型（用于加载旧 events.jsonl 并迁移到新格式） */
export interface LegacyUserMessageEvent {
  type: 'user_message'
  id: string
  timestamp: number
  requestId?: string
  trigger?: 'user' | 'cron'
  cronDescription?: string
  content: string
  images?: string[]
}

export interface LegacyAssistantMessageEvent {
  type: 'assistant_message'
  id: string
  timestamp: number
  requestId?: string
  text: string
  thinking?: string
  toolCalls?: Array<{ id: string; name: string; input: unknown }>
}

export interface LegacyToolResultEvent {
  type: 'tool_result'
  id: string
  timestamp: number
  requestId?: string
  toolCallId: string
  toolName: string
  content: string
  isError: boolean
}

export interface LegacyCompactEvent {
  type: 'compact'
  id: string
  timestamp: number
  requestId?: string
  summary: string
}

export interface LegacyRequestCompleteEvent {
  type: 'request_complete'
  id: string
  timestamp: number
  requestId?: string
  status: string
  totalTurns: number
  totalToolCalls: number
  durationMs: number
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  error?: string
}

export interface LegacySystemEvent {
  type: 'system_event'
  id: string
  timestamp: number
  requestId?: string
  kind: string
  content: string
  cronDescription?: string
}

export interface LegacyToolExecutionEvent {
  type: 'tool_execution'
  id: string
  timestamp: number
  requestId?: string
  toolCallId: string
  toolName: string
  durationMs: number
  status: string
  outputPreview?: string
  errorSummary?: string
}

export type LegacyConversationEvent =
  | LegacyUserMessageEvent
  | LegacyAssistantMessageEvent
  | LegacyToolResultEvent
  | LegacyCompactEvent
  | LegacyRequestCompleteEvent
  | LegacySystemEvent
  | LegacyToolExecutionEvent

/**
 * 将旧格式事件日志转换为 ChatMessage[]（主存储格式）。
 * 用于迁移旧会话数据。
 */
export function migrateEventsToMessages(events: LegacyConversationEvent[]): ChatMessage[] {
  const messages: ChatMessage[] = []

  for (const ev of events) {
    switch (ev.type) {
      case 'user_message':
        messages.push({
          role: 'user',
          content: ev.content,
          timestamp: ev.timestamp,
          requestId: ev.requestId,
          ...(ev.images ? { images: ev.images } : {}),
          ...(ev.trigger ? { trigger: ev.trigger } : {}),
          ...(ev.cronDescription ? { cronDescription: ev.cronDescription } : {}),
        })
        break

      case 'assistant_message':
        messages.push({
          role: 'assistant',
          content: ev.text || null,
          timestamp: ev.timestamp,
          requestId: ev.requestId,
          ...(ev.thinking ? { thinking: ev.thinking } : {}),
          ...(ev.toolCalls && ev.toolCalls.length > 0 ? { tool_calls: ev.toolCalls } : {}),
        })
        break

      case 'tool_result':
        messages.push({
          role: 'tool',
          content: ev.content,
          tool_call_id: ev.toolCallId,
          name: ev.toolName,
          is_error: ev.isError,
          timestamp: ev.timestamp,
          requestId: ev.requestId,
        })
        break

      case 'compact':
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

      case 'system_event':
        messages.push({
          role: 'user',
          content: ev.content,
          timestamp: ev.timestamp,
          requestId: ev.requestId,
        })
        break

      // request_complete, tool_execution 不转换为消息
      case 'request_complete':
      case 'tool_execution':
        break
    }
  }

  return messages
}
