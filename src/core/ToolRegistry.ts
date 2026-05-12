/**
 * ToolRegistry — 集中式工具注册表
 *
 *  ToolRegistry 设计，
 * 支持动态注册/注销、批量注册、plan-mode 检查、拦截器等高级功能。
 *
 * 主要特性：
 * - register() / unregister() 动态管理工具
 * - dispatch() 统一执行入口
 * - setPlanMode() 全局 plan-mode 控制
 * - setToolInterceptor() 全局拦截器
 * - setResultAugmenter() 结果后处理
 */

import type { ToolDef, ToolResult, ToolContext } from './Tool.js'
import { isReadOnlyCall } from './Tool.js'
import { zodToJsonSchema } from './schema.js'
import { analyzeSchema, flattenSchema, nestArguments, hasDotKey, type JsonSchemaNode } from './flatten.js'

/**
 * 工具调用上下文
 */
export interface ToolCallContext extends ToolContext {
  signal?: AbortSignal
}

/**
 * 工具调用审计事件
 */
export type ToolCallAuditEvent = {
  name: string
  args: Record<string, unknown>
  timestamp: number
}

/**
 * 工具调用审计监听器
 */
export type ToolCallAuditListener = (event: ToolCallAuditEvent) => void

/**
 * 工具拦截器
 * 返回字符串表示短路执行（直接返回结果），返回 null/undefined 继续执行
 */
export type ToolInterceptor = (
  name: string,
  args: Record<string, unknown>,
) => ToolResult | null | undefined | Promise<ToolResult | null | undefined>

/**
 * 结果后处理器
 * 在工具执行完成后对结果进行处理（如添加剩余预算提示）
 */
export type ToolResultAugmenter = (
  name: string,
  args: Record<string, unknown>,
  result: ToolResult,
) => ToolResult

/**
 * ToolRegistry 配置选项
 */
export interface ToolRegistryOptions {
  /** 是否自动扁平化深层 schema（默认 true） */
  autoFlatten?: boolean
}

/**
 * 工具注册表
 *
 * 集中管理所有工具的注册、注销和执行。
 * 支持动态添加/移除工具，适用于 MCP 热插拔场景。
 */
export class ToolRegistry {
  private readonly _tools = new Map<string, ToolDef>()
  private readonly _flatSchemas = new Map<string, JsonSchemaNode>()
  private readonly _autoFlatten: boolean
  private _planMode = false
  private _interceptor: ToolInterceptor | null = null
  private _auditListener: ToolCallAuditListener | null = null
  private _resultAugmenter: ToolResultAugmenter | null = null

  constructor(opts: ToolRegistryOptions = {}) {
    this._autoFlatten = opts.autoFlatten !== false
  }

  /**
   * 启用/禁用 plan-mode
   * 在 plan-mode 下，非只读工具的调用将被拒绝
   */
  setPlanMode(on: boolean): void {
    this._planMode = Boolean(on)
  }

  /** 当前是否处于 plan-mode */
  get planMode(): boolean {
    return this._planMode
  }

  /**
   * 设置工具拦截器
   * 拦截器在工具执行前运行，返回字符串可短路执行
   */
  setToolInterceptor(fn: ToolInterceptor | null): void {
    this._interceptor = fn
  }

  /**
   * 设置审计监听器
   * 每次工具调用时触发，用于日志记录
   */
  setAuditListener(fn: ToolCallAuditListener | null): void {
    this._auditListener = fn
  }

  /**
   * 设置结果后处理器
   * 在工具执行完成后对结果进行处理
   */
  setResultAugmenter(fn: ToolResultAugmenter | null): void {
    this._resultAugmenter = fn
  }

  /** 是否已设置结果后处理器 */
  get hasResultAugmenter(): boolean {
    return this._resultAugmenter !== null
  }

  /**
   * 注册工具
   * @param def 工具定义
   * @returns this（支持链式调用）
   */
  register(def: ToolDef): this {
    if (!def.name) throw new Error('tool requires a name')
    this._tools.set(def.name, def)

    // autoFlatten: 分析 schema，必要时预计算扁平版本
    if (this._autoFlatten) {
      try {
        const jsonSchema = zodToJsonSchema(def.inputSchema) as JsonSchemaNode
        const decision = analyzeSchema(jsonSchema)
        if (decision.shouldFlatten) {
          this._flatSchemas.set(def.name, flattenSchema(jsonSchema))
        }
      } catch {
        /* schema 分析失败不阻塞注册 */
      }
    }

    return this
  }

  /**
   * 注销工具
   * @param name 工具名称
   * @returns 是否成功注销
   */
  unregister(name: string): boolean {
    this._flatSchemas.delete(name)
    return this._tools.delete(name)
  }

  /**
   * 检查工具是否已注册
   * @param name 工具名称
   */
  has(name: string): boolean {
    return this._tools.has(name)
  }

  /**
   * 获取工具定义
   * @param name 工具名称
   */
  get(name: string): ToolDef | undefined {
    return this._tools.get(name)
  }

