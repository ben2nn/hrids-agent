// 事件溯源对话存储 — 单一数据源 + 双投影
//
// 架构：
//   eventLog (append-only) ──┬──► projectForDisplay() ──► DisplayMessage[]
//                            └──► projectForLLM()     ──► ChatMessage[]
//
// 事件是不可变的，所有优化（prune/budget/compact）在投影层处理，
// 不修改原始事件。

// ── 事件类型定义 ────────────────────────────────────────────────

/** 用户消息事件 */
export interface UserMessageEvent {
  type: 'user_message'
  id: string
  timestamp: number
  requestId?: string
  trigger?: 'user' | 'cron'
  cronDescription?: string
  content: string          // 原始文本（含 @filename，不含 base64）
  images?: string[]        // 关联的图片路径列表
}

/** 助手消息事件（可能包含文本和/或工具调用） */
export interface AssistantMessageEvent {
  type: 'assistant_message'
  id: string
  timestamp: number
  requestId?: string
  text: string             // 助手文本回复
  toolCalls?: ToolCallEvent[]
}

export interface ToolCallEvent {
  id: string
  name: string
  input: unknown
}

/** 工具结果事件 */
export interface ToolResultEvent {
  type: 'tool_result'
  id: string
  timestamp: number
  requestId?: string
  toolCallId: string       // 对应的 tool_use id
  toolName: string
  content: string          // 工具输出内容
  isError: boolean
}

/** 上下文压缩事件（summary 存储在事件中，原始事件保留不删除） */
export interface CompactEvent {
  type: 'compact'
  id: string
  timestamp: number
  requestId?: string
  summary: string
}

/** 请求完成事件 —— 标记一轮用户请求的 LLM 执行全部结束 */
export interface RequestCompleteEvent {
  type: 'request_complete'
  id: string
  timestamp: number
  requestId?: string
  status: 'completed' | 'error' | 'aborted' | 'turn_limit' | 'budget_exceeded' | 'permission_denied'
  totalTurns: number        // LLM 调用轮次
  totalToolCalls: number    // 工具调用总次数
  durationMs: number        // 从请求开始到结束的总耗时
  inputTokens?: number      // 本次请求消耗的输入 token
  outputTokens?: number     // 本次请求消耗的输出 token
  costUsd?: number          // 本次请求的费用
  error?: string            // status=error 时的错误信息
}

/** 所有事件类型的联合 */
export type ConversationEvent =
  | UserMessageEvent
  | AssistantMessageEvent
  | ToolResultEvent
  | CompactEvent
  | RequestCompleteEvent

// ── 事件工厂函数 ────────────────────────────────────────────────

