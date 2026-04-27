import { z } from 'zod'
import { zodToJsonSchema } from './schema.js'

// 工具执行结果
export type ToolResult =
  | { type: 'success'; output: string }
  | { type: 'error'; message: string }

// 权限检查结果
export type PermissionResult =
  | { granted: true }
  | { granted: false; reason: string }

// 工具执行上下文，包含日志回调
export interface ToolContext {
  onLog?: (line: string) => void
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

// 将工具定义转换为 Anthropic API 所需的 tool 格式
export function toAnthropicTool(tool: ToolDef): object {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: zodToJsonSchema(tool.inputSchema),
  }
}
