// ToolExecutor — 工具执行生命周期模块
//
// 从 QueryEngine 中提取工具执行逻辑，通过 EventBridge 发射事件。
// 三阶段：validate → execute → postProcess

import type { ToolDef, ToolResult } from './Tool.js'
import { isReadOnlyCall } from './Tool.js'
import type { ToolRegistry } from './ToolRegistry.js'
import type { PermissionManager, PermissionRequest } from './PermissionManager.js'
import type { EventBridge } from './EventBridge.js'
import type { StormBreaker } from './StormBreaker.js'
import type { Todo } from '../tools/TodoTool.js'
import { loadTodos } from '../tools/TodoTool.js'
import { logger } from './logger.js'
import { auditLog } from './audit.js'
import { truncateToolResult } from './projections.js'
import { DEFAULT_TOOL_TIMEOUT_MS, TOOL_TIMEOUT_MARGIN_MS, TOOL_LOG_POLL_MS, STORM_WINDOW_SIZE, TODO_TOOLS } from './engine-constants.js'
import type { ContentBlock } from './ConversationStore.js'

const log = logger.child({ component: 'tool-executor' })

export interface ValidateResult {
  ok: boolean
  tool?: ToolDef
  effectiveInput?: unknown
  execStatus?: 'denied' | 'error'
  errorSummary?: string
  resultContent?: string
}

export interface ExecuteResult {
  block: ContentBlock
  outputPreview: string
  status: 'ok' | 'err' | 'timeout' | 'abort'
  errorSummary?: string
  durationMs: number
}

export class ToolExecutor {
  private totalToolCalls = 0

  constructor(
    private registry: ToolRegistry,
    private permissions: PermissionManager,
    private events: EventBridge,
    private deps: {
      getAbortSignal: () => AbortSignal
      getStormBreaker: () => StormBreaker
      getOnPermissionRequest?: () => ((req: PermissionRequest) => Promise<boolean>) | undefined
      onTodoSnapshotRefresh?: (snapshot: Todo[]) => void
    },
  ) {}

  updateEvents(events: EventBridge): void {
    this.events = events
  }

  resetCounter(): void {
    this.totalToolCalls = 0
  }

  getTotalToolCalls(): number {
    return this.totalToolCalls
  }

