// 智能体间消息总线 —— 支持点对点和广播通信

export interface AgentMessage {
  id: string
  from: string       // 发送方智能体名称
  to: string         // 接收方名称，'*' 表示广播
  content: string
  timestamp: number
}

type MessageHandler = (msg: AgentMessage) => void

export class MessageBus {
  private static instance: MessageBus
  // 每个智能体的消息队列
  private queues = new Map<string, AgentMessage[]>()
  // 实时订阅（用于 await 等待消息）
  private subscribers = new Map<string, MessageHandler[]>()

  static getInstance(): MessageBus {
    if (!MessageBus.instance) MessageBus.instance = new MessageBus()
    return MessageBus.instance
  }

  // 注册智能体，创建其消息队列
  register(agentName: string) {
    if (!this.queues.has(agentName)) {
      this.queues.set(agentName, [])
      this.subscribers.set(agentName, [])
    }
  }

  // 注销智能体
  unregister(agentName: string) {
    this.queues.delete(agentName)
    this.subscribers.delete(agentName)
  }

  // 发送消息
  send(from: string, to: string, content: string) {
    const msg: AgentMessage = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      from,
      to,
      content,
      timestamp: Date.now(),
    }

    if (to === '*') {
      // 广播：发给所有已注册的智能体（除自己）
      for (const [name] of this.queues) {
        if (name !== from) this.deliver(name, msg)
      }
    } else {
      this.deliver(to, msg)
    }
  }

  // 读取并清空消息队列
  drain(agentName: string): AgentMessage[] {
    const msgs = this.queues.get(agentName) ?? []
    this.queues.set(agentName, [])
    return msgs
  }

  // 等待下一条消息（带超时）
  waitForMessage(agentName: string, timeoutMs = 30000): Promise<AgentMessage | null> {
    return new Promise(resolve => {
      // 先检查队列中是否已有消息
      const existing = this.queues.get(agentName) ?? []
      if (existing.length > 0) {
        const msg = existing.shift()!
        this.queues.set(agentName, existing)
        resolve(msg)
        return
      }

      const timer = setTimeout(() => {
        const handlers = this.subscribers.get(agentName) ?? []
        const idx = handlers.indexOf(handler)
        if (idx >= 0) handlers.splice(idx, 1)
        resolve(null)
      }, timeoutMs)

      const handler: MessageHandler = (msg) => {
        clearTimeout(timer)
        resolve(msg)
      }

      const handlers = this.subscribers.get(agentName) ?? []
      handlers.push(handler)
      this.subscribers.set(agentName, handlers)
    })
  }

  listAgents(): string[] {
    return Array.from(this.queues.keys())
  }

  private deliver(to: string, msg: AgentMessage) {
    const queue = this.queues.get(to)
    if (!queue) return // 目标不存在，丢弃

    // 先触发实时订阅者
    const handlers = this.subscribers.get(to) ?? []
    if (handlers.length > 0) {
      const handler = handlers.shift()!
      this.subscribers.set(to, handlers)
      handler(msg)
    } else {
      // 没有等待者，放入队列
      queue.push(msg)
    }
  }

  // 重置（测试用）
  reset() {
    this.queues.clear()
    this.subscribers.clear()
  }
}
