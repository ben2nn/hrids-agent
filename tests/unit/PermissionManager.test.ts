import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PermissionManager } from '../../src/core/PermissionManager.js'

// mock 文件系统，避免测试读写真实的 ~/.hrids-agent/permission-rules.json
const { mockFsStore } = vi.hoisted(() => ({
  mockFsStore: new Map<string, string>(),
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn((p: string) => mockFsStore.has(p)),
    readFileSync: vi.fn((p: string) => mockFsStore.get(p) ?? '{}'),
    writeFileSync: vi.fn((p: string, content: string) => mockFsStore.set(p, content)),
    renameSync: vi.fn((src: string, dest: string) => {
      const content = mockFsStore.get(src)
      if (content !== undefined) {
        mockFsStore.set(dest, content)
        mockFsStore.delete(src)
      }
    }),
    mkdirSync: vi.fn(),
  }
})

beforeEach(() => {
  mockFsStore.clear()
})

const makeReq = (overrides = {}) => ({
  toolName: 'bash',
  description: '执行命令: ls',
  isReadonly: false,
  ...overrides,
})

describe('PermissionManager', () => {
  describe('craft 模式', () => {
    let pm: PermissionManager
    beforeEach(() => {
      pm = new PermissionManager('craft', async () => false)
    })

    it('只读操作始终允许', async () => {
      expect(await pm.check({ ...makeReq(), isReadonly: true })).toBe(true)
    })

    it('写操作自动允许', async () => {
      expect(await pm.check(makeReq())).toBe(true)
    })
  })

  describe('plan 模式（只读）', () => {
    let pm: PermissionManager
    beforeEach(() => {
      pm = new PermissionManager('plan', async () => true)
    })

    it('只读操作允许', async () => {
      expect(await pm.check({ ...makeReq(), isReadonly: true })).toBe(true)
    })

    it('写操作拒绝', async () => {
      expect(await pm.check(makeReq())).toBe(false)
    })
  })

  describe('plan 模式', () => {
    let pm: PermissionManager
    beforeEach(() => {
      pm = new PermissionManager('plan', async () => true)
    })

    it('写操作拒绝（即使 callback 返回 true）', async () => {
      expect(await pm.check(makeReq())).toBe(false)
    })
  })

  describe('ask 模式', () => {
    it('callback 返回 true 时允许', async () => {
      const pm = new PermissionManager('ask', async () => true)
      expect(await pm.check(makeReq())).toBe(true)
    })

    it('callback 返回 false 时拒绝', async () => {
      const pm = new PermissionManager('ask', async () => false)
      expect(await pm.check(makeReq())).toBe(false)
    })

    it('会话内批准后不再询问', async () => {
      const callback = vi.fn(async () => true)
      const pm = new PermissionManager('ask', callback)
      pm.approveSession('bash')
      await pm.check(makeReq())
      expect(callback).not.toHaveBeenCalled()
    })
  })

  describe('路径规则', () => {
    it('deniedPaths 拒绝匹配路径', async () => {
      const pm = new PermissionManager('craft', async () => true)
      pm.denyPath('/etc/passwd')
      const result = await pm.check({ ...makeReq(), filePath: '/etc/passwd' })
      expect(result).toBe(false)
    })

    it('deniedPaths 不影响不匹配路径', async () => {
      const pm = new PermissionManager('craft', async () => true)
      pm.denyPath('/etc/passwd')
      const result = await pm.check({ ...makeReq(), filePath: '/tmp/safe.txt' })
      expect(result).toBe(true)
    })
  })

  describe('setMode', () => {
    it('可以动态切换模式', async () => {
      const pm = new PermissionManager('craft', async () => false)
      expect(await pm.check(makeReq())).toBe(true)
      pm.setMode('plan')
      expect(await pm.check(makeReq())).toBe(false)
    })

    it('getMode 返回当前模式', () => {
      const pm = new PermissionManager('ask', async () => false)
      expect(pm.getMode()).toBe('ask')
      pm.setMode('craft')
      expect(pm.getMode()).toBe('craft')
    })
  })
})
