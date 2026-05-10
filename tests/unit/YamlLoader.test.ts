import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockFiles } = vi.hoisted(() => ({
  mockFiles: new Map<string, string>(),
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    readFileSync: vi.fn((p: string, encoding?: string) => {
      const content = mockFiles.get(p)
      if (content === undefined) throw new Error(`ENOENT: ${p}`)
      return content
    }),
    writeFileSync: vi.fn((p: string, content: string) => {
      mockFiles.set(p, content)
    }),
    renameSync: vi.fn((src: string, dest: string) => {
      const content = mockFiles.get(src)
      if (content !== undefined) {
        mockFiles.set(dest, content)
        mockFiles.delete(src)
      }
    }),
  }
})

beforeEach(() => {
  mockFiles.clear()
})

import {
  loadYamlFile,
  tryLoadYamlFile,
  saveYamlFile,
  parseYamlString,
  toYamlString,
} from '../../src/core/YamlLoader.js'

describe('loadYamlFile', () => {
  it('加载有效 YAML 文件', () => {
    mockFiles.set('/test/config.yaml', 'name: test\nvalue: 42')
    const result = loadYamlFile<{ name: string; value: number }>('/test/config.yaml')
    expect(result.name).toBe('test')
    expect(result.value).toBe(42)
  })

  it('文件不存在时抛出错误', () => {
    expect(() => loadYamlFile('/nonexistent.yaml')).toThrow('ENOENT')
  })

  it('YAML 格式错误时抛出带行号的错误', () => {
    mockFiles.set('/bad.yaml', 'key:\n  bad: yaml: {{{')
    expect(() => loadYamlFile('/bad.yaml')).toThrow(/YAML 解析失败/)
  })
})

describe('tryLoadYamlFile', () => {
  it('文件存在时返回内容', () => {
    mockFiles.set('/test.yaml', 'key: value')
    const result = tryLoadYamlFile<{ key: string }>('/test.yaml')
    expect(result?.key).toBe('value')
  })

  it('文件不存在时返回 undefined', () => {
    const result = tryLoadYamlFile('/nonexistent.yaml')
    expect(result).toBeUndefined()
  })
})

describe('saveYamlFile', () => {
  it('保存数据为 YAML 格式', () => {
    saveYamlFile('/output.yaml', { name: 'test', count: 5 })
    const content = mockFiles.get('/output.yaml')
    expect(content).toContain('name: test')
    expect(content).toContain('count: 5')
  })

  it('使用原子写入（先写 .tmp 再 rename）', () => {
    saveYamlFile('/atomic.yaml', { key: 'val' })
    // .tmp 文件应该已被 rename 删除
    expect(mockFiles.has('/atomic.yaml.tmp')).toBe(false)
    expect(mockFiles.has('/atomic.yaml')).toBe(true)
  })

  it('自定义缩进', () => {
    saveYamlFile('/indent.yaml', { nested: { key: 'val' } }, { indent: 4 })
    const content = mockFiles.get('/indent.yaml')
    expect(content).toContain('    key:')
  })
})

describe('parseYamlString', () => {
  it('解析有效 YAML 字符串', () => {
    const result = parseYamlString<{ a: number }>('a: 1\nb: 2')
    expect(result.a).toBe(1)
  })

  it('解析空字符串返回 undefined', () => {
    const result = parseYamlString('')
    expect(result).toBeUndefined()
  })

  it('解析多行 YAML', () => {
    const result = parseYamlString<{ items: string[] }>('items:\n  - one\n  - two')
    expect(result.items).toEqual(['one', 'two'])
  })
})

describe('toYamlString', () => {
  it('对象转 YAML 字符串', () => {
    const result = toYamlString({ name: 'test', value: 42 })
    expect(result).toContain('name: test')
    expect(result).toContain('value: 42')
  })

  it('数组转 YAML 字符串', () => {
    const result = toYamlString([1, 2, 3])
    expect(result).toContain('- 1')
    expect(result).toContain('- 2')
  })

  it('自定义缩进', () => {
    const result = toYamlString({ nested: { key: 'val' } }, { indent: 4 })
    expect(result).toContain('    key:')
  })
})
