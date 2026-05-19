import type { LLMProvider } from './providers/index.js'
import type { ToolDef } from './tool.js'
import type { ToolRegistry } from './tool-registry.js'
import type { PermissionManager, PermissionRequest } from './permission-manager.js'
import { CostTracker } from './cost-tracker.js'
import { logger, modelLog } from '../shared/logger.js'
import { loadTodos, type Todo } from '../tools/todo-tool.js'
import { clearFileCache } from '../tools/file-read-tool.js'
import { extractMediaFromText } from './media-processor.js'
import { HEARTBEAT_CONTINUE, HEARTBEAT_DONE } from '../coordinator/coordinator-prompt.js'
import {
  ConversationStore,
  type ChatMessage, type ContentBlock, type ImageSource,
} from './conversation-store.js'
import { projectForDisplay, projectForLLM, estimateEventTokens, applyToolResultBudget, pruneOldToolResults, pruneOldImageBlocks } from './projections.js'

import { StormBreaker } from './storm-breaker.js'
import { EventBridge } from './event-bridge.js'
import { ToolExecutor } from './tool-executor.js'
import type { RuntimeEvent } from './runtime-event.js'
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_MAX_TURNS,
  DEFAULT_AUTO_COMPACT_THRESHOLD,
  ABSOLUTE_MAX_MULTIPLIER,
  BUDGET_WARN_RATIO,
  MAX_OUTPUT_TOKENS_RECOVERY_LIMIT,
  MAX_INTENT_RECOVERY_LIMIT,
} from './engine-constants.js'

const log = logger.child({ component: 'query-engine' })

type TurnResultEvent =
  | {
      type: '__llm_result__'
      fullText: string
      thinkingText: string
      thinkingSignature?: string
      toolCalls: Array<{ id: string; name: string; input: unknown }>
      hitMaxOutputTokens: boolean
    }
  | { type: '__llm_error__' }
  | { type: '__budget_exceeded__' }

/**
 * 检测 LLM 输出是否为"意图声明"——说了要做某事但没实际执行。
 * 典型模式：短文本 + 包含意图动词 + 无实质内容。
 */
export function isIntentDeclaration(text: string): boolean {
  const trimmed = text.trim()
  // 空文本不算
  if (trimmed.length === 0) return false
  // 文本过长说明有实质内容，不是纯意图声明
  if (trimmed.length > 100) return false

  // 排除模式：包含这些标记说明有实质内容，不是纯意图声明
  const exclusionPatterns = [
    /[:：]/,                              // 冒号后通常跟解释内容
    /因为|所以|因此|原因是|理由是/,          // 因果解释
    /这是|该|其|它们?的是/,                 // 指代说明
    /```/,                                // 代码块
    /如下|例如|比如|具体来说|举例/,          // 展开说明
    /可以通过|方法是|步骤是|做法是/,          // 方法描述
    /\d+\.\s/,                            // 有序列表
    /[-•]\s/,                             // 无序列表
  ]
  if (exclusionPatterns.some(p => p.test(trimmed))) return false

  // 意图声明模式：主语 + 意图动词（仅匹配短而无实质内容的文本）
  const intentPatterns = [
    /^我来[^\n]{2,20}$/,                  // 我来扫描项目
    /^让我[^\n]{2,20}$/,                  // 让我检查一下
    /我需要(查看|分析|了解|检查|扫描|读取|确认|探索|研究)[^\n]{0,10}$/,
    /接下来(分析|查看|检查|扫描|探索)$/,
    /^首先(了解|查看|分析|探索|扫描)[^\n]{0,10}$/,
    /^先(探索|了解|查看|分析|扫描)[^\n]{0,10}$/,
    /我先[^\n]{2,15}然后[^\n]{2,15}$/,   // 我先X，然后Y
    /^并行(扫描|分析|查看|检查)[^\n]{0,15}$/,
  ]

  const matchCount = intentPatterns.filter(p => p.test(trimmed)).length
  // 短文本（<50字符）只要有 1 个意图模式就判定为意图声明
  // 50-100 字符需要 2+ 个模式匹配
  return trimmed.length < 50 ? matchCount >= 1 : matchCount >= 2
}

/**
 * 根据会话级任务快照构建任务状态字符串，注入到 system prompt。
 */
function buildLiveTodoContext(snapshot: Todo[] | null): string | null {
  if (snapshot === null) return null

  try {
    const active = snapshot.filter(t => t.status !== 'completed')
    if (active.length === 0) {
      if (snapshot.length === 0) return null
      return `## 当前任务状态（实时）\n进度：${snapshot.length}/${snapshot.length}（全部完成）\n请直接输出最终结果，不要再调用任何任务工具。`
    }

    const completedCount = snapshot.filter(t => t.status === 'completed').length
    const lines: string[] = [
      '## 当前任务状态（实时）',
      `进度：${completedCount}/${snapshot.length}`,
    ]

    for (const t of active) {
      const icon = t.status === 'in_progress' ? '▸' : '○'
      lines.push(`${icon} [${t.id}] ${t.content}`)

      if (t.status === 'in_progress') {
        if (t.context) {
          lines.push(`  背景：${t.context}`)
        }
        if (t.dependsOn && t.dependsOn.length > 0) {
          lines.push(`  依赖：${t.dependsOn.join(', ')}`)
        }
        if (t.acceptance && t.acceptance.length > 0) {
          lines.push('  验收标准：')
          t.acceptance.forEach((a, i) => {
            lines.push(`    □ [${i}] ${a}`)
          })
        }
      }
    }

    const inProgress = active.find(t => t.status === 'in_progress')
    if (inProgress) {
      lines.push(`当前执行中：「${inProgress.content}」（id: ${inProgress.id}）`)
      if (inProgress.acceptance && inProgress.acceptance.length > 0) {
        const trueArr = inProgress.acceptance.map(() => 'true').join(', ')
        lines.push(`完成后调用：todo_update(id='${inProgress.id}', status='completed', confirmations=[${trueArr}])`)
      } else {
        lines.push(`完成后调用：todo_update(id='${inProgress.id}', status='completed')`)
      }
    }

    return lines.join('\n')
  } catch {
    return null
  }
}

