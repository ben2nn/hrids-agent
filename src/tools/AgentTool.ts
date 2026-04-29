// 子智能体工具 —— 派生独立的子智能体执行子任务
import { z } from 'zod'
import { mkdirSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ToolDef } from '../core/Tool.js'
import { QueryEngine } from '../core/QueryEngine.js'
import { PermissionManager } from '../core/PermissionManager.js'
import { TeamManager } from '../core/coordinator/TeamManager.js'
import { runWithCwd, getGlobalCwd } from '../core/cwd.js'
import { getCurrentSessionId } from '../core/sessionContext.js'

// 懒加载记忆系统，读取全局记忆（跨会话共享）
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

// apiKey/model 参数保留签名兼容性，实际执行时优先从 TeamManager 继承配置
export function createAgentTool(_apiKey: string, _model: string): ToolDef<typeof inputSchema> {
  return {
    name: 'agent',
    description: '派生一个子智能体来执行独立的子任务。适合需要多步骤操作的复杂任务。',
    inputSchema,
    readonly: false,

    describe(input) {
      return `子智能体: ${input.description}`
    },

    async execute(input) {
      // 获取全局记忆快照，注入子智能体的 system prompt
      const memoryContext = await getMemoryContext()
      const systemPrompt = memoryContext
        ? `${SUB_AGENT_SYSTEM_PROMPT}\n\n${memoryContext}`
        : SUB_AGENT_SYSTEM_PROMPT

      // worktree 隔离：为子智能体创建独立的临时工作目录
      // 使用 runWithCwd 包裹，避免修改父上下文的 cwd（解决 CLI 模式并发竞争问题）
      const parentCwd = getGlobalCwd()
      const subCwd = (() => {
        if (input.isolated) {
          const safeDesc = input.description.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30)
          const dir = join(tmpdir(), `hrids-agent-worktree-${safeDesc}-${Date.now()}`)
          mkdirSync(dir, { recursive: true })
          return dir
        }
        return parentCwd
      })()

      // 从会话级（Gateway）或全局（CLI）TeamManager 继承 provider 和 tools
      const sessionId = getCurrentSessionId()
      const mgr = sessionId ? TeamManager.getForSession(sessionId) : TeamManager.get()

      if (!mgr) {
        return { type: 'error', message: '子智能体无法启动：TeamManager 未初始化' }
      }

      const allTools = mgr.getBaseTools()
      const tools = input.allowed_tools
        ? allTools.filter(t => input.allowed_tools!.includes(t.name))
        : allTools

      const permissions = new PermissionManager('craft', async () => true)
      const subEngine = new QueryEngine({
        provider: mgr.getProvider(),
        systemPrompt: memoryContext
          ? [`${SUB_AGENT_SYSTEM_PROMPT}\n\n${memoryContext}`]
          : [SUB_AGENT_SYSTEM_PROMPT],
        tools,
        permissions,
        maxTurns: 30,
      })

      let result = ''
      let hasError = false
      let worktreeDir: string | null = input.isolated ? subCwd : null

      try {
        // runWithCwd 创建独立的 AsyncLocalStorage 上下文，不影响父调用链的 cwd
        await runWithCwd(subCwd, async () => {
          for await (const event of subEngine.send(input.prompt)) {
            if (event.type === 'text_delta') {
              result += event.delta
            } else if (event.type === 'error') {
              hasError = true
              result += `\n错误: ${event.message}`
            }
          }
        })
      } catch (err) {
        return { type: 'error', message: `子智能体执行失败: ${String(err)}` }
      } finally {
        if (input.isolated && worktreeDir && existsSync(worktreeDir)) {
          try { rmSync(worktreeDir, { recursive: true, force: true }) } catch { /* 忽略清理失败 */ }
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
