import type { LLMProvider } from './providers/index.js'
import type { ToolDef, ToolResult } from './Tool.js'
import type { PermissionManager } from './PermissionManager.js'
import { CostTracker } from './CostTracker.js'
import { logger } from './logger.js'
import { auditLog } from './audit.js'
import { parseDsml, hasDsmlMarker } from './DsmlParser.js'
import { loadTodos } from '../tools/TodoTool.js'

const log = logger.child({ component: 'query-engine' })

/**
 * 实时读取 todos.json，构建任务状态快照字符串，注入到 system prompt。
 * 无活跃任务（pending/in_progress）时返回 null，避免无意义 token 消耗。
 * 文件不存在或读取失败时静默返回 null，不影响正常请求。
 */
function buildLiveTodoContext(): string | null {
  try {
    const todos = loadTodos()
    const active = todos.filter(t => t.status !== 'completed')
    if (active.length === 0) return null

    const completedCount = todos.filter(t => t.status === 'completed').length
    const lines: string[] = [
      '## 当前任务状态（实时）',
      `进度：${completedCount}/${todos.length}`,
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
      lines.push(`完成后调用：todo_update(id='${inProgress.id}', status='completed')`)
    }

    return lines.join('\n')
  } catch {
    // 文件不存在或读取失败时静默跳过
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
  initialMessages?: Message[]
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

// ── Token 估算 ────────────────────────────────────────────────────────────────
// 优化1：区分中英文字符，中文约 1.5 token/字，英文约 0.25 token/字符
// 图片内容块不计入 token 估算，避免 base64 数据虚高触发误压缩
function estimateTokens(messages: Message[]): number {
  let tokens = 0
  for (const m of messages) {
    if (typeof m.content === 'string') {
      tokens += estimateStringTokens(m.content)
    } else {
      for (const b of m.content) {
        if (b.type === 'text') tokens += estimateStringTokens(b.text)
        else if (b.type === 'tool_result') tokens += estimateStringTokens(b.content)
        else if (b.type === 'image') tokens += 1000  // 图片固定计 1000 token（视觉模型实际消耗）
        else tokens += estimateStringTokens(JSON.stringify(b))
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
      // CJK 及其他宽字符：实际约 1.5 token/字，用 +6 再整体 /4 ≈ 1.5
      tokens += 6
    } else {
      // ASCII / 拉丁字符：约 0.25 token/字符（4字符≈1token）
      tokens += 1
    }
  }
  return Math.ceil(tokens / 4)
}

// 旧工具输出超过此字符数时替换为占位符（压缩前的廉价预处理）
const PRUNE_TOOL_RESULT_THRESHOLD = 800
const PRUNED_PLACEHOLDER = '[旧工具输出已清除以节省上下文空间]'

// tool_result 内容截断上限（写入 history 时）
// 优化2：单条 tool_result 总量预算，防止单次大输出撑爆上下文
const MAX_TOOL_RESULT_CHARS = 12000  // 单条上限（约 3000-6000 token）
// 所有 tool_result 的总字符预算（超出时对最旧的结果做截断）
const TOTAL_TOOL_RESULT_BUDGET_CHARS = 60000  // 约 15000-30000 token

export class QueryEngine {
  private config: QueryEngineConfig
  private history: Message[]
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

  constructor(config: QueryEngineConfig) {
    this.config = config
    this.history = config.initialMessages ? [...config.initialMessages] : []
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

  // ── 优先级 2：压缩前先 prune 旧工具输出（不调用 LLM，免费降 token）──────────
  // 保护最近 protectTailCount 条消息，对更早的 tool_result 做截断
  private pruneOldToolResults(protectTailCount = 40): number {
    let pruned = 0
    const boundary = Math.max(0, this.history.length - protectTailCount)
    for (let i = 0; i < boundary; i++) {
      const msg = this.history[i]
      if (msg.role !== 'user') continue
      if (!Array.isArray(msg.content)) continue
      let changed = false
      const newContent = (msg.content as ContentBlock[]).map(b => {
        if (b.type !== 'tool_result') return b
        if (b.content === PRUNED_PLACEHOLDER) return b
        if (b.content.length <= PRUNE_TOOL_RESULT_THRESHOLD) return b
        pruned++
        changed = true
        return { ...b, content: PRUNED_PLACEHOLDER }
      })
      if (changed) this.history[i] = { ...msg, content: newContent }
    }
    return pruned
  }

  // ── 优先级 0（最廉价）：tool_result 总量预算截断 ──────────────────────────────
  // 参考 claude-code applyToolResultBudget：当所有 tool_result 总字符超出预算时，
  // 从最旧的开始截断，保护最近 protectTailCount 条消息不被截断。
  // 不调用 LLM，纯字符串操作，每轮都可以运行。
  private applyToolResultBudget(protectTailCount = 20): void {
    let total = 0
    for (const msg of this.history) {
      if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
      for (const b of msg.content as ContentBlock[]) {
        if (b.type === 'tool_result' && b.content !== PRUNED_PLACEHOLDER) {
          total += b.content.length
        }
      }
    }
    if (total <= TOTAL_TOOL_RESULT_BUDGET_CHARS) return

    // 超出预算：从最旧的 tool_result 开始截断（保护尾部）
    const boundary = Math.max(0, this.history.length - protectTailCount)
    for (let i = 0; i < boundary && total > TOTAL_TOOL_RESULT_BUDGET_CHARS; i++) {
      const msg = this.history[i]
      if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
      let changed = false
      const newContent = (msg.content as ContentBlock[]).map(b => {
        if (b.type !== 'tool_result') return b
        if (b.content === PRUNED_PLACEHOLDER) return b
        total -= b.content.length
        changed = true
        return { ...b, content: PRUNED_PLACEHOLDER }
      })
      if (changed) this.history[i] = { ...msg, content: newContent }
    }
  }

  // ── 修复孤立的 tool_use / tool_result 对（防止 API 报错）──────────────────────
  // 压缩后可能出现：assistant 有 tool_use 但对应 tool_result 被删，或反过来
  private sanitizeToolPairs(): void {
    // 收集所有 assistant 消息中的 tool_use id
    const survivingCallIds = new Set<string>()
    for (const msg of this.history) {
      if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue
      for (const b of msg.content as ContentBlock[]) {
        if (b.type === 'tool_use') survivingCallIds.add(b.id)
      }
    }

    // 收集所有 tool_result 引用的 id
    const resultIds = new Set<string>()
    for (const msg of this.history) {
      if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
      for (const b of msg.content as ContentBlock[]) {
        if (b.type === 'tool_result') resultIds.add(b.tool_use_id)
      }
    }

    // 1. 删除孤立的 tool_result（找不到对应 tool_use）
    const orphanResults = new Set([...resultIds].filter(id => !survivingCallIds.has(id)))
    if (orphanResults.size > 0) {
      this.history = this.history.map(msg => {
        if (msg.role !== 'user' || !Array.isArray(msg.content)) return msg
        const filtered = (msg.content as ContentBlock[]).filter(
          b => !(b.type === 'tool_result' && orphanResults.has(b.tool_use_id))
        )
        // 如果过滤后 content 为空，转为文本消息避免空 content
        if (filtered.length === 0) return { ...msg, content: '[工具结果已在压缩中移除]' }
        return { ...msg, content: filtered }
      })
    }

    // 2. 为孤立的 tool_use（没有对应 tool_result）插入 stub result
    const missingResults = new Set([...survivingCallIds].filter(id => !resultIds.has(id)))
    if (missingResults.size > 0) {
      const patched: Message[] = []
      for (const msg of this.history) {
        patched.push(msg)
        if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue
        for (const b of msg.content as ContentBlock[]) {
          if (b.type === 'tool_use' && missingResults.has(b.id)) {
            // 在 assistant 消息后立即插入 stub tool_result
            patched.push({
              role: 'user',
              content: [{
                type: 'tool_result',
                tool_use_id: b.id,
                content: '[早期对话的工具结果 — 详见上方上下文摘要]',
              }],
            })
          }
        }
      }
      this.history = patched
    }
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
    // Phase 1: prune 旧工具输出（免费）
    this.pruneOldToolResults()

    const contentToSummarize = this.serializeForSummary(this.history)

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
      summary = `[对话历史摘要：共 ${this.history.length} 条消息，因摘要生成失败而截断]`
    }

    const result = summary || `[对话历史：${this.history.length} 条消息]`
    // 保存本次摘要，供下次迭代更新使用
    this.previousSummary = result
    return result
  }

  // 检测用户消息是否为查询/回忆类意图（只需回答，不应触发 continuation 自动执行）
  private isQueryIntent(message: string): boolean {
    const QUERY_PATTERNS = [
      // 询问上一次/之前的内容
      /上(一次|次|回|个)(的)?(问题|任务|内容|对话|消息|指令|操作|工作|结果)/,
      /之前(的)?(问题|任务|内容|对话|消息|指令|操作|工作|结果)/,
      /前(一次|次|回)(的)?(问题|任务|内容|对话)/,
      /刚才(说|问|做|讲)(了|的)?(什么|啥)/,
      // 询问历史/记录
      /历史(记录|消息|对话|内容)/,
      /对话(记录|历史)/,
      // 你记得/还记得
      /你(还)?记得/,
      /(还)?记得(吗|么|不)/,
      // 我之前说/问/做
      /我(之前|刚才|上次)(说|问|做|讲)(了|的)?(什么|啥)?/,
      // 回顾/总结类
      /回顾(一下|下)?/,
      /总结(一下|下)?(之前|上次|刚才)/,
      // 是什么/是啥 结尾的简短问句（配合上下文）
      /^(上|之前|刚才).{0,20}(是什么|是啥|是哪|怎么|如何)\??$/,
    ]
    return QUERY_PATTERNS.some(p => p.test(message))
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
    const toolsForLLM = isPlanMode
      ? this.config.tools.map(t =>
          t.readonly ? t : {
            ...t,
            description: t.description + '\n[Plan 模式：此工具当前不可用，调用将被拒绝]',
          }
        )
      : this.config.tools

    log.debug('调用 LLM stream', { model: this.config.provider.model, turn: turns })

    try {
      const liveTodo = buildLiveTodoContext()
      const systemPromptForThisTurn = liveTodo
        ? [...this.config.systemPrompt, liveTodo]
        : this.config.systemPrompt

      const streamFn = () => this.config.provider.stream(
        this.history as never,
        toolsForLLM,
        systemPromptForThisTurn,
        this.config.maxTokens ?? 8096,
        this.abortController.signal,
      )
      for await (const chunk of streamFn()) {
        if (this.abortController.signal.aborted) break

        if (chunk.type === 'text_delta' && chunk.delta) {
          fullText += chunk.delta
          // 检测到 DSML invoke 标记前正常流式发出，检测到后停止发出。
          // 流结束后在 send() 中统一处理：有工具调用则补发清理后的正文，否则补发剩余文本。
          // 这样既保留了正文部分的流式体验，又避免 DSML 标记出现在前端。
          // hasDsmlMarker 检测 <|DSML|invoke，不依赖 provider 名称，兼容任何输出 DSML 的模型。
          if (!hasDsmlMarker(fullText)) {
            // 尚未出现 DSML invoke 标记：正常流式发出
            yield { type: 'text_delta', delta: chunk.delta }
          }
          // 已出现 DSML invoke 标记：停止发出后续 delta，等流结束后统一处理
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
      this.history.push({ role: 'user', content: `[系统提示] 上次执行因错误中断: ${errMsg}。请从中断处继续完成任务。` })
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

    // 工具执行：用 Promise.race 统一处理超时、abort、正常完成三种情况
    // 优先使用工具输入中指定的 timeout（如 bash 工具的 timeout 参数），否则用默认值 10 分钟
    const inputTimeout = (tc.input as Record<string, unknown>)?.timeout
    const TOOL_TIMEOUT_MS = (typeof inputTimeout === 'number' && inputTimeout > 0)
      ? inputTimeout + 5000  // 比工具自身超时多 5s，确保工具先超时并返回错误信息
      : 10 * 60 * 1000       // 默认 10 分钟

    const toolPromise: Promise<ToolResult> = tool.execute(tc.input as never, { onLog })
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

    const resultContent = finalResult.type === 'success' ? finalResult.output : `错误: ${finalResult.message}`
    // 截断过长的工具输出，防止单条结果撑爆 history
    const truncatedContent = resultContent.length > MAX_TOOL_RESULT_CHARS
      ? resultContent.slice(0, MAX_TOOL_RESULT_CHARS)
        + `\n...[输出过长，已截断，共 ${resultContent.length} 字符，当前仅显示前 ${MAX_TOOL_RESULT_CHARS} 字符。`
        + `如需读取更多内容，请使用 file_read 工具并指定 startLine/endLine 参数分段读取。]...`
      : resultContent

    yield { type: '__tool_result__', block: { type: 'tool_result', tool_use_id: tc.id, content: truncatedContent, is_error: finalResult.type === 'error' } }
  }

  async *send(userMessage: string | Message): AsyncGenerator<StreamEvent> {
    // 并发保护：如果已有任务在运行，拒绝新任务
    if (this.running) {
      log.warn('并发保护触发：上一个任务仍在执行中', { historyLength: this.history.length })
      yield { type: 'error', message: '上一个任务仍在执行中，请等待完成后再发送新消息' }
      return
    }
    this.running = true
    this.abortController = new AbortController()

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

    // 规范化用户消息为 Message 对象，并添加 requestId、trigger、timestamp
    const userMsg: Message = typeof userMessage === 'string'
      ? { role: 'user', content: userMessage, requestId: this.currentRequestId ?? undefined, timestamp: Date.now() }
      : { ...userMessage, requestId: this.currentRequestId ?? userMessage.requestId, timestamp: userMessage.timestamp ?? Date.now() }
    
    // 前置意图检测：查询/回忆类消息禁用 continuation 自动执行（复用上方已提取的 msgText）
    const isQueryMode = this.isQueryIntent(msgText)

    // craft 模式：不设轮次上限，完全依赖 autocompact 管理上下文
    // ask/plan 模式：保留轮次限制，超出后通知用户决定是否继续
    const isCraftMode = this.config.permissions.getMode() === 'craft'
    const maxTurns = isCraftMode ? Infinity : (this.config.maxTurns ?? 50)

    log.debug('send 开始', { historyLength: this.history.length, isQueryMode, estimatedTokens: this.getEstimatedTokens(), maxTurns: isCraftMode ? 'unlimited' : maxTurns })
    this.history.push(userMsg)

    const maxBudgetUsd = this.config.maxBudgetUsd
    // 自动压缩阈值：默认 20000 tokens
    const autoCompactThreshold = this.config.autoCompactThreshold ?? 20000
    let turns = 0
    // 用 API 返回的真实 inputTokens 校准估算，避免中文场景低估
    let lastKnownInputTokens = 0
    // max_output_tokens 恢复计数（最多重试3次，参考 claude-code）
    let maxOutputTokensRecoveryCount = 0
    const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3

    try {
      while (turns < maxTurns) {
        if (this.abortController.signal.aborted) break
        turns++

        log.debug(`第 ${turns} 轮开始`, {
          historyLength: this.history.length,
          estimatedTokens: estimateTokens(this.history),
          lastKnownInputTokens,
          maxTurns: isCraftMode ? 'unlimited' : maxTurns,
        })

        // 成本预算检查（每轮开始前）
        if (maxBudgetUsd !== undefined && this.costs.getCostUsd() >= maxBudgetUsd) {
          yield { type: 'budget_exceeded', costUsd: this.costs.getCostUsd(), limitUsd: maxBudgetUsd }
          break
        }

        // 每轮先做廉价的 tool_result 预算截断（不调用 LLM）
        this.applyToolResultBudget()

        // autocompact 触发判断：优先用 API 返回的真实 inputTokens，其次用估算值
        const tokenCount = lastKnownInputTokens > 0
          ? lastKnownInputTokens
          : estimateTokens(this.history)

        const latestMsg = this.history[this.history.length - 1]
        const latestHasImage = Array.isArray(latestMsg?.content) &&
          (latestMsg.content as ContentBlock[]).some(b => b.type === 'image')

        if (!latestHasImage && tokenCount > autoCompactThreshold) {
          yield { type: 'compact_start' }
          const summary = await this.generateCompactSummary()
          if (this.onBeforeCompact) {
            try { await this.onBeforeCompact(summary) } catch { /* 归档失败不阻断压缩 */ }
          }
          this.compactHistory(summary)
          this.sanitizeToolPairs()
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
          } else if (ev.type === 'error' || ev.type === 'interrupted') {
            yield ev
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

        // 将 assistant 回复加入历史
        const assistantBlocks: ContentBlock[] = []
        if (fullText) assistantBlocks.push({ type: 'text', text: fullText })
        for (const tc of toolCalls) {
          assistantBlocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input })
        }
        if (assistantBlocks.length > 0) {
          this.history.push({
            role: 'assistant',
            content: assistantBlocks,
            timestamp: Date.now(),
            requestId: this.currentRequestId ?? undefined,
            trigger: this.currentTrigger,
            ...(this.currentCronDescription ? { cronDescription: this.currentCronDescription } : {}),
          })
        }

        // 没有工具调用：尝试从文本中解析 DSML 格式工具调用
        // parseDsml 内部通过 hasDsmlMarker 检测，不依赖 provider 名称
        if (toolCalls.length === 0 && hasDsmlMarker(fullText)) {
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

            // 重新构建 assistant 历史块（包含解析出的工具调用）
            const lastAssistant = this.history[this.history.length - 1]
            if (lastAssistant?.role === 'assistant') {
              const blocks: ContentBlock[] = []
              if (dsmlResult.cleanText) blocks.push({ type: 'text', text: dsmlResult.cleanText })
              for (const tc of dsmlResult.toolCalls) {
                blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input })
              }
              this.history[this.history.length - 1] = { ...lastAssistant, content: blocks }
            }
          } else {
            // 有 DSML invoke 标记但解析不出工具调用（格式不完整）：补发完整 fullText 给前端
            yield { type: 'text_delta', delta: fullText }
          }
        }
        // 注意：无 DSML 标记时 fullText 已在 streamOneTurn 中全部流式发出，无需补发

        // 没有工具调用：检查是否需要 continuation 或直接结束
        if (toolCalls.length === 0) {
          log.debug('本轮无工具调用', { turn: turns, textLength: fullText.length, isQueryMode })

          // 输出被截断时注入继续指令，让 LLM 从中断处接着写，最多重试3次
          if (hitMaxOutputTokens && maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
            maxOutputTokensRecoveryCount++
            log.info('输出被截断，注入继续指令', { turn: turns, recovery: maxOutputTokensRecoveryCount })
            this.history.push({
              role: 'user',
              content: '[系统内部] 输出已被截断。请直接从中断处继续，不要重复已输出的内容，不要道歉或解释。',
            })
            continue
          }

          // 查询/回忆类意图：直接结束，不触发 continuation 检测
          if (isQueryMode) break

          const mode = this.config.permissions.getMode()

          // craft 模式：默认注入继续指令，让 LLM 自己判断是否完成
          // 如果 LLM 真的完成了，它会回复确认信息，不会再调用工具，下一轮会再次进入这里并停止
          if (mode === 'craft') {
            // 检测是否是明确的完成信号（避免无限循环）
            const COMPLETION_PATTERNS = [
              /任务(已|已经|全部|完全)?(已完成|完成了|结束了|执行完毕)/,
              /所有(工作|任务|操作)(已|已经)(完成|结束)/,
              /^(完成|好的|OK|Done)[。！!.]*$/i,
              /(已|已经)按(要求|照|您的要求)(完成|执行完毕)/,
              /没有(其他|更多|额外)(工作|任务|操作)需要(执行|完成|处理)/,
              /task (is )?(completed|finished|done)/i,
              /all (tasks?|work) (is |are )?(completed|finished|done)/i,
            ]
            const isCompleted = COMPLETION_PATTERNS.some(p => p.test(fullText))
            if (isCompleted) {
              log.debug('检测到完成信号，停止执行', { turn: turns })
              break
            }

            // 未检测到完成信号：注入继续指令
            log.debug('craft 模式：注入继续指令', { turn: turns })
            this.history.push({ role: 'user', content: '[系统内部] 请继续执行，不要停下。直接调用工具完成任务，不要再解释计划。如果任务已完成，请明确回复"任务已完成"。' })
            continue
          }

          // ask/plan 模式：检测是否需要 continuation
          const CONTINUATION_PATTERNS = [
            /接下来(将|我会|会|要)/,
            /然后(我会|将|要)/,
            /下一步/,
            /第(一|二|三|四|五|六|七|八|九|十)[步个]/,
            /继续(读取|分析|处理|执行|爬取|抓取|获取|修复|创建|编写|改进|优化)/,
            /让我(继续|读取|分析|查看|创建|编写|修复|改进|尝试|搜索|获取|爬取)/,
            /我(将|会)(读取|分析|处理|继续|创建|编写|修复|改进|尝试|搜索|获取|爬取)/,
            /发现(了|一个)(小|一个)?(bug|问题|错误|issue)/i,
            /需要(修复|处理|解决|改进|优化|分析|测试|验证|检查|调试|实现|完成|执行)/,
            /让我(来)?(创建|改进|修改|更新|重写|优化)/,
            /现在(开始|来|我来)(执行|处理|创建|编写|修复)/,
            /马上(开始|执行|处理|创建)/,
            /并(完成|继续|执行|进行|实现|测试|验证|分析|处理)(测试|任务|操作|工作|验证|分析)/,
            /let me (create|fix|update|improve|continue|check|read|write|analyze|test)/i,
            /next[,，]? (I will|I'll|we)/i,
            /I (need to|should|will|must) (analyze|test|verify|check|fix|implement|continue)/i,
          ]
          const shouldContinue = CONTINUATION_PATTERNS.some(p => p.test(fullText))
          if (shouldContinue && turns < maxTurns) {
            // 非自动模式（ask/plan）：通知 UI 询问用户是否继续
            yield { type: 'continuation_needed' }
            break
          }
          break
        }

        // ── 执行工具调用（串行，委托给 executeOneTool）──────────────────────
        const toolResults: ContentBlock[] = []
        log.debug('本轮工具调用', { turn: turns, tools: toolCalls.map(tc => tc.name) })

        let toolAborted = false
        for (const tc of toolCalls) {
          for await (const ev of this.executeOneTool(tc)) {
            if ('type' in ev && ev.type === '__tool_result__') {
              toolResults.push(ev.block)
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

        this.history.push({ role: 'user', content: toolResults, requestId: this.currentRequestId ?? undefined })
      }

      // 达到最大轮次（仅 ask/plan 模式会触发，craft 模式 maxTurns = Infinity）
      if (turns >= maxTurns) {
        yield { type: 'interrupted', reason: 'turn_limit', message: `已达到最大执行轮次 ${maxTurns}，任务可能未完成。发送"继续"可恢复执行。` }
        yield { type: 'turn_limit', turns }
        this.history.push({ role: 'user', content: `[系统提示] 任务因达到最大轮次限制（${maxTurns} 轮）而中断，尚未完成。请继续执行剩余工作。` })
      }
      // 被用户中止
      if (this.abortController.signal.aborted) {
        yield { type: 'interrupted', reason: 'aborted', message: '任务已被中止。发送"继续"可恢复执行。' }
        this.history.push({ role: 'user', content: '[系统提示] 任务被用户中止。如需继续，请发送指令。' })
      }
    } finally {
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

  clearHistory() { this.history = [] }
  getHistory(): readonly Message[] { return this.history }
  setHistory(messages: Message[]) { this.history = [...messages] }
  setSystemPrompt(prompt: string[]) { this.config.systemPrompt = prompt }
  setProvider(provider: LLMProvider) { this.config.provider = provider }
  getTools(): readonly ToolDef[] { return this.config.tools }

  compactHistory(summary: string) {
    this.history = [
      { role: 'user', content: `[上下文压缩] 早期对话轮次已被压缩以节省上下文空间。以下摘要描述了已完成的工作，当前会话状态可能仍反映该工作（例如文件可能已被修改）。请基于此摘要和当前状态继续，避免重复已完成的工作：\n\n${summary}` },
      { role: 'assistant', content: '已了解之前的对话内容，将基于摘要继续工作。' },
    ]
  }

  getEstimatedTokens(): number {
    return estimateTokens(this.history)
  }
}
