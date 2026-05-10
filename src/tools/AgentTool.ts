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
import { getCurrentSessionId, runWithSession } from '../core/sessionContext.js'
import { resolveProfile, resolveSystemPrompt } from '../core/coordinator/ProfileLoader.js'
import type { AgentProfile } from '../core/Config.js'
import { loadConfig } from '../core/Config.js'

// 懒加载记忆系统，优先使用当前会话的会话级记忆，降级到全局记忆
// 与 AgentPool 保持一致的记忆获取策略
async function getMemoryContext(sessionId?: string): Promise<string> {
  try {
    const { getMemoryStackForSession, getMemoryStack } = await import('../memory/index.js')
    const stack = sessionId
      ? getMemoryStackForSession(sessionId)
      : getMemoryStack()
    const stats = await stack.status()
    if (stats.totalMemories === 0) return ''
    const { summary } = stack.wakeUp()
    return `## 继承自父智能体的记忆上下文\n\n${summary}`
  } catch {
    return ''
  }
}

const inputSchema = z.object({
  description: z.string().describe('3-5 个词描述任务'),
  prompt: z.string().describe('给子智能体的完整任务指令'),
  profile: z.string().optional().describe(
    '预定义的智能体角色名称（从 config.yaml 或 agents.d/ 中加载），传入后自动使用该角色的 systemPrompt/model/tools 配置'
  ),
  allowed_tools: z.array(z.string()).optional().describe(
    '允许使用的工具列表，默认从配置的 toolPermissions.defaultDenyList 排除'
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
    description: `派生一个子智能体来执行独立的子任务。
适用场景：可独立执行的子任务（5+ 次工具调用）、需要并行处理多个独立工作
不适用场景：单次工具调用 → 直接调用 | 问候/闲聊 | 需要用户交互的任务`,
    inputSchema,
    readonly: false,

    describe(input) {
      return `子智能体: ${input.description}`
    },

    async execute(input) {
      // 从会话级（Gateway）或全局（CLI）TeamManager 继承 provider 和 tools
      const sessionId = getCurrentSessionId()
      const mgr = sessionId ? TeamManager.getForSession(sessionId) : TeamManager.get()

      if (!mgr) {
        return { type: 'error', message: '子智能体无法启动：TeamManager 未初始化' }
      }

      // 解析 profile（传入则从 ProfileLoader 加载预设角色）
      let profile: AgentProfile | undefined
      let profilePrompt = ''
      if (input.profile) {
        profile = resolveProfile(input.profile)
        if (profile) {
          profilePrompt = resolveSystemPrompt(profile)
        }
      }

      // 获取记忆快照，优先使用当前会话的会话级记忆（与 AgentPool 保持一致）
      const memoryContext = await getMemoryContext(sessionId ?? undefined)
      const basePrompt = profilePrompt || SUB_AGENT_SYSTEM_PROMPT
      const systemPrompt = memoryContext
        ? `${basePrompt}\n\n${memoryContext}`
        : basePrompt

      // 隔离目录：profile 默认值可被 input.isolated 覆盖
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

      // 工具过滤：配置驱动的 denyList（与 AgentPool.filterToolsForAgent 一致）
      const allTools = mgr.getBaseTools()
      const config = loadConfig()
      const deniedTools = new Set(config.toolPermissions?.defaultDenyList ?? ['todo_write', 'todo_update', 'todo_append', 'todo_reset'])
      const tools = input.allowed_tools
        ? allTools.filter(t => input.allowed_tools!.includes(t.name))
        : profile?.allowedTools
          ? allTools.filter(t => profile.allowedTools!.includes(t.name))
          : allTools.filter(t => !deniedTools.has(t.name))

      const maxTurns = profile?.maxTurns ?? 30
      const permissions = new PermissionManager('craft', async () => true)
      const subEngine = new QueryEngine({
        provider: mgr.getProvider(),
        systemPrompt: [systemPrompt],
        tools,
        permissions,
        maxTurns,
      })

      let result = ''
      let hasError = false
      const worktreeDir: string | null = useIsolated ? subCwd : null

      try {
        // runWithCwd 创建独立的 AsyncLocalStorage 上下文，不影响父调用链的 cwd
        // runWithSession 给子智能体独立的 sessionId，避免 todo 等工具污染父会话状态
        const subSessionId = `ephemeral-${input.profile ?? 'sub'}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
        await runWithCwd(subCwd, () =>
          runWithSession(subSessionId, async () => {
            for await (const event of subEngine.send(input.prompt)) {
              if (event.type === 'text_delta') {
                result += event.delta
              } else if (event.type === 'error') {
                hasError = true
                result += `\n错误: ${event.message}`
              }
            }
          })
        )
      } catch (err) {
        return { type: 'error', message: `子智能体执行失败: ${String(err)}` }
      } finally {
        if (useIsolated && worktreeDir && existsSync(worktreeDir)) {
          try { rmSync(worktreeDir, { recursive: true, force: true }) } catch { /* 忽略清理失败 */ }
        }
      }

      const costSummary = subEngine.costs.getSummary()
      const worktreeNote = useIsolated ? `\n[隔离工作目录: ${worktreeDir}（已清理）]` : ''
      const output = `${result}\n\n[子智能体用量: ${costSummary}]${worktreeNote}`

      return hasError
        ? { type: 'error', message: output }
        : { type: 'success', output }
    },
  }
}
