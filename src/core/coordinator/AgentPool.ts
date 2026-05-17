// 智能体池 —— 管理并发运行的多个子智能体
import { QueryEngine } from '../QueryEngine.js'
import { ToolRegistry } from '../ToolRegistry.js'
import { PermissionManager } from '../PermissionManager.js'
import { MessageBus } from './MessageBus.js'
import { runWithAgentName } from './agentContext.js'
import { runWithSession } from '../sessionContext.js'
import { runWithCwd, getGlobalCwd } from '../cwd.js'
import type { LLMProvider } from '../providers/index.js'
import type { ToolDef } from '../Tool.js'
import type { AgentProfile } from '../Config.js'
import { loadConfig } from '../Config.js'

// 默认排除的子智能体工具（可被配置覆盖）
const DEFAULT_SUB_AGENT_EXCLUDED_TOOLS = new Set(['todo_write', 'todo_update', 'todo_append', 'todo_reset'])

/** 从配置或默认值获取工具排除列表 */
function getDeniedTools(): Set<string> {
  try {
    const config = loadConfig()
    if (config.toolPermissions?.defaultDenyList) {
      return new Set(config.toolPermissions.defaultDenyList)
    }
  } catch { /* 配置不可用，使用默认 */ }
  return DEFAULT_SUB_AGENT_EXCLUDED_TOOLS
}

/** 获取允许的工具列表 */
function filterToolsForAgent(
  baseTools: ToolDef[],
  allowedTools?: string[],
  deniedTools?: Set<string>,
): ToolDef[] {
  // 显式传入 allowedTools 时以它为准（最高优先级）
  if (allowedTools) {
    return baseTools.filter(t => allowedTools.includes(t.name))
  }
  const denied = deniedTools ?? getDeniedTools()
  return baseTools.filter(t => !denied.has(t.name))
}

// 信号量：替代忙等待轮询，用 Promise 队列实现无 CPU 消耗的并发控制
class Semaphore {
  private permits: number
  private queue: Array<() => void> = []

  constructor(permits: number) {
    this.permits = permits
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--
      return
    }
    await new Promise<void>(resolve => this.queue.push(resolve))
  }

  release(): void {
    const next = this.queue.shift()
    if (next) {
      next()
    } else {
      this.permits++
    }
  }
}

export type AgentStatus = 'pending' | 'running' | 'completed' | 'failed'

export interface AgentTask {
  id: string
  name: string
  description: string
  prompt: string
  status: AgentStatus
  result?: string
  error?: string
  startedAt?: number
  completedAt?: number
  engine?: QueryEngine
}

export class AgentPool {
  private tasks = new Map<string, AgentTask>()
  // Promise 通知：任务完成时 resolve 所有等待者，替代 200ms 轮询
  private taskResolvers = new Map<string, Array<(task: AgentTask) => void>>()
  private bus: MessageBus
  private provider: LLMProvider
  private baseTools: ToolDef[]
  private semaphore: Semaphore

  constructor(
    provider: LLMProvider,
    baseTools: ToolDef[],
    maxConcurrent = 5,
    bus: MessageBus,
  ) {
    this.provider = provider
    this.baseTools = baseTools
    this.semaphore = new Semaphore(maxConcurrent)
    this.bus = bus
  }

