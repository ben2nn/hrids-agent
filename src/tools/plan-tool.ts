// Plan 工具模块 —— 提供计划的创建、读取、更新、列表功能
import { z } from 'zod'
import type { ToolDef } from '../core/tool.js'
import {
  createPlan,
  getPlan,
  updatePlan,
  updatePlanStatus,
  archivePlan,
  listPlans,
  formatPlan,
  formatPlanList,
} from '../core/plan-manager.js'

// ─── plan_create 工具 ────────────────────────────────────────────────────────

const planCreateInputSchema = z.strictObject({
  title:   z.string().describe('计划标题'),
  content: z.string().describe('计划内容（Markdown 格式）'),
  tags:    z.array(z.string()).optional().describe('标签列表，用于分类和筛选'),
})

/**
 * plan_create — 创建新计划
 *
 * 将计划持久化到 ~/.hrids/plans/ 目录
 * plan 模式下可用（planSafe: true）
 */
export const PlanCreateTool: ToolDef<typeof planCreateInputSchema> = {
  name: 'plan_create',
  description: `创建新计划并持久化到文件。

适用场景：
- Plan 模式下探索完成后，输出结构化执行计划
- 需要保存规划结果供后续参考

规则：
- 计划存储在 ~/.hrids/plans/ 目录
- 系统自动分配 ID（格式：plan-YYYYMMDD-NNN）
- 标签用于分类和筛选，可选`,
  inputSchema: planCreateInputSchema,
  readonly: false,
  planSafe: true,
  capabilities: { parallelSafe: false },

  describe(input) {
    return `创建计划：${input.title}`
  },

  async execute(input) {
    try {
      const plan = createPlan(input.title, input.content, { tags: input.tags })

      return {
        type: 'success',
        output: [
          `计划已创建：${plan.id}`,
          '',
          formatPlan(plan),
        ].join('\n'),
      }
    } catch (err) {
      return {
        type: 'error',
        message: `创建计划失败：${(err as Error).message}`,
      }
    }
  },
}

// ─── plan_update 工具 ────────────────────────────────────────────────────────

const planUpdateInputSchema = z.strictObject({
  id:      z.string().describe('计划 ID'),
  content: z.string().describe('更新后的计划内容'),
})

/**
 * plan_update — 更新计划内容
 *
 * plan 模式下可用（planSafe: true）
 */
export const PlanUpdateTool: ToolDef<typeof planUpdateInputSchema> = {
  name: 'plan_update',
  description: `更新已有计划的内容。

适用场景：
- 修正计划中的错误
- 根据新信息调整计划

规则：
- 必须提供有效的计划 ID
- 更新后自动修改 updated 时间戳`,
  inputSchema: planUpdateInputSchema,
  readonly: false,
  planSafe: true,
  capabilities: { parallelSafe: false },

  describe(input) {
    return `更新计划：${input.id}`
  },

  async execute(input) {
    try {
      const plan = updatePlan(input.id, input.content)
      if (!plan) {
        return {
          type: 'error',
          message: `计划 ${input.id} 不存在。请先调用 plan_list 查看可用计划。`,
        }
      }

      return {
        type: 'success',
        output: [
          `计划已更新：${plan.id}`,
          '',
          formatPlan(plan),
        ].join('\n'),
      }
    } catch (err) {
      return {
        type: 'error',
        message: `更新计划失败：${(err as Error).message}`,
      }
    }
  },
}

// ─── plan_list 工具 ──────────────────────────────────────────────────────────

const planListInputSchema = z.strictObject({
  status: z.enum(['draft', 'active', 'completed', 'archived']).optional().describe('按状态筛选'),
  tags:   z.array(z.string()).optional().describe('按标签筛选（任一匹配）'),
})

/**
 * plan_list — 列出所有计划
 *
 * 只读工具，plan 模式下可用
 */
export const PlanListTool: ToolDef<typeof planListInputSchema> = {
  name: 'plan_list',
  description: `列出所有计划，可选按状态或标签筛选。

适用场景：
- 查看已有计划
- 找到特定计划的 ID`,
  inputSchema: planListInputSchema,
  readonly: true,
  planSafe: true,
  capabilities: { parallelSafe: true },

  describe(_input) {
    return '列出所有计划'
  },

  async execute(input) {
    try {
      const filter = {
        status: input.status,
        tags: input.tags,
      }
      const plans = listPlans(input.status || input.tags ? filter : undefined)

      return {
        type: 'success',
        output: [
          `共 ${plans.length} 个计划：`,
          '',
          formatPlanList(plans),
        ].join('\n'),
      }
    } catch (err) {
      return {
        type: 'error',
        message: `列出计划失败：${(err as Error).message}`,
      }
    }
  },
}

