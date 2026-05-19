// 记忆工具集 —— 供 agent 主动读写记忆
import { z } from 'zod'
import type { ToolDef, ToolContext } from '../core/Tool.js'
import { logger } from '../shared/logger.js'
import { getMemoryStack } from './layers.js'
import { getMemoryStore } from './store.js'

const log = logger.child({ component: 'memory-tool' })

function resolveStack() {
  return getMemoryStack()
}

function resolveStore() {
  return getMemoryStore()
}

function reportError(ctx: ToolContext | undefined, op: string, err: unknown): void {
  const msg = `[memory] ${op} 失败: ${err instanceof Error ? err.message : String(err)}`
  log.error(msg)
  ctx?.onLog?.(msg)
}

// ── memory_add ───────────────────────────────────────────────

const addSchema = z.object({
  content: z.string().describe('要记住的内容（原始文本）'),
  type: z.enum(['decision', 'preference', 'milestone', 'problem', 'fact'])
    .describe('记忆类型：decision=决策, preference=偏好, milestone=里程碑, problem=问题, fact=事实'),
  importance: z.number().optional().describe('重要性 1-5，默认 3'),
})

export const MemoryAddTool: ToolDef<typeof addSchema> = {
  name: 'memory_add',
  description: `将重要信息写入长期记忆，跨会话持久化。
适用场景：
- 用户明确纠正或要求记住（"以后不要用X"、"记住这个"）→ type=preference
- 做出有影响的技术决策（"我们决定用X替代Y"）→ type=decision
- 完成重要里程碑（"上线了"、"搞定了"）→ type=milestone
- 发现 bug 根因或解决方案 → type=problem
不适用场景：
- 问候/闲聊/简单对话 → 不需要记录
- 明显的事实（Python 是编程语言）→ 没有必要记录
- 任务中间状态 → 用 todo 管理，不要用 memory`,
  inputSchema: addSchema,
  readonly: false,

  describe(input) {
    return `记住: ${input.content.slice(0, 60)}`
  },

  async execute(input, ctx?: ToolContext) {
    try {
      const store = resolveStore()
      const mem = store.addMemory({
        content: input.content,
        type: input.type,
        agent: 'main',
        importance: input.importance ?? 3,
      })
      ctx?.onLog?.(`[memory] 已记录: ${mem.type} - ${input.content.slice(0, 80)}`)
      return { type: 'success', output: `已记住（ID: ${mem.id}，类型: ${mem.type}）` }
    } catch (err) {
      reportError(ctx, '记录', err)
      return { type: 'error', message: `记录失败: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
}

// ── memory_search ────────────────────────────────────────────

const searchSchema = z.object({
  query: z.string().describe('搜索查询'),
  topK: z.number().optional().describe('返回结果数量，默认 5'),
})

export const MemorySearchTool: ToolDef<typeof searchSchema> = {
  name: 'memory_search',
  description: `在长期记忆中搜索相关内容。
适用场景：开始新任务前检查是否有相关历史 | 用户提到之前讨论过的话题
不适用场景：问候/闲聊 | 用户没有提到需要回忆的内容`,
  inputSchema: searchSchema,
  readonly: true,

  describe(input) {
    return `搜索记忆: ${input.query}`
  },

  async execute(input, ctx?: ToolContext) {
    try {
      const stack = resolveStack()
      const text = await stack.searchText(input.query, {
        topK: input.topK ?? 5,
      })
      ctx?.onLog?.(`[memory] 搜索 "${input.query}" 完成`)
      return { type: 'success', output: text }
    } catch (err) {
      reportError(ctx, '搜索', err)
      return { type: 'error', message: `搜索失败: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
}

// ── memory_recall ────────────────────────────────────────────

const recallSchema = z.object({
  agent: z.string().optional().describe('智能体名称'),
  limit: z.number().optional().describe('最多返回条数，默认 10'),
})

export const MemoryRecallTool: ToolDef<typeof recallSchema> = {
  name: 'memory_recall',
  description: `列出已保存的记忆条目（按重要性排序）。
适用场景：用户要求查看记忆、需要回顾之前保存的偏好和决策
不适用场景：每次对话开始时自动调用 | 问候/闲聊`,
  inputSchema: recallSchema,
  readonly: true,

  describe(input) {
    return `回忆: ${input.agent ?? '全部'}`
  },

  async execute(input, ctx?: ToolContext) {
    try {
      const stack = resolveStack()
      const text = stack.recall({ agent: input.agent, limit: input.limit })
      ctx?.onLog?.('[memory] 回忆完成')
      return { type: 'success', output: text }
    } catch (err) {
      reportError(ctx, '回忆', err)
      return { type: 'error', message: `回忆失败: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
}

// ── memory_fact ──────────────────────────────────────────────

const factSchema = z.object({
  subject: z.string().describe('主语（实体名称）'),
  predicate: z.string().describe('谓语（关系类型，如 uses, has, is, works_on）'),
  object: z.string().describe('宾语（实体或值）'),
  validFrom: z.string().optional().describe('生效日期（ISO 格式，如 2025-01-01）'),
  confidence: z.number().optional().describe('置信度 0-1，默认 1.0'),
})

export const MemoryFactTool: ToolDef<typeof factSchema> = {
  name: 'memory_fact',
  description: '向知识图谱写入事实三元组（主语-谓语-宾语）。用于记录实体关系，如"项目A 使用 React"。',
  inputSchema: factSchema,
  readonly: false,

  describe(input) {
    return `记录事实: ${input.subject} → ${input.predicate} → ${input.object}`
  },

  async execute(input, ctx?: ToolContext) {
    try {
      const stack = resolveStack()
      const triple = stack.addFact(input.subject, input.predicate, input.object, {
        validFrom: input.validFrom,
        confidence: input.confidence,
      })
      ctx?.onLog?.(`[memory] 已记录事实: ${input.subject} → ${input.predicate} → ${input.object}`)
      return { type: 'success', output: `已记录事实（ID: ${triple.id}）` }
    } catch (err) {
      reportError(ctx, '记录事实', err)
      return { type: 'error', message: `记录事实失败: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
}

// ── memory_update ────────────────────────────────────────────

const updateSchema = z.object({
  oldId: z.string().describe('要替换的旧记忆 ID（从 memory_search 或 memory_recall 结果中获取）'),
  content: z.string().describe('新的记忆内容'),
  type: z.enum(['decision', 'preference', 'milestone', 'problem', 'fact']).optional()
    .describe('新的记忆类型（不填则保持原类型）'),
  importance: z.number().optional().describe('新的重要性 1-5'),
})

export const MemoryUpdateTool: ToolDef<typeof updateSchema> = {
  name: 'memory_update',
  description: `更新已有记忆（标记旧记忆失效，写入新版本）。
适用场景：用户改变之前的决策/偏好、之前记录的事实已过时
不适用场景：新增记忆 → 用 memory_add | 闲聊中无意提到的信息`,
  inputSchema: updateSchema,
  readonly: false,

  describe(input) {
    return `更新记忆: ${input.oldId} → ${input.content.slice(0, 50)}`
  },

  async execute(input, ctx?: ToolContext) {
    try {
      const store = resolveStore()
      const updated = store.updateMemory(input.oldId, {
        content: input.content,
        type: input.type,
        importance: input.importance,
      })
      if (!updated) {
        return { type: 'error', message: `未找到记忆 ID: ${input.oldId}` }
      }
      ctx?.onLog?.(`[memory] 已更新: ${input.oldId} → ${updated.id}`)
      return { type: 'success', output: `已更新（旧 ID: ${input.oldId} → 新 ID: ${updated.id}）` }
    } catch (err) {
      reportError(ctx, '更新', err)
      return { type: 'error', message: `更新失败: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
}

// ── memory_status ────────────────────────────────────────────

const statusSchema = z.object({})

export const MemoryStatusTool: ToolDef<typeof statusSchema> = {
  name: 'memory_status',
  description: '查看记忆系统的统计信息（记忆总数、类型分布、知识图谱规模等）。',
  inputSchema: statusSchema,
  readonly: true,

  describe() { return '查看记忆状态' },

  async execute(_input, ctx?: ToolContext) {
    try {
      const stack = resolveStack()
      const stats = await stack.status()
      const lines = [
        `记忆总数: ${stats.totalMemories}`,
        `活跃事实: ${stats.activeTriples}`,
        '类型分布:',
        ...Object.entries(stats.byType).map(([t, c]) => `  ${t}: ${c}`),
      ]
      return { type: 'success', output: lines.join('\n') }
    } catch (err) {
      reportError(ctx, '查询状态', err)
      return { type: 'error', message: `查询状态失败: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
}

export const MEMORY_TOOLS: ToolDef[] = [
  MemoryAddTool,
  MemoryUpdateTool,
  MemorySearchTool,
  MemoryRecallTool,
  MemoryFactTool,
  MemoryStatusTool,
]