  /** 已注册工具数量 */
  get size(): number {
    return this._tools.size
  }

  /**
   * 获取所有已注册工具
   * @returns 工具定义数组
   */
  getAll(): ToolDef[] {
    return [...this._tools.values()]
  }

  /**
   * 获取所有工具名称
   * @returns 工具名称数组
   */
  getNames(): string[] {
    return [...this._tools.keys()]
  }

  /**
   * 获取工具的扁平化 schema（如有）
   * 用于生成模型的工具 spec，替代原始嵌套 schema
   */
  getFlatSchema(name: string): JsonSchemaNode | undefined {
    return this._flatSchemas.get(name)
  }

  /**
   * 检查工具的 schema 是否已被扁平化
   */
  wasFlattened(name: string): boolean {
    return this._flatSchemas.has(name)
  }

  /**
   * 批量注册工具
   * @param tools 工具定义数组
   * @returns this（支持链式调用）
   */
  registerAll(tools: ToolDef[]): this {
    for (const tool of tools) {
      this.register(tool)
    }
    return this
  }

  /**
   * 执行工具
   *
   * 完整执行流程：
   * 1. 查找工具
   * 2. Plan-mode 检查
   * 3. 拦截器检查
   * 4. 执行工具
   * 5. 结果后处理
   *
   * @param name 工具名称
   * @param args 工具参数
   * @param opts 执行选项
   * @returns 工具执行结果
   */
  async dispatch(
    name: string,
    args: Record<string, unknown>,
    opts: {
      signal?: AbortSignal
      maxResultChars?: number
      ctx?: ToolContext
    } = {},
  ): Promise<ToolResult> {
    const tool = this._tools.get(name)
    if (!tool) {
      return { type: 'error', message: `unknown tool: ${name}` }
    }

    // Plan-mode 检查（支持 readOnlyCheck 动态检查）
    if (this._planMode && !isReadOnlyCall(tool, args)) {
      return { type: 'error', message: `${name}: unavailable in plan mode — this is a read-only exploration phase.` }
    }

    // 拦截器检查
    if (this._interceptor) {
      try {
        const short = await this._interceptor(name, args)
        if (short) return short
      } catch (err) {
        return { type: 'error', message: `${name}: interceptor failed — ${(err as Error).message}` }
      }
    }

    // 审计日志
    try {
      this._auditListener?.({
        name,
        args,
        timestamp: Date.now(),
      })
    } catch {
      /* audit path must never break tool execution */
    }

    // autoFlatten: 还原点号路径参数为嵌套对象
    if (this._flatSchemas.has(name) && args && typeof args === 'object' && hasDotKey(args)) {
      args = nestArguments(args)
    }

    // 执行工具
    let finalResult: ToolResult
    try {
      const result = await tool.execute(args as any, opts.ctx)

      // 结果截断
      if (opts.maxResultChars !== undefined) {
        const str = result.type === 'success' ? result.output : result.message
        if (str.length > opts.maxResultChars) {
          const clipped = str.slice(0, opts.maxResultChars) + `\n\n[…truncated ${str.length - opts.maxResultChars} chars]`
          finalResult = result.type === 'success'
            ? { ...result, output: clipped }
            : { ...result, message: clipped }
        } else {
          finalResult = result
        }
      } else {
        finalResult = result
      }
    } catch (err) {
      const e = err as Error
      finalResult = { type: 'error', message: `${e.name}: ${e.message}` }
    }

    // 结果后处理
    if (this._resultAugmenter) {
      try {
        return this._resultAugmenter(name, args, finalResult)
      } catch {
        /* augmenter must never break the tool result */
      }
    }

    return finalResult
  }

  /**
   * 获取 LLM 可用的工具列表
   * plan-mode 下标注非只读工具为不可用
   */
  getToolsForLLM(isPlanMode: boolean): ToolDef[] {
    const tools = this.getAll()
    if (!isPlanMode) return tools
    return tools.map(t =>
      (t.readonly || t.readOnlyCheck) ? t : {
        ...t,
        description: t.description + '\n[Plan 模式：此工具当前不可用，调用将被拒绝]',
      }
    )
  }
}

/**
 * 创建批量注册函数的辅助工厂
 *
 * 使用方式：
 * ```typescript
 * // 无 opts
 * export const registerFilesystemTools = createBatchRegistrar((registry) => {
 *   registry.register(FileReadTool)
 *   registry.register(FileWriteTool)
 * })
 *
 * // 带 opts
 * export const registerShellTools = createBatchRegistrar((registry, opts: ShellOptions) => {
 *   registry.register(BashTool)
 * })
 *
 * // 使用
 * const registry = new ToolRegistry()
 * registerFilesystemTools(registry)
 * registerShellTools(registry, { rootDir: '/path' })
 * ```
 */
export function createBatchRegistrar<T = void>(
  fn: (registry: ToolRegistry, opts: T) => void,
): (registry: ToolRegistry, opts?: T) => ToolRegistry {
  return (registry: ToolRegistry, opts?: T): ToolRegistry => {
    fn(registry, opts as T)
    return registry
  }
}