// ─── plan_read 工具 ──────────────────────────────────────────────────────────

const planReadInputSchema = z.strictObject({
  id: z.string().describe('计划 ID'),
})

/**
 * plan_read — 读取指定计划
 *
 * 只读工具，plan 模式下可用
 */
export const PlanReadTool: ToolDef<typeof planReadInputSchema> = {
  name: 'plan_read',
  description: `读取指定计划的详细内容。

适用场景：
- 查看计划详情
- 确认计划内容后执行`,
  inputSchema: planReadInputSchema,
  readonly: true,
  planSafe: true,
  capabilities: { parallelSafe: true },

  describe(input) {
    return `读取计划：${input.id}`
  },

  async execute(input) {
    try {
      const plan = getPlan(input.id)
      if (!plan) {
        return {
          type: 'error',
          message: `计划 ${input.id} 不存在。请先调用 plan_list 查看可用计划。`,
        }
      }

      return {
        type: 'success',
        output: formatPlan(plan),
      }
    } catch (err) {
      return {
        type: 'error',
        message: `读取计划失败：${(err as Error).message}`,
      }
    }
  },
}

// ─── plan_status 工具 ────────────────────────────────────────────────────────

const planStatusInputSchema = z.strictObject({
  id:     z.string().describe('计划 ID'),
  status: z.enum(['draft', 'active', 'completed', 'archived']).describe('目标状态'),
})

/**
 * plan_status — 变更计划状态
 *
 * 支持状态流转：draft → active → completed → archived
 * plan 模式下可用（planSafe: true）
 */
export const PlanStatusTool: ToolDef<typeof planStatusInputSchema> = {
  name: 'plan_status',
  description: `变更计划状态。

状态流转：
- draft（草稿）→ active（进行中）→ completed（已完成）→ archived（已归档）

适用场景：
- 开始执行计划时设为 active
- 完成计划后设为 completed
- 归档旧计划`,
  inputSchema: planStatusInputSchema,
  readonly: false,
  planSafe: true,
  capabilities: { parallelSafe: false },

  describe(input) {
    return `变更计划 ${input.id} 状态为 ${input.status}`
  },

  async execute(input) {
    try {
      const plan = updatePlanStatus(input.id, input.status)
      if (!plan) {
        return {
          type: 'error',
          message: `计划 ${input.id} 不存在。请先调用 plan_list 查看可用计划。`,
        }
      }

      return {
        type: 'success',
        output: [
          `计划 ${plan.id} 状态已变更为：${plan.status}`,
          '',
          formatPlan(plan),
        ].join('\n'),
      }
    } catch (err) {
      return {
        type: 'error',
        message: `变更状态失败：${(err as Error).message}`,
      }
    }
  },
}

// ─── plan_archive 工具 ───────────────────────────────────────────────────────

const planArchiveInputSchema = z.strictObject({
  id: z.string().describe('计划 ID'),
})

/**
 * plan_archive — 归档计划
 *
 * 将计划状态设为 archived，plan 模式下可用（planSafe: true）
 */
export const PlanArchiveTool: ToolDef<typeof planArchiveInputSchema> = {
  name: 'plan_archive',
  description: `归档计划，将其状态设为 archived。

适用场景：
- 计划已完成或不再需要，归档以保持列表整洁`,
  inputSchema: planArchiveInputSchema,
  readonly: false,
  planSafe: true,
  capabilities: { parallelSafe: false },

  describe(input) {
    return `归档计划：${input.id}`
  },

  async execute(input) {
    try {
      const plan = archivePlan(input.id)
      if (!plan) {
        return {
          type: 'error',
          message: `计划 ${input.id} 不存在。请先调用 plan_list 查看可用计划。`,
        }
      }

      return {
        type: 'success',
        output: [
          `计划已归档：${plan.id}`,
          '',
          formatPlan(plan),
        ].join('\n'),
      }
    } catch (err) {
      return {
        type: 'error',
        message: `归档失败：${(err as Error).message}`,
      }
    }
  },
}

// ─── 批量注册 ────────────────────────────────────────────────────────────────

export const ALL_PLAN_TOOLS = [
  PlanCreateTool,
  PlanUpdateTool,
  PlanListTool,
  PlanReadTool,
  PlanStatusTool,
  PlanArchiveTool,
]
