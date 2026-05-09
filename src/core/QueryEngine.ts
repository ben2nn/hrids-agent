import type { LLMProvider } from './providers/index.js'
import type { ToolDef, ToolResult } from './Tool.js'
import type { PermissionManager } from './PermissionManager.js'
import { CostTracker } from './CostTracker.js'
import { logger } from './logger.js'
import { auditLog } from './audit.js'
import { parseDsml, hasDsmlMarker } from './DsmlParser.js'
import { loadTodos, type Todo } from '../tools/TodoTool.js'
import { extractMediaFromText } from './MediaProcessor.js'
import { HEARTBEAT_CONTINUE, HEARTBEAT_DONE } from './coordinator/coordinatorPrompt.js'
import { ConversationStore, createUserMessageEvent, createAssistantMessageEvent, createToolResultEvent, createCompactEvent, createRequestCompleteEvent } from './ConversationStore.js'
import { projectForDisplay, projectForLLM, estimateEventTokens } from './projections.js'

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
  tools: ToolDef[]
  permissions: PermissionManager
  maxTokens?: number
  maxTurns?: number
  maxBudgetUsd?: number          // 成本预算上限（USD），超出后停止执行
  autoCompactThreshold?: number  // 历史消息数超过此值时自动触发压缩（默认 80）
  sessionCwd?: string            // 会话工作目录，用于图片预处理
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
  private serializeForSummary(messages: Message[]): string {
    return messages.map(m => {
      if (typeof m.content === 'string') {
        const role = m.role === 'user' ? '用户' : '助手'
        return `[${role}]: ${m.content.slice(0, 3000)}`
      }
      const blocks = m.content as ContentBlock[]
      const parts: string[] = []
      for (const b of blocks) {
        if (b.type === 'text') {
          parts.push(b.text.slice(0, 2000))
        } else if (b.type === 'tool_use') {
          const args = JSON.stringify(b.input)
          parts.push(`[工具调用: ${b.name}(${args.length > 400 ? args.slice(0, 400) + '...' : args})]`)
        } else if (b.type === 'tool_result') {
          const content = b.content.length > 3000
            ? b.content.slice(0, 2000) + '\n...[截断]...\n' + b.content.slice(-800)
            : b.content
          parts.push(`[工具结果 ${b.tool_use_id}]: ${content}`)
        }
      }
      const role = m.role === 'user' ? '用户' : '助手'
      return `[${role}]: ${parts.join('\n')}`
    }).join('\n\n')
  }

  // 调用 LLM 生成对话摘要，用于自动压缩（公开方法，供 UI 层 /compact 命令调用）
  async generateCompactSummary(): Promise<string> {
    // prune 已在投影层处理，此处直接用事件日志序列化
    const contentToSummarize = this.serializeForSummary(this.projectToMessages())

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
    } catch {
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
  ): AsyncGenerator<StreamEvent | { type: '__llm_result__'; fullText: string; toolCalls: Array<{ id: string; name: string; input: unknown }>; hitMaxOutputTokens: boolean }> {
    let fullText = ''
    const toolCalls: Array<{ id: string; name: string; input: unknown }> = []
    let hitMaxOutputTokens = false

    // plan 模式下对写工具 description 追加不可用标注，
    // 让 LLM 在工具选择阶段就知道这些工具当前不可用，避免盲目调用。
    const isPlanMode = this.config.permissions.getMode() === 'plan'
    const toolsForLLM = this.chatMode
      ? []  // chat 模式：不传任何工具，模型只能直接回复
      : isPlanMode
        ? this.config.tools.map(t =>
            t.readonly ? t : {
              ...t,
              description: t.description + '\n[Plan 模式：此工具当前不可用，调用将被拒绝]',
            }
          )
        : this.config.tools

    log.debug('调用 LLM stream', { model: this.config.provider.model, turn: turns })

    try {
      const liveTodo = buildLiveTodoContext(this.activeTodoSnapshot)
      const systemPromptForThisTurn = liveTodo
        ? [...this.config.systemPrompt, liveTodo]
        : this.config.systemPrompt

      // 从 store 事件日志投影出 LLM 所需的消息（含 prune/budget 优化）
      const projectedMessages = projectForLLM(this.store.getEventLog(), {
        latestPreprocessed: this.store.getLatestPreprocessed(),
        prunedToolCallIds: this.store.isToolCallPruned('__budget__') ? undefined : undefined, // 由 applyToolResultBudget 管理
      })

      const streamFn = () => this.config.provider.stream(
        projectedMessages as never,
        toolsForLLM,
        systemPromptForThisTurn,
        this.config.maxTokens ?? 8096,
        this.abortController.signal,
      )
      for await (const chunk of streamFn()) {
        if (this.abortController.signal.aborted) break

        if (chunk.type === 'text_delta' && chunk.delta) {
          fullText += chunk.delta
          // dsml 模式：检测到 DSML invoke 标记后停止流式发出，等流结束后统一解析。
          // native 模式：直接流式发出，不做 DSML 检测（避免误判正常文本中的 DSML 字样）。
          // TODO: DSML 解析暂时关闭，强制走 native 模式
          const isDsmlMode = false // this.config.provider.toolMode === 'dsml'
          if (!isDsmlMode || !hasDsmlMarker(fullText)) {
            yield { type: 'text_delta', delta: chunk.delta }
          }
          // dsml 模式且已出现 DSML invoke 标记：停止发出后续 delta，等流结束后统一处理
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
      this.store.appendEvents(createUserMessageEvent(
        `[系统提示] 上次执行因错误中断: ${errMsg}。请从中断处继续完成任务。`,
        this.currentRequestId ?? undefined,
      ))
      return
    }

    yield { type: '__llm_result__', fullText, toolCalls, hitMaxOutputTokens }
  }

  // ── 执行单个工具调用，返回 tool_result ContentBlock ──────────────────────────
  private async *executeOneTool(
    tc: { id: string; name: string; input: unknown },
  ): AsyncGenerator<StreamEvent | { type: '__tool_result__'; block: ContentBlock }> {
    const logQueue: string[] = []
    const onLog = (line: string) => { logQueue.push(line) }

    // 查找工具
    const tool = this.config.tools.find(t => t.name === tc.name)
    if (!tool) {
      yield { type: 'tool_start', id: tc.id, name: tc.name, input: tc.input, description: tc.name }
      yield { type: 'tool_end', id: tc.id, name: tc.name, result: { type: 'error', message: `未找到工具: ${tc.name}` } }
      yield { type: '__tool_result__', block: { type: 'tool_result', tool_use_id: tc.id, content: `错误: 未找到工具: ${tc.name}`, is_error: true } }
      return
    }

    const description = tool.describe?.(tc.input) ?? tc.name
    yield { type: 'tool_start', id: tc.id, name: tc.name, input: tc.input, description }
    log.debug('工具开始执行', { toolName: tc.name, toolId: tc.id, description })

    // 第一道：工具级硬拦截（checkPermission）
    // 在询问用户之前先做硬检查，避免用户被询问无论如何都会被拦截的危险操作。
    if (tool.checkPermission) {
      const hardCheck = await tool.checkPermission(tc.input as never)
      if (!hardCheck.granted) {
        log.info('工具硬拦截', { toolName: tc.name, reason: hardCheck.reason })
        auditLog({
          action: 'permission_denied',
          resource: tc.name,
          result: 'denied',
          permissionMode: this.config.permissions.getMode(),
          details: { reason: hardCheck.reason, stage: 'hard_check' },
        })
        yield { type: 'tool_end', id: tc.id, name: tc.name, result: { type: 'error', message: hardCheck.reason } }
        yield { type: '__tool_result__', block: { type: 'tool_result', tool_use_id: tc.id, content: `错误: ${hardCheck.reason}`, is_error: true } }
        return
      }
    }

    // 第二道：PermissionManager 策略决策
    const filePath = tool.getFilePath?.(tc.input as never)
    const ruleContent = tool.getRuleContent?.(tc.input as never)
    const allowed = await this.config.permissions.check({
      toolName: tc.name,
      description,
      isReadonly: tool.readonly,
      isDestructive: tool.isDestructive,
      filePath,
      ruleContent,
    })

    if (!allowed) {
      log.info('权限拒绝', { toolName: tc.name, description })
      auditLog({
        action: 'permission_denied',
        resource: tc.name,
        result: 'denied',
        permissionMode: this.config.permissions.getMode(),
        details: { description },
      })
      yield { type: 'permission_denied', id: tc.id, toolName: tc.name, description }

      // 构建拒绝原因，根据模式和拒绝追踪状态给出不同提示
      let denyReason: string
      if (this.config.permissions.getMode() === 'plan') {
        denyReason = '[Plan 模式] 此操作在规划模式下被禁止。请继续完成规划，不要尝试执行写操作。'
      } else if (this.config.permissions.isDenialThresholdReached()) {
        const { consecutive, total } = this.config.permissions.getDenialState()
        denyReason = `用户拒绝了此操作（已连续拒绝 ${consecutive} 次，会话内共拒绝 ${total} 次）。请停止尝试此类操作，直接询问用户希望如何处理。`
      } else {
        denyReason = '用户拒绝了此操作'
      }
      yield { type: '__tool_result__', block: { type: 'tool_result', tool_use_id: tc.id, content: denyReason, is_error: true } }
      return
    }

    // 写操作记录审计日志
    if (!tool.readonly) {
      auditLog({ action: tc.name as never, resource: description, result: 'allowed', details: { toolName: tc.name } })
    }

    // Zod 参数校验：在执行前验证 LLM 传入的参数格式，避免运行时崩溃
    // effectiveInput 可能在自动修复后与 tc.input 不同，后续 execute 统一用 effectiveInput
    let effectiveInput: unknown = tc.input
    if (tool.inputSchema) {
      // 自动修复：LLM 传单个对象而非数组时（如 todos: {...} 而非 todos: [{...}]），
      // 尝试将对象包装成数组后重新校验，避免因格式错误浪费一轮重试。
      const inputObj = tc.input as Record<string, unknown>
      if (inputObj && typeof inputObj === 'object' && !Array.isArray(inputObj)) {
        const arrayFields = ['todos'] // 已知需要数组的字段名
        for (const field of arrayFields) {
          if (
            field in inputObj &&
            inputObj[field] !== null &&
            typeof inputObj[field] === 'object' &&
            !Array.isArray(inputObj[field])
          ) {
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
        const issues = parseResult.error.issues
          .map(i => `  - ${i.path.join('.')}: ${i.message}`)
          .join('\n')
        const errMsg = `工具参数校验失败 [${tc.name}]:\n${issues}`
        log.warn('工具参数校验失败', { toolName: tc.name, issues: parseResult.error.issues })
        yield { type: 'tool_end', id: tc.id, name: tc.name, result: { type: 'error', message: errMsg } }
        yield { type: '__tool_result__', block: { type: 'tool_result', tool_use_id: tc.id, content: `错误: ${errMsg}`, is_error: true } }
        return
      }
    }

    // 工具执行：用 Promise.race 统一处理超时、abort、正常完成三种情况
    // 优先使用工具输入中指定的 timeout（如 bash 工具的 timeout 参数），否则用默认值 60 分钟
    const inputTimeout = (effectiveInput as Record<string, unknown>)?.timeout
    const TOOL_TIMEOUT_MS = (typeof inputTimeout === 'number' && inputTimeout > 0)
      ? inputTimeout + 5000  // 比工具自身超时多 5s，确保工具先超时并返回错误信息
      : 60 * 60 * 1000       // 默认 60 分钟（兜底，工具自身 timeout 是主要控制手段）

    const toolPromise: Promise<ToolResult> = tool.execute(effectiveInput as never, { onLog })
      .then(r => r)
      .catch((e: unknown) => ({
        type: 'error' as const,
        message: `工具执行异常 [${tc.name}]: ${e instanceof Error ? e.message : String(e)}`,
      }))

    const timeoutPromise: Promise<ToolResult> = new Promise(resolve =>
      setTimeout(() => resolve({
        type: 'error',
        message: `工具执行超时（超过 ${TOOL_TIMEOUT_MS / 1000}s）：${tc.name}`,
      }), TOOL_TIMEOUT_MS)
    )

    const abortPromise: Promise<ToolResult> = new Promise(resolve => {
      this.abortController.signal.addEventListener('abort', () =>
        resolve({ type: 'error', message: '任务已被中止' }), { once: true }
      )
    })

    // 用 Promise.race 竞争：工具完成 / 超时 / abort
    // 每 30ms tick 一次 flush 日志，同时等待 race 结果
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

    // 刷新工具完成后残留的日志
    while (logQueue.length > 0) {
      yield { type: 'tool_log', id: tc.id, name: tc.name, line: logQueue.shift()! }
    }

    if (this.abortController.signal.aborted) {
      yield { type: 'tool_end', id: tc.id, name: tc.name, result: { type: 'error', message: '任务已被中止' } }
      return
    }

    yield { type: 'tool_end', id: tc.id, name: tc.name, result: finalResult }
    log.debug('工具执行完成', { toolName: tc.name, toolId: tc.id, resultType: finalResult.type })

    // todo 工具执行成功后刷新会话级任务快照。
    // 只在成功时刷新（失败不改变任务状态，快照无需更新）。
    // 覆盖所有会修改任务列表的工具：write / update / append / reset。
    // todo_read 是只读工具，但也刷新快照，确保会话首次读取后快照不再为 null。
    const TODO_TOOLS = new Set(['todo_write', 'todo_update', 'todo_append', 'todo_reset', 'todo_read'])
    if (TODO_TOOLS.has(tc.name) && finalResult.type === 'success') {
      try {
        this.activeTodoSnapshot = loadTodos()
        log.debug('任务快照已刷新', { toolName: tc.name, count: this.activeTodoSnapshot.length })
      } catch {
        // 读取失败不影响主流程，快照保持上次值
      }
    }

    const resultContent = finalResult.type === 'success' ? finalResult.output : `错误: ${finalResult.message}`
    // tool_result 内容截上限（写入事件时），与 projections.ts 中的常量保持一致
    const MAX_TOOL_RESULT_CHARS = 12000
    // 截断过长的工具输出，防止单条结果撑爆 history
    const truncatedContent = resultContent.length > MAX_TOOL_RESULT_CHARS
      ? resultContent.slice(0, MAX_TOOL_RESULT_CHARS)
        + `\n...[输出过长，已截断，共 ${resultContent.length} 字符，当前仅显示前 ${MAX_TOOL_RESULT_CHARS} 字符。`
        + `如需读取更多内容，请使用 file_read 工具并指定 startLine/endLine 参数分段读取。]...`
      : resultContent

    yield { type: '__tool_result__', block: { type: 'tool_result', tool_use_id: tc.id, content: truncatedContent, is_error: finalResult.type === 'error' } }
  }

  // 图片扩展名 → MIME 类型映射
  private static readonly IMAGE_MIME_MAP: Record<string, ImageSource['mediaType']> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
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
    const cwd = this.config.sessionCwd!
    const { attachments, cleanText, errors } = await extractMediaFromText(text, cwd)

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
    const costBefore = this.costs.getCostUsd()
    const usageBefore = this.costs.getUsage()
    let exitStatus: 'completed' | 'error' | 'aborted' | 'turn_limit' | 'budget_exceeded' | 'permission_denied' = 'completed'
    let totalToolCalls = 0
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
    const hasImageBlocks = Array.isArray(processedContent) &&
      (processedContent as ContentBlock[]).some(b => b.type === 'image')
    if (typeof processedContent === 'string' && this.config.sessionCwd) {
      try {
        processedContent = await this.preprocessUserMessage(processedContent)
      } catch (err) {
        log.warn('图片预处理失败', { error: String(err) })
      }
    }

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
    const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3

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

        if (!latestHasImage && tokenCount > autoCompactThreshold) {
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
        let toolCalls: Array<{ id: string; name: string; input: unknown }> = []
        let hitMaxOutputTokens = false
        let llmError = false

        for await (const ev of this.streamOneTurn(turns, maxBudgetUsd)) {
          if ('type' in ev && ev.type === '__llm_result__') {
            // 内部结果信号，不向外 yield
            fullText = ev.fullText
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
          } else {
            yield ev
          }
        }
        if (llmError) break

        // 将 assistant 回复写入事件日志
        const toolCallEvents = toolCalls.length > 0
          ? toolCalls.map(tc => ({ id: tc.id, name: tc.name, input: tc.input }))
          : undefined
        if (fullText || toolCallEvents) {
          this.store.appendEvents(createAssistantMessageEvent(
            fullText,
            toolCallEvents,
            this.currentRequestId ?? undefined,
          ))
        }

        // 第一轮 LLM 调用完成后，清除预处理状态（后续轮次不再需要图片）
        if (hasImageBlocks && turns === 1) {
          this.store.setLatestPreprocessed(null)
        }

        // 没有工具调用：dsml 模式下尝试从文本中解析 DSML 格式工具调用
        // native 模式下跳过，避免把正常文本中偶然出现的 DSML 字样误解析为工具调用
        // TODO: DSML 解析暂时关闭，强制走 native 模式
        const isDsmlMode = false // this.config.provider.toolMode === 'dsml'
        if (isDsmlMode && toolCalls.length === 0 && hasDsmlMarker(fullText)) {
          const dsmlResult = parseDsml(fullText)
          if (dsmlResult.toolCalls.length > 0) {
            log.info('从文本中解析到 DSML 工具调用', {
              turn: turns,
              count: dsmlResult.toolCalls.length,
              tools: dsmlResult.toolCalls.map(t => t.name),
            })
            toolCalls.push(...dsmlResult.toolCalls)

            // 补发清理后的正文 delta（之前在 streamOneTurn 中被缓冲了）
            if (dsmlResult.cleanText) yield { type: 'text_delta', delta: dsmlResult.cleanText }

            // DSML 解析出工具调用：追加新的 assistant 事件（包含解析出的工具调用）
            // 注意：事件日志是 append-only，之前已追加的纯文本 assistant 事件保留
            if (dsmlResult.cleanText || dsmlResult.toolCalls.length > 0) {
              this.store.appendEvents(createAssistantMessageEvent(
                dsmlResult.cleanText ?? '',
                dsmlResult.toolCalls.map(tc => ({ id: tc.id, name: tc.name, input: tc.input })),
                this.currentRequestId ?? undefined,
              ))
            }
          } else {
            // 有 DSML invoke 标记但解析不出工具调用（格式不完整）：补发完整 fullText 给前端
            yield { type: 'text_delta', delta: fullText }
          }
        }
        // 注意：无 DSML 标记时 fullText 已在 streamOneTurn 中全部流式发出，无需补发

        // ── 无工具调用：心跳协议判定 ─────────────────────────────────
        if (toolCalls.length === 0) {
          log.debug('本轮无工具调用', { turn: turns, textLength: fullText.length })

          // 输出被截断时注入继续指令，让 LLM 从中断处接着写，最多重试3次
          if (hitMaxOutputTokens && maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
            maxOutputTokensRecoveryCount++
            log.info('输出被截断，注入继续指令', { turn: turns, recovery: maxOutputTokensRecoveryCount })
            this.store.appendEvents(createUserMessageEvent(
              '[系统内部] 输出已被截断。请直接从中断处继续，不要重复已输出的内容，不要道歉或解释。',
              this.currentRequestId ?? undefined,
            ))
            continue
          }

          // 心跳协议检测
          const hasContinue = fullText.includes(HEARTBEAT_CONTINUE)
          const hasDone = fullText.includes(HEARTBEAT_DONE)

          // DONE 标记：立即结束
          if (hasDone) {
            log.debug('心跳协议：DONE，停止执行', { turn: turns })
            break
          }

          // 任务系统确认全部完成：结束
          const allTasksDone = this.activeTodoSnapshot !== null &&
            this.activeTodoSnapshot.length > 0 &&
            this.activeTodoSnapshot.every(t => t.status === 'completed')
          if (allTasksDone) {
            log.debug('任务系统确认全部完成，停止执行', { turn: turns })
            break
          }

          // CONTINUE 标记但无工具调用：允许最多 2 次（LLM 可能在思考下一步）
          if (hasContinue) {
            if (turns < maxTurns) {
              log.debug('心跳协议：CONTINUE（无工具调用），继续', { turn: turns })
              continue
            }
            log.debug('心跳协议：CONTINUE 但已达轮次上限，停止', { turn: turns })
          }

          // 无标记、无工具调用：自然结束（chat/简单问答/任务完成）
          log.debug('无工具调用无心跳标记，自然结束', { turn: turns })
          break
        }

        // ── 执行工具调用（串行，委托给 executeOneTool）──────────────────────
        log.debug('本轮工具调用', { turn: turns, tools: toolCalls.map(tc => tc.name) })

        let toolAborted = false
        for (const tc of toolCalls) {
          totalToolCalls++
          for await (const ev of this.executeOneTool(tc)) {
            if ('type' in ev && ev.type === '__tool_result__') {
              // 将工具结果写入事件日志
              const block = ev.block as { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
              this.store.appendEvents(createToolResultEvent(
                block.tool_use_id,
                tc.name,
                block.content,
                block.is_error === true,
                this.currentRequestId ?? undefined,
              ))
            } else {
              yield ev as StreamEvent
              // abort 后用标志位跳出，不能直接 return（会跳过 finally 导致 running 永久锁死）
              if (this.abortController.signal.aborted) {
                toolAborted = true
                break
              }
            }
          }
          if (toolAborted) break
        }
        if (toolAborted) break
      }

      // 达到最大轮次（仅 ask/plan 模式会触发，craft 模式 maxTurns = Infinity）
      if (turns >= maxTurns) {
        exitStatus = 'turn_limit'
        yield { type: 'interrupted', reason: 'turn_limit', message: `已达到最大执行轮次 ${maxTurns}，任务可能未完成。发送"继续"可恢复执行。` }
        yield { type: 'turn_limit', turns }
        this.store.appendEvents(createUserMessageEvent(
          `[系统提示] 任务因达到最大轮次限制（${maxTurns} 轮）而中断，尚未完成。请继续执行剩余工作。`,
          this.currentRequestId ?? undefined,
        ))
      }
      // 被用户中止
      if (this.abortController.signal.aborted) {
        exitStatus = 'aborted'
        yield { type: 'interrupted', reason: 'aborted', message: '任务已被中止。发送"继续"可恢复执行。' }
        this.store.appendEvents(createUserMessageEvent(
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
        totalToolCalls,
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
  }

  /** 向后兼容：返回由事件投影出的 Message[] */
  getHistory(): readonly Message[] {
    return this.projectToMessages()
  }

  /** 返回前端展示用的 DisplayMessage[]（直接从事件投影，含工具卡片） */
  getDisplayMessages(): import('./ConversationStore.js').DisplayMessage[] {
    return projectForDisplay(this.store.getEventLog())
  }

  /** 向后兼容：清空并重新加载（旧调用方已迁移，此方法仅清空） */
  setHistory(_messages: Message[]) {
    this.store.clear()
  }

  private chatMode = false
  setChatMode(on: boolean) { this.chatMode = on }
  setSystemPrompt(prompt: string[]) { this.config.systemPrompt = prompt }
  setProvider(provider: LLMProvider) { this.config.provider = provider }
  getTools(): readonly ToolDef[] { return this.config.tools }

  /**
   * 将事件日志投影为旧格式 Message[]（向后兼容）。
   * 用于 saveSession、postRunHooks 等仍依赖 Message[] 的调用方。
   */
  private projectToMessages(): Message[] {
    const displayMsgs = projectForDisplay(this.store.getEventLog())
    return displayMsgs.map(dm => ({
      role: dm.role as 'user' | 'assistant',
      content: dm.content,
      timestamp: dm.timestamp,
      requestId: dm.requestId,
    }))
  }

  compactHistory(summary: string) {
    // 追压缩事件到事件日志（不删除原始事件）
    this.store.appendEvents(createCompactEvent(summary, this.currentRequestId ?? undefined))
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
