import type { LLMProvider } from './providers/index.js'
import type { ToolDef, ToolResult } from './Tool.js'
import type { PermissionManager } from './PermissionManager.js'
import { CostTracker } from './CostTracker.js'
import { logger } from './logger.js'
import { auditLog } from './audit.js'
import { withRetryStream } from './retry.js'

const log = logger.child({ component: 'query-engine' })

export interface Message {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

export interface QueryEngineConfig {
  provider: LLMProvider
  systemPrompt: string
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
  | { type: 'tool_start'; id: string; name: string; input: unknown }
  | { type: 'tool_log'; id: string; name: string; line: string }
  | { type: 'tool_end'; id: string; name: string; result: ToolResult }
  | { type: 'permission_denied'; id: string; toolName: string; description: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; costUsd: number }
  | { type: 'turn_limit'; turns: number }
  | { type: 'budget_exceeded'; costUsd: number; limitUsd: number }
  | { type: 'compact_start' }
  | { type: 'compact_done'; summary: string }
  | { type: 'interrupted'; reason: InterruptReason; message: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

// 估算历史消息的大致 token 数（粗略：4字符≈1token）
function estimateTokens(messages: Message[]): number {
  let chars = 0
  for (const m of messages) {
    if (typeof m.content === 'string') {
      chars += m.content.length
    } else {
      for (const b of m.content) {
        if (b.type === 'text') chars += b.text.length
        else if (b.type === 'tool_result') chars += b.content.length
        else chars += JSON.stringify(b).length
      }
    }
  }
  return Math.ceil(chars / 4)
}

// 旧工具输出超过此字符数时替换为占位符（压缩前的廉价预处理）
const PRUNE_TOOL_RESULT_THRESHOLD = 800
const PRUNED_PLACEHOLDER = '[旧工具输出已清除以节省上下文空间]'

// tool_result 内容截断上限（写入 history 时）
const MAX_TOOL_RESULT_CHARS = 8000

export class QueryEngine {
  private config: QueryEngineConfig
  private history: Message[]
  private abortController: AbortController
  // 防止并发执行：同一时刻只允许一个 send() 运行
  private running = false
  readonly costs: CostTracker
  // 上次压缩生成的摘要，用于迭代更新（避免多次压缩后信息层层丢失）
  private previousSummary: string | null = null

  constructor(config: QueryEngineConfig) {
    this.config = config
    this.history = config.initialMessages ? [...config.initialMessages] : []
    this.abortController = new AbortController()
    this.costs = new CostTracker(config.provider.model)
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

  // ── 优先级 1：修复孤立的 tool_use / tool_result 对（防止 API 报错）──────────
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
        '你是一个对话摘要助手，请生成简洁准确的结构化摘要。',
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

  async *send(userMessage: string): AsyncGenerator<StreamEvent> {
    // 并发保护：如果已有任务在运行，拒绝新任务
    if (this.running) {
      yield { type: 'error', message: '上一个任务仍在执行中，请等待完成后再发送新消息' }
      return
    }
    this.running = true
    this.abortController = new AbortController()
    this.history.push({ role: 'user', content: userMessage })

    const maxTurns = this.config.maxTurns ?? 50
    const maxBudgetUsd = this.config.maxBudgetUsd
    // 自动压缩阈值：默认 20000 tokens（约 80KB 文本）
    // 保守设置，确保压缩后 history + system prompt + 工具定义不超出模型上下文窗口
    const autoCompactThreshold = this.config.autoCompactThreshold ?? 20000
    let turns = 0

    try {
      while (turns < maxTurns) {
        if (this.abortController.signal.aborted) break
        turns++

        // 成本预算检查（每轮开始前）
        if (maxBudgetUsd !== undefined && this.costs.getCostUsd() >= maxBudgetUsd) {
          yield { type: 'budget_exceeded', costUsd: this.costs.getCostUsd(), limitUsd: maxBudgetUsd }
          break
        }

        // 自动压缩：历史过长时在发送前压缩
        if (estimateTokens(this.history) > autoCompactThreshold) {
          yield { type: 'compact_start' }
          const summary = await this.generateCompactSummary()
          this.compactHistory(summary)
          // 压缩后修复孤立的工具调用对，防止 API 报错
          this.sanitizeToolPairs()
          yield { type: 'compact_done', summary }
        }

        let fullText = ''
        const toolCalls: Array<{ id: string; name: string; input: unknown }> = []

        try {
          const streamFn = () => this.config.provider.stream(
            this.history as never,
            this.config.tools,
            this.config.systemPrompt,
            this.config.maxTokens ?? 8096,
          )
          for await (const chunk of streamFn()) {
            if (this.abortController.signal.aborted) break

            if (chunk.type === 'text_delta' && chunk.delta) {
              fullText += chunk.delta
              yield { type: 'text_delta', delta: chunk.delta }
            } else if (chunk.type === 'tool_call' && chunk.toolCall) {
              toolCalls.push(chunk.toolCall)
            } else if (chunk.type === 'usage' && chunk.usage) {
              this.costs.add({
                inputTokens: chunk.usage.inputTokens,
                outputTokens: chunk.usage.outputTokens,
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
            }
          }
        } catch (err) {
          const errMsg = String(err)
          yield { type: 'interrupted', reason: 'error', message: `LLM 请求失败: ${errMsg}` }
          yield { type: 'error', message: errMsg }
          // 将中断原因写入 history，方便恢复时 LLM 知道上次发生了什么
          this.history.push({ role: 'user', content: `[系统提示] 上次执行因错误中断: ${errMsg}。请从中断处继续完成任务。` })
          break
        }

        // 将 assistant 回复加入历史
        const assistantBlocks: ContentBlock[] = []
        if (fullText) assistantBlocks.push({ type: 'text', text: fullText })
        for (const tc of toolCalls) {
          assistantBlocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input })
        }
        if (assistantBlocks.length > 0) {
          this.history.push({ role: 'assistant', content: assistantBlocks })
        }

        // 没有工具调用，检查是否是中途停止（任务未完成）
        if (toolCalls.length === 0) {
          // 检测 LLM 是否在中途停下（说了"接下来要做X"但没做）
          const CONTINUATION_PATTERNS = [
            /接下来(将|我会|会|要)/,
            /然后(我会|将|要)/,
            /下一步/,
            /继续(读取|分析|处理|执行)/,
            /让我(继续|读取|分析|查看)/,
            /我(将|会)(读取|分析|处理|继续)/,
          ]
          const shouldContinue = CONTINUATION_PATTERNS.some(p => p.test(fullText))
          if (shouldContinue && turns < maxTurns) {
            // 注入一条隐式 user 消息，推动 LLM 继续执行
            this.history.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'auto_continue', content: '请继续执行，不要停下。' }] })
            // 不 break，继续下一轮
            continue
          }
          break
        }

        // 执行工具调用（串行，保证历史顺序正确）
        const toolResults: ContentBlock[] = []
        for (const tc of toolCalls) {
          yield { type: 'tool_start', id: tc.id, name: tc.name, input: tc.input }

          // 实时日志队列：工具执行期间持续 yield 日志
          const logQueue: string[] = []
          const onLog = (line: string) => { logQueue.push(line) }

          // 查找工具
          const tool = this.config.tools.find(t => t.name === tc.name)
          if (!tool) {
            yield { type: 'tool_end', id: tc.id, name: tc.name, result: { type: 'error', message: `未找到工具: ${tc.name}` } }
            toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: `错误: 未找到工具: ${tc.name}`, is_error: true })
            continue
          }

          const description = tool.describe?.(tc.input) ?? tc.name
          const filePath = tool.getFilePath?.(tc.input as never)
          const allowed = await this.config.permissions.check({
            toolName: tc.name,
            description,
            isReadonly: tool.readonly,
            filePath,
          })

          if (!allowed) {
            log.info('权限拒绝', { toolName: tc.name, description })
            auditLog({ action: 'permission_denied', resource: tc.name, result: 'denied', details: { description } })
            yield { type: 'permission_denied', id: tc.id, toolName: tc.name, description }
            toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: '用户拒绝了此操作', is_error: true })
            continue
          }

