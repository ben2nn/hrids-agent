import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FallbackProvider, type FallbackStatusEvent } from '../../src/core/providers/FallbackProvider.js'
import type { LLMProvider, StreamChunk, ChatMessage } from '../../src/core/providers/types.js'
import type { ToolDef } from '../../src/core/Tool.js'
import { LlmError } from '../../src/core/LlmError.js'

// ── 测试工具 ──────────────────────────────────────────────────

const MSGS: ChatMessage[] = [{ role: 'user', content: 'hi' }]
const TOOLS: ToolDef[] = []
const SYS: string[] = []
const MAX_TOK = 1024

/** 创建一个 mock provider，可配置流式行为 */
function mockProvider(
  name: string,
  model: string,
  behavior: 'success' | 'error' | 'empty' | 'delayed-error' | { chunks: StreamChunk[] },
): LLMProvider & { callCount: number } {
  const p = {
    name,
    model,
    modelType: 'llm' as const,
    callCount: 0,
    async *stream(_msgs: ChatMessage[], _tools: ToolDef[], _sys: string[], _max: number, signal?: AbortSignal) {
      p.callCount++
      if (behavior === 'success') {
        yield { type: 'text_delta', delta: 'hello' } satisfies StreamChunk
        yield { type: 'done' } satisfies StreamChunk
      } else if (behavior === 'error') {
        throw new Error('provider failed')
      } else if (behavior === 'empty') {
        // 流结束但没有任何内容
        return
      } else if (behavior === 'delayed-error') {
        yield { type: 'text_delta', delta: 'partial' } satisfies StreamChunk
        throw new Error('mid-stream error')
      } else if (typeof behavior === 'object' && 'chunks' in behavior) {
        for (const c of behavior.chunks) yield c
      }
    },
  }
  return p
}

/** 消费异步生成器，返回所有 chunks */
async function consume(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const c of gen) chunks.push(c)
  return chunks
}

/** 消费并期望抛出错误 */
async function consumeAndThrow(gen: AsyncGenerator<StreamChunk>): Promise<never> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _c of gen) { /* drain */ }
  throw new Error('expected error but stream completed')
}

// ── 测试 ──────────────────────────────────────────────────────

