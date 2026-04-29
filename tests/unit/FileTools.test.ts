import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

// 使用真实临时目录进行文件工具测试
let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hrids-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// mock BashTool 的 getGlobalCwd，让 FileReadTool 使用临时目录
vi.mock('../../src/tools/BashTool.js', () => ({
  getGlobalCwd: vi.fn(() => tmpDir),
  setGlobalCwd: vi.fn(),
  BashTool: {},
}))

// mock audit 日志，避免写磁盘
vi.mock('../../src/core/audit.js', () => ({
  auditLog: vi.fn(),
}))

import { FileReadTool } from '../../src/tools/FileReadTool.js'
import { FileWriteTool } from '../../src/tools/FileWriteTool.js'
import { FileEditTool } from '../../src/tools/FileEditTool.js'

describe('FileReadTool', () => {
  it('读取存在的文件', async () => {
    const filePath = path.join(tmpDir, 'hello.txt')
    fs.writeFileSync(filePath, 'line1\nline2\nline3')

    const result = await FileReadTool.execute({ path: filePath })
    expect(result.type).toBe('success')
    expect((result as { type: 'success'; output: string }).output).toContain('line1')
    expect((result as { type: 'success'; output: string }).output).toContain('line2')
  })

  it('文件不存在时返回错误', async () => {
    const result = await FileReadTool.execute({ path: '/nonexistent/file.txt' })
    expect(result.type).toBe('error')
  })

  it('支持行范围读取', async () => {
    const filePath = path.join(tmpDir, 'multi.txt')
    fs.writeFileSync(filePath, 'a\nb\nc\nd\ne')

    const result = await FileReadTool.execute({ path: filePath, startLine: 2, endLine: 3 })
    expect(result.type).toBe('success')
    const output = (result as { type: 'success'; output: string }).output
    expect(output).toContain('b')
    expect(output).toContain('c')
    expect(output).not.toContain('a\n')
  })

  it('默认显示行号', async () => {
    const filePath = path.join(tmpDir, 'numbered.txt')
    fs.writeFileSync(filePath, 'hello\nworld')

    const result = await FileReadTool.execute({ path: filePath })
    expect(result.type).toBe('success')
    expect((result as { type: 'success'; output: string }).output).toContain('│')
  })

  it('可以关闭行号显示', async () => {
    const filePath = path.join(tmpDir, 'plain.txt')
    fs.writeFileSync(filePath, 'hello')

    const result = await FileReadTool.execute({ path: filePath, showLineNumbers: false })
    expect(result.type).toBe('success')
    expect((result as { type: 'success'; output: string }).output).not.toContain('│')
  })

  it('readonly 为 true', () => {
    expect(FileReadTool.readonly).toBe(true)
  })
})

describe('FileWriteTool', () => {
  it('写入新文件', async () => {
    const filePath = path.join(tmpDir, 'new.txt')
    const result = await FileWriteTool.execute({ path: filePath, content: 'hello world' })
    expect(result.type).toBe('success')
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('hello world')
  })

  it('覆盖已有文件', async () => {
    const filePath = path.join(tmpDir, 'existing.txt')
    fs.writeFileSync(filePath, 'old content')

    await FileWriteTool.execute({ path: filePath, content: 'new content' })
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('new content')
  })

  it('自动创建父目录', async () => {
    const filePath = path.join(tmpDir, 'deep', 'nested', 'file.txt')
    const result = await FileWriteTool.execute({ path: filePath, content: 'nested' })
    expect(result.type).toBe('success')
    expect(fs.existsSync(filePath)).toBe(true)
  })

  it('readonly 为 false', () => {
    expect(FileWriteTool.readonly).toBe(false)
  })

  it('getFilePath 返回文件路径', () => {
    const input = { path: '/some/file.txt', content: '' }
    expect(FileWriteTool.getFilePath!(input)).toBe('/some/file.txt')
  })
})

describe('FileEditTool', () => {
  it('精确替换唯一字符串', async () => {
    const filePath = path.join(tmpDir, 'edit.txt')
    fs.writeFileSync(filePath, 'hello world\nfoo bar')

    const result = await FileEditTool.execute({
      path: filePath,
      oldStr: 'hello world',
      newStr: 'hi there',
    })
    expect(result.type).toBe('success')
    expect(fs.readFileSync(filePath, 'utf-8')).toContain('hi there')
    expect(fs.readFileSync(filePath, 'utf-8')).not.toContain('hello world')
  })

  it('oldStr 不存在时返回错误', async () => {
    const filePath = path.join(tmpDir, 'noedit.txt')
    fs.writeFileSync(filePath, 'some content')

    const result = await FileEditTool.execute({
      path: filePath,
      oldStr: 'not here',
      newStr: 'replacement',
    })
    expect(result.type).toBe('error')
    expect((result as { type: 'error'; message: string }).message).toContain('未找到')
  })

  it('oldStr 不唯一时返回错误', async () => {
    const filePath = path.join(tmpDir, 'dup.txt')
    fs.writeFileSync(filePath, 'foo\nfoo')

    const result = await FileEditTool.execute({
      path: filePath,
      oldStr: 'foo',
      newStr: 'bar',
    })
    expect(result.type).toBe('error')
    expect((result as { type: 'error'; message: string }).message).toContain('唯一')
  })

  it('文件不存在时返回错误', async () => {
    const result = await FileEditTool.execute({
      path: '/nonexistent.txt',
      oldStr: 'x',
      newStr: 'y',
    })
    expect(result.type).toBe('error')
  })
})
