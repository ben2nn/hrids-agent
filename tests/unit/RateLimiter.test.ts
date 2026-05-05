import { describe, it, expect, vi, afterEach } from 'vitest'

// 直接测试 RateLimiter 逻辑（从 server.ts 提取为可测试单元）
class RateLimiter {
  private counts = new Map<string, { count: number; resetAt: number }>()
  constructor(private limit: number, private windowMs = 60_000) {}

  check(ip: string): boolean {
    const now = Date.now()
    const entry = this.counts.get(ip)
    if (!entry || now > entry.resetAt) {
      this.counts.set(ip, { count: 1, resetAt: now + this.windowMs })
      return true
    }
    if (entry.count >= this.limit) return false
    entry.count++
    return true
  }
}

describe('RateLimiter', () => {
  afterEach(() => vi.useRealTimers())

  it('首次请求允许', () => {
    const rl = new RateLimiter(5)
    expect(rl.check('1.2.3.4')).toBe(true)
  })

  it('未超限时持续允许', () => {
    const rl = new RateLimiter(3)
    expect(rl.check('1.2.3.4')).toBe(true)
    expect(rl.check('1.2.3.4')).toBe(true)
    expect(rl.check('1.2.3.4')).toBe(true)
  })

  it('超限后拒绝', () => {
    const rl = new RateLimiter(2)
    rl.check('1.2.3.4')
    rl.check('1.2.3.4')
    expect(rl.check('1.2.3.4')).toBe(false)
  })

  it('不同 IP 独立计数', () => {
    const rl = new RateLimiter(1)
    expect(rl.check('1.1.1.1')).toBe(true)
    expect(rl.check('2.2.2.2')).toBe(true)
    expect(rl.check('1.1.1.1')).toBe(false)
  })

  it('窗口过期后重置计数', () => {
    vi.useFakeTimers()
    const rl = new RateLimiter(1, 1000)
    rl.check('1.2.3.4')
    expect(rl.check('1.2.3.4')).toBe(false)
    vi.advanceTimersByTime(1001)
    expect(rl.check('1.2.3.4')).toBe(true)
  })
})
