// Zod → JSON Schema 转换工具
// 统一实现，供 Tool.ts（Anthropic）和 OpenAIProvider.ts 共用，避免重复维护。

import { z } from 'zod'

/** 将 ZodObject 顶层 schema 转换为 JSON Schema object */
export function zodToJsonSchema(schema: z.ZodTypeAny): object {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>
    const properties: Record<string, object> = {}
    const required: string[] = []
    for (const [key, val] of Object.entries(shape)) {
      properties[key] = zodFieldToSchema(val)
      if (!(val instanceof z.ZodOptional) && !(val instanceof z.ZodDefault)) required.push(key)
    }
    return { type: 'object', properties, required }
  }
  // 顶层 discriminatedUnion（如 ScheduleCronTool）
  if (schema instanceof z.ZodDiscriminatedUnion) {
    const types = (schema.options as z.ZodTypeAny[]).map(opt => zodToJsonSchema(opt))
    return { anyOf: types }
  }
  return { type: 'object', properties: {}, required: [] }
}

/** 将单个 Zod 字段转换为 JSON Schema */
export function zodFieldToSchema(field: z.ZodTypeAny): object {
  // 剥离 Optional 包装，保留 description
  if (field instanceof z.ZodOptional) {
    const inner = zodFieldToSchema(field.unwrap())
    const desc = field.description ?? (field.unwrap() as z.ZodTypeAny).description
    return desc ? { ...inner, description: desc } : inner
  }
  // 剥离 Default 包装
  if (field instanceof z.ZodDefault) {
    return zodFieldToSchema(field._def.innerType as z.ZodTypeAny)
  }
  // 剥离 Nullable 包装
  if (field instanceof z.ZodNullable) {
    const inner = zodFieldToSchema(field.unwrap())
    return { ...inner, nullable: true }
  }
  // 剥离 Effects 包装（.refine() / .transform() / .pipe() 等）
  if (field instanceof z.ZodEffects) {
    return zodFieldToSchema(field._def.schema as z.ZodTypeAny)
  }

  const base: Record<string, unknown> = {}
  if (field.description) base.description = field.description

  if (field instanceof z.ZodString) return { type: 'string', ...base }
  if (field instanceof z.ZodNumber) return { type: 'number', ...base }
  if (field instanceof z.ZodBoolean) return { type: 'boolean', ...base }

  if (field instanceof z.ZodEnum) {
    return { type: 'string', enum: field.options, ...base }
  }
  if (field instanceof z.ZodNativeEnum) {
    const values = Object.values(field.enum as Record<string, string | number>)
    return { type: typeof values[0] === 'number' ? 'number' : 'string', enum: values, ...base }
  }

  if (field instanceof z.ZodArray) {
    return { type: 'array', items: zodFieldToSchema(field.element), ...base }
  }

  if (field instanceof z.ZodObject) {
    return { ...zodToJsonSchema(field), ...base }
  }

  if (field instanceof z.ZodUnion) {
    const types = (field.options as z.ZodTypeAny[]).map(zodFieldToSchema)
    return { anyOf: types, ...base }
  }

  if (field instanceof z.ZodDiscriminatedUnion) {
    const types = (field.options as z.ZodTypeAny[]).map(zodFieldToSchema)
    return { anyOf: types, ...base }
  }

  if (field instanceof z.ZodLiteral) {
    const val = field.value
    return { type: typeof val, const: val, ...base }
  }

  if (field instanceof z.ZodRecord) {
    return { type: 'object', additionalProperties: zodFieldToSchema((field._def as { valueType: z.ZodTypeAny }).valueType), ...base }
  }

  if (field instanceof z.ZodTuple) {
    const items = (field._def as { items: z.ZodTypeAny[] }).items.map(zodFieldToSchema)
    return { type: 'array', items, ...base }
  }

  if (field instanceof z.ZodAny) {
    return { ...base }  // 不限制类型
  }

  // ZodNull
  if (field instanceof z.ZodNull) {
    return { type: 'null', ...base }
  }

  // ZodIntersection（.and()）
  if (field instanceof z.ZodIntersection) {
    const left = zodFieldToSchema(field._def.left as z.ZodTypeAny)
    const right = zodFieldToSchema(field._def.right as z.ZodTypeAny)
    return { allOf: [left, right], ...base }
  }

  // ZodDate
  if (field instanceof z.ZodDate) {
    return { type: 'string', format: 'date-time', ...base }
  }

  // ZodCatch（.catch() 包装，解包内部类型）
  if (field instanceof z.ZodCatch) {
    return zodFieldToSchema(field._def.innerType as z.ZodTypeAny)
  }

  // ZodReadonly（.readonly() 包装，解包内部类型）
  if (field instanceof z.ZodReadonly) {
    return zodFieldToSchema(field._def.innerType as z.ZodTypeAny)
  }

  // ZodBranded（.brand() 包装，解包内部类型）
  if (field instanceof z.ZodBranded) {
    return zodFieldToSchema(field._def.type as z.ZodTypeAny)
  }

  // 兜底：unknown / any 及未识别的 Zod 类型降级为 string
  if (!(field instanceof z.ZodUnknown)) {
    process.stderr.write(`[schema] 未识别的 Zod 类型 ${(field as { constructor?: { name?: string } }).constructor?.name ?? 'unknown'}，降级为 string\n`)
  }
  return { type: 'string', ...base }
}
