import { describe, it, expect, vi, beforeEach } from 'vitest'

// mock 文件系统
const mockStore = new Map<string, string>()

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn((p: string) => mockStore.has(p)),
    readFileSync: vi.fn((p: string) => {
      const v = mockStore.get(p)
      if (!v) throw new Error(`ENOENT: ${p}`)
      return v
    }),
    writeFileSync: vi.fn((p: string, content: string) => mockStore.set(p, content)),
    renameSync: vi.fn((src: string, dest: string) => {
      const content = mockStore.get(src)
      if (content !== undefined) {
        mockStore.set(dest, content)
        mockStore.delete(src)
      }
    }),
    mkdirSync: vi.fn(),
    statSync: vi.fn(() => ({ mtimeMs: Date.now() })),
  }
})

beforeEach(() => {
  mockStore.clear()
})

import { loadConfig, saveConfig, _resetConfigCache } from '../../src/core/Config.js'

describe('Config', () => {
  beforeEach(() => {
    _resetConfigCache()
  })
  it('配置文件不存在时返回默认值', () => {
    const config = loadConfig()
    expect(config.model).toBe('qwen3.5-122b-a10b')
    expect(config.permissionMode).toBe('ask')
    expect(config.maxTokens).toBe(8096)
    expect(config.maxTurns).toBe(50)
    expect(config.mcpServers).toEqual([])
    expect(config.theme).toBe('default')
  })

  it('saveConfig 后 loadConfig 能读取保存的值', () => {
    saveConfig({ model: 'gpt-4o', agent: { maxTokens: 4096 } })
    const config = loadConfig()
    expect(config.model).toBe('gpt-4o')
    expect(config.maxTokens).toBe(4096)
  })

  it('saveConfig 只更新指定字段，其余保持默认', () => {
    saveConfig({ model: 'deepseek-chat' })
    const config = loadConfig()
    expect(config.model).toBe('deepseek-chat')
    expect(config.permissionMode).toBe('ask') // 默认值保持
    expect(config.maxTurns).toBe(50)          // 默认值保持
  })

  it('配置文件损坏时返回默认值', () => {
    // 写入无效 JSON
    const { join } = require('path')
    const { homedir } = require('os')
    const configFile = join(homedir(), '.hrids-agent', 'config.json')
    mockStore.set(configFile, 'invalid json {{{')

    const config = loadConfig()
    expect(config.model).toBe('qwen3.5-122b-a10b')
  })

  it('可以保存 mcpServers 配置', () => {
    const mcpServers = [{ name: 'test-server', command: 'npx', args: ['test'] }]
    saveConfig({ mcpServers })
    const config = loadConfig()
    expect(config.mcpServers).toHaveLength(1)
    expect(config.mcpServers[0].name).toBe('test-server')
  })
})
