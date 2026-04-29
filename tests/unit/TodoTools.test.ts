import { describe, it, expect, vi, beforeEach } from 'vitest'

// mock 文件系统，避免读写真实的 ~/.hrids-agent/todos.json
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  let stored = ''
  return {
    ...actual,
    existsSync: vi.fn(() => stored !== ''),
    readFileSync: vi.fn(() => stored || '[]'),
    writeFileSync: vi.fn((_p: string, content: string) => { stored = content }),
  }
})

import { TodoWriteTool, TodoReadTool } from '../../src/tools/TodoWriteTool.js'

const sampleTodos = [
  { id: '1', content: '调研竞品', status: 'pending' as const, priority: 'high' as const },
  { id: '2', content: '写测试', status: 'in_progress' as const, priority: 'medium' as const },
  { id: '3', content: '部署上线', status: 'completed' as const, priority: 'low' as const },
]

describe('TodoWriteTool', () => {
  it('写入任务列表并返回摘要', async () => {
    const result = await TodoWriteTool.execute({ todos: sampleTodos })
    expect(result.type).toBe('success')
    const output = (result as { type: 'success'; output: string }).output
    // 输出为驱动性摘要，包含当前执行中的任务名
    expect(output).toContain('写测试')
  })

  it('completed 任务显示 ✓（通过 TodoReadTool 验证）', async () => {
    await TodoWriteTool.execute({ todos: sampleTodos })
    const result = await TodoReadTool.execute({})
    expect((result as { type: 'success'; output: string }).output).toContain('✓')
  })

  it('in_progress 任务显示 ▸（通过 TodoReadTool 验证）', async () => {
    await TodoWriteTool.execute({ todos: sampleTodos })
    const result = await TodoReadTool.execute({})
    expect((result as { type: 'success'; output: string }).output).toContain('▸')
  })

  it('pending 任务显示 ○（通过 TodoReadTool 验证）', async () => {
    await TodoWriteTool.execute({ todos: sampleTodos })
    const result = await TodoReadTool.execute({})
    expect((result as { type: 'success'; output: string }).output).toContain('○')
  })

  it('空列表返回错误（保护现有计划）', async () => {
    const result = await TodoWriteTool.execute({ todos: [] })
    expect(result.type).toBe('error')
  })

  it('readonly 为 false', () => {
    expect(TodoWriteTool.readonly).toBe(false)
  })

  it('describe 返回任务数量', () => {
    const desc = TodoWriteTool.describe!({ todos: sampleTodos })
    expect(desc).toContain('3')
  })
})

describe('TodoReadTool', () => {
  beforeEach(async () => {
    // 先写入数据
    await TodoWriteTool.execute({ todos: sampleTodos })
  })

  it('读取已写入的任务', async () => {
    const result = await TodoReadTool.execute({})
    expect(result.type).toBe('success')
    const output = (result as { type: 'success'; output: string }).output
    expect(output).toContain('调研竞品')
    expect(output).toContain('写测试')
  })

  it('readonly 为 true', () => {
    expect(TodoReadTool.readonly).toBe(true)
  })
})
