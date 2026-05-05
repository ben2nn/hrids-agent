import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hrids-grep-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

vi.mock('../../src/tools/BashTool.js', () => ({
  getGlobalCwd: vi.fn(() => tmpDir),
  setGlobalCwd: vi.fn(),
  BashTool: {},
}))

import { GrepTool } from '../../src/tools/GrepTool.js'

describe('GrepTool', () => {
  it('在文件中找到匹配内容', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'export function hello() {}\nexport function world() {}')

    const result = await GrepTool.execute({ pattern: 'hello', path: tmpDir })
    expect(result.type).toBe('success')
    expect((result as { type: 'success'; output: string }).output).toContain('hello')
  })

  it('无匹配时返回提示', async () => {
    fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'nothing here')

    const result = await GrepTool.execute({ pattern: 'xyz_not_found', path: tmpDir })
    expect(result.type).toBe('success')
    expect((result as { type: 'success'; output: string }).output).toContain('未找到')
  })

  it('路径不存在时返回错误', async () => {
    const result = await GrepTool.execute({ pattern: 'test', path: '/nonexistent/path' })
    expect(result.type).toBe('error')
  })

  it('无效正则表达式返回错误', async () => {
    const result = await GrepTool.execute({ pattern: '[invalid', path: tmpDir })
    expect(result.type).toBe('error')
    expect((result as { type: 'error'; message: string }).message).toContain('正则')
  })

  it('支持扩展名过滤', async () => {
    fs.writeFileSync(path.join(tmpDir, 'code.ts'), 'const x = 1')
    fs.writeFileSync(path.join(tmpDir, 'readme.md'), 'const x = 1')

    const result = await GrepTool.execute({ pattern: 'const x', path: tmpDir, include: '.ts' })
    expect(result.type).toBe('success')
    const output = (result as { type: 'success'; output: string }).output
    expect(output).toContain('code.ts')
    expect(output).not.toContain('readme.md')
  })

  it('默认大小写不敏感', async () => {
    fs.writeFileSync(path.join(tmpDir, 'case.txt'), 'Hello World')

    const result = await GrepTool.execute({ pattern: 'hello', path: tmpDir })
    expect(result.type).toBe('success')
    expect((result as { type: 'success'; output: string }).output).toContain('Hello World')
  })

  it('区分大小写模式', async () => {
    fs.writeFileSync(path.join(tmpDir, 'cs.txt'), 'Hello World\nhello world')

    const result = await GrepTool.execute({ pattern: 'Hello', path: tmpDir, caseSensitive: true })
    expect(result.type).toBe('success')
    const output = (result as { type: 'success'; output: string }).output
    // 只匹配大写 Hello 那行
    const lines = output.split('\n').filter(l => l.includes('cs.txt'))
    expect(lines.length).toBe(1)
  })

  it('readonly 为 true', () => {
    expect(GrepTool.readonly).toBe(true)
  })
})
