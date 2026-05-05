import { describe, it, expect, vi } from 'vitest'
import { withRetry, withRetryStream } from '../../src/core/retry.js'

describe('withRetry', () => {
  it('成功时直接返回结果', async () => {
    const fn = vi.fn(async () => 42)
    expect(await withRetry(fn)).toBe(42)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('可重试错误时重试指定次数', async () => {
    let calls = 0
    const fn = async () => {
      calls++
      if (calls < 3) throw new Error('fetch failed')
      return 'ok'
    }
    const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 1 })
    expect(result).toBe('ok')
    expect(calls).toBe(3)
  })

  it('不可重试错误立即抛出', async () => {
    const fn = vi.fn(async () => { throw new Error('业务逻辑错误') })
    await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 1 })).rejects.toThrow('业务逻辑错误')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('超过最大次数后抛出最后一个错误', async () => {
    const fn = vi.fn(async () => { throw new Error('429 rate limit') })
    await expect(withRetry(fn, { maxAttempts: 2, baseDelayMs: 1 })).rejects.toThrow('429 rate limit')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('自定义 retryIf 控制重试条件', async () => {
    const fn = vi.fn(async () => { throw new Error('custom error') })
    // 自定义：所有错误都重试
    await expect(
      withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, retryIf: () => true })
    ).rejects.toThrow()
    expect(fn).toHaveBeenCalledTimes(3)
  })
})

describe('withRetryStream', () => {
  async function* successGen() {
    yield 1
    yield 2
    yield 3
  }

  it('成功时正常 yield 所有值', async () => {
    const results: number[] = []
    for await (const v of withRetryStream(() => successGen())) {
      results.push(v)
    }
    expect(results).toEqual([1, 2, 3])
  })

  it('失败时重试并最终成功', async () => {
    let attempt = 0
    async function* flakyGen() {
      attempt++
      if (attempt < 2) throw new Error('fetch failed')
      yield 'done'
    }
    const results: string[] = []
    for await (const v of withRetryStream(() => flakyGen(), { maxAttempts: 3, baseDelayMs: 1 })) {
      results.push(v)
    }
    expect(results).toEqual(['done'])
    expect(attempt).toBe(2)
  })
})
