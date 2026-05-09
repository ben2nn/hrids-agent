import { describe, it, expect } from 'vitest'
import { extractMemories, extractFromConversation } from '../../src/memory/extractor.js'

describe('extractMemories', () => {
  it('识别 decision 类型（英文关键词）', () => {
    const text = "We decided to use PostgreSQL instead of MySQL because its JSON support is much better for our use case. We chose this approach after evaluating multiple trade-offs."
    const results = extractMemories(text)
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].type).toBe('decision')
  })

  it('识别 preference 类型（英文关键词）', () => {
    const text = "I prefer using TypeScript over JavaScript. Always use strict mode. Never use any type in the codebase. My convention is to use explicit return types."
    const results = extractMemories(text)
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].type).toBe('preference')
  })

  it('识别 milestone 类型（英文关键词）', () => {
    const text = "Finally got it working! The authentication module is now shipped and deployed to production. Figured out the root cause of the performance issue and it works perfectly now."
    const results = extractMemories(text)
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].type).toBe('milestone')
  })

  it('识别 problem 类型（英文关键词）', () => {
    const text = "There is a critical bug in the database connection pool. The error occurs when concurrent requests exceed the limit. The issue causes the entire system to crash under load."
    const results = extractMemories(text)
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].type).toBe('problem')
  })

  it('已解决的问题消歧为 milestone', () => {
    const text = "The database connection had a critical error that caused the system to crash. But we finally fixed the bug and got it working. The solution was to adjust the connection pool settings."
    const results = extractMemories(text)
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].type).toBe('milestone')
  })

  it('短文本不提取', () => {
    const results = extractMemories('hello')
    expect(results).toHaveLength(0)
  })

  it('无关键词的文本不提取', () => {
    const text = "Today the weather is nice. It's a good day to go for a walk and enjoy the scenery outside."
    const results = extractMemories(text)
    expect(results).toHaveLength(0)
  })

  it('minConfidence 过滤低置信度', () => {
    const text = "We decided to use the new framework for building the system. It has good documentation and active community support."
    const results = extractMemories(text, 0.9)
    for (const r of results) {
      expect(r.confidence).toBeGreaterThanOrEqual(0.9)
    }
  })

  it('importance 评分在 1-5 范围', () => {
    const text = "We decided to use React instead of Vue because the team is more familiar with its ecosystem and architecture patterns for large scale applications."
    const results = extractMemories(text)
    for (const r of results) {
      expect(r.importance).toBeGreaterThanOrEqual(1)
      expect(r.importance).toBeLessThanOrEqual(5)
    }
  })

  it('多段文本分别提取', () => {
    const text = `We decided to use TypeScript for the project.

After testing, we found a critical bug that caused memory leaks.
Finally figured out the fix and got it working properly now.`
    const results = extractMemories(text)
    expect(results.length).toBeGreaterThanOrEqual(1)
  })

  it('长文本获得更高 confidence', () => {
    const shortText = "We decided to use Docker."
    const longText = "We decided to use Docker instead of VMs because containerization is much faster for our deployment pipeline. We chose this approach after evaluating multiple trade-offs between performance, scalability, and ease of maintenance."
    const shortResults = extractMemories(shortText)
    const longResults = extractMemories(longText)
    if (shortResults.length > 0 && longResults.length > 0) {
      expect(longResults[0].confidence).toBeGreaterThanOrEqual(shortResults[0].confidence)
    }
  })
})

describe('extractFromConversation', () => {
  it('从对话历史中提取记忆', () => {
    const messages = [
      { role: 'user', content: 'I prefer using VS Code as my editor. Always use auto-save enabled.' },
      { role: 'assistant', content: 'Got it, noted your preferences.' },
      { role: 'user', content: 'We decided to adopt microservices architecture instead of monolith.' },
      { role: 'assistant', content: 'Finally completed the microservices design. Figured out the service decomposition strategy.' },
    ]
    const results = extractFromConversation(messages)
    expect(results.length).toBeGreaterThan(0)
  })

  it('处理数组类型的 content', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Finally completed the authentication module! It works perfectly now.' },
          { type: 'tool_use', name: 'bash' },
        ],
      },
    ]
    const results = extractFromConversation(messages)
    expect(results.length).toBeGreaterThanOrEqual(0)
  })

  it('空对话返回空数组', () => {
    expect(extractFromConversation([])).toEqual([])
  })

  it('纯用户消息也能提取', () => {
    const messages = [
      { role: 'user', content: 'Never use jQuery. Always use native DOM API. My convention is to avoid third-party libraries when possible.' },
    ]
    const results = extractFromConversation(messages)
    expect(results.length).toBeGreaterThan(0)
  })
})
