import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { toAnthropicTool } from '../../src/core/Tool.js'

describe('toAnthropicTool', () => {
  it('转换简单工具定义', () => {
    const tool = {
      name: 'test_tool',
      description: 'A test tool',
      inputSchema: z.object({
        query: z.string().describe('search query'),
      }),
      readonly: true,
      execute: async () => ({ type: 'success' as const, output: '' }),
    }
    const result = toAnthropicTool(tool) as Record<string, unknown>
    expect(result.name).toBe('test_tool')
    expect(result.description).toBe('A test tool')
    expect(result.input_schema).toBeDefined()
    const schema = result.input_schema as Record<string, unknown>
    expect(schema.type).toBe('object')
    expect(schema.properties).toHaveProperty('query')
  })

  it('转换含可选字段的工具', () => {
    const tool = {
      name: 'opt_tool',
      description: 'Tool with optional field',
      inputSchema: z.object({
        required: z.string(),
        optional: z.number().optional(),
      }),
      readonly: false,
      execute: async () => ({ type: 'success' as const, output: '' }),
    }
    const result = toAnthropicTool(tool) as Record<string, unknown>
    const schema = result.input_schema as Record<string, unknown>
    expect(schema.required).toEqual(['required'])
  })
})
