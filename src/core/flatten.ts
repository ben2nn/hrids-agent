/**
 * autoFlatten — 深层 Schema 扁平化
 *
 * 某些模型（DeepSeek V3/R1 等）在 schema 超过 2 层嵌套或超过 10 个叶子参数时
 * 会丢失参数。本模块将嵌套 schema 扁平化为点号路径，执行时再还原。
 *
 * 来源: DeepSeek-Reasonix
 */

/** JSON Schema 子集类型（仅覆盖 flatten 需要的字段） */
export interface JsonSchemaNode {
  type?: string
  properties?: Record<string, JsonSchemaNode>
  required?: string[]
  items?: JsonSchemaNode
  description?: string
  [key: string]: unknown
}

export interface FlattenDecision {
  shouldFlatten: boolean
  leafCount: number
  maxDepth: number
}

/**
 * 分析 schema 的嵌套深度和叶子数量，决定是否需要扁平化
 */
export function analyzeSchema(schema: JsonSchemaNode | undefined): FlattenDecision {
  if (!schema) return { shouldFlatten: false, leafCount: 0, maxDepth: 0 }
  let leafCount = 0
  let maxDepth = 0
  walk(schema, 0, (depth, isLeaf) => {
    if (isLeaf) leafCount++
    if (depth > maxDepth) maxDepth = depth
  })
  return {
    shouldFlatten: leafCount > 10 || maxDepth > 2,
    leafCount,
    maxDepth,
  }
}

/**
 * 将嵌套 schema 扁平化为单层点号路径
 *
 * 例: { user: { profile: { name: string } } }
 *  → { "user.profile.name": string }
 */
export function flattenSchema(schema: JsonSchemaNode): JsonSchemaNode {
  const flatProps: Record<string, JsonSchemaNode> = {}
  const required: string[] = []
  collect('', schema, flatProps, required, true)
  return {
    type: 'object',
    properties: flatProps,
    required,
  }
}

/**
 * 将点号路径参数还原为嵌套对象
 *
 * 例: { "user.profile.name": "alice" }
 *  → { user: { profile: { name: "alice" } } }
 */
export function nestArguments(flatArgs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(flatArgs)) {
    setByPath(out, key.split('.'), value)
  }
  return out
}

/**
 * 检查参数中是否包含点号路径键
 */
export function hasDotKey(args: Record<string, unknown>): boolean {
  return Object.keys(args).some(k => k.includes('.'))
}

// --- 内部辅助函数 ---

function walk(
  schema: JsonSchemaNode,
  depth: number,
  visit: (depth: number, isLeaf: boolean) => void,
): void {
  if (schema.type === 'object' && schema.properties) {
    for (const child of Object.values(schema.properties)) {
      walk(child, depth + 1, visit)
    }
    return
  }
  if (schema.type === 'array' && schema.items) {
    walk(schema.items, depth + 1, visit)
    return
  }
  visit(depth, true)
}

function collect(
  prefix: string,
  schema: JsonSchemaNode,
  out: Record<string, JsonSchemaNode>,
  required: string[],
  isRootRequired: boolean,
): void {
  if (schema.type === 'object' && schema.properties) {
    const requiredSet = new Set(schema.required ?? [])
    for (const [key, child] of Object.entries(schema.properties)) {
      const nextPrefix = prefix ? `${prefix}.${key}` : key
      const childRequired = isRootRequired && requiredSet.has(key)
      collect(nextPrefix, child, out, required, childRequired)
    }
    return
  }
  // 非 object 节点（含 array）视为叶子
  out[prefix] = schema
  if (isRootRequired) required.push(prefix)
}

function setByPath(target: Record<string, unknown>, path: string[], value: unknown): void {
  let cur: any = target
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!
    if (typeof cur[key] !== 'object' || cur[key] === null) cur[key] = {}
    cur = cur[key]
  }
  cur[path[path.length - 1]!] = value
}
