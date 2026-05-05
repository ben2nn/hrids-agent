import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// mock fs 避免真实写文件
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    appendFileSync: vi.fn(),
  }
})

describe('logger', () => {
  beforeEach(() => {
    // 确保非 server 模式
    delete process.env.AGENT_SERVER_MODE
    process.env.LOG_LEVEL = 'debug'
  })

  afterEach(() => {
    delete process.env.LOG_LEVEL
    vi.resetModules()
  })

  it('logger 模块可以正常导入', async () => {
    const { logger } = await import('../../src/core/logger.js')
    expect(logger).toBeDefined()
    expect(typeof logger.info).toBe('function')
    expect(typeof logger.error).toBe('function')
    expect(typeof logger.warn).toBe('function')
    expect(typeof logger.debug).toBe('function')
  })

  it('child logger 继承父 logger 方法', async () => {
    const { logger } = await import('../../src/core/logger.js')
    const child = logger.child({ component: 'test' })
    expect(typeof child.info).toBe('function')
    expect(typeof child.error).toBe('function')
  })

  it('server 模式下不写 stderr', async () => {
    process.env.AGENT_SERVER_MODE = '1'
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const { logger } = await import('../../src/core/logger.js')
    logger.info('test message')
    expect(stderrSpy).not.toHaveBeenCalled()
    stderrSpy.mockRestore()
  })
})
