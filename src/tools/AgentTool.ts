// 子智能体工具集
//
// 包含两套工具：
// 1. agent（阻塞式）—— 派生子智能体并等待完成，返回完整结果。
// 2. agent_spawn / agent_wait / agent_cancel / agent_list（非阻塞式）—— 使用 AgentPool，
//    spawn 立即返回 ID，wait 稍后获取结果。支持真正的并行执行。
//
// 两套工具共享 TeamManager 基础设施（provider、tools、memory）。

import { z } from 'zod'
import { mkdirSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ToolDef } from '../core/Tool.js'
import { QueryEngine } from '../core/QueryEngine.js'
import { ToolRegistry } from '../core/ToolRegistry.js'
import { PermissionManager } from '../core/PermissionManager.js'
import { TeamManager } from '../coordinator/TeamManager.js'
import { AgentPool } from '../coordinator/AgentPool.js'
import { runWithCwd, getGlobalCwd } from '../shared/cwd.js'
import { getCurrentSessionId, runWithSession } from '../core/sessionContext.js'
import { resolveProfile, resolveSystemPrompt } from '../coordinator/ProfileLoader.js'
import type { AgentProfile } from '../core/Config.js'
import { loadConfig } from '../core/Config.js'
import { getFileLeaseManager } from '../core/FileLeaseManager.js'

// 懒加载记忆系统
async function getMemoryContext(sessionId?: string): Promise<string> {
  try {
    const { getMemoryStackForSession, getMemoryStack } = await import('../memory/index.js')
    const stack = sessionId ? getMemoryStackForSession(sessionId) : getMemoryStack()
    const stats = await stack.status()
    if (stats.totalMemories === 0) return ''
    const { summary } = stack.wakeUp()
    return `## 继承自父智能体的记忆上下文\n\n${summary}`
  } catch {
    return ''
  }
}

const SUB_AGENT_SYSTEM_PROMPT = `你是一个专注的子智能体，负责完成分配给你的具体任务。
- 专注于完成任务，不要偏离主题
- 完成后输出清晰的结果摘要
- 如果遇到无法解决的问题，说明原因并返回已完成的部分`

// ── 共享辅助 ──────────────────────────────────────────────────────────────

/** 获取当前会话的 TeamManager（Gateway 模式用会话级，CLI 模式用全局单例） */
function getManager(): TeamManager | null {
  const sessionId = getCurrentSessionId()
  return sessionId ? TeamManager.getForSession(sessionId) : TeamManager.get()
}

/** 获取或创建 TeamManager 的默认 AgentPool（用于非阻塞 agent 工具） */
function getDefaultPool(mgr: TeamManager): AgentPool {
  // TeamManager 已有 bus，我们用一个隐藏的 "__default__" 团队作为默认池
  let team = mgr.getTeam('__default__')
  if (!team) {
    team = mgr.createTeam({ name: '__default__', maxConcurrent: 5 })
  }
  return team.pool
}

// ── agent（阻塞式）──────────────────────────────────────────────

const agentSchema = z.object({
  description: z.string().describe('3-5 个词描述任务'),
  prompt: z.string().describe('给子智能体的完整任务指令'),
  profile: z.string().optional().describe(
    '预定义的智能体角色名称（从 config.yaml 或 roles/ 中加载），传入后自动使用该角色的 systemPrompt/model/tools 配置'
  ),
  allowed_tools: z.array(z.string()).optional().describe(
    '允许使用的工具列表，默认从配置的 toolPermissions.defaultDenyList 排除'
  ),
  isolated: z.boolean().optional().describe(
    '是否使用独立的临时工作目录（worktree 隔离），默认 false。并行任务建议设为 true 避免互相干扰'
  ),
})

