import { describe, it, expect } from 'vitest'
import { runWithSession, getCurrentSessionId } from '../../src/core/sessionContext.js'

describe('sessionContext', () => {
  it('不在上下文内返回 undefined', () => {
    expect(getCurrentSessionId()).toBeUndefined()
  })

  it('runWithSession 内可获取 sessionId', () => {
    runWithSession('sess-123', () => {
      expect(getCurrentSessionId()).toBe('sess-123')
    })
  })

  it('runWithSession 结束后 sessionId 恢复', () => {
    runWithSession('sess-outer', () => {
      expect(getCurrentSessionId()).toBe('sess-outer')
      runWithSession('sess-inner', () => {
        expect(getCurrentSessionId()).toBe('sess-inner')
      })
      expect(getCurrentSessionId()).toBe('sess-outer')
    })
    expect(getCurrentSessionId()).toBeUndefined()
  })

  it('runWithSession 返回函数结果', () => {
    const result = runWithSession('sess-1', () => 42)
    expect(result).toBe(42)
  })
})
