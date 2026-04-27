// Todo 列表工具 —— 帮助智能体追踪任务进度
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'
import { z } from 'zod'
import type { ToolDef } from '../core/Tool.js'
import { getCurrentSessionId } from '../core/sessionContext.js'

// todos_updated 推送回调（Gateway 模式由 SessionManager 注册）
let todosUpdatedCallback: ((sessionId: string, todos: Todo[]) => void) | null = null

/** @deprecated 已无需手动设置 sessionId，由 AsyncLocalStorage 自动获取。保留仅供向后兼容。 */
export function setTodoSessionId(_id: string | null): void { /* no-op */ }

/** @deprecated 已无需手动获取 sessionId。保留仅供向后兼容。 */
export function getTodoSessionId(): string | null {
  return getCurrentSessionId() ?? null
}

export function setTodosUpdatedCallback(cb: ((sessionId: string, todos: Todo[]) => void) | null): void {
  todosUpdatedCallback = cb
}

function getTodoFile(): string {
  const sessionId = getCurrentSessionId()
  if (sessionId) {
    return join(homedir(), '.hrids-agent', 'sessions', sessionId, 'todos.json')
  }
  return join(homedir(), '.hrids-agent', 'todos.json')
}

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface Todo {
  id: string
  content: string
  status: TodoStatus
  priority: 'high' | 'medium' | 'low'
}

function loadTodos(): Todo[] {
  const todoFile = getTodoFile()
  if (!existsSync(todoFile)) return []
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = JSON.parse(readFileSync(todoFile, 'utf-8')) as any[]
    // 兼容旧格式：{ task, status } → { id, content, status, priority }
    return raw.map((item, index) => ({
      id: item.id ?? String(index + 1),
      content: item.content ?? item.task ?? '',
      status: item.status ?? 'pending',
      priority: item.priority ?? 'medium',
    }))
  } catch {
    return []
  }
}

function saveTodos(todos: Todo[]) {
  const todoFile = getTodoFile()
  mkdirSync(dirname(todoFile), { recursive: true })
  writeFileSync(todoFile, JSON.stringify(todos, null, 2), 'utf-8')
}

const inputSchema = z.object({
  todos: z.array(z.object({
    id: z.string().describe('唯一标识符，如 "1", "2"'),
    content: z.string().describe('任务内容'),
    status: z.enum(['pending', 'in_progress', 'completed']).describe('任务状态'),
    priority: z.enum(['high', 'medium', 'low']).describe('优先级'),
  })).describe('完整的 todo 列表。初次调用时建立完整计划；后续调用只能新增任务或更新状态，不能删除未完成的任务。'),
})

/**
 * 保护现有计划的完整性：
 * - 如果列表为空（初次建立），直接写入
 * - 如果列表已存在，禁止删除 pending/in_progress 的任务（只能新增或更新状态）
 * 返回合并后的最终列表，以及被保护的任务数量（用于反馈给 LLM）
 */
function mergeWithProtection(existing: Todo[], incoming: Todo[]): { merged: Todo[]; protectedCount: number } {
  if (existing.length === 0) {
    return { merged: incoming, protectedCount: 0 }
  }

  // 以 incoming 为基础（允许新增、状态变更）
  const incomingMap = new Map(incoming.map(t => [t.id, t]))

  // 找出被删除的未完成任务（在 existing 中存在但 incoming 中不存在，且状态不是 completed）
  const dropped = existing.filter(t =>
    !incomingMap.has(t.id) && t.status !== 'completed'
  )

  if (dropped.length === 0) {
    return { merged: incoming, protectedCount: 0 }
  }

  // 将被删除的未完成任务追加回列表末尾，保持原状态
  const merged = [...incoming, ...dropped]
  return { merged, protectedCount: dropped.length }
}

export const TodoWriteTool: ToolDef<typeof inputSchema> = {
  name: 'todo_write',
  description: `创建和管理任务列表，用于追踪复杂任务的进度。

规则：
- 首次调用：建立完整的任务计划（所有步骤一次性列出）
- 后续调用：只能新增任务或更新已有任务的状态/内容，不能删除未完成（pending/in_progress）的任务
- 系统会自动保护未完成的任务，防止计划被意外覆盖`,
  inputSchema,
  readonly: false,

  describe(input) {
    const count = Array.isArray(input.todos) ? input.todos.length : 0
    return `更新任务列表（${count} 项）`
  },

  async execute(input) {
    // 防御：LLM 有时会传字符串或非数组，做兼容处理
    let todos = input.todos
    if (!Array.isArray(todos)) {
      try {
        todos = JSON.parse(todos as unknown as string)
      } catch {
        todos = []
      }
    }
    if (!Array.isArray(todos)) todos = []

    // 读取现有列表，执行保护性合并
    const existing = loadTodos()
    const { merged, protectedCount } = mergeWithProtection(existing, todos)

    saveTodos(merged)

    // 若有 sessionId 且有回调，触发 todos_updated 推送
    const sessionId = getCurrentSessionId()
    if (sessionId && todosUpdatedCallback) {
      todosUpdatedCallback(sessionId, merged)
    }

    const summary = merged.map(t => {
      const icon = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '○'
      return `${icon} [${t.priority}] ${t.content}`
    }).join('\n')

    const protectMsg = protectedCount > 0
      ? `\n\n⚠️ 注意：${protectedCount} 个未完成任务被自动保留（不允许删除未完成的任务）。`
      : ''

    return { type: 'success', output: `任务列表已更新:\n${summary}${protectMsg}` }
  },
}

// 只读的 todo 读取工具
const readSchema = z.object({})

export const TodoReadTool: ToolDef<typeof readSchema> = {
  name: 'todo_read',
  description: '读取当前任务列表',
  inputSchema: readSchema,
  readonly: true,

  async execute() {
    const todos = loadTodos()
    if (todos.length === 0) return { type: 'success', output: '任务列表为空。' }

    const lines = todos.map(t => {
      const icon = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '○'
      return `${icon} [${t.id}] [${t.priority}] ${t.content} (${t.status})`
    })
    return { type: 'success', output: lines.join('\n') }
  },
}