          // 写操作记录审计日志
          if (!tool.readonly) {
            auditLog({ action: tc.name as never, resource: description, result: 'allowed', details: { toolName: tc.name } })
          }

          // 工具执行：用 Promise.race 统一处理超时、abort、正常完成三种情况
          const TOOL_TIMEOUT_MS = 5 * 60 * 1000

          // 将工具执行结果 settle 到这个 promise，同时持续 yield 日志
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
          const result = finalResult
          const resultContent = result.type === 'success' ? result.output : `错误: ${result.message}`
          // 截断过长的工具输出，防止单条结果撑爆 history
          const truncatedContent = resultContent.length > MAX_TOOL_RESULT_CHARS
            ? resultContent.slice(0, MAX_TOOL_RESULT_CHARS)
              + `\n...[输出过长，已截断，共 ${resultContent.length} 字符，当前仅显示前 ${MAX_TOOL_RESULT_CHARS} 字符。`
              + `如需读取更多内容，请使用 file_read 工具并指定 startLine/endLine 参数分段读取。]...`
            : resultContent
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tc.id,
            content: truncatedContent,
            is_error: result.type === 'error',
          })
        }

        this.history.push({ role: 'user', content: toolResults })
      }

      // 达到最大轮次
      if (turns >= maxTurns) {
        yield { type: 'interrupted', reason: 'turn_limit', message: `已达到最大执行轮次 ${maxTurns}，任务可能未完成。发送"继续"可恢复执行。` }
        yield { type: 'turn_limit', turns }
        // 将中断原因写入 history，恢复时 LLM 知道从哪里继续
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
      yield { type: 'done' }
    }
  }

  abort() {
    this.abortController.abort()
  }

  isRunning(): boolean {
    return this.running
  }

  clearHistory() { this.history = [] }
  getHistory(): readonly Message[] { return this.history }
  setHistory(messages: Message[]) { this.history = [...messages] }

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
