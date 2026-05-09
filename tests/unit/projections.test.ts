import { describe, it, expect } from 'vitest'
import {
  projectForDisplay,
  projectForLLM,
  applyToolResultBudget,
  pruneOldToolResults,
  pruneOldImageBlocks,
  estimateEventTokens,
} from '../../src/core/projections.js'
import type { ConversationEvent } from '../../src/core/ConversationStore.js'

// 辅助函数：创建测试事件
function makeUserEvent(content: string, ts = 1000): ConversationEvent {
  return { type: 'user_message', id: `u-${ts}`, timestamp: ts, content }
}
function makeAssistantEvent(text: string, toolCalls?: Array<{ id: string; name: string; input: unknown }>, ts = 2000): ConversationEvent {
  return { type: 'assistant_message', id: `a-${ts}`, timestamp: ts, text, toolCalls }
}
function makeToolResultEvent(toolCallId: string, content: string, isError = false, ts = 3000): ConversationEvent {
  return { type: 'tool_result', id: `tr-${ts}`, timestamp: ts, toolCallId, toolName: 'test', content, isError }
}
function makeCompactEvent(summary: string, ts = 4000): ConversationEvent {
  return { type: 'compact', id: `c-${ts}`, timestamp: ts, summary }
}

describe('projectForDisplay', () => {
  it('用户消息生成 user 气泡', () => {
    const events = [makeUserEvent('hello')]
    const result = projectForDisplay(events)
    expect(result).toHaveLength(1)
    expect(result[0].role).toBe('user')
    expect(result[0].content).toBe('hello')
  })

  it('助手消息生成 assistant 气泡', () => {
    const events = [makeAssistantEvent('hi there')]
    const result = projectForDisplay(events)
    expect(result).toHaveLength(1)
    expect(result[0].role).toBe('assistant')
    expect(result[0].content).toBe('hi there')
  })

  it('助手空文本不生成气泡', () => {
    const events = [makeAssistantEvent('')]
    const result = projectForDisplay(events)
    expect(result).toHaveLength(0)
  })

  it('助手工具调用生成工具卡片', () => {
    const events = [
      makeAssistantEvent('text', [{ id: 'tc1', name: 'bash', input: { command: 'ls' } }]),
      makeToolResultEvent('tc1', 'file1.txt\nfile2.txt'),
    ]
    const result = projectForDisplay(events)
    // 1 文本气泡 + 1 工具卡片
    expect(result).toHaveLength(2)
    const toolCard = result.find(m => m.toolCards && m.toolCards.length > 0)
    expect(toolCard).toBeDefined()
    expect(toolCard!.toolCards![0].name).toBe('bash')
    expect(toolCard!.toolCards![0].status).toBe('success')
  })

  it('工具错误状态正确标记', () => {
    const events = [
      makeAssistantEvent('', [{ id: 'tc1', name: 'bash', input: {} }]),
      makeToolResultEvent('tc1', 'error msg', true),
    ]
    const result = projectForDisplay(events)
    const toolCard = result.find(m => m.toolCards && m.toolCards.length > 0)
    expect(toolCard!.toolCards![0].status).toBe('error')
  })

  it('compact 事件生成上下文压缩消息对', () => {
    const events = [makeCompactEvent('之前的对话摘要')]
    const result = projectForDisplay(events)
    expect(result).toHaveLength(2)
    expect(result[0].role).toBe('user')
    expect(result[0].content).toContain('上下文压缩')
    expect(result[1].role).toBe('assistant')
  })

  it('tool_result 事件不直接生成展示消息', () => {
    const events = [makeToolResultEvent('tc1', 'output')]
    const result = projectForDisplay(events)
    expect(result).toHaveLength(0)
  })

  it('cron 触发的用户消息标记 isCron', () => {
    const event: ConversationEvent = {
      type: 'user_message', id: 'u1', timestamp: 1000,
      content: 'cron task', trigger: 'cron', cronDescription: 'daily check',
    }
    const result = projectForDisplay([event])
    expect(result[0].isCron).toBe(true)
    expect(result[0].cronDescription).toBe('daily check')
  })
})

