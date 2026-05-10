import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MessageBus } from '../../src/core/coordinator/MessageBus.js'

describe('MessageBus', () => {
  let bus: MessageBus

  beforeEach(() => {
    bus = new MessageBus()
  })

  it('注册智能体后可列出', () => {
    bus.register('agent-a')
    bus.register('agent-b')
    expect(bus.listAgents()).toEqual(['agent-a', 'agent-b'])
  })

  it('重复注册不报错', () => {
    bus.register('agent-a')
    bus.register('agent-a')
    expect(bus.listAgents()).toHaveLength(1)
  })

  it('注销智能体', () => {
    bus.register('agent-a')
    bus.unregister('agent-a')
    expect(bus.listAgents()).toHaveLength(0)
  })

  it('点对点发送和接收', () => {
    bus.register('agent-a')
    bus.register('agent-b')
    bus.send('agent-a', 'agent-b', 'hello')
    const msgs = bus.drain('agent-b')
    expect(msgs).toHaveLength(1)
    expect(msgs[0].content).toBe('hello')
    expect(msgs[0].from).toBe('agent-a')
    expect(msgs[0].to).toBe('agent-b')
  })

  it('drain 清空队列', () => {
    bus.register('agent-a')
    bus.register('agent-b')
    bus.send('agent-a', 'agent-b', 'msg1')
    bus.drain('agent-b')
    expect(bus.drain('agent-b')).toHaveLength(0)
  })

  it('广播消息发给所有其他智能体', () => {
    bus.register('agent-a')
    bus.register('agent-b')
    bus.register('agent-c')
    bus.send('agent-a', '*', 'broadcast')
    expect(bus.drain('agent-b')).toHaveLength(1)
    expect(bus.drain('agent-c')).toHaveLength(1)
    // 发送方自己不收到
    expect(bus.drain('agent-a')).toHaveLength(0)
  })

  it('发送给不存在的智能体丢弃', () => {
    bus.register('agent-a')
    bus.send('agent-a', 'nonexistent', 'msg')
    // 不报错
  })

  it('drain 空队列返回空数组', () => {
    bus.register('agent-a')
    expect(bus.drain('agent-a')).toEqual([])
  })

  it('waitForMessage 已有消息立即返回', async () => {
    bus.register('agent-a')
    bus.register('agent-b')
    bus.send('agent-b', 'agent-a', 'queued msg')
    const msg = await bus.waitForMessage('agent-a', 1000)
    expect(msg).not.toBeNull()
    expect(msg!.content).toBe('queued msg')
  })

  it('waitForMessage 无消息时超时返回 null', async () => {
    bus.register('agent-a')
    const msg = await bus.waitForMessage('agent-a', 50)
    expect(msg).toBeNull()
  })

  it('waitForMessage 新消息到达时立即返回', async () => {
    bus.register('agent-a')
    bus.register('agent-b')
    // 延迟发送
    setTimeout(() => bus.send('agent-b', 'agent-a', 'delayed'), 20)
    const msg = await bus.waitForMessage('agent-a', 2000)
    expect(msg).not.toBeNull()
    expect(msg!.content).toBe('delayed')
  })

  it('消息包含 id 和 timestamp', () => {
    bus.register('agent-a')
    bus.register('agent-b')
    bus.send('agent-a', 'agent-b', 'test')
    const msgs = bus.drain('agent-b')
    expect(msgs[0].id).toBeTruthy()
    expect(msgs[0].timestamp).toBeGreaterThan(0)
  })

  it('reset 清空所有数据', () => {
    bus.register('agent-a')
    bus.register('agent-b')
    bus.send('agent-a', 'agent-b', 'msg')
    bus.reset()
    expect(bus.listAgents()).toHaveLength(0)
  })
})
