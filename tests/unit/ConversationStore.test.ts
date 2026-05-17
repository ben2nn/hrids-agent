import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  ConversationStore,
  createUserEvent,
  createAssistantEvent,
  createToolEndEvent,
  createCompactEvent,
  createReqEndEvent,
} from '../../src/core/ConversationStore.js'
import {
  createUserMessageEvent,
  createAssistantMessageEvent,
} from '../../src/core/KernelEvent.js'

describe('ConversationStore - 事件工厂', () => {
  it('createUserEvent 创建正确结构', () => {
    const ev = createUserEvent('hello', 'req1', 'user', undefined, ['img.png'])
    expect(ev.type).toBe('user')
    expect(ev.content).toBe('hello')
    expect(ev.requestId).toBe('req1')
    expect(ev.trigger).toBe('user')
    expect(ev.images).toEqual(['img.png'])
    expect(ev.id).toBeTruthy()
    expect(ev.ts).toBeGreaterThan(0)
  })

  it('createUserEvent cron 触发', () => {
    const ev = createUserEvent('task', 'req1', 'cron', 'daily check')
    expect(ev.trigger).toBe('cron')
    expect(ev.cronDescription).toBe('daily check')
  })

  it('createAssistantEvent 创建正确结构', () => {
    const ev = createAssistantEvent('response', 'req1', undefined, 2)
    expect(ev.type).toBe('assistant')
    expect(ev.text).toBe('response')
    expect(ev.toolCount).toBe(2)
  })

  it('createAssistantEvent 无工具调用', () => {
    const ev = createAssistantEvent('text only')
    expect(ev.toolCount).toBeUndefined()
  })

  it('createToolEndEvent 创建正确结构', () => {
    const ev = createToolEndEvent('req1', 'tc1', 'bash', 100, 'ok', 'output preview')
    expect(ev.type).toBe('tool_end')
    expect(ev.toolCallId).toBe('tc1')
    expect(ev.toolName).toBe('bash')
    expect(ev.durationMs).toBe(100)
    expect(ev.status).toBe('ok')
    expect(ev.outputPreview).toBe('output preview')
  })

  it('createCompactEvent 创建正确结构', () => {
    const ev = createCompactEvent('summary text', 'req1')
    expect(ev.type).toBe('compact')
    expect(ev.summary).toBe('summary text')
  })

  it('createReqEndEvent 创建正确结构', () => {
    const ev = createReqEndEvent('req1', 'ok', 3, 5, 1000, 500, 200, 0.01)
    expect(ev.type).toBe('req_end')
    expect(ev.status).toBe('ok')
    expect(ev.totalTurns).toBe(3)
    expect(ev.totalToolCalls).toBe(5)
    expect(ev.durationMs).toBe(1000)
    expect(ev.inputTokens).toBe(500)
    expect(ev.outputTokens).toBe(200)
    expect(ev.costUsd).toBe(0.01)
  })

  it('createReqEndEvent 带错误状态', () => {
    const ev = createReqEndEvent('req1', 'err', 1, 0, 500)
    expect(ev.status).toBe('err')
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
    const s = new ConversationStore()
    s.appendEventsNoSave(createUserMessageEvent('test'))
    expect(s.getEventCount()).toBe(1)
  })

  it('replaceEvents 替换整个日志', () => {
    store.appendEvents(createUserMessageEvent('old'))
    const newEvents = [createUserMessageEvent('new1'), createUserMessageEvent('new2')]
    store.replaceEvents(newEvents)
    expect(store.getEventCount()).toBe(2)
  })

  it('clear 清空所有事件', () => {
    store.appendEvents(createUserMessageEvent('test'))
    store.clear()
    expect(store.getEventCount()).toBe(0)
  })
})

describe('ConversationStore - 持久化', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hrids-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('appendEvents 增量保存到磁盘', () => {
    const store = new ConversationStore(tmpDir)
    store.appendEvents(createUserMessageEvent('first'))
    store.appendEvents(createUserMessageEvent('second'))

    // 重新加载验证持久化
    const store2 = new ConversationStore()
    store2.loadFromDisk(tmpDir)
    expect(store2.getEventCount()).toBe(2)
  })

  it('loadFromDisk 加载事件', () => {
    const store = new ConversationStore(tmpDir)
    store.appendEvents(createUserMessageEvent('loaded'))

    const store2 = new ConversationStore()
    store2.loadFromDisk(tmpDir)
    expect(store2.getEventCount()).toBe(1)
  })

  it('appendMessage 增量保存消息到磁盘', () => {
    const store = new ConversationStore(tmpDir)
    store.appendMessage({ role: 'user', content: 'hello', timestamp: Date.now() })
    store.appendMessage({ role: 'assistant', content: 'hi', timestamp: Date.now() })

    const store2 = new ConversationStore()
    store2.loadFromDisk(tmpDir)
    expect(store2.getMessages()).toHaveLength(2)
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