  /**
   * 阶段 1：校验 + 权限 + Storm Breaker
   */
  async validate(
    tc: { id: string; name: string; input: unknown },
  ): Promise<ValidateResult> {
    const tool = this.registry.get(tc.name)
    if (!tool) {
      const errorSummary = `未找到工具: ${tc.name}`
      this.events.toolStart(tc.id, tc.name, tc.input, tc.name)
      this.events.toolEnd(tc.id, tc.name, { type: 'error', message: errorSummary })
      return { ok: false, execStatus: 'error', errorSummary, resultContent: `错误: ${errorSummary}` }
    }

    const description = tool.describe?.(tc.input) ?? tc.name

    this.events.toolIntent(tc.id, tc.name, tc.input, description)
    this.events.toolStart(tc.id, tc.name, tc.input, description)
    log.debug('工具开始执行', { toolName: tc.name, toolId: tc.id, description })

    // 第一道：工具级硬拦截
    if (tool.checkPermission) {
      const hardCheck = await tool.checkPermission(tc.input as never)
      if (!hardCheck.granted) {
        log.info('工具硬拦截', { toolName: tc.name, reason: hardCheck.reason })
        auditLog({ action: 'permission_denied', resource: tc.name, result: 'denied', permissionMode: this.permissions.getMode(), details: { reason: hardCheck.reason, stage: 'hard_check' } })
        this.events.toolEnd(tc.id, tc.name, { type: 'error', message: hardCheck.reason })
        return { ok: false, execStatus: 'denied', errorSummary: hardCheck.reason, resultContent: `错误: ${hardCheck.reason}` }
      }
    }

    // 第二道：PermissionManager 策略决策
    const filePath = tool.getFilePath?.(tc.input as never)
    const ruleContent = tool.getRuleContent?.(tc.input as never)
    const permReq: PermissionRequest = {
      toolName: tc.name, description, isReadonly: isReadOnlyCall(tool, tc.input),
      isDestructive: tool.isDestructive, planSafe: tool.planSafe, filePath, ruleContent,
    }

    const onPermissionRequest = this.deps.getOnPermissionRequest?.()
    if (onPermissionRequest) {
      this.permissions.setOnAsk(async (req) => {
        this.events.permissionRequest(req.toolName, req.description, req.isReadonly, tc.id, req.isDestructive, req.ruleContent)
        return onPermissionRequest(req)
      })
    }
    const allowed = await this.permissions.check(permReq)

    if (!allowed) {
      log.info('权限拒绝', { toolName: tc.name, description })
      auditLog({ action: 'permission_denied', resource: tc.name, result: 'denied', permissionMode: this.permissions.getMode(), details: { description } })
      let denyReason: string
      if (this.permissions.getMode() === 'plan') {
        denyReason = '[Plan 模式] 此操作在规划模式下被禁止。请继续完成规划，不要尝试执行写操作。'
        this.events.planBlocked(tc.id, tc.name, denyReason)
      } else if (this.permissions.isDenialThresholdReached()) {
        const { consecutive, total } = this.permissions.getDenialState()
        denyReason = `用户拒绝了此操作（已连续拒绝 ${consecutive} 次，会话内共拒绝 ${total} 次）。请停止尝试此类操作，直接询问用户希望如何处理。`
      } else {
        denyReason = '用户拒绝了此操作'
      }
      this.events.permissionDenied(tc.id, tc.name, description)
      this.events.toolConfirm(tc.id, tc.name, 'deny', this.permissions.getMode(), permReq.isReadonly, permReq.isDestructive ?? false, denyReason)
      return { ok: false, execStatus: 'denied', errorSummary: `权限拒绝: ${description}`, resultContent: denyReason }
    }

    // 权限已授予
    const decision = 'allow'
    this.events.toolConfirm(tc.id, tc.name, decision, this.permissions.getMode(), permReq.isReadonly, permReq.isDestructive ?? false)

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
        this.events.toolEnd(tc.id, tc.name, { type: 'error', message: errMsg })
        return { ok: false, execStatus: 'error', errorSummary: errMsg.slice(0, 200), resultContent: `错误: ${errMsg}` }
      }
    }

    // Storm Breaker
    this.totalToolCalls++
    const stormBreaker = this.deps.getStormBreaker()
    const stormError = stormBreaker.check(tc.name, effectiveInput, this.totalToolCalls, tool.stormExempt)
    if (stormError) {
      this.events.stormBlocked(tc.id, tc.name, effectiveInput, this.totalToolCalls, STORM_WINDOW_SIZE)
      this.events.toolEnd(tc.id, tc.name, { type: 'error', message: stormError })
      return { ok: false, execStatus: 'error', errorSummary: 'Storm Breaker 拦截', resultContent: stormError }
    }

    return { ok: true, tool, effectiveInput }
  }

  /**
   * 阶段 2：执行单个工具
   */
  async execute(
    tc: { id: string; name: string; input: unknown },
  ): Promise<ExecuteResult> {
    const startTime = Date.now()
    const abortSignal = this.deps.getAbortSignal()
    const logQueue: string[] = []
    const onLog = (line: string) => { logQueue.push(line) }

    // 校验阶段
    const prepared = await this.validate(tc)
    if (!prepared.ok) {
      return {
        block: { type: 'tool_result', tool_use_id: tc.id, content: prepared.resultContent!, is_error: true },
        outputPreview: prepared.errorSummary!,
        status: 'err',
        errorSummary: prepared.errorSummary,
        durationMs: Date.now() - startTime,
      }
    }

    const { tool, effectiveInput } = prepared!

    // 写入工具开始执行事件
    this.events.toolDispatched(tc.id, tc.name)

    // 计算超时时间
    const inputTimeout = (effectiveInput as Record<string, unknown>)?.timeout
    const toolTimeoutMs = (typeof inputTimeout === 'number' && inputTimeout > 0)
      ? inputTimeout + TOOL_TIMEOUT_MARGIN_MS
      : DEFAULT_TOOL_TIMEOUT_MS

    // 执行工具（超时 + abort 竞争）
    const toolPromise: Promise<ToolResult> = tool!.execute(effectiveInput as never, { onLog })
      .then(r => r)
      .catch((e: unknown) => ({
        type: 'error' as const,
        message: `工具执行异常 [${tc.name}]: ${e instanceof Error ? e.message : String(e)}`,
      }))

    const timeoutPromise: Promise<ToolResult> = new Promise(resolve =>
      setTimeout(() => resolve({ type: 'error', message: `工具执行超时（超过 ${toolTimeoutMs / 1000}s）：${tc.name}` }), toolTimeoutMs))

    let abortListener: (() => void) | undefined
    const abortPromise: Promise<ToolResult> = new Promise(resolve => {
      abortListener = () => resolve({ type: 'error', message: '任务已被中止' })
      abortSignal.addEventListener('abort', abortListener, { once: true })
    })

    const racePromise = Promise.race([toolPromise, timeoutPromise, abortPromise])

    // 日志轮询 + 等待完成
    let finalResult: ToolResult | undefined = undefined
    while (true) {
      const raceOrTick = await Promise.race([
        racePromise,
        new Promise<'tick'>(r => setTimeout(() => r('tick'), TOOL_LOG_POLL_MS)),
      ])
      while (logQueue.length > 0) {
        this.events.toolProgress(tc.id, tc.name, logQueue.shift()!)
      }
      if (raceOrTick !== 'tick') {
        finalResult = raceOrTick
        break
      }
    }

    if (abortListener) {
      abortSignal.removeEventListener('abort', abortListener)
    }

    // 后处理
    const { block, outputPreview } = this.postProcess(tc, tool!, finalResult!)
    const durationMs = Date.now() - startTime

    // 写入工具结束事件
    const status = abortSignal.aborted ? 'abort' : finalResult!.type === 'success' ? 'ok' : 'err'
    this.events.toolEnd(tc.id, tc.name, finalResult!)
    this.events.toolResult(tc.id, tc.name, durationMs, status, outputPreview, status === 'err' ? (finalResult as { type: 'error'; message: string }).message : undefined)

    return { block, outputPreview, status, durationMs }
  }

  /**
   * 阶段 3：执行后处理
   */
  private postProcess(
    tc: { id: string; name: string; input: unknown },
    tool: ToolDef,
    finalResult: ToolResult,
  ): { block: ContentBlock; outputPreview: string } {
    if (finalResult.type === 'success' && !tool.readonly) {
      this.deps.getStormBreaker().clearOnMutation()

      // 写入文件变更副作用事件
      const filePath = (tc.input as Record<string, unknown>)?.path ?? (tc.input as Record<string, unknown>)?.file_path ?? (tc.input as Record<string, unknown>)?.filename
      if (typeof filePath === 'string') {
        const mode = tc.name.includes('delete') ? 'delete' : tc.name.includes('edit') || tc.name.includes('replace') ? 'edit' : 'create'
        this.events.fileTouched(filePath, mode, finalResult.output?.length ?? 0)
      }

      // todo 工具后刷新快照
      if (TODO_TOOLS.has(tc.name) && this.deps.onTodoSnapshotRefresh) {
        try {
          this.deps.onTodoSnapshotRefresh(loadTodos())
        } catch {
          // 读取失败不影响主流程
        }
      }
    }

    const outputText = finalResult.type === 'success' ? finalResult.output : finalResult.message
    const truncatedText = truncateToolResult(outputText, 10000)
    const outputPreview = truncatedText.slice(0, 200)

    const block: ContentBlock = {
      type: 'tool_result',
      tool_use_id: tc.id,
      content: truncatedText,
      is_error: finalResult.type === 'error',
    }

    return { block, outputPreview }
  }
}
