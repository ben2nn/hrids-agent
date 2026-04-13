// 子智能体工具 —— 派生独立的子智能体执行子任务
import { z } from 'zod'
import { mkdirSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ToolDef } from '../core/Tool.js'
import { QueryEngine } from '../core/QueryEngine.js'
import { PermissionManager } from '../core/PermissionManager.js'
import { TeamManager } from '../core/coordinator/TeamManager.js'
import { setGlobalCwd, getGlobalCwd } from './BashTool.js'

// 懒加载记忆系统，避免未初始化时报错
async function getMemoryContext(): Promise<string> {
  try {
    const { getMemoryStack } = await import('../memory/index.js')
    const stack = getMemoryStack()
    const stats = await stack.status()
    if (stats.totalMemories === 0) return ''
    const { l0Identity, l1Essential } = stack.wakeUp()
    return `## 继承自父智能体的记忆上下文\n\n${l0Identity}\n\n${l1Essential}`
  } catch {
    return ''
  }
}

const inputSchema = z.object({
  description: z.string().describe('3-5 个词描述任务'),
  prompt: z.string().describe('给子智能体的完整任务指令'),
  allowed_tools: z.array(z.string()).optional().describe(
    '允许使用的工具列表，默认全部允许'
  ),
  isolated: z.boolean().optional().describe(
    '是否使用独立的临时工作目录（worktree 隔离），默认 false。并行任务建议设为 true 避免互相干扰'
  ),
})

const SUB_AGENT_SYSTEM_PROMPT = `你是一个专注的子智能体，负责完成分配给你的具体任务。
- 专注于完成任务，不要偏离主题
- 完成后输出清晰的结果摘要
- 如果遇到无法解决的问题，说明原因并返回已完成的部分`

export function createAgentTool(apiKey: string, model: string): ToolDef<typeof inputSchema> {
  return {
    name: 'agent',
    description: '派生一个子智能体来执行独立的子任务。适合需要多步骤操作的复杂任务。',
    inputSchema,
    readonly: false,

    describe(input) {
      return `子智能体: ${input.description}`
    },

    async execute(input) {
      // 获取记忆快照，注入子智能体的 system prompt
      const memoryContext = await getMemoryContext()
      const systemPrompt = memoryContext
        ? `${SUB_AGENT_SYSTEM_PROMPT}\n\n${memoryContext}`
        : SUB_AGENT_SYSTEM_PROMPT
      // worktree 隔离：为子智能体创建独立的临时工作目录
      const parentCwd = getGlobalCwd()
      let worktreeDir: string | null = null

      if (input.isolated) {
        const safeDesc = input.description.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30)
        worktreeDir = join(tmpdir(), `hrids-agent-worktree-${safeDesc}-${Date.now()}`)
        mkdirSync(worktreeDir, { recursive: true })
        // 切换到隔离目录（子智能体的 bash 工具会使用这个目录）
        setGlobalCwd(worktreeDir)
      }

      // 优先从全局 TeamManager 获取 provider 和 tools（继承父智能体配置）
      const mgr = TeamManager.get()

      let subEngine: QueryEngine

      if (mgr) {
        const allTools = mgr.getBaseTools()
        const tools = input.allowed_tools
          ? allTools.filter(t => input.allowed_tools!.includes(t.name))
          : allTools

        const permissions = new PermissionManager('auto', async () => true)
        subEngine = new QueryEngine({
          provider: mgr.getProvider(),
          systemPrompt,
          tools,
          permissions,
          maxTurns: 30,
        })
      } else {
        // 回退：使用传入的 apiKey/model
        const { createProvider } = await import('../core/providers/index.js')
        const { BashTool } = await import('./BashTool.js')
        const { FileReadTool } = await import('./FileReadTool.js')
        const { FileWriteTool } = await import('./FileWriteTool.js')
        const { FileEditTool } = await import('./FileEditTool.js')
        const { GlobTool } = await import('./GlobTool.js')
        const { GrepTool } = await import('./GrepTool.js')
        const { WebFetchTool } = await import('./WebFetchTool.js')
        const { TodoWriteTool, TodoReadTool } = await import('./TodoWriteTool.js')

        const allFallbackTools = [
          BashTool, FileReadTool, FileWriteTool, FileEditTool,
          GlobTool, GrepTool, WebFetchTool, TodoWriteTool, TodoReadTool,
        ]

        const provider = createProvider({ model, apiKey })
        const tools = input.allowed_tools
          ? allFallbackTools.filter(t => input.allowed_tools!.includes(t.name))
          : allFallbackTools

        const permissions = new PermissionManager('auto', async () => true)
        subEngine = new QueryEngine({
          provider,
          systemPrompt,
          tools,
          permissions,
          maxTurns: 30,
        })
      }

      let result = ''
      let hasError = false

      try {
        for await (const event of subEngine.send(input.prompt)) {
          if (event.type === 'text_delta') {
            result += event.delta
          } else if (event.type === 'error') {
            hasError = true
            result += `\n错误: ${event.message}`
          }
        }
      } catch (err) {
        return { type: 'error', message: `子智能体执行失败: ${String(err)}` }
      } finally {
        // 恢复父智能体的工作目录
        if (input.isolated) {
          setGlobalCwd(parentCwd)
          // 清理临时目录（可选，注释掉则保留供调试）
          if (worktreeDir && existsSync(worktreeDir)) {
            try { rmSync(worktreeDir, { recursive: true, force: true }) } catch { /* 忽略清理失败 */ }
          }
        }
      }

      const costSummary = subEngine.costs.getSummary()
      const worktreeNote = input.isolated ? `\n[隔离工作目录: ${worktreeDir}（已清理）]` : ''
      const output = `${result}\n\n[子智能体用量: ${costSummary}]${worktreeNote}`

      return hasError
        ? { type: 'error', message: output }
        : { type: 'success', output }
    },
  }
}
