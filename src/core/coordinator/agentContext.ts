// 智能体上下文 —— 通过 AsyncLocalStorage 传递当前智能体名称
// 替代 process.env.AGENT_NAME（进程级全局变量，多并发时互相覆盖）
import { AsyncLocalStorage } from 'async_hooks'

const agentNameStorage = new AsyncLocalStorage<string>()

/** 获取当前 AsyncLocalStorage 上下文中的智能体名称 */
export function getCurrentAgentName(): string | undefined {
  return agentNameStorage.getStore()
}

/** 在指定智能体名称的上下文中运行函数 */
export function runWithAgentName<T>(name: string, fn: () => T): T {
  return agentNameStorage.run(name, fn)
}
