import { describe, it, expect, vi, beforeEach } from 'vitest'

// mock 文件系统，避免读写真实的 .hrids/tasks/todos.json
// stored 放在模块顶层，通过 resetStore() 在 beforeEach 中重置
let _stored = ''

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn((p: string) => {
      if (String(p).includes('todos.json')) return _stored !== ''
      return actual.existsSync(p)
    }),
    readFileSync: vi.fn((p: string, enc?: string) => {
      if (String(p).includes('todos.json') && enc === 'utf-8') return _stored || '[]'
      return actual.readFileSync(p, enc as BufferEncoding)
    }),
    writeFileSync: vi.fn((p: string, content: string) => {
      if (String(p).includes('todos.json')) { _stored = content; return }
      actual.writeFileSync(p, content)
    }),
    renameSync: vi.fn((src: string, _dest: string) => {
      // 原子替换：tmp → 目标文件，tmp 文件已通过 writeFileSync 写入 _stored，此处无需额外操作
      if (String(src).includes('todos.json')) return
      actual.renameSync(src, _dest)
    }),
    mkdirSync: vi.fn(() => undefined),
  }
})

import { TodoWriteTool, TodoReadTool } from '../../src/tools/TodoTool.js'

// 新接口的 sampleTodos：不含 id/status，只含 content/priority（以及可选字段）
const sampleNewTodos = [
  { content: '调研竞品', priority: 'high' as const },
  { content: '写测试', priority: 'medium' as const },
  { content: '部署上线', priority: 'low' as const },
]

describe('TodoWriteTool', () => {
  beforeEach(() => {
    // 每个测试前重置存储，确保列表为空
    _stored = ''
  })

  it('列表为空时成功建立计划并返回摘要', async () => {
    const result = await TodoWriteTool.execute({ todos: sampleNewTodos })
    expect(result.type).toBe('success')
    const output = (result as { type: 'success'; output: string }).output
    // 输出包含任务内容
    expect(output).toContain('调研竞品')
  })

  it('第一个任务自动标记为 in_progress', async () => {
    const result = await TodoWriteTool.execute({ todos: sampleNewTodos })
    expect(result.type).toBe('success')
    const output = (result as { type: 'success'; output: string }).output
    // 返回值包含第一个任务的执行指令，且第一个任务用 ▸ 标记（表示 in_progress）
    expect(output).toContain('调研竞品')
    // ▸ 符号表示 in_progress 状态
    expect(output).toContain('▸')
  })

  it('兼容 LLM 传入的 id/status 字段，并由系统重置状态', async () => {
    const parsed = TodoWriteTool.inputSchema!.safeParse({
      todos: [
        { id: 'custom-1', content: '任务 A', status: 'pending', priority: 'high' },
        { id: 'custom-2', content: '任务 B', status: 'completed', priority: 'medium' },
      ],
    })
    expect(parsed.success).toBe(true)

    const result = await TodoWriteTool.execute(parsed.data)
    expect(result.type).toBe('success')
    const output = (result as { type: 'success'; output: string }).output
    expect(output).toContain('▸ [1] [high] 任务 A')
    expect(output).toContain('○ [2] [medium] 任务 B')
    expect(output).not.toContain('custom-1')
  })

  it('列表非空时拒绝写入（保护现有计划）', async () => {
    // 先建立计划
    await TodoWriteTool.execute({ todos: sampleNewTodos })
    // 再次调用应被拒绝
    const result = await TodoWriteTool.execute({ todos: sampleNewTodos })
    expect(result.type).toBe('error')
    const message = (result as { type: 'error'; message: string }).message
    expect(message).toContain('todo_write 只能在列表为空时调用')
  })

  it('readonly 为 false', () => {
    expect(TodoWriteTool.readonly).toBe(false)
  })

  it('describe 返回任务数量', () => {
    const desc = TodoWriteTool.describe!({ todos: sampleNewTodos })
    expect(desc).toContain('3')
  })
})

describe('TodoReadTool', () => {
  beforeEach(async () => {
    _stored = ''
    // 先写入数据
    await TodoWriteTool.execute({ todos: sampleNewTodos })
  })

  it('读取已写入的任务', async () => {
    const result = await TodoReadTool.execute({})
    expect(result.type).toBe('success')
    const output = (result as { type: 'success'; output: string }).output
    expect(output).toContain('调研竞品')
    expect(output).toContain('写测试')
  })

  it('in_progress 任务显示 ▸', async () => {
    const result = await TodoReadTool.execute({})
    expect((result as { type: 'success'; output: string }).output).toContain('▸')
  })

  it('pending 任务显示 ○', async () => {
    const result = await TodoReadTool.execute({})
    expect((result as { type: 'success'; output: string }).output).toContain('○')
  })

  it('readonly 为 true', () => {
    expect(TodoReadTool.readonly).toBe(true)
  })
})
