import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  ConversationStore,
  createUserMessageEvent,
  createAssistantMessageEvent,
  createToolResultEvent,
  createCompactEvent,
  createRequestCompleteEvent,
} from '../../src/core/ConversationStore.js'

describe('ConversationStore - 事件工厂', () => {
  it('createUserMessageEvent 创建正确结构', () => {
    const ev = createUserMessageEvent('hello', 'req1', 'user', undefined, ['img.png'])
    expect(ev.type).toBe('user_message')
    expect(ev.content).toBe('hello')
    expect(ev.requestId).toBe('req1')
    expect(ev.trigger).toBe('user')
    expect(ev.images).toEqual(['img.png'])
    expect(ev.id).toBeTruthy()
    expect(ev.timestamp).toBeGreaterThan(0)
  })

  it('createUserMessageEvent cron 触发', () => {
    const ev = createUserMessageEvent('task', 'req1', 'cron', 'daily check')
    expect(ev.trigger).toBe('cron')
    expect(ev.cronDescription).toBe('daily check')
  })

  it('createAssistantMessageEvent 创建正确结构', () => {
    const toolCalls = [{ id: 'tc1', name: 'bash', input: {} }]
    const ev = createAssistantMessageEvent('response', toolCalls, 'req1')
    expect(ev.type).toBe('assistant_message')
    expect(ev.text).toBe('response')
    expect(ev.toolCalls).toEqual(toolCalls)
  })

  it('createAssistantMessageEvent 无工具调用', () => {
    const ev = createAssistantMessageEvent('text only')
    expect(ev.toolCalls).toBeUndefined()
  })

  it('createToolResultEvent 创建正确结构', () => {
    const ev = createToolResultEvent('tc1', 'bash', 'output', false, 'req1')
    expect(ev.type).toBe('tool_result')
    expect(ev.toolCallId).toBe('tc1')
    expect(ev.toolName).toBe('bash')
    expect(ev.content).toBe('output')
    expect(ev.isError).toBe(false)
  })

  it('createCompactEvent 创建正确结构', () => {
    const ev = createCompactEvent('summary text', 'req1')
    expect(ev.type).toBe('compact')
    expect(ev.summary).toBe('summary text')
  })

  it('createRequestCompleteEvent 创建正确结构', () => {
    const ev = createRequestCompleteEvent('req1', 'completed', 3, 5, 1000, 500, 200, 0.01)
    expect(ev.type).toBe('request_complete')
    expect(ev.status).toBe('completed')
    expect(ev.totalTurns).toBe(3)
    expect(ev.totalToolCalls).toBe(5)
    expect(ev.durationMs).toBe(1000)
    expect(ev.inputTokens).toBe(500)
    expect(ev.outputTokens).toBe(200)
    expect(ev.costUsd).toBe(0.01)
  })

  it('createRequestCompleteEvent 带错误信息', () => {
    const ev = createRequestCompleteEvent('req1', 'error', 1, 0, 500, undefined, undefined, undefined, 'API failed')
    expect(ev.status).toBe('error')
    expect(ev.error).toBe('API failed')
  })
})

describe('ConversationStore - 基本操作', () => {
  let store: ConversationStore

  beforeEach(() => {
    store = new ConversationStore()
  })

  it('初始状态为空', () => {
    expect(store.getEventCount()).toBe(0)
    expect(store.getEventLog()).toEqual([])
  })

  it('appendEvents 添加事件', () => {
    const ev = createUserMessageEvent('hello')
    store.appendEvents(ev)
    expect(store.getEventCount()).toBe(1)
    expect(store.getEventLog()[0]).toBe(ev)
  })

  it('appendEvents 多个事件', () => {
    const ev1 = createUserMessageEvent('hello')
    const ev2 = createAssistantMessageEvent('hi')
    store.appendEvents(ev1, ev2)
    expect(store.getEventCount()).toBe(2)
  })

  it('appendEvents 空调用不报错', () => {
    store.appendEvents()
    expect(store.getEventCount()).toBe(0)
  })

  it('appendEventsNoSave 不持久化', () => {
    const mockStorage = { saveEvents: vi.fn(), loadEvents: vi.fn(() => []) }
    const s = new ConversationStore(mockStorage)
    s.appendEventsNoSave(createUserMessageEvent('test'))
    expect(mockStorage.saveEvents).not.toHaveBeenCalled()
    expect(s.getEventCount()).toBe(1)
  })

  it('replaceEvents 替换整个日志', () => {
    store.appendEvents(createUserMessageEvent('old'))
    const newEvents = [createUserMessageEvent('new1'), createUserMessageEvent('new2')]
    store.replaceEvents(newEvents)
    expect(store.getEventCount()).toBe(2)
    expect(store.getEventLog()[0].content).toBe('new1')
  })

  it('clear 清空所有事件', () => {
    store.appendEvents(createUserMessageEvent('test'))
    store.clear()
    expect(store.getEventCount()).toBe(0)
  })
})

describe('ConversationStore - 持久化', () => {
  it('appendEvents 调用 storage.saveEvents', () => {
    const mockStorage = { saveEvents: vi.fn(), loadEvents: vi.fn(() => []) }
    const store = new ConversationStore(mockStorage)
    store.appendEvents(createUserMessageEvent('test'))
    expect(mockStorage.saveEvents).toHaveBeenCalledOnce()
  })

  it('增量保存只保存新事件', () => {
    const mockStorage = { saveEvents: vi.fn(), loadEvents: vi.fn(() => []) }
    const store = new ConversationStore(mockStorage)
    store.appendEvents(createUserMessageEvent('first'))
    store.appendEvents(createUserMessageEvent('second'))
    // 第二次调用只包含第二个事件
    const secondCall = mockStorage.saveEvents.mock.calls[1]
    expect(secondCall[0]).toHaveLength(1)
    expect(secondCall[0][0].content).toBe('second')
  })

  it('loadFromDisk 加载事件', () => {
    const events = [createUserMessageEvent('loaded')]
    const mockStorage = { saveEvents: vi.fn(), loadEvents: vi.fn(() => events) }
    const store = new ConversationStore(mockStorage)
    store.loadFromDisk('/tmp/session')
    expect(store.getEventCount()).toBe(1)
    expect(store.getEventLog()[0].content).toBe('loaded')
  })
})

describe('ConversationStore - 预处理状态', () => {
  let store: ConversationStore

  beforeEach(() => {
    store = new ConversationStore()
  })

  it('latestPreprocessed 默认为 null', () => {
    expect(store.getLatestPreprocessed()).toBeNull()
  })

  it('setLatestPreprocessed 设置值', () => {
    const blocks = [{ type: 'text' as const, text: 'processed' }]
    store.setLatestPreprocessed(blocks)
    expect(store.getLatestPreprocessed()).toEqual(blocks)
  })

  it('markToolCallPruned / isToolCallPruned', () => {
    expect(store.isToolCallPruned('tc1')).toBe(false)
    store.markToolCallPruned('tc1')
    expect(store.isToolCallPruned('tc1')).toBe(true)
    expect(store.isToolCallPruned('tc2')).toBe(false)
  })
})
