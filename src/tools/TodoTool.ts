// 任务管理系统核心模块 —— 实现全部 5 个任务管理工具
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { z } from 'zod'
import type { ToolDef } from '../core/Tool.js'
import { getGlobalCwd } from './BashTool.js'
import { auditLog } from '../core/audit.js'
import { getCurrentSessionId } from '../core/sessionContext.js'

// ─── 数据类型定义 ────────────────────────────────────────────────────────────

export interface Todo {
  id: string                                          // 系统自增，格式 "1", "2", "3"...
  content: string                                     // 任务内容
  status: 'pending' | 'in_progress' | 'completed'    // 状态
  priority: 'high' | 'medium' | 'low'                // 优先级，影响排序
  createdAt: number                                   // 创建时间戳（ms）
  acceptance?: string[]   // 验收标准，完成前逐条确认
  dependsOn?: string[]    // 依赖的任务 id，依赖未完成时不能开始
  context?: string        // 任务背景/来源，压缩后意图锚点
}

// ─── WebSocket 推送回调 ───────────────────────────────────────────────────────

let todosUpdatedCallback: (() => void) | null = null

/**
 * 注册 todos_updated 推送回调（由 SessionManager 调用）
 * 与 SessionManager 解耦，TodoTool 不直接依赖 WebSocket 实现
 */
export function setTodosUpdatedCallback(cb: (() => void) | null): void {
  todosUpdatedCallback = cb
}

/** 内部触发推送回调 */
function triggerTodosUpdated(): void {
  if (todosUpdatedCallback) {
    todosUpdatedCallback()
  }
}

// ─── 文件路径解析 ─────────────────────────────────────────────────────────────

/**
 * 解析 todos.json 的绝对路径
 * 使用 getGlobalCwd() 确保路径基于持久化工作目录，而非 process.cwd()
 */
function getTodoFile(): string {
  return resolve(getGlobalCwd(), '.hrids', 'tasks', 'todos.json')
}

// ─── 读写操作 ─────────────────────────────────────────────────────────────────

/**
 * 读取并解析 todos.json
 * 文件不存在时返回空数组（容错处理）
 */
