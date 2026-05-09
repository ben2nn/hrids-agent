import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { zodToJsonSchema, zodFieldToSchema } from '../../src/core/schema.js'

describe('zodToJsonSchema', () => {
  it('转换简单 ZodObject', () => {
    const schema = z.object({
      name: z.string(),
      age: z.number(),
      active: z.boolean(),
    })
    const result = zodToJsonSchema(schema) as Record<string, unknown>
    expect(result.type).toBe('object')
    expect(result.properties).toHaveProperty('name')
    expect(result.properties).toHaveProperty('age')
    expect(result.properties).toHaveProperty('active')
    expect(result.required).toEqual(['name', 'age', 'active'])
  })

  it('可选字段不出现在 required 中', () => {
    const schema = z.object({
      name: z.string(),
      nickname: z.string().optional(),
    })
    const result = zodToJsonSchema(schema) as Record<string, unknown>
    expect(result.required).toEqual(['name'])
  })

  it('转换 ZodDiscriminatedUnion', () => {
    const schema = z.discriminatedUnion('type', [
      z.object({ type: z.literal('a'), value: z.string() }),
      z.object({ type: z.literal('b'), count: z.number() }),
    ])
    const result = zodToJsonSchema(schema) as Record<string, unknown>
    expect(result.anyOf).toBeDefined()
    expect((result.anyOf as unknown[]).length).toBe(2)
  })

  it('非 ZodObject 返回空 schema', () => {
    const result = zodToJsonSchema(z.string()) as Record<string, unknown>
    expect(result.type).toBe('object')
    expect(result.properties).toEqual({})
  })
})

describe('zodFieldToSchema', () => {
  it('string 字段', () => {
    const result = zodFieldToSchema(z.string()) as Record<string, unknown>
    expect(result.type).toBe('string')
  })

  it('number 字段', () => {
    const result = zodFieldToSchema(z.number()) as Record<string, unknown>
    expect(result.type).toBe('number')
  })

  it('boolean 字段', () => {
    const result = zodFieldToSchema(z.boolean()) as Record<string, unknown>
    expect(result.type).toBe('boolean')
  })

  it('enum 字段', () => {
    const result = zodFieldToSchema(z.enum(['a', 'b', 'c'])) as Record<string, unknown>
    expect(result.type).toBe('string')
    expect(result.enum).toEqual(['a', 'b', 'c'])
  })

  it('nativeEnum 字段', () => {
    enum Color { Red, Green, Blue }
    const result = zodFieldToSchema(z.nativeEnum(Color)) as Record<string, unknown>
    // TypeScript numeric enum 的 Object.values 包含 string 和 number
    expect(result.enum).toBeDefined()
    expect((result.enum as unknown[]).length).toBeGreaterThan(0)
  })

  it('array 字段', () => {
    const result = zodFieldToSchema(z.array(z.string())) as Record<string, unknown>
    expect(result.type).toBe('array')
    expect((result.items as Record<string, unknown>).type).toBe('string')
  })

  it('object 字段', () => {
    const result = zodFieldToSchema(z.object({ x: z.number() })) as Record<string, unknown>
    expect(result.type).toBe('object')
    expect(result.properties).toHaveProperty('x')
  })

  it('optional 字段剥离包装', () => {
    const result = zodFieldToSchema(z.string().optional()) as Record<string, unknown>
    expect(result.type).toBe('string')
  })

  it('optional 字段保留 description', () => {
    const result = zodFieldToSchema(z.string().describe('test desc').optional()) as Record<string, unknown>
    expect(result.description).toBe('test desc')
  })

  it('default 字段剥离包装', () => {
    const result = zodFieldToSchema(z.string().default('hello')) as Record<string, unknown>
    expect(result.type).toBe('string')
  })

  it('nullable 字段', () => {
    const result = zodFieldToSchema(z.string().nullable()) as Record<string, unknown>
    expect(result.type).toBe('string')
    expect(result.nullable).toBe(true)
  })

  it('literal 字段', () => {
    const result = zodFieldToSchema(z.literal('hello')) as Record<string, unknown>
    expect(result.type).toBe('string')
    expect(result.const).toBe('hello')
  })

  it('number literal 字段', () => {
    const result = zodFieldToSchema(z.literal(42)) as Record<string, unknown>
    expect(result.type).toBe('number')
    expect(result.const).toBe(42)
  })

  it('record 字段', () => {
    const result = zodFieldToSchema(z.record(z.string(), z.number())) as Record<string, unknown>
    expect(result.type).toBe('object')
    expect((result.additionalProperties as Record<string, unknown>).type).toBe('number')
  })

  it('union 字段', () => {
    const result = zodFieldToSchema(z.union([z.string(), z.number()])) as Record<string, unknown>
    expect(result.anyOf).toBeDefined()
    expect((result.anyOf as unknown[]).length).toBe(2)
  })

  it('description 被保留', () => {
    const result = zodFieldToSchema(z.string().describe('my desc')) as Record<string, unknown>
    expect(result.description).toBe('my desc')
  })

  it('兜底 unknown 类型返回 string', () => {
    const result = zodFieldToSchema(z.unknown()) as Record<string, unknown>
    expect(result.type).toBe('string')
  })
})