let _nextId = 0
function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${++_nextId}`
}

export function createUserMessageEvent(
  content: string,
  requestId?: string,
  trigger?: 'user' | 'cron',
  cronDescription?: string,
  images?: string[],
): UserMessageEvent {
  return {
    type: 'user_message',
    id: genId('user'),
    timestamp: Date.now(),
    requestId,
    trigger,
    cronDescription,
    content,
    ...(images && images.length > 0 ? { images } : {}),
  }
}

export function createAssistantMessageEvent(
  text: string,
  toolCalls?: ToolCallEvent[],
  requestId?: string,
): AssistantMessageEvent {
  return {
    type: 'assistant_message',
    id: genId('asst'),
    timestamp: Date.now(),
    requestId,
    text,
    ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
  }
}

export function createToolResultEvent(
  toolCallId: string,
  toolName: string,
  content: string,
  isError: boolean,
  requestId?: string,
): ToolResultEvent {
  return {
    type: 'tool_result',
    id: genId('tres'),
    timestamp: Date.now(),
    requestId,
    toolCallId,
    toolName,
    content,
    isError,
  }
}

export function createCompactEvent(summary: string, requestId?: string): CompactEvent {
  return {
    type: 'compact',
    id: genId('comp'),
    timestamp: Date.now(),
    requestId,
    summary,
  }
}

export function createRequestCompleteEvent(
  requestId: string | undefined,
  status: RequestCompleteEvent['status'],
  totalTurns: number,
  totalToolCalls: number,
  durationMs: number,
  inputTokens?: number,
  outputTokens?: number,
  costUsd?: number,
  error?: string,
): RequestCompleteEvent {
  return {
    type: 'request_complete',
    id: genId('rc'),
    timestamp: Date.now(),
    requestId,
    status,
    totalTurns,
    totalToolCalls,
    durationMs,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(error ? { error } : {}),
  }
}

// ── 持久化接口 ──────────────────────────────────────────────────

export interface EventStorage {
  saveEvents(events: ConversationEvent[]): void
  loadEvents(): ConversationEvent[]
}

// ── 投影类型 ────────────────────────────────────────────────────

export interface DisplayToolCard {
  id: string
  name: string
  input: unknown
  status: 'success' | 'error'
  result?: unknown
  requestId?: string
  timestamp: number
}

export interface DisplayMessage {
  role: 'user' | 'assistant'
  content: string
  images?: string[]
  isCron?: boolean
  cronDescription?: string
  requestId?: string
  timestamp: number
  toolCards?: DisplayToolCard[]
}

// ── 对话存储 ────────────────────────────────────────────────────

export class ConversationStore {
  private eventLog: ConversationEvent[] = []
  private storage: EventStorage | null = null
  private savedEventCount = 0

  // LLM 投影的预处理状态
  /** 最新用户消息的预处理结果（含 image block），投影时替换原始文本 */
  private latestPreprocessed: import('./QueryEngine.js').ContentBlock[] | null = null
  /** 因 prune 被清除的 toolCallId 集合，LLM 投影时跳过对应的 tool_use */
  private prunedToolCallIds = new Set<string>()

  constructor(storage?: EventStorage) {
    this.storage = storage ?? null
  }

  // ── 事件追加 ──────────────────────────────────────────────────

  /** 追加事件到日志并持久化 */
  appendEvents(...events: ConversationEvent[]): void {
    if (events.length === 0) return
    this.eventLog.push(...events)
    this.saveToDisk()
  }

  /** 追加事件但不持久化（用于批量导入后手动调用 saveToDisk） */
  appendEventsNoSave(...events: ConversationEvent[]): void {
    if (events.length === 0) return
    this.eventLog.push(...events)
  }

  /** 替换整个事件日志（用于会话切换），并全量重写磁盘 */
  replaceEvents(events: ConversationEvent[]): void {
    this.eventLog = [...events]
    this.latestPreprocessed = null
    this.prunedToolCallIds.clear()
    this.savedEventCount = 0
    this.forceRewriteDisk()
  }

  // ── 访问器 ────────────────────────────────────────────────────

  /** 获取完整事件日志（只读） */
  getEventLog(): readonly ConversationEvent[] {
    return this.eventLog
  }

  /** 事件总数 */
  getEventCount(): number {
    return this.eventLog.length
  }

  /** 清空所有事件 */
  clear(): void {
    this.eventLog = []
    this.latestPreprocessed = null
    this.prunedToolCallIds.clear()
    this.savedEventCount = 0
    this.saveToDisk()
  }

  // ── LLM 投影预处理状态 ────────────────────────────────────────

  /**
   * 设置最新用户消息的预处理结果。
   * QueryEngine 在调用 LLM 前，将含 image block 的 ContentBlock[] 传入，
   * 投影时会替换原始文本版本。
   */
  setLatestPreprocessed(blocks: import('./QueryEngine.js').ContentBlock[] | null): void {
    this.latestPreprocessed = blocks
  }

  getLatestPreprocessed(): import('./QueryEngine.js').ContentBlock[] | null {
    return this.latestPreprocessed
  }

  /** 标记 toolCallId 对应的 tool_result 已被 prune，LLM 投影时跳过该 tool_use */
  markToolCallPruned(toolCallId: string): void {
    this.prunedToolCallIds.add(toolCallId)
  }

  isToolCallPruned(toolCallId: string): boolean {
    return this.prunedToolCallIds.has(toolCallId)
  }

  // ── 持久化 ────────────────────────────────────────────────────

  /** 加载事件：优先从 events.jsonl，降级到 transcript.jsonl */
  loadFromDisk(sessionDir: string): void {
    if (!this.storage) {
      this.storage = new JsonlEventStorage(sessionDir)
    }
    this.eventLog = this.storage.loadEvents()
    this.savedEventCount = this.eventLog.length
  }

  /** 增量保存新事件到磁盘 */
  saveToDisk(): void {
    if (!this.storage) return

    const newEvents = this.eventLog.slice(this.savedEventCount)
    if (newEvents.length > 0) {
      this.storage.saveEvents(newEvents)
      this.savedEventCount = this.eventLog.length
    }
  }

  /**
   * 强制全量重写磁盘（用于 clearHistory 或 compact 后事件数减少的情况）。
   * 注意：事件日志是 append-only，正常情况下不会减少。
   * 此方法主要用于兼容旧的 clearHistory 语义。
   */
  forceRewriteDisk(): void {
    if (!this.storage) return
    // 重新初始化存储会清空文件并重写
    if (this.storage instanceof JsonlEventStorage) {
      this.storage.rewrite(this.eventLog)
    }
    this.savedEventCount = this.eventLog.length
  }
}

// ── JSONL 事件存储实现 ──────────────────────────────────────────

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync } from 'fs'
import { join } from 'path'

export class JsonlEventStorage implements EventStorage {
  private eventsPath: string

  constructor(sessionDir: string) {
    this.eventsPath = join(sessionDir, 'events.jsonl')
    if (!existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true })
    }
  }

  saveEvents(events: ConversationEvent[]): void {
    const lines = events.map(e => JSON.stringify(e)).join('\n') + '\n'
    appendFileSync(this.eventsPath, lines, 'utf-8')
  }

  loadEvents(): ConversationEvent[] {
    // 优先加载新格式
    if (existsSync(this.eventsPath)) {
      const content = readFileSync(this.eventsPath, 'utf-8')
      if (!content.trim()) return []
      return content
        .split('\n')
        .filter(line => line.trim())
        .map(line => JSON.parse(line) as ConversationEvent)
    }

    return []
  }

  /** 全量重写事件文件 */
  rewrite(events: ConversationEvent[]): void {
    const tmp = this.eventsPath + '.tmp'
    const content = events.map(e => JSON.stringify(e)).join('\n') + '\n'
    writeFileSync(tmp, content, 'utf-8')
    renameSync(tmp, this.eventsPath)
  }
}