describe('FallbackProvider', () => {

  // ── 基本构造 ──────────────────────────────────────────────

  it('空 providers 列表抛出错误', () => {
    expect(() => new FallbackProvider([])).toThrow('FallbackProvider 至少需要一个提供商')
  })

  it('单个 provider 时 name 和 model 直接反映', () => {
    const p = mockProvider('openai', 'gpt-4', 'success')
    const fb = new FallbackProvider([p])
    expect(fb.name).toContain('openai')
    expect(fb.model).toBe('gpt-4')
  })

  // ── 首选模型成功 ──────────────────────────────────────────

  it('首选模型成功时不降级', async () => {
    const primary = mockProvider('openai', 'gpt-4', 'success')
    const fallback = mockProvider('anthropic', 'claude', 'success')
    const fb = new FallbackProvider([primary, fallback])

    const chunks = await consume(fb.stream(MSGS, TOOLS, SYS, MAX_TOK))
    expect(chunks.some(c => c.type === 'text_delta')).toBe(true)
    expect(primary.callCount).toBe(1)
    expect(fallback.callCount).toBe(0)
  })

  // ── 首选模型失败 → 降级 ──────────────────────────────────

  it('首选模型不可重试错误时立即降级到下一个', async () => {
    const primary = mockProvider('openai', 'gpt-4', 'error')
    const fallback = mockProvider('anthropic', 'claude', 'success')
    // unknown 错误默认 retryable=true，需要不可重试的错误才能跳过重试
    // 使用 auth_error（不可重试）来模拟
    const pAuth: LLMProvider & { callCount: number } = {
      name: 'openai', model: 'gpt-4', modelType: 'llm', callCount: 0,
      async *stream() { pAuth.callCount++; throw new LlmError('auth_error', '401', false) },
    }
    const fb = new FallbackProvider([pAuth, fallback])

    const chunks = await consume(fb.stream(MSGS, TOOLS, SYS, MAX_TOK))
    expect(chunks.some(c => c.type === 'text_delta')).toBe(true)
    expect(pAuth.callCount).toBe(1)  // 不可重试，只调用一次
    expect(fallback.callCount).toBe(1)
  })

  it('首选模型可重试错误时先重试再降级', async () => {
    let callCount = 0
    const primary: LLMProvider = {
      name: 'openai', model: 'gpt-4', modelType: 'llm',
      async *stream() {
        callCount++
        throw new LlmError('rate_limited', '429 too many requests', true, 10) // 10ms retry-after
      },
    }
    const fallback = mockProvider('anthropic', 'claude', 'success')
    const fb = new FallbackProvider([primary, fallback])

    const chunks = await consume(fb.stream(MSGS, TOOLS, SYS, MAX_TOK))
    expect(chunks.some(c => c.type === 'text_delta')).toBe(true)
    expect(callCount).toBe(3)  // MAX_RETRIES=3
    expect(fallback.callCount).toBe(1)
  })

  // ── 位置记忆：核心修复验证 ────────────────────────────────

  it('fallback 成功后记住位置，下次直接从该模型开始', async () => {
    const primary = mockProvider('openai', 'gpt-4', 'error')
    // 用 auth_error 使 primary 不可重试，立即降级
    const pAuth: LLMProvider & { callCount: number } = {
      name: 'openai', model: 'gpt-4', modelType: 'llm', callCount: 0,
      async *stream() { pAuth.callCount++; throw new LlmError('auth_error', '401', false) },
    }
    const fallback = mockProvider('anthropic', 'claude', 'success')
    const fb = new FallbackProvider([pAuth, fallback])

    // 第一次调用：primary 失败 → fallback 成功
    await consume(fb.stream(MSGS, TOOLS, SYS, MAX_TOK))
    expect(pAuth.callCount).toBe(1)
    expect(fallback.callCount).toBe(1)

    // 第二次调用：应直接从 fallback 开始，不再尝试 primary
    await consume(fb.stream(MSGS, TOOLS, SYS, MAX_TOK))
    expect(pAuth.callCount).toBe(1)   // 没有再次调用
    expect(fallback.callCount).toBe(2) // 直接使用
  })

  it('记住的位置在 /model 手动切换后被覆盖', async () => {
    const p1: LLMProvider & { callCount: number } = {
      name: 'openai', model: 'gpt-4', modelType: 'llm', callCount: 0,
      async *stream() { p1.callCount++; throw new LlmError('auth_error', '401', false) },
    }
    const p2 = mockProvider('anthropic', 'claude', 'success')
    const fb = new FallbackProvider([p1, p2])

    // 第一次：p1 失败 → p2 成功 → 记住 p2
    await consume(fb.stream(MSGS, TOOLS, SYS, MAX_TOK))
    expect(p2.callCount).toBe(1)

    // 手动切回 p1
    fb.selectModel('gpt-4')

    // 第二次：应从 p1 开始（尽管它会失败）
    await consume(fb.stream(MSGS, TOOLS, SYS, MAX_TOK))
    expect(p1.callCount).toBe(2) // 手动切换后又尝试了 p1
  })

  // ── 空响应处理 ──────────────────────────────────────────

  it('模型返回空响应时自动降级到下一个', async () => {
    const primary = mockProvider('openai', 'gpt-4', 'empty')
    const fallback = mockProvider('anthropic', 'claude', 'success')
    const fb = new FallbackProvider([primary, fallback])

    const chunks = await consume(fb.stream(MSGS, TOOLS, SYS, MAX_TOK))
    expect(chunks.some(c => c.type === 'text_delta')).toBe(true)
    expect(primary.callCount).toBe(3)   // 空响应 retryable=true，重试 3 次
    expect(fallback.callCount).toBe(1)
  })

  // ── 中途出错已有内容 ────────────────────────────────────

  it('流中途出错且已有内容时直接抛出，不重试', async () => {
    const primary = mockProvider('openai', 'gpt-4', 'delayed-error')
    const fallback = mockProvider('anthropic', 'claude', 'success')
    const fb = new FallbackProvider([primary, fallback])

    await expect(consumeAndThrow(fb.stream(MSGS, TOOLS, SYS, MAX_TOK))).rejects.toThrow('mid-stream error')
    expect(primary.callCount).toBe(1)   // 已有内容，不重试
    expect(fallback.callCount).toBe(0)  // 也不降级
  })

  // ── 全部失败 ────────────────────────────────────────────

  it('所有模型均失败时抛出最后一个错误', async () => {
    const p1: LLMProvider = {
      name: 'a', model: 'm1', modelType: 'llm',
      async *stream() { throw new LlmError('auth_error', '401', false) },
    }
    const p2: LLMProvider = {
      name: 'b', model: 'm2', modelType: 'llm',
      async *stream() { throw new LlmError('auth_error', '403', false) },
    }
    const fb = new FallbackProvider([p1, p2])

    await expect(consumeAndThrow(fb.stream(MSGS, TOOLS, SYS, MAX_TOK))).rejects.toThrow('403')
  })

  // ── 平台分组 ────────────────────────────────────────────

  it('分组模式：组内顺序降级，组内全失败后跨组', async () => {
    const g1m1: LLMProvider & { callCount: number } = {
      name: 'aliyun', model: 'qwen-1', modelType: 'llm', callCount: 0,
      async *stream() { g1m1.callCount++; throw new LlmError('auth_error', '401', false) },
    }
    const g1m2: LLMProvider & { callCount: number } = {
      name: 'aliyun', model: 'qwen-2', modelType: 'llm', callCount: 0,
      async *stream() { g1m2.callCount++; throw new LlmError('auth_error', '401', false) },
    }
    const g2m1 = mockProvider('openai', 'gpt-4', 'success')

    const allProviders = [g1m1, g1m2, g2m1]
    const groups = [
      { platformName: 'aliyun', providers: [g1m1, g1m2] },
      { platformName: 'openai', providers: [g2m1] },
    ]
    const fb = new FallbackProvider(allProviders, groups)

    const chunks = await consume(fb.stream(MSGS, TOOLS, SYS, MAX_TOK))
    expect(chunks.some(c => c.type === 'text_delta')).toBe(true)
    expect(g1m1.callCount).toBe(1)
    expect(g1m2.callCount).toBe(1)
    expect(g2m1.callCount).toBe(1)
  })

  it('分组模式 fallback 成功后记住组索引和模型索引', async () => {
    const g1m1: LLMProvider & { callCount: number } = {
      name: 'aliyun', model: 'qwen-1', modelType: 'llm', callCount: 0,
      async *stream() { g1m1.callCount++; throw new LlmError('auth_error', '401', false) },
    }
    const g1m2: LLMProvider & { callCount: number } = {
      name: 'aliyun', model: 'qwen-2', modelType: 'llm', callCount: 0,
      async *stream() { g1m2.callCount++; throw new LlmError('auth_error', '401', false) },
    }
    const g2m1 = mockProvider('openai', 'gpt-4', 'success')

    const allProviders = [g1m1, g1m2, g2m1]
    const groups = [
      { platformName: 'aliyun', providers: [g1m1, g1m2] },
      { platformName: 'openai', providers: [g2m1] },
    ]
    const fb = new FallbackProvider(allProviders, groups)

    // 第一次：g1m1 失败 → g1m2 失败 → g2m1 成功
    await consume(fb.stream(MSGS, TOOLS, SYS, MAX_TOK))
    expect(g2m1.callCount).toBe(1)

    // 第二次：应直接从 g2m1 开始
    await consume(fb.stream(MSGS, TOOLS, SYS, MAX_TOK))
    expect(g1m1.callCount).toBe(1) // 没有再次调用
    expect(g1m2.callCount).toBe(1) // 没有再次调用
    expect(g2m1.callCount).toBe(2) // 直接使用
  })

  // ── selectModel ─────────────────────────────────────────

  it('selectModel 设置正确的位置', async () => {
    const p1 = mockProvider('a', 'm1', 'success')
    const p2 = mockProvider('b', 'm2', 'success')
    const fb = new FallbackProvider([p1, p2])

    fb.selectModel('m2')
    await consume(fb.stream(MSGS, TOOLS, SYS, MAX_TOK))
    expect(p1.callCount).toBe(0)
    expect(p2.callCount).toBe(1)
  })

  it('selectModel 支持 provider:model 格式', async () => {
    const p1 = mockProvider('a', 'm1', 'success')
    const p2 = mockProvider('b', 'm2', 'success')
    const fb = new FallbackProvider([p1, p2])

    expect(fb.selectModel('b:m2')).toBe(true)
    await consume(fb.stream(MSGS, TOOLS, SYS, MAX_TOK))
    expect(p2.callCount).toBe(1)
  })

  it('selectModel 找不到模型返回 false', () => {
    const p1 = mockProvider('a', 'm1', 'success')
    const fb = new FallbackProvider([p1])
    expect(fb.selectModel('nonexistent')).toBe(false)
  })

  // ── 状态回调 ────────────────────────────────────────────

  it('限流时发射 rate_limited 状态事件', async () => {
    const events: FallbackStatusEvent[] = []
    const primary: LLMProvider = {
      name: 'a', model: 'm1', modelType: 'llm',
      async *stream() { throw new LlmError('rate_limited', '429', true, 100) },
    }
    const fallback = mockProvider('b', 'm2', 'success')
    const fb = new FallbackProvider([primary, fallback], undefined, e => events.push(e))

    await consume(fb.stream(MSGS, TOOLS, SYS, MAX_TOK))
    expect(events.some(e => e.type === 'rate_limited')).toBe(true)
  })

  it('切换模型时发射 switching 状态事件', async () => {
    const events: FallbackStatusEvent[] = []
    const p1: LLMProvider = {
      name: 'a', model: 'm1', modelType: 'llm',
      async *stream() { throw new LlmError('auth_error', '401', false) },
    }
    const p2 = mockProvider('b', 'm2', 'success')
    const fb = new FallbackProvider([p1, p2], undefined, e => events.push(e))

    await consume(fb.stream(MSGS, TOOLS, SYS, MAX_TOK))
    const switching = events.find(e => e.type === 'switching')
    expect(switching).toBeDefined()
    expect(switching!.model).toBe('m2')
  })

  // ── AbortSignal ─────────────────────────────────────────

  it('已中止的 signal 立即返回', async () => {
    const p = mockProvider('a', 'm1', 'success')
    const fb = new FallbackProvider([p])
    const ac = new AbortController()
    ac.abort()

    const chunks = await consume(fb.stream(MSGS, TOOLS, SYS, MAX_TOK, ac.signal))
    expect(chunks).toHaveLength(0)
    expect(p.callCount).toBe(0)
  })

  // ── 位置记忆不污染同组其他模型 ──────────────────────────

  it('组内第二模型成功后记住的是该模型，不是组首', async () => {
    const g1m1: LLMProvider & { callCount: number } = {
      name: 'aliyun', model: 'qwen-1', modelType: 'llm', callCount: 0,
      async *stream() { g1m1.callCount++; throw new LlmError('auth_error', '401', false) },
    }
    const g1m2 = mockProvider('aliyun', 'qwen-2', 'success')

    const groups = [
      { platformName: 'aliyun', providers: [g1m1, g1m2] },
    ]
    const fb = new FallbackProvider([g1m1, g1m2], groups)

    // 第一次：g1m1 失败 → g1m2 成功
    await consume(fb.stream(MSGS, TOOLS, SYS, MAX_TOK))
    expect(fb.model).toBe('qwen-2')

    // 第二次：应从 g1m2 开始，跳过 g1m1
    await consume(fb.stream(MSGS, TOOLS, SYS, MAX_TOK))
    expect(g1m1.callCount).toBe(1) // 没有再次尝试
  })
})
