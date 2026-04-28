// 智能体池 —— 管理并发运行的多个子智能体
import { QueryEngine } from '../QueryEngine.js'
import { PermissionManager } from '../PermissionManager.js'
import { MessageBus } from './MessageBus.js'
import type { LLMProvider } from '../providers/index.js'
import type { ToolDef } from '../Tool.js'

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
    // 没有可用槽位，挂起等待
    await new Promise<void>(resolve => this.queue.push(resolve))
  }

  release(): void {
    const next = this.queue.shift()
    if (next) {
      // 直接唤醒下一个等待者，不增减 permits
      next()
    } else {
      this.permits++
    }
  }
}

export type AgentStatus = 'pending' | 'running' | 'completed' | 'failed'

export interface AgentTask {
  id: string
  name: string          // 智能体名称（用于消息寻址）
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
  private bus: MessageBus
  private provider: LLMProvider
  private baseTools: ToolDef[]
  private semaphore: Semaphore
  // 所属会话 ID（Gateway 模式下用于获取会话级记忆，CLI 模式为 undefined）
  private sessionId: string | undefined

  constructor(
    provider: LLMProvider,
    baseTools: ToolDef[],
    maxConcurrent = 5,
    sessionId?: string,
  ) {
    this.provider = provider
    this.baseTools = baseTools
    this.semaphore = new Semaphore(maxConcurrent)
    this.bus = MessageBus.getInstance()
    this.sessionId = sessionId
  }

  // 提交一个新的智能体任务（立即返回任务 ID，后台运行）
  submit(
    name: string,
    description: string,
    prompt: string,
    systemPrompt: string,
    allowedTools?: string[],
  ): string {
    const id = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

    const tools = allowedTools
      ? this.baseTools.filter(t => allowedTools.includes(t.name))
      : this.baseTools

    const task: AgentTask = { id, name, description, prompt, status: 'pending' }
    this.tasks.set(id, task)
    this.bus.register(name)

    // 异步启动，不阻塞调用方
    // 注意：runTask 内部已有 finally 释放信号量，这里的 catch 只处理 acquire 之前的异常
    this.runTask(task, tools, systemPrompt).catch(err => {
      if (task.status === 'pending') {
        // acquire 之前就失败了，信号量未被占用，无需释放
        task.status = 'failed'
        task.error = String(err)
        task.completedAt = Date.now()
      }
    })

    return id
  }

  // 等待指定任务完成（用 Promise 轮询，间隔 200ms）
  async wait(id: string, timeoutMs = 300000): Promise<AgentTask> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const task = this.tasks.get(id)
      if (!task) throw new Error(`任务 ${id} 不存在`)
      if (task.status === 'completed' || task.status === 'failed') return task
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    throw new Error(`任务 ${id} 超时`)
  }

  // 等待所有任务完成
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

  // 中止指定任务
  abort(id: string) {
    const task = this.tasks.get(id)
    if (task?.engine) {
      task.engine.abort()
      task.status = 'failed'
      task.error = '已中止'
      task.completedAt = Date.now()
    }
  }

  private async runTask(task: AgentTask, tools: ToolDef[], systemPrompt: string) {
    // 用信号量获取并发槽位（无 CPU 消耗的等待，替代忙等待轮询）
    // 用 acquired 标志位防止 acquire 失败时 finally 中双重释放
    let acquired = false
    try {
      await this.semaphore.acquire()
      acquired = true
    } catch (err) {
      task.status = 'failed'
      task.error = `获取并发槽位失败: ${String(err)}`
      task.completedAt = Date.now()
      return
    }

    task.status = 'running'
    task.startedAt = Date.now()

    // 注入记忆快照（L0+L1）到子智能体 system prompt
    // 优先使用会话级记忆（Gateway 模式），CLI 模式回退到全局单例
    let finalSystemPrompt = systemPrompt
    try {
      const { getMemoryStack, getMemoryStackForSession } = await import('../../memory/index.js')
      const stack = this.sessionId ? getMemoryStackForSession(this.sessionId) : getMemoryStack()
      const stats = await stack.status()
      if (stats.totalMemories > 0) {
        const { l0Identity, l1Essential } = stack.wakeUp()
        finalSystemPrompt = `${systemPrompt}\n\n## 继承自父智能体的记忆上下文\n\n${l0Identity}\n\n${l1Essential}`
      }
    } catch { /* 记忆系统不可用时静默跳过 */ }

    const permissions = new PermissionManager('craft', async () => true)
    const engine = new QueryEngine({
      provider: this.provider,
      systemPrompt: finalSystemPrompt,
      tools,
      permissions,
      maxTurns: 30,
    })
    task.engine = engine

    let result = ''
    try {
      for await (const ev of engine.send(task.prompt)) {
        if (ev.type === 'text_delta') result += ev.delta
        else if (ev.type === 'error') {
          task.status = 'failed'
          task.error = ev.message
          task.completedAt = Date.now()
          this.bus.unregister(task.name)
          return
        }
      }
      task.result = result
      task.status = 'completed'
    } catch (err) {
      task.status = 'failed'
      task.error = String(err)
    } finally {
      task.completedAt = Date.now()
      this.bus.unregister(task.name)
      // 只有成功 acquire 后才释放，防止双重释放
      if (acquired) this.semaphore.release()
    }
  }
}
