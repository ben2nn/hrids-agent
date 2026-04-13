import { z } from 'zod'

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
  // 执行工具（ctx 可选，用于传递日志回调）
  execute(input: z.infer<TInput>, ctx?: ToolContext): Promise<ToolResult>
  // 权限检查（可选，默认允许）
  checkPermission?(input: z.infer<TInput>): Promise<PermissionResult>
  // 用户可读的操作描述
  describe?(input: z.infer<TInput>): string
  // 返回工具操作涉及的文件路径（用于路径级权限控制，可选）
  getFilePath?(input: z.infer<TInput>): string | undefined
}

// 将工具定义转换为 Anthropic API 所需的 tool 格式
export function toAnthropicTool(tool: ToolDef): object {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: zodToJsonSchema(tool.inputSchema),
  }
}

// 简单的 Zod schema 转 JSON Schema（仅支持常用类型）
function zodToJsonSchema(schema: z.ZodTypeAny): object {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>
    const properties: Record<string, object> = {}
    const required: string[] = []

    for (const [key, val] of Object.entries(shape)) {
      properties[key] = zodFieldToJsonSchema(val)
      if (!(val instanceof z.ZodOptional)) {
        required.push(key)
      }
    }

    return { type: 'object', properties, required }
  }
  return { type: 'string' }
}

function zodFieldToJsonSchema(field: z.ZodTypeAny): object {
  if (field instanceof z.ZodString) {
    const base: Record<string, unknown> = { type: 'string' }
    const desc = field.description
    if (desc) base.description = desc
    return base
  }
  if (field instanceof z.ZodNumber) return { type: 'number' }
  if (field instanceof z.ZodBoolean) return { type: 'boolean' }
  if (field instanceof z.ZodOptional) return zodFieldToJsonSchema(field.unwrap())
  if (field instanceof z.ZodArray) {
    return { type: 'array', items: zodFieldToJsonSchema(field.element) }
  }
  if (field instanceof z.ZodEnum) {
    return { type: 'string', enum: field.options }
  }
  return { type: 'string' }
}
