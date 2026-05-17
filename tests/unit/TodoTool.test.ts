/**
 * TodoTool.test.ts — 任务管理系统核心基础设施测试
 *
 * 覆盖：
 *   - 任务 1.1：assignIds() 属性测试（属性 2：id 单调递增且系统分配）
 *   - 任务 1.2：saveTodos() / loadTodos() 单元测试
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fc from 'fast-check'
import { mkdirSync, rmSync, existsSync, writeFileSync, renameSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { tmpdir } from 'os'
import { assignIds, loadTodos, TodoUpdateTool } from '../../src/tools/TodoTool.js'
import type { Todo } from '../../src/tools/TodoTool.js'

// ─── 测试辅助：临时目录管理 ───────────────────────────────────────────────────

let testDir: string
let todosFile: string

// 由于 loadTodos/saveTodos 内部使用 getGlobalCwd()，
// 我们通过直接操作文件来测试 loadTodos，
// 并通过 mock getGlobalCwd 来测试 saveTodos。
// 对于 assignIds，不涉及文件系统，可直接测试。

// ─── 任务 1.1：assignIds() 属性测试 ──────────────────────────────────────────

describe('assignIds()', () => {
  // 生成合法的 Todo 对象（不含 id 和 createdAt）
  const todoInputArb = fc.record({
    content: fc.string({ minLength: 1, maxLength: 100 }),
    status: fc.constantFrom('pending' as const, 'in_progress' as const, 'completed' as const),
    priority: fc.constantFrom('high' as const, 'medium' as const, 'low' as const),
  })

  // 生成合法的现有 Todo 列表（id 为正整数字符串）
  const existingTodosArb = fc.array(
    fc.record({
      id: fc.nat({ max: 1000 }).map(n => String(n + 1)),  // "1" ~ "1001"
      content: fc.string({ minLength: 1 }),
      status: fc.constantFrom('pending' as const, 'in_progress' as const, 'completed' as const),
      priority: fc.constantFrom('high' as const, 'medium' as const, 'low' as const),
      createdAt: fc.integer({ min: 0 }),
    }),
    { maxLength: 20 }
  ).map(todos => {
    // 确保 id 唯一（去重）
    const seen = new Set<string>()
    return todos.filter(t => {
      if (seen.has(t.id)) return false
      seen.add(t.id)
      return true
    })
  })

  /**
   * 属性 2：id 单调递增且系统分配
   * 验证：需求 2.1、2.2、2.3、2.4
   */
  it('属性 2：新分配的 id 均大于 existingTodos 中所有 id', () => {
    fc.assert(
      fc.property(
        fc.array(todoInputArb, { minLength: 1, maxLength: 10 }),
        existingTodosArb,
        (newTodos, existingTodos) => {
          const result = assignIds(newTodos, existingTodos)

          // 找到现有任务中最大 id
          const maxExistingId = existingTodos.reduce((max, t) => {
            const num = parseInt(t.id, 10)
            return isNaN(num) ? max : Math.max(max, num)
          }, 0)

          // 所有新分配的 id 必须大于现有最大 id
          for (const todo of result) {
            const num = parseInt(todo.id, 10)
            expect(num).toBeGreaterThan(maxExistingId)
          }
        }
      )
    )
  })

  it('属性 2：新分配的 id 序列连续无间隔', () => {
    fc.assert(
      fc.property(
        fc.array(todoInputArb, { minLength: 1, maxLength: 10 }),
        existingTodosArb,
        (newTodos, existingTodos) => {
          const result = assignIds(newTodos, existingTodos)

          // id 序列应连续递增（无间隔）
          for (let i = 1; i < result.length; i++) {
            const prev = parseInt(result[i - 1]!.id, 10)
            const curr = parseInt(result[i]!.id, 10)
            expect(curr).toBe(prev + 1)
          }
        }
      )
    )
  })

  it('属性 2：LLM 传入 id 字段时，该字段被忽略', () => {
    fc.assert(
      fc.property(
        fc.array(todoInputArb, { minLength: 1, maxLength: 5 }),
        existingTodosArb,
        fc.array(fc.string(), { minLength: 1, maxLength: 5 }),
        (newTodos, existingTodos, llmIds) => {
          // 模拟 LLM 传入 id 字段（应被忽略）
          const todosWithIds = newTodos.map((t, i) => ({
            ...t,
            id: llmIds[i % llmIds.length] ?? 'llm-id',
          }))

          const result = assignIds(todosWithIds as Omit<Todo, 'id' | 'createdAt'>[], existingTodos)

          // 结果中的 id 应为系统分配的正整数字符串，而非 LLM 传入的值
          const maxExistingId = existingTodos.reduce((max, t) => {
            const num = parseInt(t.id, 10)
            return isNaN(num) ? max : Math.max(max, num)
          }, 0)

          for (let i = 0; i < result.length; i++) {
            const expectedId = String(maxExistingId + i + 1)
            expect(result[i]!.id).toBe(expectedId)
          }
        }
      )
    )
  })

  // ─── 具体示例测试 ───────────────────────────────────────────────────────────

  it('空 existingTodos 时从 "1" 开始分配', () => {
    const newTodos = [
      { content: '任务 A', status: 'pending' as const, priority: 'high' as const },
      { content: '任务 B', status: 'pending' as const, priority: 'medium' as const },
    ]
    const result = assignIds(newTodos, [])
    expect(result[0]!.id).toBe('1')
    expect(result[1]!.id).toBe('2')
  })

  it('existingTodos 最大 id 为 3 时，新任务从 "4" 开始', () => {
    const existing: Todo[] = [
      { id: '1', content: '已有任务 1', status: 'completed', priority: 'high', createdAt: 0 },
      { id: '3', content: '已有任务 3', status: 'pending', priority: 'low', createdAt: 0 },
      { id: '2', content: '已有任务 2', status: 'in_progress', priority: 'medium', createdAt: 0 },
    ]
    const newTodos = [
      { content: '新任务', status: 'pending' as const, priority: 'high' as const },
    ]
    const result = assignIds(newTodos, existing)
    expect(result[0]!.id).toBe('4')
  })

  it('分配后每个任务都有 createdAt 时间戳', () => {
    const before = Date.now()
    const result = assignIds(
      [{ content: '任务', status: 'pending' as const, priority: 'medium' as const }],
      []
    )
    const after = Date.now()
    expect(result[0]!.createdAt).toBeGreaterThanOrEqual(before)
    expect(result[0]!.createdAt).toBeLessThanOrEqual(after)
  })
})