describe('projectForLLM', () => {
  it('用户消息投影为 user role', () => {
    const events = [makeUserEvent('hello')]
    const result = projectForLLM(events)
    expect(result).toHaveLength(1)
    expect(result[0].role).toBe('user')
    expect(result[0].content).toBe('hello')
  })

  it('助手消息投影为 assistant role', () => {
    const events = [makeAssistantEvent('response')]
    const result = projectForLLM(events)
    expect(result).toHaveLength(1)
    expect(result[0].role).toBe('assistant')
  })

  it('工具调用和结果正确配对', () => {
    const events = [
      makeUserEvent('do something'),
      makeAssistantEvent('', [{ id: 'tc1', name: 'bash', input: { command: 'ls' } }]),
      makeToolResultEvent('tc1', 'output'),
    ]
    const result = projectForLLM(events)
    // user + assistant(tool_use) + user(tool_result)
    expect(result).toHaveLength(3)
    expect(result[2].role).toBe('user')
  })

  it('compact 事件截断之前的事件', () => {
    const events = [
      makeUserEvent('old message', 1000),
      makeAssistantEvent('old response', undefined, 2000),
      makeCompactEvent('摘要', 3000),
      makeUserEvent('new message', 4000),
    ]
    const result = projectForLLM(events)
    // compact 注入 (2) + new user (1)
    expect(result).toHaveLength(3)
    expect(result[0].content).toContain('上下文压缩')
    expect(result[2].content).toBe('new message')
  })

  it('被 prune 的 tool_use 跳过投影', () => {
    const events = [
      makeUserEvent('do something'),
      makeAssistantEvent('', [{ id: 'tc1', name: 'bash', input: {} }]),
      makeToolResultEvent('tc1', 'output'),
    ]
    const result = projectForLLM(events, { prunedToolCallIds: new Set(['tc1']) })
    // user + assistant (空，tool_use 被跳过) + tool_result 被跳过
    // assistant 因 content 为空不生成
    expect(result).toHaveLength(1)
  })

  it('最新用户消息使用预处理版本', () => {
    const events = [makeUserEvent('original text')]
    const preprocessed = [{ type: 'text' as const, text: 'processed text' }]
    const result = projectForLLM(events, { latestPreprocessed: preprocessed })
    expect(result[0].content).toEqual(preprocessed)
  })
})

describe('applyToolResultBudget', () => {
  it('未超预算的消息不变', () => {
    const messages = [{
      role: 'user' as const,
      content: [{ type: 'tool_result' as const, tool_use_id: 'tc1', content: 'short', is_error: false }],
    }]
    const { messages: result, prunedIds } = applyToolResultBudget(messages)
    expect(result).toEqual(messages)
    expect(prunedIds.size).toBe(0)
  })

  it('单条过大的 tool_result 被截断', () => {
    const bigContent = 'x'.repeat(15000)
    const messages = [{
      role: 'user' as const,
      content: [{ type: 'tool_result' as const, tool_use_id: 'tc1', content: bigContent, is_error: false }],
    }]
    const { messages: result } = applyToolResultBudget(messages)
    const block = (result[0].content as Array<{ type: string; content: string }>)[0]
    expect(block.content.length).toBeLessThan(bigContent.length)
    expect(block.content).toContain('已截断')
  })
})

describe('pruneOldToolResults', () => {
  it('保护最近的消息不被 prune', () => {
    const messages = [{
      role: 'user' as const,
      content: [{ type: 'tool_result' as const, tool_use_id: 'tc1', content: 'x'.repeat(1000), is_error: false }],
    }]
    const { prunedIds } = pruneOldToolResults(messages, 10)
    expect(prunedIds.size).toBe(0)
  })

  it('旧的大的 tool_result 被替换为占位符', () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({
      role: 'user' as const,
      content: [{ type: 'tool_result' as const, tool_use_id: `tc${i}`, content: 'x'.repeat(1000), is_error: false }],
    }))
    const { messages: result, prunedIds } = pruneOldToolResults(messages, 5)
    expect(prunedIds.size).toBeGreaterThan(0)
    // 最后 5 条不应被 prune
    const lastMsg = result[result.length - 1]
    const lastBlock = (lastMsg.content as Array<{ type: string; content: string }>)[0]
    expect(lastBlock.content).not.toContain('已清除')
  })
})

describe('pruneOldImageBlocks', () => {
  it('保护最近的图片不被替换', () => {
    const messages = [{
      role: 'user' as const,
      content: [{ type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'abc' } }],
    }]
    const result = pruneOldImageBlocks(messages, 10)
    expect(result).toEqual(messages)
  })

  it('旧图片被替换为文字占位符', () => {
    const messages = Array.from({ length: 20 }, () => ({
      role: 'user' as const,
      content: [{ type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'abc' } }],
    }))
    const result = pruneOldImageBlocks(messages, 3)
    const oldBlock = (result[0].content as Array<{ type: string; text?: string }>)[0]
    expect(oldBlock.type).toBe('text')
    expect(oldBlock.text).toContain('图片已从上下文中移除')
  })
})

describe('estimateEventTokens', () => {
  it('用户消息估算 token', () => {
    const events = [makeUserEvent('hello world')]
    const tokens = estimateEventTokens(events)
    expect(tokens).toBeGreaterThan(0)
  })

  it('助手消息含工具调用估算', () => {
    const events = [makeAssistantEvent('text', [{ id: 'tc1', name: 'bash', input: { command: 'ls' } }])]
    const tokens = estimateEventTokens(events)
    expect(tokens).toBeGreaterThan(0)
  })

  it('空事件返回 0', () => {
    expect(estimateEventTokens([])).toBe(0)
  })

  it('compact 事件摘要计入估算', () => {
    const events = [makeCompactEvent('这是一段摘要文本')]
    const tokens = estimateEventTokens(events)
    expect(tokens).toBeGreaterThan(0)
  })
})