export interface Message {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
  timestamp?: number
  requestId?: string
  trigger?: 'user' | 'cron'
  cronDescription?: string
}

export interface QueryEngineConfig {
  provider: LLMProvider
  systemPrompt: string[]
  registry: ToolRegistry
  permissions: PermissionManager
  maxTokens?: number
  maxTurns?: number
  maxBudgetUsd?: number
  autoCompactThreshold?: number
  sessionCwd?: string
  uploadsDir?: string
  sessionId?: string
  resumed?: boolean
}

export class QueryEngine {
  private config: QueryEngineConfig
  readonly store: ConversationStore
  private abortController: AbortController
  private running = false
  readonly costs: CostTracker
  private previousSummary: string | null = null
  onBeforeCompact: ((summary: string) => Promise<void>) | null = null
  onBeforeSend: ((message: string) => Promise<void>) | null = null
  onAfterSend: (() => void) | null = null
  onPermissionRequest: ((req: PermissionRequest) => Promise<boolean>) | null = null
  private currentRequestId: string | null = null
  private currentTrigger: 'user' | 'cron' = 'user'
  private currentCronDescription: string | undefined = undefined
  private activeTodoSnapshot: Todo[] | null = null
  private stormBreaker = new StormBreaker()
  private chatMode = false

  /** ToolExecutor — 工具执行生命周期 */
  private toolExecutor: ToolExecutor

  constructor(config: QueryEngineConfig, store?: ConversationStore) {
    this.config = config
    this.store = store ?? new ConversationStore()
    this.abortController = new AbortController()
    this.costs = new CostTracker(config.provider.model)

    // 初始化 ToolExecutor（events 在 run() 中更新）
    this.toolExecutor = new ToolExecutor(
      config.registry,
      config.permissions,
      new EventBridge(this.store, []), // 临时实例，run() 时重建
      {
        getAbortSignal: () => this.abortController.signal,
        getStormBreaker: () => this.stormBreaker,
        getOnPermissionRequest: () => this.onPermissionRequest ?? undefined,
        onTodoSnapshotRefresh: (snapshot) => { this.activeTodoSnapshot = snapshot },
      },
    )

    // 写入 session_opened 事件
    const events = new EventBridge(this.store, [])
    events.sessionOpened(config.sessionId ?? 'unknown', config.resumed ?? false)
  }

  setRequestId(requestId: string): void {
    this.currentRequestId = requestId
  }

  setTrigger(trigger: 'user' | 'cron', cronDescription?: string): void {
    this.currentTrigger = trigger
    this.currentCronDescription = cronDescription
  }

  // ── 摘要生成 ─────────────────────────────────────────────────────

  private serializeForSummary(displayMsgs: import('./ConversationStore.js').DisplayMessage[]): string {
    return displayMsgs.map(dm => {
      const role = dm.role === 'user' ? '用户' : '助手'
      const parts: string[] = []
      if (dm.content) parts.push(dm.content.slice(0, 3000))
      if (dm.toolCards) {
        for (const tc of dm.toolCards) {
          const args = JSON.stringify(tc.input)
          parts.push(`[工具调用: ${tc.name}(${args.length > 400 ? args.slice(0, 400) + '...' : args})]`)
        }
      }
      return `[${role}]: ${parts.join('\n')}`
    }).join('\n\n')
  }