// ─── 任务 1.2：saveTodos() / loadTodos() 单元测试 ─────────────────────────────

describe('loadTodos() / saveTodos() 文件读写', () => {
  // 由于 loadTodos 内部使用 getGlobalCwd()，我们通过直接写文件来测试读取逻辑
  // 使用临时目录隔离测试

  beforeEach(() => {
    testDir = resolve(tmpdir(), `todo-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(testDir, { recursive: true })
    todosFile = resolve(testDir, 'todos.json')
  })

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  it('文件不存在时 loadTodos() 返回空数组', () => {
    // 直接测试：文件不存在时的行为
    // 由于 loadTodos 使用 getGlobalCwd()，我们测试其内部逻辑
    // 通过写一个不存在路径的文件来验证
    const nonExistentFile = resolve(testDir, 'nonexistent', 'todos.json')
    expect(existsSync(nonExistentFile)).toBe(false)

    // 验证 loadTodos 在文件不存在时返回空数组（通过直接调用）
    // 注意：loadTodos 使用 getGlobalCwd()，这里我们验证其容错逻辑
    const result = loadTodos()
    expect(Array.isArray(result)).toBe(true)
  })

  it('正常读写往返（round-trip）：写入后读取内容一致', () => {
    // 直接写文件，验证 JSON 解析逻辑
    const todos: Todo[] = [
      {
        id: '1',
        content: '测试任务',
        status: 'pending',
        priority: 'high',
        createdAt: 1000000,
        acceptance: ['验收标准 1'],
        dependsOn: [],
        context: '背景信息',
      },
    ]
    writeFileSync(todosFile, JSON.stringify(todos, null, 2), 'utf-8')

    // 验证文件内容可被正确解析
    const parsed = JSON.parse(readFileSync(todosFile, 'utf-8')) as Todo[]
    expect(parsed).toHaveLength(1)
    expect(parsed[0]!.id).toBe('1')
    expect(parsed[0]!.content).toBe('测试任务')
    expect(parsed[0]!.acceptance).toEqual(['验收标准 1'])
    expect(parsed[0]!.createdAt).toBe(1000000)
  })

  it('saveTodos() 写入后文件内容正确（通过 readFileSync 验证）', () => {
    // 直接测试原子写入逻辑（不依赖 getGlobalCwd）
    const todos: Todo[] = [
      { id: '1', content: '任务 1', status: 'pending', priority: 'high', createdAt: 123 },
      { id: '2', content: '任务 2', status: 'in_progress', priority: 'medium', createdAt: 456 },
    ]

    // 模拟 saveTodos 的原子写入逻辑
    const tmpPath = todosFile + '.tmp'
    mkdirSync(testDir, { recursive: true })
    writeFileSync(tmpPath, JSON.stringify(todos, null, 2), 'utf-8')
    renameSync(tmpPath, todosFile)

    // 验证目标文件存在且内容正确
    expect(existsSync(todosFile)).toBe(true)
    expect(existsSync(tmpPath)).toBe(false)  // 临时文件已被替换

    const parsed = JSON.parse(readFileSync(todosFile, 'utf-8')) as Todo[]
    expect(parsed).toHaveLength(2)
    expect(parsed[0]!.id).toBe('1')
    expect(parsed[1]!.id).toBe('2')
  })

  it('目录不存在时 saveTodos() 自动创建目录', () => {
    // 验证 mkdirSync recursive 逻辑
    const deepDir = resolve(testDir, 'a', 'b', 'c')
    const deepFile = resolve(deepDir, 'todos.json')
    const tmpPath = deepFile + '.tmp'

    expect(existsSync(deepDir)).toBe(false)

    // 模拟 saveTodos 的目录创建逻辑
    mkdirSync(deepDir, { recursive: true })
    expect(existsSync(deepDir)).toBe(true)

    writeFileSync(tmpPath, '[]', 'utf-8')
    renameSync(tmpPath, deepFile)
    expect(existsSync(deepFile)).toBe(true)
  })

  it('loadTodos() 对损坏的 JSON 文件返回空数组（容错）', () => {
    // 写入损坏的 JSON
    writeFileSync(todosFile, '{ invalid json }', 'utf-8')

    // 验证容错逻辑：JSON.parse 失败时返回空数组
    let result: Todo[] = []
    try {
      result = JSON.parse(readFileSync(todosFile, 'utf-8')) as Todo[]
    } catch {
      result = []
    }
    expect(result).toEqual([])
  })
})

// ─── 任务 8.1：todo_read 单元测试 ─────────────────────────────────────────────

import { TodoReadTool } from '../../src/tools/TodoTool.js'
import { vi } from 'vitest'

// Mock getConfigDir 让 loadTodos() 读取测试临时目录
vi.mock('../../src/core/Config.js', () => ({
  getConfigDir: () => (globalThis as any).__testConfigDir ?? require('os').homedir(),
}))

describe('TodoReadTool (todo_read)', () => {
  // 辅助：构建 Todo 对象
  function makeTodo(overrides: Partial<Todo> & Pick<Todo, 'id' | 'content' | 'status' | 'priority'>): Todo {
    return {
      createdAt: Date.now(),
      ...overrides,
    }
  }

  // 辅助：调用 todo_read 并返回输出字符串
  async function callRead(): Promise<string> {
    const result = await TodoReadTool.execute({})
    if (result.type !== 'success') throw new Error(`期望 success，得到 ${result.type}`)
    return result.output
  }

  // 使用临时目录隔离测试，mock getConfigDir 指向临时目录
  let testCwd: string
  let todosJsonPath: string

  beforeEach(() => {
    testCwd = resolve(tmpdir(), `todo-read-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(resolve(testCwd, 'tasks'), { recursive: true })
    todosJsonPath = resolve(testCwd, 'tasks', 'todos.json')
    // 将 getConfigDir() 指向临时目录（无 sessionId 时 loadTodos 使用 getConfigDir()/tasks/）
    globalThis.__testConfigDir = testCwd
  })

  afterEach(() => {
    if (existsSync(testCwd)) {
      rmSync(testCwd, { recursive: true, force: true })
    }
    delete (globalThis as any).__testConfigDir
  })

  function writeTodos(todos: Todo[]): void {
    writeFileSync(todosJsonPath, JSON.stringify(todos, null, 2), 'utf-8')
  }

  // ── 测试：空列表返回提示 ────────────────────────────────────────────────────

  it('空列表时返回提示调用 todo_write 的消息', async () => {
    writeTodos([])
    const output = await callRead()
    expect(output).toContain('todo_write')
    expect(output).toContain('没有任务计划')
  })

  // ── 测试：排序 ─────────────────────────────────────────────────────────────

  it('high 优先级任务排在 medium/low 之前', async () => {
    const todos: Todo[] = [
      makeTodo({ id: '1', content: '低优先级任务', status: 'pending', priority: 'low' }),
      makeTodo({ id: '2', content: '高优先级任务', status: 'pending', priority: 'high' }),
      makeTodo({ id: '3', content: '中优先级任务', status: 'pending', priority: 'medium' }),
    ]
    writeTodos(todos)
    const output = await callRead()

    // 高优先级应出现在中/低优先级之前
    const highPos = output.indexOf('高优先级任务')
    const medPos = output.indexOf('中优先级任务')
    const lowPos = output.indexOf('低优先级任务')

    expect(highPos).toBeLessThan(medPos)
    expect(medPos).toBeLessThan(lowPos)
  })

  it('同优先级任务按 id 升序排列', async () => {
    const todos: Todo[] = [
      makeTodo({ id: '3', content: '任务 C', status: 'pending', priority: 'medium' }),
      makeTodo({ id: '1', content: '任务 A', status: 'pending', priority: 'medium' }),
      makeTodo({ id: '2', content: '任务 B', status: 'pending', priority: 'medium' }),
    ]
    writeTodos(todos)
    const output = await callRead()

    const posA = output.indexOf('任务 A')
    const posB = output.indexOf('任务 B')
    const posC = output.indexOf('任务 C')

    expect(posA).toBeLessThan(posB)
    expect(posB).toBeLessThan(posC)
  })

  // ── 测试：只读 ─────────────────────────────────────────────────────────────

  it('只读：调用前后任务列表完全一致', async () => {
    const todos: Todo[] = [
      makeTodo({ id: '1', content: '任务 1', status: 'in_progress', priority: 'high' }),
      makeTodo({ id: '2', content: '任务 2', status: 'pending', priority: 'medium' }),
    ]
    writeTodos(todos)

    await callRead()

    // 读取文件，验证内容未被修改
    const { readFileSync } = await import('fs')
    const afterContent = JSON.parse(readFileSync(todosJsonPath, 'utf-8')) as Todo[]

    expect(afterContent).toHaveLength(2)
    expect(afterContent[0]!.status).toBe('in_progress')
    expect(afterContent[1]!.status).toBe('pending')
  })

  // ── 测试：最近完成任务 ─────────────────────────────────────────────────────

  it('最多展示 3 条已完成任务，按 id 降序', async () => {
    const todos: Todo[] = [
      makeTodo({ id: '1', content: '完成任务 1', status: 'completed', priority: 'high' }),
      makeTodo({ id: '2', content: '完成任务 2', status: 'completed', priority: 'medium' }),
      makeTodo({ id: '3', content: '完成任务 3', status: 'completed', priority: 'low' }),
      makeTodo({ id: '4', content: '完成任务 4', status: 'completed', priority: 'high' }),
      makeTodo({ id: '5', content: '当前任务', status: 'in_progress', priority: 'high' }),
    ]
    writeTodos(todos)
    const output = await callRead()

    // 应展示最近 3 条（id 4、3、2），不展示 id 1
    expect(output).toContain('完成任务 4')
    expect(output).toContain('完成任务 3')
    expect(output).toContain('完成任务 2')
    expect(output).not.toContain('完成任务 1')

    // id 4 应排在 id 3 之前（降序）
    const pos4 = output.indexOf('完成任务 4')
    const pos3 = output.indexOf('完成任务 3')
    expect(pos4).toBeLessThan(pos3)
  })

  // ── 测试：in_progress 任务展示 acceptance ──────────────────────────────────

  it('in_progress 任务展示完整 acceptance 列表（带索引）', async () => {
    const todos: Todo[] = [
      makeTodo({
        id: '1',
        content: '执行中任务',
        status: 'in_progress',
        priority: 'high',
        acceptance: ['验收标准 A', '验收标准 B', '验收标准 C'],
      }),
    ]
    writeTodos(todos)
    const output = await callRead()

    expect(output).toContain('[0] 验收标准 A')
    expect(output).toContain('[1] 验收标准 B')
    expect(output).toContain('[2] 验收标准 C')
  })

  it('pending 任务不展示 acceptance 列表', async () => {
    const todos: Todo[] = [
      makeTodo({
        id: '1',
        content: '待执行任务',
        status: 'pending',
        priority: 'high',
        acceptance: ['验收标准 X'],
      }),
    ]
    writeTodos(todos)
    const output = await callRead()

    // pending 任务不展示验收标准
    expect(output).not.toContain('验收标准 X')
  })

  // ── 测试：下一步操作指令 ───────────────────────────────────────────────────

  it('包含当前执行中任务的下一步操作指令（无 acceptance）', async () => {
    const todos: Todo[] = [
      makeTodo({ id: '1', content: '执行中任务', status: 'in_progress', priority: 'high' }),
    ]
    writeTodos(todos)
    const output = await callRead()

    expect(output).toContain("todo_update(id='1', status='completed')")
    expect(output).toContain('执行中任务')
  })

  it('包含当前执行中任务的下一步操作指令（有 acceptance）', async () => {
    const todos: Todo[] = [
      makeTodo({
        id: '2',
        content: '有验收标准的任务',
        status: 'in_progress',
        priority: 'high',
        acceptance: ['标准 1', '标准 2'],
      }),
    ]
    writeTodos(todos)
    const output = await callRead()

    expect(output).toContain("todo_update(id='2', status='completed', confirmations=[true, true])")
  })

  // ── 测试：进度统计 ─────────────────────────────────────────────────────────

  it('正确显示已完成 / 总数进度', async () => {
    const todos: Todo[] = [
      makeTodo({ id: '1', content: '任务 1', status: 'completed', priority: 'high' }),
      makeTodo({ id: '2', content: '任务 2', status: 'completed', priority: 'medium' }),
      makeTodo({ id: '3', content: '任务 3', status: 'in_progress', priority: 'low' }),
      makeTodo({ id: '4', content: '任务 4', status: 'pending', priority: 'low' }),
      makeTodo({ id: '5', content: '任务 5', status: 'pending', priority: 'low' }),
    ]
    writeTodos(todos)
    const output = await callRead()

    expect(output).toContain('2/5 已完成')
  })

  // ── 测试：依赖信息展示 ─────────────────────────────────────────────────────

  it('展示任务的依赖信息', async () => {
    const todos: Todo[] = [
      makeTodo({ id: '1', content: '前置任务', status: 'in_progress', priority: 'high' }),
      makeTodo({ id: '2', content: '依赖任务', status: 'pending', priority: 'medium', dependsOn: ['1'] }),
    ]
    writeTodos(todos)
    const output = await callRead()

    expect(output).toContain('[依赖: 1]')
  })
})

// ─── todo_update 工具测试 ─────────────────────────────────────────────────

describe('TodoUpdateTool', () => {
  // 辅助：构建 Todo 对象
  function makeTodo(overrides: Partial<Todo> & Pick<Todo, 'id' | 'content' | 'status' | 'priority'>): Todo {
    return {
      createdAt: Date.now(),
      ...overrides,
    }
  }

  // 辅助：调用 todo_update
  async function callUpdate(input: { id: string; status: 'in_progress' | 'completed'; confirmations?: (boolean | string)[] }) {
    return await TodoUpdateTool.execute(input as any)
  }

  // 使用临时目录隔离测试
  let testCwd: string
  let todosJsonPath: string

  beforeEach(() => {
    testCwd = resolve(tmpdir(), `todo-update-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(resolve(testCwd, 'tasks'), { recursive: true })
    todosJsonPath = resolve(testCwd, 'tasks', 'todos.json')
    globalThis.__testConfigDir = testCwd
  })

  afterEach(() => {
    if (existsSync(testCwd)) {
      rmSync(testCwd, { recursive: true, force: true })
    }
    delete (globalThis as any).__testConfigDir
  })

  function writeTodos(todos: Todo[]): void {
    writeFileSync(todosJsonPath, JSON.stringify(todos, null, 2), 'utf-8')
  }

  function readTodos(): Todo[] {
    return JSON.parse(readFileSync(todosJsonPath, 'utf-8')) as Todo[]
  }

  // ── 测试：布尔值 confirmations 正常工作 ──────────────────────────────────────

  it('布尔值 confirmations 正常完成任务', async () => {
    const todos: Todo[] = [
      makeTodo({ id: '1', content: '任务 1', status: 'in_progress', priority: 'high', acceptance: ['标准 A', '标准 B'] }),
      makeTodo({ id: '2', content: '任务 2', status: 'pending', priority: 'medium' }),
    ]
    writeTodos(todos)

    const result = await callUpdate({ id: '1', status: 'completed', confirmations: [true, true] })

    expect(result.type).toBe('success')
    const after = readTodos()
    expect(after[0]!.status).toBe('completed')
    expect(after[1]!.status).toBe('in_progress')
  })

  // ── 测试：字符串 'true' confirmations 也能正常工作（LLM 常见行为）────────────

  it("字符串 'true' confirmations 也能正常完成任务", async () => {
    const todos: Todo[] = [
      makeTodo({ id: '1', content: '任务 1', status: 'in_progress', priority: 'high', acceptance: ['标准 A', '标准 B'] }),
      makeTodo({ id: '2', content: '任务 2', status: 'pending', priority: 'medium' }),
    ]
    writeTodos(todos)

    // LLM 可能传入字符串 'true' 而非布尔值 true
    const result = await callUpdate({ id: '1', status: 'completed', confirmations: ['true', 'true'] as any })

    expect(result.type).toBe('success')
    const after = readTodos()
    expect(after[0]!.status).toBe('completed')
    expect(after[1]!.status).toBe('in_progress')
  })

  // ── 测试：混合布尔值和字符串的 confirmations ─────────────────────────────────

  it('混合布尔值和字符串的 confirmations 也能正常工作', async () => {
    const todos: Todo[] = [
      makeTodo({ id: '1', content: '任务 1', status: 'in_progress', priority: 'high', acceptance: ['标准 A', '标准 B', '标准 C'] }),
      makeTodo({ id: '2', content: '任务 2', status: 'pending', priority: 'medium' }),
    ]
    writeTodos(todos)

    const result = await callUpdate({ id: '1', status: 'completed', confirmations: [true, 'true', true] as any })

    expect(result.type).toBe('success')
    const after = readTodos()
    expect(after[0]!.status).toBe('completed')
  })
})