export function loadTodos(): Todo[] {
  const todoFile = getTodoFile()
  if (!existsSync(todoFile)) return []
  try {
    const raw = JSON.parse(readFileSync(todoFile, 'utf-8')) as Todo[]
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

/**
 * 原子写入 todos 列表
 * 先写临时文件 todos.json.tmp，再通过 renameSync 原子替换目标文件
 * 写入前确保目录存在（mkdirSync + recursive: true）
 */
function saveTodos(todos: Todo[], filePath?: string): void {
  const targetPath = filePath ?? getTodoFile()
  const tmpPath = targetPath + '.tmp'
  const dir = dirname(targetPath)

  // 确保目录存在
  mkdirSync(dir, { recursive: true })

  // 先写临时文件，再原子替换
  writeFileSync(tmpPath, JSON.stringify(todos, null, 2), 'utf-8')
  renameSync(tmpPath, targetPath)
}

// ─── 系统自增 id 分配 ─────────────────────────────────────────────────────────

/**
 * 为新任务分配系统自增 id
 * 从 existingTodos 中最大 id + 1 开始连续分配
 * 忽略 newTodos 输入中的 id 字段（LLM 不可指定 id）
 *
 * @param newTodos - 待分配 id 的新任务列表（id 字段会被忽略）
 * @param existingTodos - 现有任务列表（用于确定起始 id）
 * @returns 已分配 id 的新任务列表
 */
export function assignIds(
  newTodos: Omit<Todo, 'id' | 'createdAt'>[],
  existingTodos: Todo[]
): Todo[] {
  // 找到现有任务中最大的 id（数字形式）
  let maxId = 0
  for (const todo of existingTodos) {
    const num = parseInt(todo.id, 10)
    if (!isNaN(num) && num > maxId) {
      maxId = num
    }
  }

  const now = Date.now()
  return newTodos.map((todo, index) => ({
    ...todo,
    id: String(maxId + index + 1),
    createdAt: now,
  }))
}

// ─── 有向图环检测 ─────────────────────────────────────────────────────────────

/**
 * 检测任务依赖图中是否存在有向环（循环依赖）
 *
 * 算法：DFS + inStack 集合
 * - visited：已完成 DFS 的节点（不会重复访问）
 * - inStack：当前 DFS 路径上的节点（用于检测回边）
 *
 * 若某节点在 inStack 中被再次访问，说明存在有向环。
 *
 * @param allTodos - 包含新任务的完整任务列表
 * @returns { hasCycle, cyclePath }
 *   - hasCycle: 是否存在循环依赖
 *   - cyclePath: 循环链路描述，如 "任务 1 → 3 → 1 形成循环"，无环时为 null
 */
function detectCycle(allTodos: Todo[]): { hasCycle: boolean; cyclePath: string | null } {
  // 构建邻接表：id → dependsOn[]（只保留图中存在的节点）
  const graph = new Map<string, string[]>()
  const idSet = new Set<string>(allTodos.map(t => t.id))

  for (const todo of allTodos) {
    // 过滤掉 dependsOn 中引用了不存在 id 的情况
    const deps = (todo.dependsOn ?? []).filter(dep => idSet.has(dep))
    graph.set(todo.id, deps)
  }

  const visited = new Set<string>()
  const inStack = new Set<string>()

  /**
   * 格式化循环路径为可读字符串
   * 例：path = ["1", "3"]，cycleStart = "1" → "任务 1 → 3 → 1 形成循环"
   */
  function formatCyclePath(path: string[], cycleStart: string): string {
    // 找到循环起点在路径中的位置
    const startIndex = path.indexOf(cycleStart)
    const cyclePart = startIndex >= 0 ? path.slice(startIndex) : path
    return `任务 ${[...cyclePart, cycleStart].join(' → ')} 形成循环`
  }

  /**
   * DFS 遍历
   * @param nodeId - 当前节点 id
   * @param path - 当前 DFS 路径（不含当前节点）
   * @returns [hasCycle, cyclePath]
   */
  function dfs(nodeId: string, path: string[]): [boolean, string | null] {
    // 当前节点已在栈中 → 发现回边 → 存在环
    if (inStack.has(nodeId)) {
      return [true, formatCyclePath(path, nodeId)]
    }
    // 已完成访问的节点 → 无需重复遍历
    if (visited.has(nodeId)) {
      return [false, null]
    }

    visited.add(nodeId)
    inStack.add(nodeId)

    const neighbors = graph.get(nodeId) ?? []
    for (const neighbor of neighbors) {
      const [hasCycle, cyclePath] = dfs(neighbor, [...path, nodeId])
      if (hasCycle) {
        return [true, cyclePath]
      }
    }

    // 回溯：离开当前节点时从栈中移除
    inStack.delete(nodeId)
    return [false, null]
  }

  // 遍历所有节点（处理非连通图）
  for (const id of graph.keys()) {
    if (!visited.has(id)) {
      const [hasCycle, cyclePath] = dfs(id, [])
      if (hasCycle) {
        return { hasCycle: true, cyclePath }
      }
    }
  }

  return { hasCycle: false, cyclePath: null }
}

// ─── todo_write 工具 ──────────────────────────────────────────────────────────

const todoWriteInputSchema = z.strictObject({
  todos: z.array(z.strictObject({
    content:    z.string().describe('任务内容'),
    priority:   z.enum(['high', 'medium', 'low']).describe('优先级'),
    acceptance: z.array(z.string()).optional().describe('验收标准列表'),
    dependsOn:  z.array(z.string()).optional().describe('依赖的任务 id 列表'),
    context:    z.string().optional().describe('任务背景/来源'),
  })).min(1).describe('任务列表，至少包含一项'),
})

/**
 * 格式化任务列表为可读字符串
 */
function formatTodoList(todos: Todo[]): string {
  return todos.map(t => {
    const icon = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '○'
    const deps = t.dependsOn && t.dependsOn.length > 0 ? ` [依赖: ${t.dependsOn.join(', ')}]` : ''
    const acc = t.acceptance && t.acceptance.length > 0
      ? `\n    验收标准：${t.acceptance.map((a, i) => `\n      [${i}] ${a}`).join('')}`
      : ''
    return `${icon} [${t.id}] [${t.priority}] ${t.content}${deps}${acc}`
  }).join('\n')
}

/**
 * todo_write — 建立任务计划
 *
 * 语义：仅在任务列表为空时允许调用，建立全新计划。
 * 列表非空时直接拒绝，返回当前计划快照，提示使用 todo_append 或 todo_update。
 *
 * 需求：1.1、1.2、1.3、1.4、1.5、1.6、13.1、13.2、13.3、13.4、13.5
 */
export const TodoWriteTool: ToolDef<typeof todoWriteInputSchema> = {
  name: 'todo_write',
  description: `建立任务计划。仅在任务列表为空时可用。

规则：
- 只能在没有任何现有任务时调用（列表为空）
- 一次性提交完整计划，系统自动分配 id（从 "1" 开始）
- 第一个任务自动标记为 in_progress，无需额外调用 todo_update
- 如果任务列表已存在，请使用 todo_append 追加或 todo_update 更新状态
- 不要在输入中传入 id 字段，系统会忽略并自动分配`,
  inputSchema: todoWriteInputSchema,
  readonly: false,

  describe(input) {
    const count = Array.isArray(input.todos) ? input.todos.length : 0
    return `建立任务计划（共 ${count} 项）`
  },

  async execute(input) {
    const todoFile = getTodoFile()

    // ── 前置检查：列表非空时拒绝 ──────────────────────────────────────────────
    const existing = loadTodos()
    if (existing.length > 0) {
      const snapshot = formatTodoList(existing)
      auditLog({
        action: 'todo_write',
        resource: todoFile,
        result: 'denied',
        details: { reason: '任务列表已存在', existingCount: existing.length },
      })
      return {
        type: 'error',
        message: [
          '错误：任务列表已存在，todo_write 只能在列表为空时调用。',
          '',
          '当前计划快照：',
          snapshot,
          '',
          '如需追加新任务，请使用 todo_append。',
          '如需更新任务状态，请使用 todo_update。',
          '如需重置计划，请使用 todo_reset（需要用户确认）。',
        ].join('\n'),
      }
    }

    // ── 环检测：检查 dependsOn 是否形成有向环 ────────────────────────────────
    // 先临时分配 id 以便构建图进行检测
    const inputWithStatus = input.todos.map(t => ({ ...t, status: 'pending' as const }))
    const tempTodos = assignIds(inputWithStatus, [])
    const cycleResult = detectCycle(tempTodos)
    if (cycleResult.hasCycle) {
      auditLog({
        action: 'todo_write',
        resource: todoFile,
        result: 'denied',
        details: { reason: '循环依赖', cyclePath: cycleResult.cyclePath },
      })
      return {
        type: 'error',
        message: `错误：检测到循环依赖，无法建立计划。\n\n${cycleResult.cyclePath}\n\n请修正 dependsOn 字段后重新调用。`,
      }
    }

    // ── 分配 id 并设置初始状态 ────────────────────────────────────────────────
    const todos = assignIds(inputWithStatus, [])

    // 将第一个任务自动标记为 in_progress（需求 1.3）
    todos[0]!.status = 'in_progress'

    // ── 原子写入 ──────────────────────────────────────────────────────────────
    try {
      saveTodos(todos)
    } catch (err) {
      auditLog({
        action: 'todo_write',
        resource: todoFile,
        result: 'error',
        details: { error: String(err) },
      })
      return { type: 'error', message: `写入失败：${String(err)}` }
    }

    // ── 触发 WebSocket 推送 ───────────────────────────────────────────────────
    triggerTodosUpdated()

    // ── 审计日志 ──────────────────────────────────────────────────────────────
    auditLog({
      action: 'todo_write',
      resource: todoFile,
      result: 'allowed',
      details: { count: todos.length },
    })

    // ── 构建返回值 ────────────────────────────────────────────────────────────
    const firstTask = todos[0]!
    const todoList = formatTodoList(todos)

    const output = [
      `任务计划已建立（共 ${todos.length} 项）。`,
      '',
      todoList,
      '',
      `现在执行：「${firstTask.content}」，完成后调用 todo_update(id='${firstTask.id}', status='completed')`,
    ].join('\n')

    return { type: 'success', output }
  },
}

// ─── todo_update 工具 ─────────────────────────────────────────────────────────

const todoUpdateInputSchema = z.strictObject({
  id:            z.string().describe('要更新的任务 id'),
  status:        z.enum(['in_progress', 'completed']).describe('目标状态'),
  confirmations: z.array(z.boolean()).optional().describe('验收标准逐条确认布尔数组'),
})

/**
 * 找到下一个可开始的 pending 任务
 *
 * 排序规则：
 *   1. 按优先级 high → medium → low
 *   2. 同优先级按 id 数字升序
 *
 * 过滤条件：
 *   - status === 'pending'
 *   - 所有 dependsOn 任务均为 completed
 *
 * @param todos - 完整任务列表
 * @returns 下一个可开始的任务，或 null（无可用任务时）
 */
function findNextPending(todos: Todo[]): Todo | null {
  const completedIds = new Set(
    todos.filter(t => t.status === 'completed').map(t => t.id)
  )

  const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 }

  const candidates = todos.filter(t => {
    if (t.status !== 'pending') return false
    // 所有依赖任务均已完成
    const deps = t.dependsOn ?? []
    return deps.every(depId => completedIds.has(depId))
  })

  if (candidates.length === 0) return null

  // 按优先级升序，同优先级按 id 数字升序
  candidates.sort((a, b) => {
    const pa = priorityOrder[a.priority] ?? 99
    const pb = priorityOrder[b.priority] ?? 99
    if (pa !== pb) return pa - pb
    return parseInt(a.id, 10) - parseInt(b.id, 10)
  })

  return candidates[0]!
}

/**
 * 格式化验收清单（带索引）
 * 用于提示 LLM 逐条确认
 *
 * @param taskId - 任务 id
 * @param taskContent - 任务内容
 * @param acceptance - 验收标准列表
 * @param failedIndices - 未通过的索引集合（可选，用于标注哪些未通过）
 */
function formatAcceptanceChecklist(
  taskId: string,
  taskContent: string,
  acceptance: string[],
  failedIndices?: Set<number>
): string {
  const lines = [
    `任务「${taskContent}」有以下验收标准需要逐条确认：`,
  ]
  for (let i = 0; i < acceptance.length; i++) {
    const failed = failedIndices?.has(i)
    const marker = failed ? '  ✗' : '   '
    lines.push(`${marker} [${i}] ${acceptance[i]}`)
  }
  lines.push('')
  lines.push('请在确认每条标准后，调用：')
  const trueArr = acceptance.map(() => 'true').join(', ')
  lines.push(`todo_update(id='${taskId}', status='completed', confirmations=[${trueArr}])`)
  return lines.join('\n')
}

/**
 * todo_update — 更新单条任务状态
 *
 * 支持两种目标状态：
 *   - in_progress：检查依赖，将其他 in_progress 降为 pending，标记目标为 in_progress
 *   - completed：检查验收标准（如有），标记完成，自动推进下一个任务
 *
 * 需求：3.1、3.2、3.3、3.4、3.5、3.6、3.7、4.1、4.2、5.1、5.2、5.3、5.4
 */
export const TodoUpdateTool: ToolDef<typeof todoUpdateInputSchema> = {
  name: 'todo_update',
  description: `更新单条任务的状态。

支持的状态转换：
- → in_progress：开始执行任务（依赖必须全部完成）
- → completed：标记任务完成（有验收标准时需提供 confirmations）

规则：
- 同一时刻只能有一个 in_progress 任务，标记新任务时其他 in_progress 自动降为 pending
- 有 acceptance 字段的任务，必须提供 confirmations 数组（长度一致且全部为 true）才能标记完成
- 完成后自动推进下一个满足依赖条件的 pending 任务为 in_progress`,
  inputSchema: todoUpdateInputSchema,
  readonly: false,

  describe(input) {
    return `更新任务 ${input.id} → ${input.status}`
  },

  async execute(input) {
    const todoFile = getTodoFile()
    const todos = loadTodos()

    // ── 查找目标任务 ──────────────────────────────────────────────────────────
    const targetIndex = todos.findIndex(t => t.id === input.id)
    if (targetIndex === -1) {
      auditLog({
        action: 'todo_update',
        resource: todoFile,
        result: 'denied',
        details: { reason: 'id 不存在', id: input.id },
      })
      return {
        type: 'error',
        message: `错误：任务 id="${input.id}" 不存在。\n请调用 todo_read 确认当前任务列表后重试。`,
      }
    }

    const target = todos[targetIndex]!

    // ══════════════════════════════════════════════════════════════════════════
    // 分支一：标记为 in_progress
    // ══════════════════════════════════════════════════════════════════════════
    if (input.status === 'in_progress') {
      // ── 依赖检查：dependsOn 中所有任务必须为 completed ────────────────────
      const deps = target.dependsOn ?? []
      if (deps.length > 0) {
        const incompleteDeps = deps
          .map(depId => todos.find(t => t.id === depId))
          .filter((dep): dep is Todo => dep !== undefined && dep.status !== 'completed')

        if (incompleteDeps.length > 0) {
          const depInfo = incompleteDeps
            .map(d => `  - [${d.id}] ${d.content}（当前状态：${d.status}）`)
            .join('\n')
          auditLog({
            action: 'todo_update',
            resource: todoFile,
            result: 'denied',
            details: { reason: '依赖未完成', id: input.id, incompleteDeps: incompleteDeps.map(d => d.id) },
          })
          return {
            type: 'error',
            message: [
              `错误：任务「${target.content}」的以下依赖任务尚未完成，无法开始：`,
              depInfo,
              '',
              '请先完成上述依赖任务，再标记本任务为 in_progress。',
            ].join('\n'),
          }
        }
      }

      // ── 将其他所有 in_progress 任务降为 pending（需求 3.1、3.2）────────────
      const updated = todos.map((t, i) => {
        if (i === targetIndex) {
          return { ...t, status: 'in_progress' as const }
        }
        if (t.status === 'in_progress') {
          return { ...t, status: 'pending' as const }
        }
        return t
      })

      // ── 原子写入 ──────────────────────────────────────────────────────────
      try {
        saveTodos(updated)
      } catch (err) {
        auditLog({
          action: 'todo_update',
          resource: todoFile,
          result: 'error',
          details: { error: String(err) },
        })
        return { type: 'error', message: `写入失败：${String(err)}` }
      }

      triggerTodosUpdated()
      auditLog({
        action: 'todo_update',
        resource: todoFile,
        result: 'allowed',
        details: { id: input.id, status: 'in_progress' },
      })

      return {
        type: 'success',
        output: [
          `任务「${target.content}」已标记为 in_progress。`,
          '',
          '完成后调用：',
          target.acceptance && target.acceptance.length > 0
            ? `todo_update(id='${target.id}', status='completed', confirmations=[${target.acceptance.map(() => 'true').join(', ')}])`
            : `todo_update(id='${target.id}', status='completed')`,
        ].join('\n'),
      }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // 分支二：标记为 completed
    // ══════════════════════════════════════════════════════════════════════════

    // ── 验收标准检查（需求 5.1、5.2、5.3、5.4）────────────────────────────────
    const acceptance = target.acceptance
    if (acceptance && acceptance.length > 0) {
      // 5.1：未提供 confirmations
      if (input.confirmations === undefined || input.confirmations === null) {
        auditLog({
          action: 'todo_update',
          resource: todoFile,
          result: 'denied',
          details: { reason: '未提供 confirmations', id: input.id },
        })
        return {
          type: 'error',
          message: formatAcceptanceChecklist(target.id, target.content, acceptance),
        }
      }

      // 5.2：confirmations 长度不匹配
      if (input.confirmations.length !== acceptance.length) {
        auditLog({
          action: 'todo_update',
          resource: todoFile,
          result: 'denied',
          details: {
            reason: 'confirmations 长度不匹配',
            id: input.id,
            expected: acceptance.length,
            got: input.confirmations.length,
          },
        })
        return {
          type: 'error',
          message: [
            `错误：confirmations 长度（${input.confirmations.length}）与验收标准数量（${acceptance.length}）不一致。`,
            '',
            formatAcceptanceChecklist(target.id, target.content, acceptance),
          ].join('\n'),
        }
      }

      // 5.3：confirmations 中有 false
      const failedIndices = new Set<number>()
      input.confirmations.forEach((v, i) => { if (!v) failedIndices.add(i) })
      if (failedIndices.size > 0) {
        auditLog({
          action: 'todo_update',
          resource: todoFile,
          result: 'denied',
          details: { reason: 'confirmations 存在 false', id: input.id, failedIndices: [...failedIndices] },
        })
        return {
          type: 'error',
          message: [
            `错误：以下验收标准未通过（标注 ✗），请完成后重新确认：`,
            '',
            formatAcceptanceChecklist(target.id, target.content, acceptance, failedIndices),
          ].join('\n'),
        }
      }

      // 5.4：全部为 true → 允许标记完成（继续执行下方逻辑）
    }

    // ── 标记目标任务为 completed ──────────────────────────────────────────────
    let updated = todos.map((t, i) =>
      i === targetIndex ? { ...t, status: 'completed' as const } : t
    )

    // ── 自动推进下一个任务（需求 3.3、3.4）────────────────────────────────────
    const nextTask = findNextPending(updated)
    if (nextTask) {
      updated = updated.map(t =>
        t.id === nextTask.id ? { ...t, status: 'in_progress' as const } : t
      )
    }

    // ── 原子写入 ──────────────────────────────────────────────────────────────
    try {
      saveTodos(updated)
    } catch (err) {
      auditLog({
        action: 'todo_update',
        resource: todoFile,
        result: 'error',
        details: { error: String(err) },
      })
      return { type: 'error', message: `写入失败：${String(err)}` }
    }

    triggerTodosUpdated()
    auditLog({
      action: 'todo_update',
      resource: todoFile,
      result: 'allowed',
      details: { id: input.id, status: 'completed', nextTaskId: nextTask?.id ?? null },
    })

    // ── 所有任务均已完成（需求 3.7）────────────────────────────────────────────
    const allCompleted = updated.every(t => t.status === 'completed')
    if (allCompleted) {
      return {
        type: 'success',
        output: [
          `✓ 任务「${target.content}」已完成。`,
          '',
          '🎉 所有任务均已完成！',
          '请根据以上执行结果，向用户输出最终结果，无需再调用任何任务工具。',
        ].join('\n'),
      }
    }

    // ── 返回完成确认 + 下一步指令 ─────────────────────────────────────────────
    const nextInstruction = nextTask
      ? [
          `下一步执行：「${nextTask.content}」（id: ${nextTask.id}）`,
          nextTask.acceptance && nextTask.acceptance.length > 0
            ? `完成后调用：todo_update(id='${nextTask.id}', status='completed', confirmations=[${nextTask.acceptance.map(() => 'true').join(', ')}])`
            : `完成后调用：todo_update(id='${nextTask.id}', status='completed')`,
        ].join('\n')
      : '当前没有满足依赖条件的待执行任务，请调用 todo_read 查看整体进度。'

    return {
      type: 'success',
      output: [
        `✓ 任务「${target.content}」已完成。`,
        '',
        nextInstruction,
      ].join('\n'),
    }
  },
}

// ─── todo_append 工具 ─────────────────────────────────────────────────────────

const todoAppendInputSchema = z.strictObject({
  todos: z.array(z.strictObject({
    content:    z.string().describe('任务内容'),
    priority:   z.enum(['high', 'medium', 'low']).describe('优先级'),
    acceptance: z.array(z.string()).optional().describe('验收标准列表'),
    dependsOn:  z.array(z.string()).optional().describe('依赖的任务 id 列表'),
    context:    z.string().optional().describe('任务背景/来源'),
  })).min(1).describe('要追加的任务列表，至少包含一项'),
})

/**
 * todo_append — 追加新任务
 *
 * 语义：在任务列表末尾追加新任务，不修改任何已有任务的状态。
 * 适用于执行过程中发现遗漏步骤时扩展计划，无需中断当前任务。
 *
 * 执行逻辑：
 *   1. 验证 dependsOn 引用的 id 均存在于当前列表（需求 4.3）
 *   2. 调用 detectCycle() 检测合并后的完整图是否有环（需求 6.1、6.2、6.3）
 *   3. 调用 assignIds() 从当前最大 id + 1 开始分配（需求 2.3）
 *   4. 追加到列表末尾，不修改已有任务（需求 7.1）
 *   5. 原子写入（需求 7.4）
 *   6. 触发 WebSocket 推送回调（需求 11.1）
 *   7. 审计日志
 *
 * 需求：4.3、6.1、6.2、6.3、7.1、7.2、7.3、7.4
 */
export const TodoAppendTool: ToolDef<typeof todoAppendInputSchema> = {
  name: 'todo_append',
  description: `在任务列表末尾追加新任务，不影响已有任务状态。

适用场景：
- 执行过程中发现遗漏步骤
- 需要扩展计划但不想中断当前任务

规则：
- 不修改任何已有任务的状态
- 系统自动分配 id（从当前最大 id + 1 开始），不要在输入中传入 id 字段
- dependsOn 只能引用已存在于当前列表的任务 id
- 追加成功后请继续执行当前任务，不要切换到新追加的任务`,
  inputSchema: todoAppendInputSchema,
  readonly: false,

  describe(input) {
    const count = Array.isArray(input.todos) ? input.todos.length : 0
    return `追加 ${count} 个新任务`
  },

  async execute(input) {
    const todoFile = getTodoFile()
    const existing = loadTodos()

    // ── 构建已有 id 集合，用于 dependsOn 引用验证 ────────────────────────────
    const existingIdSet = new Set<string>(existing.map(t => t.id))

    // ── 验证 dependsOn 引用的 id 均存在于当前列表（需求 4.3）────────────────
    const invalidRefs: Array<{ taskIndex: number; missingId: string }> = []
    for (let i = 0; i < input.todos.length; i++) {
      const deps = input.todos[i]!.dependsOn ?? []
      for (const depId of deps) {
        // 只允许引用已存在于当前列表的 id（不允许引用同批次新任务的 id）
        if (!existingIdSet.has(depId)) {
          invalidRefs.push({ taskIndex: i, missingId: depId })
        }
      }
    }

    if (invalidRefs.length > 0) {
      const details = invalidRefs
        .map(r => `  - 第 ${r.taskIndex + 1} 个新任务的 dependsOn 引用了不存在的 id: "${r.missingId}"`)
        .join('\n')
      auditLog({
        action: 'todo_append',
        resource: todoFile,
        result: 'denied',
        details: { reason: 'dependsOn 引用不存在的 id', invalidRefs },
      })
      return {
        type: 'error',
        message: [
          '错误：新任务的 dependsOn 引用了不存在于当前列表的任务 id：',
          details,
          '',
          '请调用 todo_read 确认当前任务列表后，使用正确的 id 重新调用。',
        ].join('\n'),
      }
    }

    // ── 临时分配 id，构建合并后的完整列表用于环检测 ──────────────────────────
    const inputWithStatus = input.todos.map(t => ({ ...t, status: 'pending' as const }))
    const newTodosWithIds = assignIds(inputWithStatus, existing)
    const mergedTodos = [...existing, ...newTodosWithIds]

    // ── 环检测：检查合并后的完整图是否有有向环（需求 6.1、6.2）────────────────
    const cycleResult = detectCycle(mergedTodos)
    if (cycleResult.hasCycle) {
      auditLog({
        action: 'todo_append',
        resource: todoFile,
        result: 'denied',
        details: { reason: '循环依赖', cyclePath: cycleResult.cyclePath },
      })
      return {
        type: 'error',
        message: `错误：检测到循环依赖，无法追加任务。\n\n${cycleResult.cyclePath}\n\n请修正 dependsOn 字段后重新调用。`,
      }
    }

    // ── 原子写入合并后的列表（需求 7.4）──────────────────────────────────────
    try {
      saveTodos(mergedTodos)
    } catch (err) {
      auditLog({
        action: 'todo_append',
        resource: todoFile,
        result: 'error',
        details: { error: String(err) },
      })
      return { type: 'error', message: `写入失败：${String(err)}` }
    }

    // ── 触发 WebSocket 推送（需求 11.1）──────────────────────────────────────
    triggerTodosUpdated()

    // ── 审计日志 ──────────────────────────────────────────────────────────────
    const newIds = newTodosWithIds.map(t => t.id)
    auditLog({
      action: 'todo_append',
      resource: todoFile,
      result: 'allowed',
      details: { count: newTodosWithIds.length, newIds },
    })

    // ── 构建返回值（需求 7.2）────────────────────────────────────────────────
    const idList = newIds.join(', ')
    const output = [
      `已追加 ${newTodosWithIds.length} 个新任务（id: ${idList}）。`,
      '',
      '请继续执行当前任务，新追加的任务将在适当时机自动推进。',
    ].join('\n')

    return { type: 'success', output }
  },
}

// ─── todo_reset 工具 ──────────────────────────────────────────────────────────

const todoResetInputSchema = z.strictObject({
  reason:  z.string().describe('重置原因，说明为什么需要重置当前计划'),
  newPlan: z.string().optional().describe('新方案描述（可选），说明重置后打算如何重新规划'),
})

// ── 会话级 reset 决策 pending resolve 表 ─────────────────────────────────────
// 与 DecisionTool 的 sessionDecisionResolves 并行，专用于 todo_reset 决策
const resetDecisionResolves = new Map<string, (approved: boolean) => void>()

// ── 会话级 reset 决策推送回调表 ───────────────────────────────────────────────
const resetDecisionCallbacks = new Map<string, (payload: object) => void>()

/**
 * 注册 todo_reset 决策推送回调（由 SessionManager 调用）
 * 与 setGatewayDecisionCallback 类似，但专用于 todo_reset 的决策广播
 */
export function setResetDecisionCallback(
  cb: ((payload: object) => void) | null,
  sessionId?: string,
): void {
  const key = sessionId ?? '__global__'
  if (cb) resetDecisionCallbacks.set(key, cb)
  else resetDecisionCallbacks.delete(key)
}

/**
 * 将用户对 todo_reset 的决策回答注入等待中的 Promise。
 * Gateway 模式传入 sessionId 精确路由；CLI/Server 模式不传。
 * answer: 'approve' | 'reject' 或任意字符串（非 'approve' 均视为拒绝）
 */
export function resolveResetDecision(answer: string, sessionId?: string): boolean {
  const key = sessionId ?? '__global__'
  const resolve = resetDecisionResolves.get(key)
  if (!resolve) return false
  resetDecisionResolves.delete(key)
  resolve(answer === 'approve')
  return true
}

/**
 * todo_reset — 请求重置计划
 *
 * 安全机制：LLM 无法直接清空任务列表，必须经过用户确认。
 *
 * 执行流程：
 *   1. 列表为空时直接返回错误（需求 8.6）
 *   2. 备份当前列表到 todos.bak.{timestamp}.json（原子写入，需求 8.1、12.4）
 *   3. 向用户广播决策请求，展示当前计划状态、重置原因和新方案（需求 8.2）
 *   4. 使用 Promise.race + setTimeout(5min) 实现超时自动拒绝（需求 8.5）
 *   5. 用户允许 → 清空列表，触发推送回调，返回提示（需求 8.3）
 *   6. 用户拒绝或超时 → 保留列表，返回当前执行中任务信息（需求 8.4、8.5）
 *
 * 需求：8.1、8.2、8.3、8.4、8.5、8.6、12.4
 */
export const TodoResetTool: ToolDef<typeof todoResetInputSchema> = {
  name: 'todo_reset',
  description: `请求重置任务计划（需要用户确认）。

⚠️ 此操作需要用户明确批准，LLM 无法自行清空任务列表。

适用场景：
- 当前计划方向完全错误，需要从头规划
- 遇到根本性障碍，原计划无法继续执行

规则：
- 重置前自动备份当前列表（可手动恢复）
- 用户拒绝或 5 分钟内无响应，自动保留原计划继续执行
- 用户批准后，调用 todo_write 建立新计划`,
  inputSchema: todoResetInputSchema,
  readonly: false,

  describe(input) {
    return `请求重置任务计划：${input.reason.slice(0, 50)}`
  },

  async execute(input) {
    const todoFile = getTodoFile()
    const todos = loadTodos()

    // ── 需求 8.6：列表为空时直接返回错误 ─────────────────────────────────────
    if (todos.length === 0) {
      auditLog({
        action: 'todo_reset',
        resource: todoFile,
        result: 'denied',
        details: { reason: '任务列表为空' },
      })
      return {
        type: 'error',
        message: '当前没有任务计划，无需重置。如需建立新计划，请直接调用 todo_write。',
      }
    }

    // ── 需求 8.1、12.4：备份当前列表（原子写入）─────────────────────────────
    const timestamp = Date.now()
    const backupPath = resolve(getGlobalCwd(), '.hrids', 'tasks', `todos.bak.${timestamp}.json`)
    try {
      saveTodos(todos, backupPath)
    } catch (err) {
      auditLog({
        action: 'todo_reset',
        resource: todoFile,
        result: 'error',
        details: { error: `备份失败: ${String(err)}` },
      })
      return { type: 'error', message: `备份失败，重置已取消：${String(err)}` }
    }

    // ── 需求 8.2：构建决策请求 payload ───────────────────────────────────────
    const inProgressTask = todos.find(t => t.status === 'in_progress')
    const pendingCount = todos.filter(t => t.status === 'pending').length
    const completedCount = todos.filter(t => t.status === 'completed').length

    const currentPlanSummary = [
      `当前计划共 ${todos.length} 项任务：`,
      `  - 已完成：${completedCount} 项`,
      `  - 执行中：${inProgressTask ? `「${inProgressTask.content}」（id: ${inProgressTask.id}）` : '无'}`,
      `  - 待执行：${pendingCount} 项`,
    ].join('\n')

    const decisionPayload = {
      type: 'todo_reset_request',
      reason: input.reason,
      newPlan: input.newPlan ?? null,
      currentPlanSummary,
      backupPath,
      timestamp,
    }

    // ── 需求 8.2、8.3、8.4、8.5：等待用户决策（5 分钟超时）─────────────────
    const sessionId = getCurrentSessionId()

    const decisionPromise = new Promise<boolean>((resolve) => {
      const key = sessionId ?? '__global__'
      resetDecisionResolves.set(key, resolve)

      // 尝试通过已注册的回调广播决策请求
      const cb = sessionId
        ? (resetDecisionCallbacks.get(sessionId) ?? resetDecisionCallbacks.get('__global__'))
        : resetDecisionCallbacks.get('__global__')

      if (cb) {
        cb(decisionPayload)
      } else if (sessionId) {
        // 降级：尝试复用 DecisionTool 的 gatewayDecisionCallback 广播
        // 通过 setGatewayDecisionCallback 注册的回调已在 SessionManager 中注册
        // 此处直接调用 resolveDecision 机制不可行（不同的 resolve 表）
        // 因此通过 process.stdout 输出（Server 模式）或打印到控制台（CLI 模式）
        if (process.env.AGENT_SERVER_MODE === '1') {
          process.stdout.write(JSON.stringify(decisionPayload) + '\n')
        } else {
          process.stdout.write(
            `\n${'═'.repeat(60)}\n` +
            `⚡ 任务重置请求\n` +
            `${'═'.repeat(60)}\n` +
            `原因：${input.reason}\n` +
            (input.newPlan ? `新方案：${input.newPlan}\n` : '') +
            `\n${currentPlanSummary}\n\n` +
            `请输入 "approve" 批准重置，或任意其他内容拒绝：`
          )
        }
      }
    })

    const timeoutPromise = new Promise<boolean>((resolve) => {
      setTimeout(() => {
        // 超时：清理 pending resolve，自动视为拒绝
        const key = sessionId ?? '__global__'
        resetDecisionResolves.delete(key)
        resolve(false)
      }, 5 * 60 * 1000)
    })

    const approved = await Promise.race([decisionPromise, timeoutPromise])

    // ── 需求 8.3：用户批准 → 清空列表 ────────────────────────────────────────
    if (approved) {
      try {
        saveTodos([])
      } catch (err) {
        auditLog({
          action: 'todo_reset',
          resource: todoFile,
          result: 'error',
          details: { error: `清空失败: ${String(err)}` },
        })
        return { type: 'error', message: `清空任务列表失败：${String(err)}` }
      }

      // 触发 WebSocket 推送（需求 11.1）
      triggerTodosUpdated()

      auditLog({
        action: 'todo_reset',
        resource: todoFile,
        result: 'allowed',
        details: { approved: true, backupPath, timestamp },
      })

      return {
        type: 'success',
        output: [
          '✓ 任务计划已重置。',
          `原计划已备份至：${backupPath}`,
          '',
          '请调用 todo_write 建立新的任务计划。',
        ].join('\n'),
      }
    }

    // ── 需求 8.4、8.5：用户拒绝或超时 → 保留列表 ────────────────────────────
    auditLog({
      action: 'todo_reset',
      resource: todoFile,
      result: 'denied',
      details: { approved: false, backupPath, timestamp },
    })

    const continueInstruction = inProgressTask
      ? `请继续执行当前任务：「${inProgressTask.content}」（id: ${inProgressTask.id}）`
      : '当前没有执行中的任务，请调用 todo_read 查看整体进度。'

    return {
      type: 'success',
      output: [
        '重置请求已被拒绝（或等待超时），原有任务计划保持不变。',
        '',
        continueInstruction,
      ].join('\n'),
    }
  },
}

// ─── todo_read 工具 ───────────────────────────────────────────────────────────

const todoReadInputSchema = z.strictObject({})

/**
 * todo_read — 读取当前任务状态
 *
 * 只读操作，不修改任何任务状态。
 *
 * 输出内容：
 *   - 任务进度概览（已完成 / 总数）
 *   - 最近 3 条已完成任务（按 id 降序）
 *   - 未完成任务（按 high→medium→low 优先级，同优先级按 id 升序）
 *   - in_progress 任务展示完整 acceptance 列表（带索引）
 *   - 当前执行中任务的下一步操作指令
 *
 * 需求：9.1、9.2、9.3、9.4
 */
export const TodoReadTool: ToolDef<typeof todoReadInputSchema> = {
  name: 'todo_read',
  description: `读取当前任务状态（只读，不修改任何状态）。

返回内容：
- 任务整体进度（已完成 / 总数）
- 最近 3 条已完成任务
- 未完成任务列表（按优先级排序：high → medium → low，同优先级按 id 升序）
- 当前执行中任务的验收标准（如有）及下一步操作指令`,
  inputSchema: todoReadInputSchema,
  readonly: true,

  describe(_input) {
    return '读取当前任务状态'
  },

  async execute(_input) {
    const todos = loadTodos()

    // ── 需求 9.3：列表为空时返回提示 ─────────────────────────────────────────
    if (todos.length === 0) {
      return {
        type: 'success',
        output: '当前没有任务计划。请调用 todo_write 建立新的任务计划。',
      }
    }

    // ── 分类任务 ──────────────────────────────────────────────────────────────
    const completedTodos = todos.filter(t => t.status === 'completed')
    const incompleteTodos = todos.filter(t => t.status !== 'completed')

    const completedCount = completedTodos.length
    const totalCount = todos.length

    // ── 最近 3 条已完成任务（按 id 降序取最后 3 条）──────────────────────────
    const recentCompleted = [...completedTodos]
      .sort((a, b) => parseInt(b.id, 10) - parseInt(a.id, 10))
      .slice(0, 3)

    // ── 未完成任务排序：high→medium→low，同优先级按 id 升序 ──────────────────
    const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 }
    const sortedIncomplete = [...incompleteTodos].sort((a, b) => {
      const pa = priorityOrder[a.priority] ?? 99
      const pb = priorityOrder[b.priority] ?? 99
      if (pa !== pb) return pa - pb
      return parseInt(a.id, 10) - parseInt(b.id, 10)
    })

    // ── 构建输出 ──────────────────────────────────────────────────────────────
    const lines: string[] = []

    // 标题行
    lines.push(`## 任务进度（${completedCount}/${totalCount} 已完成）`)

    // 最近完成区块
    if (recentCompleted.length > 0) {
      lines.push('')
      lines.push('### 最近完成')
      for (const t of recentCompleted) {
        lines.push(`✓ [${t.id}] [${t.priority}] ${t.content}`)
      }
    }

    // 待执行任务区块
    if (sortedIncomplete.length > 0) {
      lines.push('')
      lines.push('### 待执行任务')
      for (const t of sortedIncomplete) {
        const icon = t.status === 'in_progress' ? '▸' : '○'
        const inProgressMark = t.status === 'in_progress' ? '（执行中）' : ''
        const deps = t.dependsOn && t.dependsOn.length > 0
          ? ` [依赖: ${t.dependsOn.join(', ')}]`
          : ''
        lines.push(`${icon} [${t.id}] [${t.priority}] ${t.content}${inProgressMark}${deps}`)

        // in_progress 任务展示完整 acceptance 列表（带索引）
        if (t.status === 'in_progress' && t.acceptance && t.acceptance.length > 0) {
          lines.push('   验收标准：')
          for (let i = 0; i < t.acceptance.length; i++) {
            lines.push(`     [${i}] ${t.acceptance[i]}`)
          }
        }
      }
    }

    // ── 当前执行中任务的下一步操作指令（需求 9.2）────────────────────────────
    const inProgressTask = todos.find(t => t.status === 'in_progress')
    if (inProgressTask) {
      lines.push('')
      lines.push(`当前执行中：「${inProgressTask.content}」（id: ${inProgressTask.id}）`)

      if (inProgressTask.acceptance && inProgressTask.acceptance.length > 0) {
        const trueArr = inProgressTask.acceptance.map(() => 'true').join(', ')
        lines.push(
          `完成后调用：todo_update(id='${inProgressTask.id}', status='completed', confirmations=[${trueArr}])`
        )
      } else {
        lines.push(
          `完成后调用：todo_update(id='${inProgressTask.id}', status='completed')`
        )
      }
    }

    return {
      type: 'success',
      output: lines.join('\n'),
    }
  },
}
