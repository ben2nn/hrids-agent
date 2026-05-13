import type { LLMProvider } from './providers/index.js'
import type { ToolDef, ToolResult } from './Tool.js'
import { isReadOnlyCall } from './Tool.js'
import type { ToolRegistry } from './ToolRegistry.js'
import type { PermissionManager } from './PermissionManager.js'
import { CostTracker } from './CostTracker.js'
import { logger } from './logger.js'
import { auditLog } from './audit.js'
import { loadTodos, type Todo } from '../tools/TodoTool.js'
import { clearFileCache } from '../tools/FileReadTool.js'
import { extractMediaFromText } from './MediaProcessor.js'
import { HEARTBEAT_CONTINUE, HEARTBEAT_DONE } from './coordinator/coordinatorPrompt.js'
import { ConversationStore, createUserMessageEvent, createAssistantMessageEvent, createToolResultEvent, createCompactEvent, createRequestCompleteEvent, createSystemEvent, createToolExecutionEvent } from './ConversationStore.js'
import { projectForDisplay, projectForLLM, estimateEventTokens, MAX_TOOL_RESULT_CHARS, truncateToolResult, applyToolResultBudget, pruneOldToolResults, pruneOldImageBlocks } from './projections.js'

import { StormBreaker } from './StormBreaker.js'
import { partitionToolCalls, type ToolCall } from './ToolScheduler.js'

const log = logger.child({ component: 'query-engine' })

/**
 * 根据会话级任务快照构建任务状态字符串，注入到 system prompt。
 *
 * 接受快照而非直接读文件，由调用方（QueryEngine）控制何时刷新快照：
 *   - 快照为 null：本会话尚未执行过任何任务工具，不注入任何内容
 *   - 快照非空但无活跃任务：所有任务已完成，不注入（避免无意义 token）
 *   - 快照有活跃任务：注入完整状态 + 执行驱动指令
 *
 * 这样"你好"等简单消息在会话初始状态（快照为 null）时不会触发工具调用，
 * 只有任务工具实际执行后快照才会被填充，后续轮次才注入执行指令。
 */
