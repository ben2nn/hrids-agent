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

export function loadTodos(): Todo[] {
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
 * 从 XML 格式的 todos 字符串中解析任务列表。
 * 兼容模型偶尔输出的 XML 格式：
 *   <todos>
 *     <item>
 *       <id>1</id>
 *       <content>任务内容</content>
 *       <status>pending</status>
 *       <priority>high</priority>
 *     </item>
 *   </todos>
 */
function parseTodosFromXml(xml: string): Todo[] {
  const todos: Todo[] = []
  // 提取所有 <item>...</item> 块
  const itemRegex = /<item>([\s\S]*?)<\/item>/g
  let itemMatch: RegExpExecArray | null
  while ((itemMatch = itemRegex.exec(xml)) !== null) {
    const block = itemMatch[1]!
    const id = extractXmlTag(block, 'id')
    const content = extractXmlTag(block, 'content')
    const status = extractXmlTag(block, 'status')
    const priority = extractXmlTag(block, 'priority')
    if (!id || !content) continue
    todos.push({
      id,
      content,
      status: (['pending', 'in_progress', 'completed'].includes(status ?? '') ? status : 'pending') as TodoStatus,
      priority: (['high', 'medium', 'low'].includes(priority ?? '') ? priority : 'medium') as 'high' | 'medium' | 'low',
    })
  }
  return todos
}

/** 从 XML 片段中提取指定标签的文本内容 */
function extractXmlTag(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))
  return match ? match[1]!.trim() : null
}

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
      const raw = todos as unknown as string
      // 先尝试 JSON 解析
      let parsed: unknown = null
      try {
        parsed = JSON.parse(raw)
      } catch {
        // JSON 失败，尝试解析 XML 格式（<todos><item>...</item></todos>）
        parsed = parseTodosFromXml(raw)
      }
      todos = Array.isArray(parsed) ? parsed : []
    }
    if (!Array.isArray(todos)) todos = []

    // 拒绝空数组：空 todos 没有意义，且会清空现有计划
    if (todos.length === 0) {
      return { type: 'error', message: '错误：todos 数组不能为空。请提供完整的任务列表，每项包含 id、content、status 和 priority。' }
    }

    // 读取现有列表，执行保护性合并
    const existing = loadTodos()
    const { merged, protectedCount } = mergeWithProtection(existing, todos)

    // 强制约束：同一时刻只能有一个 in_progress 任务
    // 如果 LLM 传入多个 in_progress，保留优先级最高的那个，其余降回 pending
    const inProgressItems = merged.filter(t => t.status === 'in_progress')
    let normalized = merged
    if (inProgressItems.length > 1) {
      // 按优先级排序：high > medium > low，取第一个保留，其余降为 pending
      const priorityOrder = { high: 0, medium: 1, low: 2 }
      inProgressItems.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority])
      const keepId = inProgressItems[0]!.id
      normalized = merged.map(t =>
        t.status === 'in_progress' && t.id !== keepId
          ? { ...t, status: 'pending' as TodoStatus }
          : t
      )
    }

    // 所有任务都已完成时自动清空列表（无需 LLM 手动确认）
    const allDone = normalized.every(t => t.status === 'completed')
    const toSave = allDone ? [] : normalized

    saveTodos(toSave)

    // 若有 sessionId 且有回调，触发 todos_updated 推送
    const sessionId = getCurrentSessionId()
    if (sessionId && todosUpdatedCallback) {
      todosUpdatedCallback(sessionId, toSave)
    }

    // 统计各状态数量，用于生成驱动性返回消息
    const inProgress = normalized.filter(t => t.status === 'in_progress')
    const pending = normalized.filter(t => t.status === 'pending')
    const completed = normalized.filter(t => t.status === 'completed')

    const protectMsg = protectedCount > 0
      ? `\n⚠️ ${protectedCount} 个未完成任务被自动保留。`
      : ''

    // 根据任务状态生成驱动性返回消息（参考 claude-code 的设计）
    let statusMsg: string
    if (allDone) {
      // 全部完成：清空列表，提示可以输出最终结果
      statusMsg = `所有 ${completed.length} 个任务已完成，任务列表已清空。请输出最终结果。`
    } else if (inProgress.length > 0) {
      // 有进行中的任务：提示继续执行
      const currentTask = inProgress[0]!  // 已判断 length > 0，安全
      const pendingHint = pending.length > 0 ? `，之后还有 ${pending.length} 个待执行` : ''
      statusMsg = `任务列表已更新。当前执行中：「${currentTask.content}」${pendingHint}。请继续完成当前任务。`
    } else if (pending.length > 0) {
      // 只有待执行任务（刚建立计划）：提示开始第一个
      const firstTask = pending[0]!  // 已判断 length > 0，安全
      statusMsg = `任务计划已建立（共 ${normalized.length} 项）。请从第一个任务开始：将「${firstTask.content}」标记为 in_progress，然后执行。`
    } else {
      // 异常情况：没有任何任务（理论上不应该到这里，因为前面拒绝了空数组）
      statusMsg = `任务列表已更新（${normalized.length} 项）。`
    }

    return { type: 'success', output: statusMsg + protectMsg }
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

    // 附加驱动性提示：告知当前应该做什么
    const inProgress = todos.filter(t => t.status === 'in_progress')
    const pending = todos.filter(t => t.status === 'pending')
    let hint = ''
    if (inProgress.length > 0) {
      hint = `\n当前执行中：「${inProgress[0]!.content}」，请继续完成。`
    } else if (pending.length > 0) {
      hint = `\n下一步：将「${pending[0]!.content}」标记为 in_progress，然后执行。`
    }

    return { type: 'success', output: lines.join('\n') + hint }
  },
}