  submit(
    name: string,
    description: string,
    prompt: string,
    systemPrompt: string[],
    allowedTools?: string[],
    parentSessionId?: string,
    profile?: AgentProfile,
  ): string {
    const id = `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

    // 工具权限：显式传入 allowedTools > profile.allowedTools > 配置 denyList
    const effectiveAllowed = allowedTools ?? profile?.allowedTools
    const tools = filterToolsForAgent(this.baseTools, effectiveAllowed)

    const task: AgentTask = { id, name, description, prompt, status: 'pending' }
    this.tasks.set(id, task)
    this.bus.register(name)

    this.runTask(task, tools, systemPrompt, parentSessionId, profile).catch(err => {
      if (task.status === 'pending') {
        task.status = 'failed'
        task.error = String(err)
        task.completedAt = Date.now()
        this._notifyWaiters(task)
      }
    })

    return id
  }

  // 等待指定任务完成（Promise 通知，无轮询）
  async wait(id: string, timeoutMs = 300000): Promise<AgentTask> {
    const task = this.tasks.get(id)
    if (!task) throw new Error(`任务 ${id} 不存在`)
    if (task.status === 'completed' || task.status === 'failed') return task

    return new Promise<AgentTask>((resolve, reject) => {
      const timer = setTimeout(() => {
        const resolvers = this.taskResolvers.get(id) ?? []
        this.taskResolvers.set(id, resolvers.filter(r => r !== resolver))
        reject(new Error(`任务 ${id} 超时（${timeoutMs}ms）`))
      }, timeoutMs)

      const resolver = (t: AgentTask) => {
        clearTimeout(timer)
        resolve(t)
      }

      const resolvers = this.taskResolvers.get(id) ?? []
      resolvers.push(resolver)
      this.taskResolvers.set(id, resolvers)
    })
  }

  async waitAll(ids: string[], timeoutMs = 300000): Promise<AgentTask[]> {
    return Promise.all(ids.map(id => this.wait(id, timeoutMs)))
  }

  getTask(id: string): AgentTask | undefined {
    return this.tasks.get(id)
  }

  getTaskByName(name: string): AgentTask | undefined {
    return Array.from(this.tasks.values()).find(t => t.name === name)
  }

  listTasks(): AgentTask[] {
    return Array.from(this.tasks.values())
  }

  getRunningCount(): number {
    return Array.from(this.tasks.values()).filter(t => t.status === 'running').length
  }

  abort(id: string) {
    const task = this.tasks.get(id)
    if (task?.engine) {
      task.engine.abort()
      task.status = 'failed'
      task.error = '已中止'
      task.completedAt = Date.now()
      this._notifyWaiters(task)
    }
  }

  private _notifyWaiters(task: AgentTask) {
    const resolvers = this.taskResolvers.get(task.id) ?? []
    resolvers.forEach(r => r(task))
    this.taskResolvers.delete(task.id)
    // 任务完成后延迟 5 分钟清理，保留一段时间供查询（如 getTask / listTasks）
    if (task.status === 'completed' || task.status === 'failed') {
      setTimeout(() => {
        this.tasks.delete(task.id)
      }, 5 * 60 * 1000)
    }
  }

  private async runTask(task: AgentTask, tools: ToolDef[], systemPrompt: string[], parentSessionId?: string, profile?: AgentProfile) {
    let acquired = false
    try {
      await this.semaphore.acquire()
      acquired = true
    } catch (err) {
      task.status = 'failed'
      task.error = `获取并发槽位失败: ${String(err)}`
      task.completedAt = Date.now()
      this._notifyWaiters(task)
      return
    }

    task.status = 'running'
    task.startedAt = Date.now()

    // 注入记忆快照：优先使用父会话的会话级记忆，降级到全局记忆
    // 这样 Gateway 多会话场景下，子智能体继承的是正确的父会话记忆，而非其他用户的数据
    let finalSystemPrompt: string[] = [...systemPrompt]
    try {
      const { getMemoryStackForSession, getMemoryStack } = await import('../../memory/index.js')
      const stack = parentSessionId
        ? getMemoryStackForSession(parentSessionId)
        : getMemoryStack()
      const stats = await stack.status()
      if (stats.totalMemories > 0) {
        const { summary } = stack.wakeUp()
        finalSystemPrompt = [
          ...systemPrompt,
          `## 继承自父智能体的记忆上下文\n\n${summary}`,
        ]
      }
    } catch { /* 记忆系统不可用时静默跳过 */ }

    const permissions = new PermissionManager('craft', async () => true)
    const maxTurns = profile?.maxTurns ?? loadConfig().multiAgent?.defaultMaxTurns ?? 30
    const subRegistry = new ToolRegistry().registerAll(tools)
    const engine = new QueryEngine({
      provider: this.provider,
      systemPrompt: finalSystemPrompt,
      registry: subRegistry,
      permissions,
      maxTurns,
    })
    task.engine = engine

    // 为子智能体生成独立的 sessionId，避免 todo 等工具污染父会话状态
    // 使用 "ephemeral-" 前缀标记为临时会话，便于后续清理策略识别
    const subSessionId = `ephemeral-${task.id}`

    let result = ''
    try {
      // 获取父会话的 cwd，子智能体继承但在独立上下文中运行，避免 cd 命令污染父会话
      const parentCwd = getGlobalCwd()
      // runWithCwd：子智能体的 cd 命令只影响自己的上下文，不影响父会话
      // runWithAgentName：注入智能体名称，供 send_message 工具读取
      // runWithSession：独立 sessionId，避免 todo 等工具污染父会话状态
      await runWithCwd(parentCwd, () =>
        runWithAgentName(task.name, () =>
          runWithSession(subSessionId, async () => {
            for await (const ev of engine.run(task.prompt)) {
              if (ev.type === 'text_delta') result += ev.delta
              else if (ev.type === 'error') {
                task.status = 'failed'
                task.error = ev.message
                task.completedAt = Date.now()
                this.bus.unregister(task.name)
                this._notifyWaiters(task)
                return
              }
            }
          })
        )
      )
      task.result = result
      task.status = 'completed'
    } catch (err) {
      task.status = 'failed'
      task.error = String(err)
    } finally {
      task.completedAt = Date.now()
      this.bus.unregister(task.name)
      if (acquired) this.semaphore.release()
      this._notifyWaiters(task)
    }
  }
}