function buildLiveTodoContext(snapshot: Todo[] | null): string | null {
  if (snapshot === null) return null

  try {
    const active = snapshot.filter(t => t.status !== 'completed')
    // 所有任务已完成：注入一条简短的完成提示，让 LLM 知道不需要再调用任务工具
    // 避免 LLM 在最后一轮看不到任务状态而重复执行或调用 todo_read 确认
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
      // 根据是否有验收标准，动态生成正确的完成调用指令
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
  timestamp?: number       // 消息创建时间（ms），写入 history 时自动填充
  requestId?: string       // 关联到请求 ID，用于前端消息分组
  trigger?: 'user' | 'cron'  // 触发来源，cron 表示定时任务触发
  cronDescription?: string   // 定时任务描述（trigger=cron 时有值）
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
  data?: string   // base64 编码的图像/PDF 数据
  url?: string    // 图像 URL
}

export interface QueryEngineConfig {
  provider: LLMProvider
  systemPrompt: string[]
  registry: ToolRegistry
  permissions: PermissionManager
  maxTokens?: number
  maxTurns?: number
  maxBudgetUsd?: number          // 成本预算上限（USD），超出后停止执行
  autoCompactThreshold?: number  // 自动压缩 token 阈值（默认 100000）
  sessionCwd?: string            // 会话工作目录，用于图片预处理
  uploadsDir?: string            // 会话上传目录，用于 @引用 搜索
  /** FallbackProvider 状态回调（用于通知用户重试/切换状态） */
  onFallbackStatus?: (event: { type: 'retrying' | 'switching' | 'rate_limited'; provider: string; model: string; delayMs?: number; reason?: string }) => void
}
export type InterruptReason = 'turn_limit' | 'budget_exceeded' | 'aborted' | 'error' | 'permission_denied'

export type StreamEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_start'; id: string; name: string; input: unknown; description: string }
  | { type: 'tool_log'; id: string; name: string; line: string }
  | { type: 'tool_end'; id: string; name: string; result: ToolResult }
  | { type: 'permission_denied'; id: string; toolName: string; description: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; costUsd: number }
  | { type: 'turn_limit'; turns: number }
  | { type: 'budget_exceeded'; costUsd: number; limitUsd: number }
  | { type: 'compact_start' }
  | { type: 'compact_done'; summary: string }
  | { type: 'interrupted'; reason: InterruptReason; message: string }
  | { type: 'continuation_needed' }  // 非自动模式下，LLM 表达了继续意图但需用户确认
  | { type: 'fallback_status'; status: 'retrying' | 'switching' | 'rate_limited'; provider: string; model: string; delayMs?: number; reason?: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

export class QueryEngine {
  private config: QueryEngineConfig
  /** 事件溯源对话存储（单一数据源） */
  readonly store: ConversationStore
  private abortController: AbortController
  // 防止并发执行：同一时刻只允许一个 send() 运行
  private running = false
  readonly costs: CostTracker
  // 上次压缩生成的摘要，用于迭代更新（避免多次压缩后信息层层丢失）
  private previousSummary: string | null = null
  // 压缩前归档回调（由外部注册，用于持久化原始历史）
  onBeforeCompact: ((summary: string) => Promise<void>) | null = null
  // 每次 send 前的钩子（由外部注册，用于动态更新 systemPrompt、保存会话等）
  // 替代 monkey-patch engine.send 的方式，类型安全且调用栈清晰
  onBeforeSend: ((message: string) => Promise<void>) | null = null
  // 每次 send 完成后的钩子
  onAfterSend: (() => void) | null = null
  // 当前请求的 requestId，用于关联消息分组
  private currentRequestId: string | null = null
  // 当前请求的触发来源
  private currentTrigger: 'user' | 'cron' = 'user'
  // 当前 cron 任务的描述（仅 trigger=cron 时有值）
  private currentCronDescription: string | undefined = undefined
  /**
   * 会话级任务快照。
   *
   * - null：本会话尚未执行过任何 todo 工具，system prompt 不注入任务状态。
   *         这是初始状态，确保"你好"等简单消息不会触发工具调用。
   * - Todo[]：最近一次 todo 工具执行后从文件刷新的快照，用于构建 system prompt 注入内容。
   *           所有任务完成后快照仍保留（数组全为 completed），buildLiveTodoContext 会返回 null。
   *
   * 刷新时机：executeOneTool 检测到 todo_* 工具调用成功后立即调用 loadTodos() 更新。
   */
  private activeTodoSnapshot: Todo[] | null = null
  /** Storm Breaker — 防重复调用风暴 */
  private stormBreaker = new StormBreaker()
  /** 工具调用计数器（用于 Storm Breaker 滑动窗口） */
  private totalToolCalls = 0
  /** max_output_tokens 恢复重试上限 */
  private static readonly MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3
  /** todo 工具集合（postExecution 刷新快照用） */
  private static readonly TODO_TOOLS = new Set(['todo_write', 'todo_update', 'todo_append', 'todo_reset', 'todo_read'])

  constructor(config: QueryEngineConfig, store?: ConversationStore) {
    this.config = config
    this.store = store ?? new ConversationStore()
    this.abortController = new AbortController()
    this.costs = new CostTracker(config.provider.model)
  }

  /**
   * 设置当前请求的 requestId，用于关联消息分组
   */
  setRequestId(requestId: string): void {
    this.currentRequestId = requestId
  }

  /**
   * 设置当前请求的触发来源
   */
  setTrigger(trigger: 'user' | 'cron', cronDescription?: string): void {
    this.currentTrigger = trigger
    this.currentCronDescription = cronDescription
  }

  // ── 优先级 3：结构化摘要 + 迭代更新 ─────────────────────────────────────────
  // 序列化历史消息为摘要器可读的文本（工具调用保留名称和参数摘要）
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

  // 调用 LLM 生成对话摘要，用于自动压缩（公开方法，供 UI 层 /compact 命令调用）
  async generateCompactSummary(): Promise<string> {
    // prune 已在投影层处理，此处直接用事件日志序列化
    const contentToSummarize = this.serializeForSummary(projectForDisplay(this.store.getEventLog()))

    // Phase 2: 结构化摘要 prompt，支持迭代更新
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
        3000,
      )) {
        if (chunk.type === 'text_delta' && chunk.delta) {
          summary += chunk.delta
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err)
      log.warn('摘要生成失败，使用兜底文本', { error: errMsg })
      summary = `[对话历史摘要：共 ${this.store.getEventCount()} 条消息，因摘要生成失败而截断]`
    }

    const result = summary || `[对话历史：${this.store.getEventCount()} 条消息]`
    // 保存本次摘要，供下次迭代更新使用
    this.previousSummary = result
    return result
  }

  // ── 流式调用 LLM，yield StreamEvent，最后 yield 一个内部结果对象 ──────────────
  // 返回类型用 type 字段区分，避免 _internal 字段的类型推断问题
  private async *streamOneTurn(
    turns: number,
    maxBudgetUsd: number | undefined,
  ): AsyncGenerator<StreamEvent | { type: '__llm_result__'; fullText: string; thinkingText: string; toolCalls: Array<{ id: string; name: string; input: unknown }>; hitMaxOutputTokens: boolean }> {
    let fullText = ''
    let thinkingText = ''
    const toolCalls: Array<{ id: string; name: string; input: unknown }> = []
    let hitMaxOutputTokens = false

    // plan 模式下对写工具 description 追加不可用标注，
    // 让 LLM 在工具选择阶段就知道这些工具当前不可用，避免盲目调用。
    const isPlanMode = this.config.permissions.getMode() === 'plan'
    const toolsForLLM = this.chatMode
      ? []  // chat 模式：不传任何工具，模型只能直接回复
      : this.config.registry.getToolsForLLM(isPlanMode)

    log.debug('调用 LLM stream', { model: this.config.provider.model, turn: turns })

    try {
      const liveTodo = buildLiveTodoContext(this.activeTodoSnapshot)
      const systemPromptForThisTurn = liveTodo
        ? [...this.config.systemPrompt, liveTodo]
        : this.config.systemPrompt

      // 从 store 事件日志投影出 LLM 所需的消息
      const rawMessages = projectForLLM(this.store.getEventLog(), {
        latestPreprocessed: this.store.getLatestPreprocessed(),
        prunedToolCallIds: this.store.getPrunedToolCallIds(),
      })

      // 依次应用 prune 优化（纯函数，只修改投影副本不修改事件日志）
      const { messages: afterOldPrune, prunedIds: oldPruned } = pruneOldToolResults(rawMessages)
      const { messages: afterBudget, prunedIds: budgetPruned } = applyToolResultBudget(afterOldPrune)
      const projectedMessages = pruneOldImageBlocks(afterBudget)

      // 合并 prunedIds 存回 store，供下次投影跳过已 prune 的 tool_use
      for (const id of oldPruned) this.store.markToolCallPruned(id)
      for (const id of budgetPruned) this.store.markToolCallPruned(id)

      // 重试 + 故障转移由 FallbackProvider 内部统一处理
      for await (const chunk of this.config.provider.stream(
        projectedMessages,
        toolsForLLM,
        systemPromptForThisTurn,
        this.config.maxTokens ?? 8096,
        this.abortController.signal,
      )) {
        if (this.abortController.signal.aborted) break

        if (chunk.type === 'thinking_delta' && chunk.delta) {
          thinkingText += chunk.delta
        } else if (chunk.type === 'text_delta' && chunk.delta) {
          fullText += chunk.delta
          yield { type: 'text_delta', delta: chunk.delta }
        } else if (chunk.type === 'tool_call' && chunk.toolCall) {
          toolCalls.push(chunk.toolCall)
        } else if (chunk.type === 'usage' && chunk.usage) {
          this.costs.add({
            inputTokens: chunk.usage.inputTokens,
            outputTokens: chunk.usage.outputTokens,
            cacheReadTokens: chunk.usage.cacheReadTokens ?? 0,
            cacheWriteTokens: chunk.usage.cacheWriteTokens ?? 0,
          })
          const costUsd = this.costs.getCostUsd()
          yield {
            type: 'usage',
            inputTokens: chunk.usage.inputTokens,
            outputTokens: chunk.usage.outputTokens,
            costUsd,
          }
          // 成本超限：立即停止（在流式输出中途也能响应）
          if (maxBudgetUsd !== undefined && costUsd >= maxBudgetUsd) {
            yield { type: 'budget_exceeded', costUsd, limitUsd: maxBudgetUsd }
            return
          }
        } else if (chunk.type === 'stop_reason' && chunk.stopReason === 'max_tokens') {
          hitMaxOutputTokens = true
        }
      }
    } catch (err) {
      const errMsg = String(err)
      log.error('LLM 请求失败', { turn: turns, error: errMsg })
      yield { type: 'interrupted', reason: 'error', message: `LLM 请求失败: ${errMsg}` }
      yield { type: 'error', message: errMsg }
      // abort 导致的异常不写 error_recovery，由 send() 的 abort 处理统一负责
      if (!this.abortController.signal.aborted) {
        this.store.appendEvents(createSystemEvent(
          'error_recovery',
          `[系统提示] 上次执行因错误中断: ${errMsg}。请从中断处继续完成任务。`,
          this.currentRequestId ?? undefined,
        ))
      }
      return
    }

    yield { type: '__llm_result__', fullText, thinkingText, toolCalls, hitMaxOutputTokens }
  }

  // ── 工具执行辅助方法 ──────────────────────────────────────────────────────

  /**
   * 阶段 1：工具查找 + 权限检查 + Zod 校验 + Storm Breaker。
   * 成功返回 { ok: true, ... }，失败返回 { ok: false, ... }。
   * 调用方负责 yield 事件（通过返回的 events 数组）。
   */
  private async validateAndPrepareTool(
    tc: { id: string; name: string; input: unknown },
  ): Promise<
    | { ok: true; tool: ToolDef; effectiveInput: unknown; events: StreamEvent[] }
    | { ok: false; execStatus: 'error' | 'denied'; errorSummary: string; resultContent: string; events: StreamEvent[] }
  > {
    const events: StreamEvent[] = []

    const tool = this.config.registry.get(tc.name)
    if (!tool) {
      const errorSummary = `未找到工具: ${tc.name}`
      events.push(
        { type: 'tool_start', id: tc.id, name: tc.name, input: tc.input, description: tc.name },
        { type: 'tool_end', id: tc.id, name: tc.name, result: { type: 'error', message: errorSummary } },
      )
      return { ok: false, execStatus: 'error', errorSummary, resultContent: `错误: ${errorSummary}`, events }
    }

    const description = tool.describe?.(tc.input) ?? tc.name
    events.push({ type: 'tool_start', id: tc.id, name: tc.name, input: tc.input, description })
    log.debug('工具开始执行', { toolName: tc.name, toolId: tc.id, description })

    // 第一道：工具级硬拦截（checkPermission）
    if (tool.checkPermission) {
      const hardCheck = await tool.checkPermission(tc.input as never)
      if (!hardCheck.granted) {
        log.info('工具硬拦截', { toolName: tc.name, reason: hardCheck.reason })
        auditLog({ action: 'permission_denied', resource: tc.name, result: 'denied', permissionMode: this.config.permissions.getMode(), details: { reason: hardCheck.reason, stage: 'hard_check' } })
        events.push({ type: 'tool_end', id: tc.id, name: tc.name, result: { type: 'error', message: hardCheck.reason } })
        return { ok: false, execStatus: 'denied', errorSummary: hardCheck.reason, resultContent: `错误: ${hardCheck.reason}`, events }
      }
    }

    // 第二道：PermissionManager 策略决策
    const filePath = tool.getFilePath?.(tc.input as never)
    const ruleContent = tool.getRuleContent?.(tc.input as never)
    const allowed = await this.config.permissions.check({
      toolName: tc.name, description, isReadonly: isReadOnlyCall(tool, tc.input),
      isDestructive: tool.isDestructive, filePath, ruleContent,
    })
    if (!allowed) {
      log.info('权限拒绝', { toolName: tc.name, description })
      auditLog({ action: 'permission_denied', resource: tc.name, result: 'denied', permissionMode: this.config.permissions.getMode(), details: { description } })
      let denyReason: string
      if (this.config.permissions.getMode() === 'plan') {
        denyReason = '[Plan 模式] 此操作在规划模式下被禁止。请继续完成规划，不要尝试执行写操作。'
      } else if (this.config.permissions.isDenialThresholdReached()) {
        const { consecutive, total } = this.config.permissions.getDenialState()
        denyReason = `用户拒绝了此操作（已连续拒绝 ${consecutive} 次，会话内共拒绝 ${total} 次）。请停止尝试此类操作，直接询问用户希望如何处理。`
      } else {
        denyReason = '用户拒绝了此操作'
      }
      events.push({ type: 'permission_denied', id: tc.id, toolName: tc.name, description })
      return { ok: false, execStatus: 'denied', errorSummary: `权限拒绝: ${description}`, resultContent: denyReason, events }
    }

    // 写操作记录审计日志
    if (!tool.readonly) {
      auditLog({ action: tc.name as never, resource: description, result: 'allowed', details: { toolName: tc.name } })
    }

    // Zod 参数校验 + 自动修复
    let effectiveInput: unknown = tc.input
    if (tool.inputSchema) {
      const inputObj = tc.input as Record<string, unknown>
      if (inputObj && typeof inputObj === 'object' && !Array.isArray(inputObj)) {
        for (const field of ['todos']) {
          if (field in inputObj && inputObj[field] !== null && typeof inputObj[field] === 'object' && !Array.isArray(inputObj[field])) {
            const patched = { ...inputObj, [field]: [inputObj[field]] }
            if (tool.inputSchema.safeParse(patched).success) {
              log.info('自动修复工具参数：将单个对象包装为数组', { toolName: tc.name, field })
              effectiveInput = patched
              break
            }
          }
        }
      }
      const parseResult = tool.inputSchema.safeParse(effectiveInput)
      if (!parseResult.success) {
        const issues = parseResult.error.issues.map(i => `  - ${i.path.join('.')}: ${i.message}`).join('\n')
        const errMsg = `工具参数校验失败 [${tc.name}]:\n${issues}`
        log.warn('工具参数校验失败', { toolName: tc.name, issues: parseResult.error.issues })
        events.push({ type: 'tool_end', id: tc.id, name: tc.name, result: { type: 'error', message: errMsg } })
        return { ok: false, execStatus: 'error', errorSummary: errMsg.slice(0, 200), resultContent: `错误: ${errMsg}`, events }
      }
    }

    // Storm Breaker
    this.totalToolCalls++
    const stormError = this.stormBreaker.check(tc.name, effectiveInput, this.totalToolCalls, tool.stormExempt)
    if (stormError) {
      events.push({ type: 'tool_end', id: tc.id, name: tc.name, result: { type: 'error', message: stormError } })
      return { ok: false, execStatus: 'error', errorSummary: 'Storm Breaker 拦截', resultContent: stormError, events }
    }

    return { ok: true, tool, effectiveInput, events }
  }

  /**
   * 阶段 3：执行后处理（Storm Breaker 清理、todo 快照刷新、结果截断）。
   * 返回截断后的 __tool_result__ block 和 outputPreview。
   */
  private postExecution(
    tc: { id: string; name: string; input: unknown },
    tool: ToolDef,
    finalResult: ToolResult,
  ): { block: ContentBlock; outputPreview: string } {
    if (finalResult.type === 'success' && !tool.readonly) {
      this.stormBreaker.clearOnMutation()
    }

    if (QueryEngine.TODO_TOOLS.has(tc.name) && finalResult.type === 'success') {
      try {
        this.activeTodoSnapshot = loadTodos()
        log.debug('任务快照已刷新', { toolName: tc.name, count: this.activeTodoSnapshot.length })
      } catch { /* 读取失败不影响主流程 */ }
    }

    const resultContent = finalResult.type === 'success' ? finalResult.output : `错误: ${finalResult.message}`
    const outputPreview = resultContent.slice(0, 500)
    const truncatedContent = truncateToolResult(resultContent, MAX_TOOL_RESULT_CHARS)
    return {
      block: { type: 'tool_result', tool_use_id: tc.id, content: truncatedContent, is_error: finalResult.type === 'error' },
      outputPreview,
    }
  }

  /**
   * 无工具调用时的心跳协议判定。
   * 返回 'break' 结束循环，'continue' 继续下一轮。
   */
  private resolveHeartbeat(
    fullText: string,
    hitMaxOutputTokens: boolean,
    recoveryCount: number,
    turns: number,
    maxTurns: number,
  ): { action: 'break' | 'continue'; newRecoveryCount: number } {
    log.debug('本轮无工具调用', { turn: turns, textLength: fullText.length })

    // 输出被截断时注入继续指令，让 LLM 从中断处接着写，最多重试3次
    if (hitMaxOutputTokens && recoveryCount < QueryEngine.MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
      const newCount = recoveryCount + 1
      log.info('输出被截断，注入继续指令', { turn: turns, recovery: newCount })
      this.store.appendEvents(createUserMessageEvent(
        '[系统内部] 输出已被截断。请直接从中断处继续，不要重复已输出的内容，不要道歉或解释。',
        this.currentRequestId ?? undefined,
      ))
      return { action: 'continue', newRecoveryCount: newCount }
    }

    // DONE 标记：立即结束
    if (fullText.includes(HEARTBEAT_DONE)) {
      log.debug('心跳协议：DONE，停止执行', { turn: turns })
      return { action: 'break', newRecoveryCount: recoveryCount }
    }

    // 任务系统确认全部完成：结束
    const allTasksDone = this.activeTodoSnapshot !== null &&
      this.activeTodoSnapshot.length > 0 &&
      this.activeTodoSnapshot.every(t => t.status === 'completed')
    if (allTasksDone) {
      log.debug('任务系统确认全部完成，停止执行', { turn: turns })
      return { action: 'break', newRecoveryCount: recoveryCount }
    }

    // CONTINUE 标记但无工具调用：允许继续
    if (fullText.includes(HEARTBEAT_CONTINUE)) {
      if (turns < maxTurns) {
        log.debug('心跳协议：CONTINUE（无工具调用），继续', { turn: turns })
        return { action: 'continue', newRecoveryCount: recoveryCount }
      }
      log.debug('心跳协议：CONTINUE 但已达轮次上限，停止', { turn: turns })
    }

    // 无标记、无工具调用：自然结束
    log.debug('无工具调用无心跳标记，自然结束', { turn: turns })
    return { action: 'break', newRecoveryCount: recoveryCount }
  }

  /**
   * 执行一批工具调用（按 parallelSafe 自动分区）。
   * 通过 yield 流式产出事件，abort 时提前终止。
   */
  private async *executeToolBatches(
    toolCalls: Array<{ id: string; name: string; input: unknown }>,
  ): AsyncGenerator<StreamEvent> {
    const batches = partitionToolCalls(toolCalls as ToolCall[], this.config.registry.getAll())
    log.debug('本轮工具调用', {
      tools: toolCalls.map(tc => tc.name),
      batches: batches.map(b => ({ parallel: b.parallel, count: b.calls.length })),
    })

    for (const batch of batches) {
      if (batch.parallel && batch.calls.length > 1) {
        for await (const ev of this.executeBatch(batch.calls)) {
          if (this.abortController.signal.aborted) return
          yield ev
        }
      } else {
        for (const tc of batch.calls) {
          const gen = this.executeOneTool(tc)
          let aborted = false
          try {
            for await (const ev of gen) {
              if ('type' in ev && ev.type === '__tool_result__') {
                const block = ev.block as { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
                this.store.appendEvents(createToolResultEvent(
                  block.tool_use_id, tc.name, block.content,
                  block.is_error === true, this.currentRequestId ?? undefined,
                ))
              } else {
                yield ev as StreamEvent
                if (this.abortController.signal.aborted) { aborted = true; break }
              }
            }
          } finally {
            if (aborted) await gen.return(undefined)
          }
          if (aborted) return
        }
      }
    }
  }

  // ── 执行单个工具调用（主入口）──────────────────────────────────────────
  private async *executeOneTool(
    tc: { id: string; name: string; input: unknown },
  ): AsyncGenerator<StreamEvent | { type: '__tool_result__'; block: ContentBlock }> {
    const startTime = Date.now()
    let execStatus: 'success' | 'error' | 'denied' | 'aborted' = 'success'
    let outputPreview: string | undefined
    let errorSummary: string | undefined
    const logQueue: string[] = []
    const onLog = (line: string) => { logQueue.push(line) }

    try {
      // 阶段 1：校验 + 权限 + Storm Breaker
      const prepared = await this.validateAndPrepareTool(tc)
      for (const ev of prepared.events) yield ev

      if (!prepared.ok) {
        execStatus = prepared.execStatus
        errorSummary = prepared.errorSummary
        yield { type: '__tool_result__', block: { type: 'tool_result', tool_use_id: tc.id, content: prepared.resultContent, is_error: true } }
        return
      }

      const { tool, effectiveInput } = prepared

      // 阶段 2：工具执行（超时 + abort 竞争 + 日志 flush）
      const inputTimeout = (effectiveInput as Record<string, unknown>)?.timeout
      const TOOL_TIMEOUT_MS = (typeof inputTimeout === 'number' && inputTimeout > 0)
        ? inputTimeout + 5000
        : 60 * 60 * 1000

      const toolPromise: Promise<ToolResult> = tool.execute(effectiveInput as never, { onLog })
        .then(r => r)
        .catch((e: unknown) => ({
          type: 'error' as const,
          message: `工具执行异常 [${tc.name}]: ${e instanceof Error ? e.message : String(e)}`,
        }))

      const timeoutPromise: Promise<ToolResult> = new Promise(resolve =>
        setTimeout(() => resolve({ type: 'error', message: `工具执行超时（超过 ${TOOL_TIMEOUT_MS / 1000}s）：${tc.name}` }), TOOL_TIMEOUT_MS))

      let abortListener: (() => void) | undefined
      const abortPromise: Promise<ToolResult> = new Promise(resolve => {
        abortListener = () => resolve({ type: 'error', message: '任务已被中止' })
        this.abortController.signal.addEventListener('abort', abortListener, { once: true })
      })

      const racePromise = Promise.race([toolPromise, timeoutPromise, abortPromise])

      let finalResult: ToolResult | undefined = undefined
      while (true) {
        const raceOrTick = await Promise.race([
          racePromise,
          new Promise<'tick'>(r => setTimeout(() => r('tick'), 30)),
        ])
        while (logQueue.length > 0) {
          yield { type: 'tool_log', id: tc.id, name: tc.name, line: logQueue.shift()! }
        }
        if (raceOrTick !== 'tick') {
          finalResult = raceOrTick
          break
        }
      }

      // 清理 abort 事件监听器，防止泄漏
      if (abortListener) {
        this.abortController.signal.removeEventListener('abort', abortListener)
      }

      // flush 残留日志
      while (logQueue.length > 0) {
        yield { type: 'tool_log', id: tc.id, name: tc.name, line: logQueue.shift()! }
      }

      if (this.abortController.signal.aborted) {
        execStatus = 'aborted'
        errorSummary = '任务已被中止'
        // 标记此 tool_use 为 pruned，避免投影时产生孤立 tool_use（无对应 tool_result）
        this.store.markToolCallPruned(tc.id)
        yield { type: 'tool_end', id: tc.id, name: tc.name, result: { type: 'error', message: '任务已被中止' } }
        return
      }

      yield { type: 'tool_end', id: tc.id, name: tc.name, result: finalResult }
      log.debug('工具执行完成', { toolName: tc.name, toolId: tc.id, resultType: finalResult.type })

      // 阶段 3：后处理
      const post = this.postExecution(tc, tool, finalResult)
      outputPreview = post.outputPreview
      yield { type: '__tool_result__', block: post.block }

    } finally {
      this.store.appendEvents(createToolExecutionEvent(
        tc.id, tc.name, Date.now() - startTime, execStatus,
        this.currentRequestId ?? undefined, outputPreview, errorSummary,
      ))
    }
  }

  /**
   * 并行执行一批 parallelSafe 工具调用，流式产出事件。
   * 为每个 generator 维护独立的 pending promise，通过 Promise.race 竞争消费。
   * 避免对同一 AsyncGenerator 并发调用 next() 导致 ERR_GENERATOR_ALREADY_EXECUTING。
   */
  private async *executeBatch(
    calls: ToolCall[],
  ): AsyncGenerator<StreamEvent> {
    type GenResult = IteratorResult<StreamEvent | { type: '__tool_result__'; block: unknown }>
    interface GenState {
      tc: ToolCall
      gen: AsyncGenerator<StreamEvent | { type: '__tool_result__'; block: unknown }>
      pending: Promise<GenResult>
    }

    // 启动所有 generator，为每个创建初始 next() promise
    const gens: GenState[] = calls.map(tc => {
      const gen = this.executeOneTool(tc)
      const pending = gen.next()
      return { tc, gen, pending }
    })

    const active = new Set(gens.map((_, i) => i))

    try {
      while (active.size > 0) {
        // 竞争所有活跃 generator 的当前 pending promise
        const racePromises = [...active].map(i =>
          gens[i].pending.then(result => ({ i, done: result.done, value: result.value })),
        )

        const { i, done, value } = await Promise.race(racePromises)

        if (done) {
          active.delete(i)
          continue
        }

        // 只对 winner generator 调用 next()，获取下一个 pending promise
        // 其他 generator 的 pending 不变，避免并发 next() 问题
        gens[i].pending = gens[i].gen.next()

        const ev = value as StreamEvent | { type: '__tool_result__'; block: unknown }
        if ('type' in ev && ev.type === '__tool_result__') {
          const block = ev.block as { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
          this.store.appendEvents(createToolResultEvent(
            block.tool_use_id, gens[i].tc.name, block.content,
            block.is_error === true, this.currentRequestId ?? undefined,
          ))
        } else {
          yield ev as StreamEvent
        }

        // abort 时跳出，由 finally 清理所有活跃 generator
        if (this.abortController.signal.aborted) break
      }
    } finally {
      // 确保所有活跃 generator 被正确关闭，触发其 finally 块（审计日志写入）
      const cleanup = [...active].map(idx => gens[idx].gen.return(undefined))
      await Promise.allSettled(cleanup)
    }
  }

  /**
   * 预处理用户消息：将 @引用（本地文件 / URL）替换为 image/document ContentBlock。
   *
   * 委托给 MediaProcessor.extractMediaFromText，支持：
   *   - @filename.jpg / @/abs/path/img.png  → 本地文件（压缩 + 缓存）
   *   - @https://example.com/img.jpg        → URL 图片（fetch + 压缩 + 缓存）
   *   - @doc.pdf                            → PDF 直接传输
   *
   * 若消息中没有任何媒体引用，直接返回原始字符串（不做转换）。
   */
  private async preprocessUserMessage(text: string): Promise<string | ContentBlock[]> {
    const cwd = this.config.sessionCwd ?? process.cwd()
    const { attachments, cleanText, errors } = await extractMediaFromText(text, cwd, this.config.uploadsDir)

    if (attachments.length === 0) {
      // 没有成功加载的媒体，返回原始文本（保留失败引用，让 LLM 知道）
      return text
    }

    // 构建 ContentBlock 数组
    const blocks: ContentBlock[] = []

    // 文本部分（去掉 @引用后的干净文本 + 错误提示）
    let textContent = cleanText
    if (errors.length > 0) {
      textContent += `\n\n[媒体加载失败]\n${errors.join('\n')}`
    }
    if (textContent.trim()) {
      blocks.push({ type: 'text', text: textContent })
    }

    // 媒体 block
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

  async *send(userMessage: string | Message): AsyncGenerator<StreamEvent> {
    // 并发保护：如果已有任务在运行，拒绝新任务
    if (this.running) {
      log.warn('并发保护触发：上一个任务仍在执行中', { historyLength: this.store.getEventCount() })
      yield { type: 'error', message: '上一个任务仍在执行中，请等待完成后再发送新消息' }
      return
    }
    this.running = true
    this.abortController = new AbortController()

    // 请求级快照（用于 request_complete 事件）
    const requestStartTime = Date.now()
    this.costs.reset()  // 每次请求重置，避免跨请求累积导致预算误触
    const costBefore = this.costs.getCostUsd()
    const usageBefore = this.costs.getUsage()
    let exitStatus: 'completed' | 'error' | 'aborted' | 'turn_limit' | 'budget_exceeded' | 'permission_denied' = 'completed'
    this.totalToolCalls = 0  // 重置计数器（每个请求独立计数）
    this.stormBreaker.reset()
    let errorMessage: string | undefined

    // 调用 onBeforeSend 钩子（动态更新 systemPrompt、保存会话等）
    // 同时提取消息文本用于后续意图检测，避免重复计算
    const msgText = typeof userMessage === 'string'
      ? userMessage
      : (Array.isArray((userMessage as Message).content)
          ? ((userMessage as Message).content as ContentBlock[])
              .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
              .map(b => b.text).join('')
          : String((userMessage as Message).content))
    if (this.onBeforeSend) {
      try { await this.onBeforeSend(msgText) } catch { /* 钩子失败不阻断执行 */ }
    }

    // 预处理用户消息：将 @filename 转换为 image block（仅用于发给 LLM）
    // 事件日志里保留原始文本（含 @filename），避免 base64 数据膨胀事件流
    let processedContent: string | ContentBlock[] = typeof userMessage === 'string' ? userMessage : (userMessage as Message).content
    if (typeof processedContent === 'string' && this.config.sessionCwd) {
      try {
        processedContent = await this.preprocessUserMessage(processedContent)
      } catch (err) {
        log.warn('图片预处理失败', { error: String(err) })
      }
    }
    // 在 preprocess 之后检查，确保 @filename 转换的 image block 能被检测到
    const hasImageBlocks = Array.isArray(processedContent) &&
      (processedContent as ContentBlock[]).some(b => b.type === 'image')

    // 提取原始文本（不含 base64），存入事件日志
    const originalText = typeof userMessage === 'string' ? userMessage : msgText

    // 如果有 image block，将预处理结果存入 store 供 LLM 投影使用
    if (hasImageBlocks) {
      this.store.setLatestPreprocessed(
        Array.isArray(processedContent) ? processedContent as ContentBlock[] : null,
      )
    }

    // 追加用户消息事件（原始文本，不含 base64）
    this.store.appendEvents(createUserMessageEvent(
      originalText,
      this.currentRequestId ?? undefined,
      this.currentTrigger,
      this.currentCronDescription,
    ))

    // 任务快照预热
    if (this.activeTodoSnapshot === null) {
      try {
        const existing = loadTodos()
        if (existing.length > 0) {
          this.activeTodoSnapshot = existing
          log.debug('任务快照预热：从磁盘读取到已有任务', { count: existing.length })
        }
      } catch {
        // 读取失败不影响主流程，快照保持 null
      }
    }

    // craft 模式：不设轮次上限，完全依赖 autocompact 管理上下文
    // ask/plan 模式：保留轮次限制，超出后通知用户决定是否继续
    const isCraftMode = this.config.permissions.getMode() === 'craft'
    const maxTurns = isCraftMode ? Infinity : (this.config.maxTurns ?? 50)

    log.debug('send 开始', { eventCount: this.store.getEventCount(), estimatedTokens: this.getEstimatedTokens(), maxTurns: isCraftMode ? 'unlimited' : maxTurns })

    const maxBudgetUsd = this.config.maxBudgetUsd
    // 自动压缩阈值：默认 100000 tokens（约 40-80 轮对话后才触发，参考 Kiro/Claude Code 的策略）
    const autoCompactThreshold = this.config.autoCompactThreshold ?? 100000
    let turns = 0
    // 用 API 返回的真实 inputTokens 校准估算，避免中文场景低估
    let lastKnownInputTokens = 0
    // max_output_tokens 恢复计数（最多重试3次，参考 claude-code）
    let maxOutputTokensRecoveryCount = 0

    try {
      while (turns < maxTurns) {
        if (this.abortController.signal.aborted) {
          exitStatus = 'aborted'
          break
        }
        turns++

        log.debug(`第 ${turns} 轮开始`, {
          eventCount: this.store.getEventCount(),
          estimatedTokens: this.getEstimatedTokens(),
          lastKnownInputTokens,
          maxTurns: isCraftMode ? 'unlimited' : maxTurns,
        })

        // 成本预算检查（每轮开始前）
        if (maxBudgetUsd !== undefined && this.costs.getCostUsd() >= maxBudgetUsd) {
          exitStatus = 'budget_exceeded'
          yield { type: 'budget_exceeded', costUsd: this.costs.getCostUsd(), limitUsd: maxBudgetUsd }
          break
        }

        // 廉价优化（prune/budget）现在在 projectForLLM 投影时执行，无需在此处调用

        // autocompact 触发判断：优先用 API 返回的真实 inputTokens，其次用估算值
        const tokenCount = lastKnownInputTokens > 0
          ? lastKnownInputTokens
          : this.getEstimatedTokens()

        // 检查最新用户消息是否包含图片（图片消息不触发压缩）
        const latestHasImage = this.store.getLatestPreprocessed() !== null

        // 图片消息不触发压缩（避免图片上下文丢失），但超过绝对上限时强制压缩
        const absoluteMaxTokens = autoCompactThreshold * 3
        if ((!latestHasImage && tokenCount > autoCompactThreshold) || tokenCount > absoluteMaxTokens) {
          yield { type: 'compact_start' }
          const summary = await this.generateCompactSummary()
          if (this.onBeforeCompact) {
            try { await this.onBeforeCompact(summary) } catch { /* 归档失败不阻断压缩 */ }
          }
          this.compactHistory(summary)
          // 孤立 tool_use/tool_result 对的修复已由投影层处理
          lastKnownInputTokens = 0
          yield { type: 'compact_done', summary }
        }

        // ── 调用 LLM（委托给 streamOneTurn）────────────────────────────────
        let fullText = ''
        let thinkingText = ''
        let toolCalls: Array<{ id: string; name: string; input: unknown }> = []
        let hitMaxOutputTokens = false
        let llmError = false

        for await (const ev of this.streamOneTurn(turns, maxBudgetUsd)) {
          if ('type' in ev && ev.type === '__llm_result__') {
            // 内部结果信号，不向外 yield
            fullText = ev.fullText
            thinkingText = ev.thinkingText
            toolCalls = ev.toolCalls
            hitMaxOutputTokens = ev.hitMaxOutputTokens
          } else if (ev.type === 'error') {
            yield ev
            exitStatus = 'error'
            llmError = true
          } else if (ev.type === 'interrupted') {
            yield ev
            exitStatus = ev.reason === 'error' ? 'error' : ev.reason
            llmError = true
          } else if (ev.type === 'usage') {
            // 用 API 返回的真实 inputTokens 更新计量
            if (ev.inputTokens > 0) lastKnownInputTokens = ev.inputTokens
            yield ev
          } else if (ev.type === 'budget_exceeded') {
            exitStatus = 'budget_exceeded'
            yield ev
            break
          } else {
            yield ev
          }
        }
        if (llmError || exitStatus === 'budget_exceeded') break

        // 将 assistant 回复写入事件日志
        const toolCallEvents = toolCalls.length > 0
          ? toolCalls.map(tc => ({ id: tc.id, name: tc.name, input: tc.input }))
          : undefined
        // 过滤心跳标记，避免内部协议标记污染前端展示
        const cleanText = fullText
          .replace(HEARTBEAT_DONE, '')
          .replace(HEARTBEAT_CONTINUE, '')
          .trim()
        if (cleanText || thinkingText || toolCallEvents) {
          this.store.appendEvents(createAssistantMessageEvent(
            cleanText,
            toolCallEvents,
            this.currentRequestId ?? undefined,
            thinkingText || undefined,
          ))
        }

        // 第一轮 LLM 调用完成后，清除预处理状态（后续轮次不再需要图片）
        if (hasImageBlocks && turns === 1) {
          this.store.setLatestPreprocessed(null)
        }

        // ── 无工具调用：心跳协议判定 ─────────────────────────────────
        if (toolCalls.length === 0) {
          const heartbeat = this.resolveHeartbeat(fullText, hitMaxOutputTokens, maxOutputTokensRecoveryCount, turns, maxTurns)
          maxOutputTokensRecoveryCount = heartbeat.newRecoveryCount
          if (heartbeat.action === 'continue') continue
          break
        }

        // ── 执行工具调用（按 parallelSafe 自动分区：并行批次 + 串行批次）──────────
        for await (const ev of this.executeToolBatches(toolCalls)) {
          yield ev
        }
        if (this.abortController.signal.aborted) break
      }

      // 达到最大轮次（仅 ask/plan 模式会触发，craft 模式 maxTurns = Infinity）
      if (turns >= maxTurns) {
        exitStatus = 'turn_limit'
        yield { type: 'interrupted', reason: 'turn_limit', message: `已达到最大执行轮次 ${maxTurns}，任务可能未完成。发送"继续"可恢复执行。` }
        yield { type: 'turn_limit', turns }
        this.store.appendEvents(createSystemEvent(
          'turn_limit',
          `[系统提示] 任务因达到最大轮次限制（${maxTurns} 轮）而中断，尚未完成。请继续执行剩余工作。`,
          this.currentRequestId ?? undefined,
        ))
      }
      // 被用户中止
      if (this.abortController.signal.aborted) {
        exitStatus = 'aborted'
        yield { type: 'interrupted', reason: 'aborted', message: '任务已被中止。发送"继续"可恢复执行。' }
        this.store.appendEvents(createSystemEvent(
          'user_abort',
          '[系统提示] 任务被用户中止。如需继续，请发送指令。',
          this.currentRequestId ?? undefined,
        ))
      }
    } catch (err) {
      exitStatus = 'error'
      errorMessage = String(err)
      yield { type: 'error', message: `消息处理失败: ${errorMessage}` }
    } finally {
      // 写入请求完成事件（持久化，不 yield 给外部）
      const usageAfter = this.costs.getUsage()
      this.store.appendEvents(createRequestCompleteEvent(
        this.currentRequestId ?? undefined,
        exitStatus,
        turns,
        this.totalToolCalls,
        Date.now() - requestStartTime,
        usageAfter.inputTokens - usageBefore.inputTokens,
        usageAfter.outputTokens - usageBefore.outputTokens,
        this.costs.getCostUsd() - costBefore,
        errorMessage,
      ))

      // 无论正常结束还是异常，都要释放锁并发 done
      this.running = false
      if (this.onAfterSend) {
        try { this.onAfterSend() } catch { /* 钩子失败不阻断 */ }
      }
      yield { type: 'done' }
    }
  }

  abort() {
    this.abortController.abort()
    // 强制释放锁，防止 generator 未被消费时 running 永久为 true
    this.running = false
  }

  isRunning(): boolean {
    return this.running
  }

  clearHistory() {
    this.store.clear()
    // 清空历史时同步重置任务快照，确保新会话不会继承旧任务状态
    this.activeTodoSnapshot = null
    // 重置压缩摘要，避免下次 autocompact 引用已不存在的历史
    this.previousSummary = null
    // 清除文件读取缓存，防止跨会话脏读
    clearFileCache()
  }

  /** 返回消息历史（仅 user/assistant 消息，供测试和外部查询） */
  getHistory(): Message[] {
    const events = this.store.getEventLog()
    const msgs: Message[] = []
    for (const ev of events) {
      if (ev.type === 'user_message') {
        msgs.push({ role: 'user', content: ev.content, timestamp: ev.timestamp, requestId: ev.requestId })
      } else if (ev.type === 'assistant_message') {
        msgs.push({ role: 'assistant', content: ev.text, timestamp: ev.timestamp, requestId: ev.requestId })
      } else if (ev.type === 'compact') {
        msgs.push({ role: 'user', content: ev.summary, timestamp: ev.timestamp, requestId: ev.requestId })
      }
    }
    return msgs
  }

  /** 替换消息历史（清空后写入新消息） */
  setHistory(messages: Message[]) {
    this.store.clear()
    // 重置任务快照和压缩摘要，避免新会话继承旧状态
    this.activeTodoSnapshot = null
    this.previousSummary = null
    for (const msg of messages) {
      if (msg.role === 'user') {
        this.store.appendEvents(createUserMessageEvent(
          typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
          msg.requestId,
          msg.trigger,
          msg.cronDescription,
        ))
      } else {
        this.store.appendEvents(createAssistantMessageEvent(
          typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
          undefined,
          msg.requestId,
        ))
      }
    }
  }

  /** 返回前端展示用的 DisplayMessage[]（直接从事件投影，含工具卡片） */
  getDisplayMessages(): import('./ConversationStore.js').DisplayMessage[] {
    return projectForDisplay(this.store.getEventLog())
  }

  private chatMode = false
  setChatMode(on: boolean) { this.chatMode = on }
  setSystemPrompt(prompt: string[]) { this.config.systemPrompt = prompt }
  setProvider(provider: LLMProvider) { this.config.provider = provider }
  getTools(): readonly ToolDef[] { return this.config.registry.getAll() }

  compactHistory(summary: string) {
    // 用 replaceEvents 替换为 CompactEvent + 空 assistant，不丢失原始事件的元信息
    const compactEv = createCompactEvent(summary, this.currentRequestId ?? undefined)
    const assistantEv = createAssistantMessageEvent('', undefined, this.currentRequestId ?? undefined)
    this.store.replaceEvents([compactEv, assistantEv])
    // 压缩后重新从文件读取快照确保状态同步
    try {
      this.activeTodoSnapshot = loadTodos()
    } catch {
      // 读取失败保持原快照，不重置为 null，避免压缩后丢失任务状态
    }
  }

  getEstimatedTokens(): number {
    return estimateEventTokens(this.store.getEventLog())
  }
}