export function createAgentTool(): ToolDef<typeof agentSchema> {
  return {
    name: 'agent',
    description: `派生一个子智能体来执行独立的子任务（阻塞等待完成）。
适用场景：可独立执行的子任务（5+ 次工具调用）、需要并行处理多个独立工作
不适用场景：单次工具调用 → 直接调用 | 问候/闲聊 | 需要用户交互的任务`,
    inputSchema: agentSchema,
    readonly: false,
    capabilities: { parallelSafe: false },

    describe(input) {
      return `子智能体: ${input.description}`
    },

    async execute(input) {
      const sessionId = getCurrentSessionId()
      const mgr = getManager()
      if (!mgr) return { type: 'error', message: '子智能体无法启动：TeamManager 未初始化' }

      let profile: AgentProfile | undefined
      let profilePrompt = ''
      if (input.profile) {
        profile = resolveProfile(input.profile)
        if (profile) profilePrompt = resolveSystemPrompt(profile)
      }

      const memoryContext = await getMemoryContext(sessionId ?? undefined)
      const basePrompt = profilePrompt || SUB_AGENT_SYSTEM_PROMPT
      const systemPrompt = memoryContext ? `${basePrompt}\n\n${memoryContext}` : basePrompt

      const useIsolated = input.isolated ?? profile?.isolated ?? false
      const parentCwd = getGlobalCwd()
      const subCwd = (() => {
        if (useIsolated) {
          const safeDesc = input.description.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30)
          const dir = join(tmpdir(), `hrids-agent-worktree-${safeDesc}-${Date.now()}`)
          mkdirSync(dir, { recursive: true })
          return dir
        }
        return parentCwd
      })()

      const allTools = mgr.getBaseTools()
      const config = loadConfig()
      const deniedTools = new Set(config.toolPermissions?.defaultDenyList ?? ['todo_write', 'todo_update', 'todo_append', 'todo_reset'])
      const tools = input.allowed_tools?.length
        ? allTools.filter(t => input.allowed_tools!.includes(t.name))
        : profile?.allowedTools?.length
          ? allTools.filter(t => profile.allowedTools!.includes(t.name))
          : allTools.filter(t => !deniedTools.has(t.name))

      const maxTurns = profile?.maxTurns ?? 30
      const permissions = new PermissionManager('craft', async () => true)
      const subRegistry = new ToolRegistry().registerAll(tools)
      const subEngine = new QueryEngine({
        provider: mgr.getProvider(),
        systemPrompt: [systemPrompt],
        registry: subRegistry,
        permissions,
        maxTurns,
      })

      let result = ''
      let hasError = false
      const worktreeDir: string | null = useIsolated ? subCwd : null

      try {
        const { randomBytes } = await import('crypto')
        const subSessionId = `ephemeral-${input.profile ?? 'sub'}-${Date.now()}-${randomBytes(4).toString('hex')}`
        await runWithCwd(subCwd, () =>
          runWithSession(subSessionId, async () => {
            for await (const event of subEngine.run(input.prompt)) {
              if (event.type === 'text_delta') result += event.delta
              else if (event.type === 'error') { hasError = true; result += `\n错误: ${event.message}` }
            }
          })
        )
      } catch (err) {
        return { type: 'error', message: `子智能体执行失败: ${String(err)}` }
      } finally {
        if (useIsolated && worktreeDir && existsSync(worktreeDir)) {
          try { rmSync(worktreeDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
        }
      }

      const costSummary = subEngine.costs.getSummary()
      const worktreeNote = useIsolated ? `\n[隔离工作目录: ${worktreeDir}（已清理）]` : ''
      const output = `${result}\n\n[子智能体用量: ${costSummary}]${worktreeNote}`
      return hasError ? { type: 'error', message: output } : { type: 'success', output }
    },
  }
}

// ── agent_spawn（非阻塞）──────────────────────────────────────────────────

const spawnSchema = z.object({
  description: z.string().describe('3-5 个词描述任务'),
  prompt: z.string().describe('给子智能体的完整任务指令'),
  profile: z.string().optional().describe('预定义的智能体角色名称'),
  allowed_tools: z.array(z.string()).optional().describe('允许使用的工具列表'),
  isolated: z.boolean().optional().describe('是否使用独立临时工作目录（并行任务建议设为 true）'),
})

export function createAgentSpawnTool(): ToolDef<typeof spawnSchema> {
  return {
    name: 'agent_spawn',
    description: `启动一个后台子智能体执行独立任务，立即返回任务 ID（不等待完成）。
适用场景：可独立执行的子任务、需要并行处理多个独立工作
工作流：先用 agent_spawn 启动，再用 agent_wait 获取结果。可同时 spawn 多个。
不适用场景：单次工具调用 → 直接调用 | 问候/闲聊 | 需要用户交互的任务`,
    inputSchema: spawnSchema,
    readonly: false,
    capabilities: { parallelSafe: false },

    describe(input) {
      return `启动子智能体: ${input.description}`
    },

    async execute(input) {
      const sessionId = getCurrentSessionId()
      const mgr = getManager()
      if (!mgr) return { type: 'error', message: '子智能体无法启动：TeamManager 未初始化' }

      let profile: AgentProfile | undefined
      if (input.profile) profile = resolveProfile(input.profile) ?? undefined

      // 记忆注入由 AgentPool.runTask 统一处理，此处不重复注入
      const basePrompt = (profile ? resolveSystemPrompt(profile) : '') || SUB_AGENT_SYSTEM_PROMPT

      // 通过 AgentPool 提交非阻塞任务
      const pool = getDefaultPool(mgr)
      const taskId = pool.submit(
        'subagent',                    // agentName
        input.description,             // description
        input.prompt,                  // prompt
        [basePrompt],                  // systemPrompt
        input.allowed_tools,           // allowedTools
        sessionId ?? undefined,        // parentSessionId
        profile,                       // profile
      )

      return {
        type: 'success',
        output: `子智能体已启动\n任务 ID: ${taskId}\n描述: ${input.description}\n\n使用 agent_wait(task_id='${taskId}') 获取结果。可同时 spawn 多个任务。`,
      }
    },
  }
}

// ── agent_wait ────────────────────────────────────────────────────────────

const waitSchema = z.object({
  task_id: z.string().describe('要等待的任务 ID'),
  timeout_ms: z.number().optional().describe('等待超时（ms），默认 300000（5 分钟）'),
})

export function createAgentWaitTool(): ToolDef<typeof waitSchema> {
  return {
    name: 'agent_wait',
    description: '等待一个子智能体任务完成并返回结果。如果任务仍在运行，会阻塞等待。',
    inputSchema: waitSchema,
    readonly: true,
    capabilities: { parallelSafe: false },

    describe(input) {
      return `等待任务 ${input.task_id}`
    },

    async execute(input) {
      const mgr = getManager()
      if (!mgr) return { type: 'error', message: 'TeamManager 未初始化' }

      const pool = getDefaultPool(mgr)
      try {
        const task = await pool.wait(input.task_id, input.timeout_ms ?? 300_000)

        if (task.status === 'completed') {
          getFileLeaseManager().releaseAll(input.task_id)
          return { type: 'success', output: `[任务完成] ${task.description}\n\n${task.result ?? '(无结果)'}` }
        }
        if (task.status === 'failed') {
          getFileLeaseManager().releaseAll(input.task_id)
          return { type: 'error', message: `[任务失败] ${task.description}\n错误: ${task.error}` }
        }
        // pending / running（超时但仍在运行）
        return {
          type: 'success',
          output: `[任务仍在运行] ${task.description}\n状态: ${task.status}\n\n可以稍后再次调用 agent_wait 等待，或用 agent_cancel 取消。`,
        }
      } catch (err) {
        return { type: 'error', message: `等待任务失败: ${String(err)}` }
      }
    },
  }
}

// ── agent_cancel ──────────────────────────────────────────────────────────

const cancelSchema = z.object({
  task_id: z.string().describe('要取消的任务 ID'),
})

export function createAgentCancelTool(): ToolDef<typeof cancelSchema> {
  return {
    name: 'agent_cancel',
    description: '取消一个正在运行的子智能体任务。',
    inputSchema: cancelSchema,
    readonly: false,
    isDestructive: true,
    capabilities: { parallelSafe: false },

    describe(input) {
      return `取消任务 ${input.task_id}`
    },

    async execute(input) {
      const mgr = getManager()
      if (!mgr) return { type: 'error', message: 'TeamManager 未初始化' }

      const pool = getDefaultPool(mgr)
      const task = pool.getTask(input.task_id)
      if (!task) return { type: 'error', message: `任务 ${input.task_id} 不存在` }
      if (task.status === 'completed' || task.status === 'failed') {
        return { type: 'error', message: `任务 ${input.task_id} 已结束（${task.status}）` }
      }

      pool.abort(input.task_id)
      // 释放该任务持有的所有文件租约
      const released = getFileLeaseManager().releaseAll(input.task_id)
      const leaseNote = released > 0 ? `，已释放 ${released} 个文件租约` : ''
      return { type: 'success', output: `任务 ${input.task_id} 已取消${leaseNote}` }
    },
  }
}

// ── agent_list ────────────────────────────────────────────────────────────

const listSchema = z.object({
  status: z.enum(['pending', 'running', 'completed', 'failed']).optional().describe('按状态过滤'),
})

export function createAgentListTool(): ToolDef<typeof listSchema> {
  return {
    name: 'agent_list',
    description: '列出所有子智能体任务及其状态。',
    inputSchema: listSchema,
    readonly: true,
    capabilities: { parallelSafe: true },

    describe() {
      return '列出子智能体任务'
    },

    async execute(input) {
      const mgr = getManager()
      if (!mgr) return { type: 'error', message: 'TeamManager 未初始化' }

      const pool = getDefaultPool(mgr)
      let tasks = pool.listTasks()
      if (input.status) tasks = tasks.filter(t => t.status === input.status)

      if (tasks.length === 0) {
        return { type: 'success', output: '没有子智能体任务。' }
      }

      const formatTask = (t: typeof tasks[number]) => {
        const duration = t.completedAt
          ? `${((t.completedAt - (t.startedAt ?? 0)) / 1000).toFixed(1)}s`
          : t.startedAt
            ? `运行中 (${((Date.now() - t.startedAt) / 1000).toFixed(0)}s)`
            : '等待中'
        return `[${t.id}] ${t.status} | ${t.description} | ${duration}`
      }

      return {
        type: 'success',
        output: `子智能体任务列表（${tasks.length} 个）:\n${tasks.map(formatTask).join('\n')}`,
      }
    },
  }
}
