import { describe, it, expect, beforeEach } from 'vitest'
import { CostTracker } from '../../src/core/CostTracker.js'

describe('CostTracker', () => {
  let tracker: CostTracker

  beforeEach(() => {
    tracker = new CostTracker('claude-sonnet-4-5')
  })

  it('初始成本为 0', () => {
    expect(tracker.getCostUsd()).toBe(0)
  })

  it('累加 token 用量', () => {
    tracker.add({ inputTokens: 1000, outputTokens: 500 })
    const usage = tracker.getUsage()
    expect(usage.inputTokens).toBe(1000)
    expect(usage.outputTokens).toBe(500)
  })

  it('正确计算 claude-sonnet-4-5 成本', () => {
    // claude-sonnet-4-5: input=$3/M, output=$15/M
    tracker.add({ inputTokens: 1_000_000, outputTokens: 1_000_000 })
    expect(tracker.getCostUsd()).toBeCloseTo(18, 4) // $3 + $15
  })

  it('未知模型成本为 0', () => {
    const t = new CostTracker('unknown-model-xyz')
    t.add({ inputTokens: 100000, outputTokens: 100000 })
    expect(t.getCostUsd()).toBe(0)
  })

  it('前缀匹配模型名（带日期后缀）', () => {
    const t = new CostTracker('claude-3-5-sonnet-20241022')
    t.add({ inputTokens: 1_000_000, outputTokens: 0 })
    expect(t.getCostUsd()).toBeCloseTo(3, 4)
  })

  it('reset 后成本归零', () => {
    tracker.add({ inputTokens: 1000, outputTokens: 1000 })
    tracker.reset()
    expect(tracker.getCostUsd()).toBe(0)
    expect(tracker.getUsage().inputTokens).toBe(0)
  })

  it('getSummary 包含 token 数和费用', () => {
    tracker.add({ inputTokens: 500, outputTokens: 200 })
    const summary = tracker.getSummary()
    expect(summary).toContain('500')
    expect(summary).toContain('200')
  })

  it('多次 add 正确累加', () => {
    tracker.add({ inputTokens: 100 })
    tracker.add({ inputTokens: 200, outputTokens: 50 })
    expect(tracker.getUsage().inputTokens).toBe(300)
    expect(tracker.getUsage().outputTokens).toBe(50)
  })
})
