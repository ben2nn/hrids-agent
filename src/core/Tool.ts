import { z } from 'zod'
import { zodToJsonSchema } from '../shared/schema.js'

// 工具执行结果
export type ToolResult =
  | { type: 'success'; output: string; structured?: unknown }
  | { type: 'error'; message: string }

// 权限检查结果
export type PermissionResult =
  | { granted: true }
  | { granted: false; reason: string }

// 工具执行上下文，包含日志回调
export interface ToolContext {
  onLog?: (line: string) => void
}

// 工具能力声明 —— 描述工具的运行时需求和特征
export interface ToolCapabilities {
  /** 是否需要网络访问（WebFetch、WebSearch 等） */
  requiresNetwork?: boolean
  /** 是否依赖 shell 执行（Bash、PowerShell） */
  requiresShell?: boolean
  /** 是否需要用户交互（AskUser 等） */
  isInteractive?: boolean
  /** 是否可以并行执行（无副作用的只读工具通常可以） */
  parallelSafe?: boolean
  /** 建议超时时间（ms），覆盖默认值 */
  maxExecutionTimeMs?: number
}

// 工具定义接口 —— 每个工具必须实现这个接口
export interface ToolDef<TInput extends z.ZodTypeAny = z.ZodTypeAny> {
  // 工具名称，用于 LLM 调用
  name: string
  // 工具描述，告诉 LLM 何时使用
  description: string
  // 输入 schema，用 Zod 定义
  inputSchema: TInput
  // 是否只读（不修改文件系统）
  readonly: boolean
  /**
   * 是否为破坏性操作（删除、覆盖、不可逆写入等）。
   * 用于在 plan 模式下给出更明确的拒绝提示，以及审计日志分级。
   * 默认 false。
   */
  isDestructive?: boolean
  /**
   * 是否豁免风暴检测。
   * 轻量级只读工具（如 file_read、glob）通常豁免，避免连续读取触发风暴警告。
   * 默认 false。
   */
  stormExempt?: boolean
  /**
   * 是否在 plan 模式下可用。
   * plan 模式默认禁止所有写操作，但标记为 planSafe 的工具除外。
   * 用于 todo_* 和 plan_* 等规划相关工具。
   * 默认 false。
   */
  planSafe?: boolean
  /**
   * 动态只读检查。
   * 用于根据具体参数判断本次调用是否为只读操作。
   * 例如：shell 工具可以检查命令内容，白名单命令视为只读。
   * 优先级高于 readonly 静态字段。
   *  readOnlyCheck 设计。
   */
  readOnlyCheck?(input: z.infer<TInput>): boolean
  /** 工具能力声明（可选），用于智能调度和安全检查 */
  capabilities?: ToolCapabilities
  // 执行工具（ctx 可选，用于传递日志回调）
  execute(input: z.infer<TInput>, ctx?: ToolContext): Promise<ToolResult>
  // 权限检查（可选，默认允许）
  checkPermission?(input: z.infer<TInput>): Promise<PermissionResult>
  // 用户可读的操作描述
  describe?(input: z.infer<TInput>): string
  // 返回工具操作涉及的文件路径（用于路径级权限控制，可选）
  getFilePath?(input: z.infer<TInput>): string | undefined
  /**
   * 返回用于权限规则内容匹配的字符串。
   * bash/powershell 工具返回命令内容，文件工具返回文件路径。
   * 用于支持 "bash(git *)" 这类细粒度规则匹配。
   */
  getRuleContent?(input: z.infer<TInput>): string | undefined
}

/**
 * buildTool 默认值配置
 *
 * 参考 claude-code-main 的 buildTool 工厂函数设计，
 * 为可选字段提供安全的默认值，减少工具定义的样板代码。
 */
const TOOL_DEFAULTS = {
  readonly: false,
  isDestructive: false,
  stormExempt: false,
  readOnlyCheck: undefined,
  capabilities: {} as ToolCapabilities,
  checkPermission: undefined,
  describe: undefined,
  getFilePath: undefined,
  getRuleContent: undefined,
}

/**
 * buildTool 工厂函数
 *
 * 从部分工具定义创建完整的 ToolDef，填充安全的默认值。
 * 使用方式：
 * ```typescript
 * export const MyTool = buildTool({
 *   name: 'my_tool',
 *   description: '...',
 *   inputSchema,
 *   readonly: true,
 *   async execute(input) { ... },
 * })
 * ```
 *
 * @param def 部分工具定义（必填字段：name, description, inputSchema, execute）
 * @returns 完整的 ToolDef 对象
 */
export function buildTool<T extends z.ZodTypeAny>(
  def: Omit<ToolDef<T>, 'readonly' | 'isDestructive' | 'stormExempt' | 'capabilities'> &
    Partial<Pick<ToolDef<T>, 'readonly' | 'isDestructive' | 'stormExempt' | 'capabilities'>>
): ToolDef<T> {
  return {
    ...TOOL_DEFAULTS,
    ...def,
  } as ToolDef<T>
}

// 将工具定义转换为 Anthropic API 所需的 tool 格式
export function toAnthropicTool(tool: ToolDef): object {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: zodToJsonSchema(tool.inputSchema),
  }
}

/**
 * 检查工具调用是否为只读操作
 *
 * 优先使用 readOnlyCheck（动态检查），否则使用 readonly（静态标记）。
 *  isReadOnlyCall 设计。
 *
 * @param tool 工具定义
 * @param args 工具参数
 * @returns 是否为只读操作
 */
export function isReadOnlyCall(tool: ToolDef, args: unknown): boolean {
  if (tool.readOnlyCheck) {
    try {
      return Boolean(tool.readOnlyCheck(args as any)) // eslint-disable-line @typescript-eslint/no-explicit-any -- ToolDef 泛型默认类型导致
    } catch {
      return false
    }
  }
  return tool.readonly === true
}
