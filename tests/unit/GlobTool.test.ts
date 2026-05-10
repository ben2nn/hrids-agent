import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hrids-glob-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

vi.mock('../../src/core/cwd.js', () => ({
  getGlobalCwd: vi.fn(() => tmpDir),
  setGlobalCwd: vi.fn(),
  runWithCwd: vi.fn((_cwd: string, fn: () => unknown) => fn()),
}))

import { GlobTool } from '../../src/tools/GlobTool.js'

describe('GlobTool', () => {
  it('查找匹配的文件', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), '')
    fs.writeFileSync(path.join(tmpDir, 'b.ts'), '')
    fs.writeFileSync(path.join(tmpDir, 'c.js'), '')

    const result = await GlobTool.execute({ pattern: '*.ts' })
    expect(result.type).toBe('success')
    const output = (result as { type: 'success'; output: string }).output
    expect(output).toContain('a.ts')
    expect(output).toContain('b.ts')
    expect(output).not.toContain('c.js')
  })

  it('无匹配时返回提示', async () => {
    const result = await GlobTool.execute({ pattern: '*.xyz' })
    expect(result.type).toBe('success')
    expect((result as { type: 'success'; output: string }).output).toContain('未找到')
  })

  it('支持子目录模式', async () => {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), '')
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '')

    const result = await GlobTool.execute({ pattern: 'src/**/*.ts' })
    expect(result.type).toBe('success')
    const output = (result as { type: 'success'; output: string }).output
    expect(output).toContain('src')
    expect(output).toContain('index.ts')
  })

  it('readonly 为 true', () => {
    expect(GlobTool.readonly).toBe(true)
  })

  it('describe 返回搜索描述', () => {
    const desc = GlobTool.describe!({ pattern: '*.ts' })
    expect(desc).toContain('*.ts')
  })

  it('自定义 cwd', async () => {
    const subDir = path.join(tmpDir, 'sub')
    fs.mkdirSync(subDir)
    fs.writeFileSync(path.join(subDir, 'test.txt'), '')

    const result = await GlobTool.execute({ pattern: '*.txt', cwd: subDir })
    expect(result.type).toBe('success')
    expect((result as { type: 'success'; output: string }).output).toContain('test.txt')
  })

  it('结果按字母排序', async () => {
    fs.writeFileSync(path.join(tmpDir, 'z.txt'), '')
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), '')
    fs.writeFileSync(path.join(tmpDir, 'm.txt'), '')

    const result = await GlobTool.execute({ pattern: '*.txt' })
    const output = (result as { type: 'success'; output: string }).output
    const files = output.split('\n')
    expect(files).toEqual(['a.txt', 'm.txt', 'z.txt'])
  })
})
