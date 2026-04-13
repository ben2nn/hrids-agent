// 记忆工具集 —— 供 agent 主动读写记忆
import { z } from 'zod'
import type { ToolDef } from '../core/Tool.js'
import { getMemoryStack } from './layers.js'
import { getMemoryStore } from './store.js'

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
  description: '将重要信息、决策、偏好或事实写入长期记忆。当发现值得记住的内容时主动调用。',
  inputSchema: addSchema,
  readonly: false,

  describe(input) {
    return `记住: ${input.content.slice(0, 60)}`
  },

  async execute(input) {
    try {
      const store = getMemoryStore()
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
      const stack = getMemoryStack()
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
      const stack = getMemoryStack()
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
      const stack = getMemoryStack()
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
      const stack = getMemoryStack()
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
  MemorySearchTool,
  MemoryRecallTool,
  MemoryFactTool,
  MemoryStatusTool,
]
