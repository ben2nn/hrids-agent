// 记忆工具集 —— 供 agent 主动读写记忆
import { z } from 'zod'
import type { ToolDef } from '../core/Tool.js'
import { getMemoryStack, getMemoryStackForSession } from './layers.js'
import { getMemoryStore, getMemoryStoreForSession } from './store.js'
import { getCurrentSessionId } from '../core/sessionContext.js'

/** 获取当前上下文的 MemoryStack（Gateway 用会话级，CLI 用全局单例） */
function resolveStack() {
  const sid = getCurrentSessionId()
  return sid ? getMemoryStackForSession(sid) : getMemoryStack()
}

/** 获取当前上下文的 MemoryStore（Gateway 用会话级，CLI 用全局单例） */
function resolveStore() {
  const sid = getCurrentSessionId()
  return sid ? getMemoryStoreForSession(sid) : getMemoryStore()
}

// ── memory_add ───────────────────────────────────────────────

const addSchema = z.object({
  content: z.string().describe('要记住的内容（原始文本）'),
  type: z.enum(['decision', 'preference', 'milestone', 'problem', 'emotional', 'fact'])
    .describe('记忆类型：decision=决策, preference=偏好, milestone=里程碑, problem=问题, emotional=情感, fact=事实'),
  wing: z.string().optional().describe('所属项目/领域（如 my-project, coding, personal）'),
  room: z.string().optional().describe('所属主题（如 architecture, auth, deployment）'),
  importance: z.number().optional().describe('重要性 1-5，默认 3'),
  tags: z.array(z.string()).optional().describe('标签列表'),
})

export const MemoryAddTool: ToolDef<typeof addSchema> = {
  name: 'memory_add',
  description: `将重要信息写入长期记忆。以下情况必须主动调用：
- 用户表达偏好（"以后都用X"、"不要用Y"、"我喜欢X风格"）→ type=preference
- 做出技术决策（"用X替代Y"、"选择了X方案"、"因为X所以用Y"）→ type=decision
- 完成重要任务（"搞定了"、"上线了"、"终于解决了"）→ type=milestone
- 发现 bug 根因或解决方案 → type=problem
- 用户提到项目名、技术栈、团队信息等事实 → type=fact
不要等到会话结束，发现值得记住的内容时立即调用。`,
  inputSchema: addSchema,
  readonly: false,

  describe(input) {
    return `记住: ${input.content.slice(0, 60)}`
  },

  async execute(input) {
    try {
      const store = resolveStore()
      const mem = store.addMemory({
        content: input.content,
        type: input.type,
        wing: input.wing ?? 'general',
        room: input.room ?? 'general',
        importance: input.importance ?? 3,
        tags: input.tags ?? [],
      })
      return { type: 'success', output: `已记住（ID: ${mem.id}，类型: ${mem.type}）` }
    } catch (err) {
      return { type: 'error', message: String(err) }
    }
  },
}

// ── memory_search ────────────────────────────────────────────

const searchSchema = z.object({
  query: z.string().describe('搜索查询'),
  wing: z.string().optional().describe('限定搜索范围的项目/领域'),
  room: z.string().optional().describe('限定搜索范围的主题'),
  topK: z.number().optional().describe('返回结果数量，默认 5'),
})

export const MemorySearchTool: ToolDef<typeof searchSchema> = {
  name: 'memory_search',
  description: '在长期记忆中搜索相关内容。当需要回忆之前的决策、偏好或事实时调用。',
  inputSchema: searchSchema,
  readonly: true,

  describe(input) {
    return `搜索记忆: ${input.query}`
  },

  async execute(input) {
    try {
      const stack = resolveStack()
      const text = await stack.searchText(input.query, {
        wing: input.wing,
        room: input.room,
        topK: input.topK ?? 5,
      })
      return { type: 'success', output: text }
    } catch (err) {
      return { type: 'error', message: String(err) }
    }
  },
}

// ── memory_recall ────────────────────────────────────────────

const recallSchema = z.object({
  wing: z.string().optional().describe('项目/领域'),
  room: z.string().optional().describe('主题'),
  limit: z.number().optional().describe('最多返回条数，默认 10'),
})

export const MemoryRecallTool: ToolDef<typeof recallSchema> = {
  name: 'memory_recall',
  description: '列出特定项目或主题下的记忆（L2 按需检索）。',
  inputSchema: recallSchema,
  readonly: true,

  describe(input) {
    return `回忆: ${[input.wing, input.room].filter(Boolean).join('/') || '全部'}`
  },

  async execute(input) {
    try {
      const stack = resolveStack()
      const text = stack.recall({ wing: input.wing, room: input.room, limit: input.limit })
      return { type: 'success', output: text }
    } catch (err) {
      return { type: 'error', message: String(err) }
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

  async execute(input) {
    try {
      const stack = resolveStack()
      const triple = stack.addFact(input.subject, input.predicate, input.object, {
        validFrom: input.validFrom,
        confidence: input.confidence,
      })
      return { type: 'success', output: `已记录事实（ID: ${triple.id}）` }
    } catch (err) {
      return { type: 'error', message: String(err) }
    }
  },
}

// ── memory_update ────────────────────────────────────────────

const updateSchema = z.object({
  oldId: z.string().describe('要替换的旧记忆 ID（从 memory_search 或 memory_recall 结果中获取）'),
  content: z.string().describe('新的记忆内容'),
  type: z.enum(['decision', 'preference', 'milestone', 'problem', 'emotional', 'fact']).optional()
    .describe('新的记忆类型（不填则保持原类型）'),
  importance: z.number().optional().describe('新的重要性 1-5'),
})

export const MemoryUpdateTool: ToolDef<typeof updateSchema> = {
  name: 'memory_update',
  description: `更新一条已有记忆（标记旧记忆失效，写入新版本）。以下情况必须调用而不是 memory_add：
- 用户改变了之前的决策（"不用X了，改用Y"）
- 用户修正了之前的偏好（"其实我更喜欢Y"）
- 之前记录的事实已经过时（版本升级、项目重命名等）
先用 memory_search 找到旧记忆的 ID，再调用此工具替换。`,
  inputSchema: updateSchema,
  readonly: false,

  describe(input) {
    return `更新记忆: ${input.oldId} → ${input.content.slice(0, 50)}`
  },

  async execute(input) {
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
      return { type: 'success', output: `已更新（旧 ID: ${input.oldId} → 新 ID: ${updated.id}）` }
    } catch (err) {
      return { type: 'error', message: String(err) }
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

  async execute() {
    try {
      const stack = resolveStack()
      const stats = await stack.status()
      const lines = [
        `记忆总数: ${stats.totalMemories}`,
        `活跃事实: ${stats.activeTriples}`,
        `项目翼: ${stats.wings.join(', ') || '无'}`,
        '类型分布:',
        ...Object.entries(stats.byType).map(([t, c]) => `  ${t}: ${c}`),
      ]
      return { type: 'success', output: lines.join('\n') }
    } catch (err) {
      return { type: 'error', message: String(err) }
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