  async generateCompactSummary(): Promise<string> {
    const contentToSummarize = this.serializeForSummary(projectForDisplay(this.store.getMessages()))

    let summaryPrompt: string
    if (this.previousSummary) {
      summaryPrompt = `你正在更新一份上下文压缩摘要。之前的压缩已生成以下摘要，现在有新的对话轮次需要合并进去。

## 上次摘要
${this.previousSummary}

## 新增对话内容
${contentToSummarize}

请按以下结构更新摘要。保留所有仍然相关的信息，将新进展合并进去，将"进行中"的工作标记为"已完成"（如果已完成）。

## 目标
[用户想要完成的事情]

## 约束与偏好
[用户偏好、编码风格、重要决策]

## 进展
### 已完成
[已完成的工作，包含具体文件路径、命令、结果]
### 进行中
[当前正在进行的工作]
### 受阻
[遇到的阻碍或问题]

## 关键决策
[重要的技术决策及原因]

## 相关文件
[已读取、修改或创建的文件，附简要说明]

## 下一步
[继续工作需要做的事情]

## 关键上下文
[不显式保留就会丢失的具体值、错误信息、配置细节]

只输出摘要正文，不要包含任何前言或前缀。`
    } else {
      summaryPrompt = `为后续助手创建一份结构化交接摘要，以便在早期对话轮次被压缩后继续工作。

## 待摘要的对话内容
${contentToSummarize}

请使用以下结构：

## 目标
[用户想要完成的事情]

## 约束与偏好
[用户偏好、编码风格、重要决策]

## 进展
### 已完成
[已完成的工作，包含具体文件路径、命令、结果]
### 进行中
[当前正在进行的工作]
### 受阻
[遇到的阻碍或问题]

## 关键决策
[重要的技术决策及原因]

## 相关文件
[已读取、修改或创建的文件，附简要说明]

## 下一步
[继续工作需要做的事情]

## 关键上下文
[不显式保留就会丢失的具体值、错误信息、配置细节]

只输出摘要正文，不要包含任何前言或前缀。`
    }

    let summary = ''
    try {
      for await (const chunk of this.config.provider.stream(
        [{ role: 'user', content: summaryPrompt }],
        [],
        ['你是一个对话摘要助手，请生成简洁准确的结构化摘要。'],
        DEFAULT_MAX_TOKENS,
      )) {
        if (chunk.type === 'text_delta' && chunk.delta) {
          summary += chunk.delta
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err)
      log.warn('摘要生成失败，使用兜底文本', { error: errMsg })
      summary = `[对话历史摘要：共 ${this.store.getMessageCount()} 条消息，因摘要生成失败而截断]`
    }

    const result = summary || `[对话历史：${this.store.getMessageCount()} 条消息]`
    this.previousSummary = result
    return result
  }

  // ── 流式调用 LLM ─────────────────────────────────────────────────

  private async *streamOneTurn(
    turns: number,
    maxBudgetUsd: number | undefined,
    events: EventBridge,
  ): AsyncGenerator<RuntimeEvent | TurnResultEvent> {
    let fullText = ''
    let thinkingText = ''
    let thinkingSignature: string | undefined
    const toolCalls: Array<{ id: string; name: string; input: unknown }> = []
    let hitMaxOutputTokens = false

    const isPlanMode = this.config.permissions.getMode() === 'plan'
    const toolsForLLM = this.chatMode
      ? []
      : this.config.registry.getToolsForLLM(isPlanMode)

    log.debug('调用 LLM stream', { model: this.config.provider.model, turn: turns })

    try {
      const liveTodo = buildLiveTodoContext(this.activeTodoSnapshot)
      const systemPromptForThisTurn = liveTodo
        ? [...this.config.systemPrompt, liveTodo]
        : this.config.systemPrompt

      const rawMessages = projectForLLM(this.store.getMessages())

      const { messages: afterOldPrune, prunedIds: oldPruned } = pruneOldToolResults(rawMessages)
      const { messages: afterBudget, prunedIds: budgetPruned } = applyToolResultBudget(afterOldPrune)
      const projectedMessages = pruneOldImageBlocks(afterBudget)

      for (const id of oldPruned) this.store.markToolCallPruned(id)
      for (const id of budgetPruned) this.store.markToolCallPruned(id)

      const llmStartTime = Date.now()
      events.modelTurnStarted(this.config.provider.model, this.config.provider.name ?? 'unknown')

      for await (const chunk of this.config.provider.stream(
        projectedMessages as import('./providers/types.js').ChatMessage[],
        toolsForLLM,
        systemPromptForThisTurn,
        this.config.maxTokens ?? DEFAULT_MAX_TOKENS,
        this.abortController.signal,
      )) {
        if (this.abortController.signal.aborted) break

        if (chunk.type === 'thinking_delta' && chunk.delta) {
          thinkingText += chunk.delta
          modelLog.write('[stream] thinking_delta', { len: chunk.delta.length, total: thinkingText.length })
          events.thinkingDelta(chunk.delta)
        } else if (chunk.type === 'text_delta' && chunk.delta) {
          fullText += chunk.delta
          modelLog.write('[stream] text_delta', { len: chunk.delta.length, total: fullText.length })
          events.textDelta(chunk.delta)
        } else if (chunk.type === 'tool_call' && chunk.toolCall) {
          toolCalls.push(chunk.toolCall)
          modelLog.write('[stream] tool_call', { name: chunk.toolCall.name, id: chunk.toolCall.id })
        } else if (chunk.type === 'done') {
          if (chunk.thinkingSignature) thinkingSignature = chunk.thinkingSignature
          modelLog.write('[stream] provider done', { fullTextLen: fullText.length, thinkingLen: thinkingText.length, toolCalls: toolCalls.length })
        } else if (chunk.type === 'usage' && chunk.usage) {
          this.costs.add({
            inputTokens: chunk.usage.inputTokens,
            outputTokens: chunk.usage.outputTokens,
            cacheReadTokens: chunk.usage.cacheReadTokens ?? 0,
            cacheWriteTokens: chunk.usage.cacheWriteTokens ?? 0,
          })
          const costUsd = this.costs.getCostUsd()
          events.usage(chunk.usage.inputTokens, chunk.usage.outputTokens, costUsd)
          if (maxBudgetUsd !== undefined && costUsd >= maxBudgetUsd) {
            events.budgetExceeded(costUsd, maxBudgetUsd)
            yield { type: '__budget_exceeded__' }
            return
          }
        } else if (chunk.type === 'stop_reason' && chunk.stopReason === 'max_tokens') {
          hitMaxOutputTokens = true
        }
      }

      const llmUsage = this.costs.getUsage()
      events.modelTurnEnded(Date.now() - llmStartTime, llmUsage.inputTokens, llmUsage.outputTokens)
    } catch (err) {
      const errMsg = String(err)
      log.error('LLM 请求失败', { turn: turns, error: errMsg })
      events.error(`LLM 请求失败: ${errMsg}`, !this.abortController.signal.aborted)
      events.interrupted('error', `LLM 请求失败: ${errMsg}`)
      if (!this.abortController.signal.aborted) {
        const recoveryMsg = `[系统提示] 上次执行因错误中断: ${errMsg}。请从中断处继续完成任务。`
        this.store.appendMessage({
          role: 'user', content: recoveryMsg,
          timestamp: Date.now(), requestId: this.currentRequestId ?? undefined,
        })
        events.userMessage(recoveryMsg, 'user')
      }
      yield { type: '__llm_error__' }
      return
    }

    yield { type: '__llm_result__', fullText, thinkingText, thinkingSignature, toolCalls, hitMaxOutputTokens }
  }

  // ── 心跳协议 ─────────────────────────────────────────────────────

  private resolveHeartbeat(
    fullText: string,
    hitMaxOutputTokens: boolean,
    recoveryCount: number,
    intentRecoveryCount: number,
    turns: number,
    maxTurns: number,
    events: EventBridge,
  ): { action: 'break' | 'continue'; newRecoveryCount: number; newIntentRecoveryCount: number } {
    log.debug('本轮无工具调用', { turn: turns, textLength: fullText.length })

    if (hitMaxOutputTokens && recoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
      const newCount = recoveryCount + 1
      log.info('输出被截断，注入继续指令', { turn: turns, recovery: newCount })
      events.recoveryMaxOutput(newCount, MAX_OUTPUT_TOKENS_RECOVERY_LIMIT)
      this.store.appendMessage({
        role: 'user', content: '[系统内部] 输出已被截断。请直接从中断处继续，不要重复已输出的内容，不要道歉或解释。',
        timestamp: Date.now(), requestId: this.currentRequestId ?? undefined,
      })
      events.userMessage('[系统内部] 输出已被截断。请直接从中断处继续，不要重复已输出的内容，不要道歉或解释。', 'user')
      return { action: 'continue', newRecoveryCount: newCount, newIntentRecoveryCount: intentRecoveryCount }
    }

    if (fullText.includes(HEARTBEAT_DONE)) {
      log.debug('心跳协议：DONE，停止执行', { turn: turns })
      return { action: 'break', newRecoveryCount: recoveryCount, newIntentRecoveryCount: intentRecoveryCount }
    }

    const allTasksDone = this.activeTodoSnapshot !== null &&
      this.activeTodoSnapshot.length > 0 &&
      this.activeTodoSnapshot.every(t => t.status === 'completed')
    if (allTasksDone) {
      log.debug('任务系统确认全部完成，停止执行', { turn: turns })
      return { action: 'break', newRecoveryCount: recoveryCount, newIntentRecoveryCount: intentRecoveryCount }
    }

    if (fullText.includes(HEARTBEAT_CONTINUE)) {
      if (turns < maxTurns) {
        log.debug('心跳协议：CONTINUE（无工具调用），继续', { turn: turns })
        return { action: 'continue', newRecoveryCount: recoveryCount, newIntentRecoveryCount: intentRecoveryCount }
      }
      log.debug('心跳协议：CONTINUE 但已达轮次上限，停止', { turn: turns })
    }

    // 意图声明检测：LLM 说了"要做X"但没实际执行
    if (!this.chatMode && intentRecoveryCount < MAX_INTENT_RECOVERY_LIMIT && turns < maxTurns && isIntentDeclaration(fullText)) {
      const newCount = intentRecoveryCount + 1
      log.info('检测到意图声明，注入继续指令', { turn: turns, recovery: newCount, textLen: fullText.length })
      const recoveryMsg = '[系统内部] 你刚才只表达了意图但没有实际执行。请立即调用工具完成任务，不要输出计划或意图声明，直接开始执行。'
      this.store.appendMessage({
        role: 'user', content: recoveryMsg,
        timestamp: Date.now(), requestId: this.currentRequestId ?? undefined,
      })
      events.userMessage(recoveryMsg, 'user')
      return { action: 'continue', newRecoveryCount: recoveryCount, newIntentRecoveryCount: newCount }
    }

    log.debug('无工具调用无心跳标记，自然结束', { turn: turns })
    return { action: 'break', newRecoveryCount: recoveryCount, newIntentRecoveryCount: intentRecoveryCount }
  }

  // ── 媒体预处理 ───────────────────────────────────────────────────

  private async preprocessUserMessage(text: string): Promise<string | ContentBlock[]> {
    const cwd = this.config.sessionCwd ?? process.cwd()
    const { attachments, cleanText, errors } = await extractMediaFromText(text, cwd, this.config.uploadsDir)

    if (attachments.length === 0) {
      return text
    }

    const blocks: ContentBlock[] = []

    let textContent = cleanText
    if (errors.length > 0) {
      textContent += `\n\n[媒体加载失败]\n${errors.join('\n')}`
    }
    if (textContent.trim()) {
      blocks.push({ type: 'text', text: textContent })
    }

    for (const att of attachments) {
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          mediaType: att.mediaType as ImageSource['mediaType'],
          data: att.data,
        },
      })
    }

    return blocks
  }

  // ── 主循环 run() ─────────────────────────────────────────────────

  async *run(userMessage: string | Message): AsyncGenerator<RuntimeEvent> {
    // 并发保护
    if (this.running) {
      log.warn('并发保护触发：上一个任务仍在执行中', { historyLength: this.store.getMessageCount() })
      yield { type: 'error', message: '上一个任务仍在执行中，请等待完成后再发送新消息' }
      return
    }
    this.running = true
    this.abortController = new AbortController()

    // 请求级状态
    const requestStartTime = Date.now()
    this.costs.reset()
    const costBefore = this.costs.getCostUsd()
    const usageBefore = this.costs.getUsage()
    let exitStatus: 'completed' | 'error' | 'aborted' | 'turn_limit' | 'budget_exceeded' | 'permission_denied' = 'completed'
    this.toolExecutor.resetCounter()
    this.stormBreaker.reset()
    let errorMessage: string | undefined

    // 创建 EventBridge（新 requestId）
    const runtimeBuffer: RuntimeEvent[] = []
    const requestId = this.currentRequestId ?? `req-${Date.now()}`
    const events = new EventBridge(this.store, runtimeBuffer, requestId)

    // 更新 ToolExecutor 的 events
    this.toolExecutor.updateEvents(events)
    this.toolExecutor.resetCounter()

    // drainRuntimeBuffer: 取出 buffer 中所有事件
    const drainRuntimeBuffer = (): RuntimeEvent[] => {
      const items = [...runtimeBuffer]
      runtimeBuffer.length = 0
      return items
    }

    // 提取消息文本
    const msgText = typeof userMessage === 'string'
      ? userMessage
      : (Array.isArray((userMessage as Message).content)
          ? ((userMessage as Message).content as ContentBlock[])
              .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
              .map(b => b.text).join('')
          : String((userMessage as Message).content))

    // onBeforeSend 钩子
    if (this.onBeforeSend) {
      try { await this.onBeforeSend(msgText) } catch { /* 钩子失败不阻断执行 */ }
    }

    // 预处理用户消息
    let processedContent: string | ContentBlock[] = typeof userMessage === 'string' ? userMessage : (userMessage as Message).content
    if (typeof processedContent === 'string' && this.config.sessionCwd) {
      try {
        processedContent = await this.preprocessUserMessage(processedContent)
      } catch (err) {
        log.warn('图片预处理失败', { error: String(err) })
      }
    }
    const hasImageBlocks = Array.isArray(processedContent) &&
      (processedContent as ContentBlock[]).some(b => b.type === 'image')

    const originalText = typeof userMessage === 'string' ? userMessage : msgText

    if (hasImageBlocks) {
      this.store.setLatestPreprocessed(
        Array.isArray(processedContent) ? processedContent as ContentBlock[] : null,
      )
    }

    // 写入用户消息
    this.store.appendMessage({
      role: 'user', content: originalText,
      timestamp: Date.now(), requestId,
      trigger: this.currentTrigger, cronDescription: this.currentCronDescription,
      images: hasImageBlocks ? (processedContent as ContentBlock[]).filter(b => b.type === 'image').map(b => ((b as { type: 'image'; source: ImageSource }).source.url) ?? '') : undefined,
    })
    events.userMessage(originalText, this.currentTrigger, this.currentCronDescription)
    events.requestStarted(this.config.permissions.getMode(), this.config.provider.model ?? 'unknown')

    // 任务快照预热
    if (this.activeTodoSnapshot === null) {
      try {
        const existing = loadTodos()
        if (existing.length > 0) {
          this.activeTodoSnapshot = existing
          log.debug('任务快照预热：从磁盘读取到已有任务', { count: existing.length })
        }
      } catch {
        // 读取失败不影响主流程
      }
    }

    const isCraftMode = this.config.permissions.getMode() === 'craft'
    const maxTurns = isCraftMode
      ? (this.config.maxTurns ?? Infinity)  // craft 模式下尊重已设置的 maxTurns
      : (this.config.maxTurns ?? DEFAULT_MAX_TURNS)

    log.debug('run 开始', { messageCount: this.store.getMessageCount(), estimatedTokens: this.getEstimatedTokens(), maxTurns: isCraftMode ? 'unlimited' : maxTurns })

    const maxBudgetUsd = this.config.maxBudgetUsd
    const autoCompactThreshold = this.config.autoCompactThreshold ?? DEFAULT_AUTO_COMPACT_THRESHOLD
    let turns = 0
    let lastKnownInputTokens = 0
    let maxOutputTokensRecoveryCount = 0
    let intentRecoveryCount = 0

    // 事件队列（工具执行 → 主循环）
    type QueueItem = { event: RuntimeEvent } | { done: true; toolCallId: string; result?: ContentBlock }
    let queueResolve: (() => void) | null = null
    const eventQueue: QueueItem[] = []
    const waitQueue = (): Promise<void> => new Promise<void>(resolve => { queueResolve = resolve })
    const pushQueue = (item: QueueItem): void => {
      eventQueue.push(item)
      if (queueResolve) { queueResolve(); queueResolve = null }
    }
    const drainQueue = (): QueueItem[] => {
      const items = [...eventQueue]
      eventQueue.length = 0
      return items
    }

    try {
      while (turns < maxTurns) {
        if (this.abortController.signal.aborted) {
          exitStatus = 'aborted'
          break
        }
        turns++

        log.debug(`第 ${turns} 轮开始`, {
          messageCount: this.store.getMessageCount(),
          estimatedTokens: this.getEstimatedTokens(),
          lastKnownInputTokens,
          maxTurns: isCraftMode ? 'unlimited' : maxTurns,
        })

        // 成本预算检查
        if (maxBudgetUsd !== undefined) {
          const spent = this.costs.getCostUsd()
          if (spent >= maxBudgetUsd) {
            events.budgetExceeded(spent, maxBudgetUsd)
            exitStatus = 'budget_exceeded'
            for (const ev of drainRuntimeBuffer()) yield ev
            break
          } else if (spent >= maxBudgetUsd * BUDGET_WARN_RATIO) {
            events.budgetWarn(spent, maxBudgetUsd, spent / maxBudgetUsd)
          }
        }

        // autocompact
        const tokenCount = lastKnownInputTokens > 0
          ? lastKnownInputTokens
          : this.getEstimatedTokens()
        const latestHasImage = this.store.getLatestPreprocessed() !== null
        const absoluteMaxTokens = autoCompactThreshold * ABSOLUTE_MAX_MULTIPLIER
        if ((!latestHasImage && tokenCount > autoCompactThreshold) || tokenCount > absoluteMaxTokens) {
          events.compactStart()
          for (const ev of drainRuntimeBuffer()) yield ev
          const summary = await this.generateCompactSummary()
          if (this.onBeforeCompact) {
            try { await this.onBeforeCompact(summary) } catch { /* 归档失败不阻断压缩 */ }
          }
          this.compactHistory(summary, events)
          lastKnownInputTokens = 0
          events.compactDone(summary)
          for (const ev of drainRuntimeBuffer()) yield ev
        }

        // ── 流式调用 LLM，同时立即执行工具 ────────────────────
        let fullText = ''
        let thinkingText = ''
        let thinkingSignature: string | undefined
        const toolCalls: Array<{ id: string; name: string; input: unknown }> = []
        let hitMaxOutputTokens = false
        let llmError = false

        const inFlight = new Map<string, { resolve: (block?: ContentBlock) => void }>()

        try {
          for await (const ev of this.streamOneTurn(turns, maxBudgetUsd, events)) {
            if ('type' in ev && ev.type === '__llm_result__') {
              fullText = ev.fullText
              thinkingText = ev.thinkingText
              thinkingSignature = ev.thinkingSignature
              toolCalls.push(...ev.toolCalls)
              hitMaxOutputTokens = ev.hitMaxOutputTokens
            } else if ('type' in ev && ev.type === '__llm_error__') {
              exitStatus = 'error'
              llmError = true
            } else if ('type' in ev && ev.type === '__budget_exceeded__') {
              exitStatus = 'budget_exceeded'
              break
            } else if (ev.type === 'error') {
              yield ev
              exitStatus = 'error'
              llmError = true
            } else if (ev.type === 'interrupted') {
              yield ev
              exitStatus = 'error'
              llmError = true
            } else if (ev.type === 'usage') {
              if (ev.inputTokens > 0) lastKnownInputTokens = ev.inputTokens
              yield ev
            } else if (ev.type === 'budget_exceeded') {
              exitStatus = 'budget_exceeded'
              yield ev
              break
            }
          }

          // drain RuntimeBuffer
          for (const ev of drainRuntimeBuffer()) yield ev


        } catch (err) {
          const errMsg = String(err)
          log.error('LLM 请求失败', { turn: turns, error: errMsg })
          events.error(`LLM 请求失败: ${errMsg}`, !this.abortController.signal.aborted)
          events.interrupted('error', `LLM 请求失败: ${errMsg}`)
          for (const ev of drainRuntimeBuffer()) yield ev
          if (!this.abortController.signal.aborted) {
            const recoveryMsg = `[系统提示] 上次执行因错误中断: ${errMsg}。请从中断处继续完成任务。`
            this.store.appendMessage({
              role: 'user', content: recoveryMsg,
              timestamp: Date.now(), requestId,
            })
            events.userMessage(recoveryMsg, 'user')
          }
          llmError = true
        }
        if (llmError || exitStatus === 'budget_exceeded') break

        // LLM 流结束后，写入 assistant_message
        const cleanText = fullText
          .replace(HEARTBEAT_DONE, '')
          .replace(HEARTBEAT_CONTINUE, '')
          .trim()

        if (cleanText || thinkingText || toolCalls.length > 0) {
          const assistantMsg: ChatMessage = {
            role: 'assistant',
            content: cleanText || null,
            thinking: thinkingText || undefined,
            thinkingSignature: thinkingSignature || undefined,
            tool_calls: toolCalls.length > 0
              ? toolCalls.map(tc => ({ id: tc.id, name: tc.name, input: tc.input }))
              : undefined,
            timestamp: Date.now(),
            requestId,
          }
          this.store.appendMessage(assistantMsg)
          modelLog.write('[run] 写入 assistant ChatMessage', {
            textLen: cleanText.length, thinkingLen: thinkingText.length, toolCount: toolCalls.length,
          })
        }

        events.assistantMessage(
          cleanText,
          thinkingText || undefined,
          toolCalls.length > 0 ? toolCalls.length : undefined,
        )

        if (!cleanText && !thinkingText && toolCalls.length === 0) {
          modelLog.write('[run] 跳过写入（无内容）', { fullTextLen: fullText.length, cleanTextLen: cleanText.length, thinkingLen: thinkingText.length })
        }

        if (hasImageBlocks && turns === 1) {
          this.store.setLatestPreprocessed(null)
        }

        // 无工具调用：心跳判定
        if (toolCalls.length === 0) {
          const heartbeat = this.resolveHeartbeat(fullText, hitMaxOutputTokens, maxOutputTokensRecoveryCount, intentRecoveryCount, turns, maxTurns, events)
          maxOutputTokensRecoveryCount = heartbeat.newRecoveryCount
          intentRecoveryCount = heartbeat.newIntentRecoveryCount
          // drain remaining events
          for (const ev of drainRuntimeBuffer()) yield ev
          if (heartbeat.action === 'continue') continue
          break
        }

        // ★ 等待所有后台工具完成，yield 剩余事件
        // Persist assistant tool_calls before tool results. Both OpenAI and
        // Anthropic require tool results to follow the assistant tool call turn.
        for (const tc of toolCalls) {
          if (inFlight.has(tc.id)) continue
          const resolveRef: (block?: ContentBlock) => void = () => {}
          inFlight.set(tc.id, { resolve: (block) => resolveRef(block) })
          void (async () => {
            let resultBlock: ContentBlock | undefined
            try {
              const result = await this.toolExecutor.execute(tc)
              resultBlock = result.block
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err)
              resultBlock = {
                type: 'tool_result',
                tool_use_id: tc.id,
                content: `Tool execution failed [${tc.name}]: ${message}`,
                is_error: true,
              }
              events.error(`Tool execution failed [${tc.name}]: ${message}`, true)
            }

            if (resultBlock?.type === 'tool_result') {
              try {
                this.store.appendMessage({
                  role: 'tool',
                  tool_call_id: tc.id,
                  name: tc.name,
                  content: resultBlock.content,
                  is_error: resultBlock.is_error === true,
                  timestamp: Date.now(),
                  requestId,
                })
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err)
                events.error(`Tool result persistence failed [${tc.name}]: ${message}`, true)
              }
            }

            pushQueue({ done: true, toolCallId: tc.id, result: resultBlock })
          })()
        }

        for (const item of drainQueue()) {
          if ('event' in item) yield item.event
          if ('done' in item) {
            inFlight.get(item.toolCallId)?.resolve(item.result)
            inFlight.delete(item.toolCallId)
          }
        }

        for (const ev of drainRuntimeBuffer()) yield ev

        while (inFlight.size > 0) {
          // 竞态保护：队列中可能已有结果（pushQueue 在 waitQueue 之前被调用）
          if (eventQueue.length === 0) await waitQueue()
          for (const item of drainQueue()) {
            if ('event' in item) yield item.event
            if ('done' in item) {
              // 工具结果已在回调中立即持久化（appendMessage），此处仅清理 inFlight
              inFlight.delete(item.toolCallId)
            }
          }
          // drain RuntimeBuffer
          for (const ev of drainRuntimeBuffer()) yield ev
        }
        if (this.abortController.signal.aborted) break
      }

      // 达到最大轮次
      if (turns >= maxTurns) {
        exitStatus = 'turn_limit'
        events.turnLimit(turns, maxTurns)
        events.interrupted('turn_limit', `已达到最大执行轮次 ${maxTurns}，任务可能未完成。发送"继续"可恢复执行。`)
        for (const ev of drainRuntimeBuffer()) yield ev
        const turnLimitMsg = `[系统提示] 任务因达到最大轮次限制（${maxTurns} 轮）而中断，尚未完成。请继续执行剩余工作。`
        this.store.appendMessage({ role: 'user', content: turnLimitMsg, timestamp: Date.now(), requestId })
        events.userMessage(turnLimitMsg, 'user')
      }

      // 被用户中止
      if (this.abortController.signal.aborted) {
        exitStatus = 'aborted'
        events.interrupted('user_abort', '任务已被中止。发送"继续"可恢复执行。')
        for (const ev of drainRuntimeBuffer()) yield ev
        const abortMsg = '[系统提示] 任务被用户中止。如需继续，请发送指令。'
        this.store.appendMessage({ role: 'user', content: abortMsg, timestamp: Date.now(), requestId })
        events.userMessage(abortMsg, 'user')
      }
    } catch (err) {
      exitStatus = 'error'
      errorMessage = String(err)
      events.error(`消息处理失败: ${errorMessage}`)
      for (const ev of drainRuntimeBuffer()) yield ev
    } finally {
      // 写入请求完成事件
      const usageAfter = this.costs.getUsage()
      const statusMap: Record<string, string> = {
        completed: 'ok', permission_denied: 'err', turn_limit: 'turn',
        budget_exceeded: 'budget', aborted: 'abort', error: 'err',
      }
      try {
        events.requestEnded(
          statusMap[exitStatus] ?? 'err',
          turns,
          this.toolExecutor.getTotalToolCalls(),
          Date.now() - requestStartTime,
          usageAfter.inputTokens - usageBefore.inputTokens,
          usageAfter.outputTokens - usageBefore.outputTokens,
          this.costs.getCostUsd() - costBefore,
        )
      } catch (err) {
        const message = `请求完成事件写入失败: ${err instanceof Error ? err.message : String(err)}`
        log.error(message)
        runtimeBuffer.push({ type: 'error', message })
      }

      this.running = false
      if (this.onAfterSend) {
        try { this.onAfterSend() } catch { /* 钩子失败不阻断 */ }
      }
      modelLog.write('[run] yield done', { exitStatus, totalToolCalls: this.toolExecutor.getTotalToolCalls() })
      events.done()
      for (const ev of drainRuntimeBuffer()) yield ev
    }
  }

  // ── 公共方法 ─────────────────────────────────────────────────────

  abort() {
    this.abortController.abort()
    this.running = false
  }

  isRunning(): boolean {
    return this.running
  }

  approveSessionPermission(toolName: string, ruleContent?: string) {
    this.config.permissions.approveSession(toolName, ruleContent)
  }

  clearHistory() {
    this.store.clear()
    this.activeTodoSnapshot = null
    this.previousSummary = null
    clearFileCache()
  }

  getHistory(): Message[] {
    const messages = this.store.getMessages()
    const msgs: Message[] = []
    for (const msg of messages) {
      if (msg.role === 'user' || msg.role === 'assistant') {
        msgs.push({
          role: msg.role,
          content: msg.content ?? '',
          timestamp: msg.timestamp,
          requestId: msg.requestId,
          trigger: msg.trigger,
          cronDescription: msg.cronDescription,
        })
      }
    }
    return msgs
  }

  setHistory(messages: Message[]) {
    this.store.clear()
    this.activeTodoSnapshot = null
    this.previousSummary = null
    for (const msg of messages) {
      this.store.appendMessage({
        role: msg.role,
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        timestamp: msg.timestamp,
        requestId: msg.requestId,
        trigger: msg.trigger,
        cronDescription: msg.cronDescription,
      })
    }
  }

  getDisplayMessages(): import('./ConversationStore.js').DisplayMessage[] {
    return projectForDisplay(this.store.getMessages())
  }

  setChatMode(on: boolean) { this.chatMode = on }
  setSystemPrompt(prompt: string[]) { this.config.systemPrompt = prompt }
  setProvider(provider: LLMProvider) { this.config.provider = provider }
  getTools(): readonly ToolDef[] { return this.config.registry.getAll() }

  compactHistory(summary: string, events?: EventBridge) {
    this.store.replaceMessages([
      { role: 'user', content: `[上下文压缩摘要]\n${summary}`, timestamp: Date.now(), requestId: this.currentRequestId ?? undefined },
      { role: 'assistant', content: '', timestamp: Date.now(), requestId: this.currentRequestId ?? undefined },
    ])
    if (events) {
      events.sessionCompacted(summary)
      events.assistantMessage('')
    }
    try {
      this.activeTodoSnapshot = loadTodos()
    } catch {
      // 读取失败保持原快照
    }
  }

  getEstimatedTokens(): number {
    return estimateEventTokens(this.store.getMessages())
  }
}
