import { readdirSync, readFileSync, statSync, existsSync } from 'fs'
import { join, relative, resolve } from 'path'
import { z } from 'zod'
import type { ToolDef } from '../core/Tool.js'
import { getGlobalCwd } from '../core/cwd.js'

const inputSchema = z.object({
  pattern: z.string().describe('正则表达式搜索模式'),
  path: z.string().optional().describe('搜索路径，默认为当前工作目录'),
  include: z.string().optional().describe('文件扩展名过滤，如 .ts 或 .py（含点号）'),
  caseSensitive: z.boolean().optional().describe('是否区分大小写，默认 false'),
  maxResults: z.number().optional().describe('最大返回结果数，默认 100'),
})

// 需要跳过的目录
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt',
  'coverage', '.cache', '__pycache__', '.venv', 'venv',
])

// 纯 Node.js 实现的递归文件搜索，跨平台兼容
function searchFiles(
  dir: string,
  regex: RegExp,
  includeExt: string | undefined,
  results: string[],
  maxResults: number,
  rootDir: string,
): void {
  if (results.length >= maxResults) return

  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }

  for (const entry of entries) {
    if (results.length >= maxResults) break
    const fullPath = join(dir, entry)

    let stat
    try {
      stat = statSync(fullPath)
    } catch {
      continue
    }

    if (stat.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) {
        searchFiles(fullPath, regex, includeExt, results, maxResults, rootDir)
      }
      continue
    }

    // 扩展名过滤
    if (includeExt && !entry.endsWith(includeExt)) continue

    // 跳过二进制文件（简单判断：文件名含常见二进制扩展名）
    const binaryExts = ['.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2',
      '.ttf', '.eot', '.pdf', '.zip', '.tar', '.gz', '.exe', '.dll', '.so', '.dylib']
    if (binaryExts.some(ext => entry.endsWith(ext))) continue

    let content: string
    try {
      content = readFileSync(fullPath, 'utf-8')
    } catch {
      continue
    }

    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (results.length >= maxResults) break
      if (regex.test(lines[i])) {
        const relPath = relative(rootDir, fullPath)
        results.push(`${relPath}:${i + 1}: ${lines[i].trimEnd()}`)
      }
    }
  }
}

export const GrepTool: ToolDef<typeof inputSchema> = {
  name: 'grep',
  description: '在文件中搜索文本模式，返回匹配行及行号（跨平台，无需系统 grep）',
  inputSchema,
  readonly: true,

  describe(input) {
    return `搜索内容: ${input.pattern}`
  },

  async execute(input) {
    const searchRoot = input.path ? resolve(getGlobalCwd(), input.path) : getGlobalCwd()

    if (!existsSync(searchRoot)) {
      return { type: 'error', message: `路径不存在: ${searchRoot}` }
    }

    let regex: RegExp
    try {
      regex = new RegExp(input.pattern, input.caseSensitive ? '' : 'i')
    } catch {
      return { type: 'error', message: `无效的正则表达式: ${input.pattern}` }
    }

    const maxResults = input.maxResults ?? 100
    const results: string[] = []

    const stat = statSync(searchRoot)
    if (stat.isFile()) {
      // 单文件搜索
      try {
        const content = readFileSync(searchRoot, 'utf-8')
        const lines = content.split('\n')
        for (let i = 0; i < lines.length && results.length < maxResults; i++) {
          if (regex.test(lines[i])) {
            results.push(`${searchRoot}:${i + 1}: ${lines[i].trimEnd()}`)
          }
        }
      } catch (err) {
        return { type: 'error', message: `读取文件失败: ${String(err)}` }
      }
    } else {
      searchFiles(searchRoot, regex, input.include, results, maxResults, searchRoot)
    }

    if (results.length === 0) return { type: 'success', output: '未找到匹配内容' }

    const output = results.join('\n')
    const suffix = results.length >= maxResults ? `\n\n[已达到最大结果数 ${maxResults}，可能有更多匹配]` : ''
    return { type: 'success', output: output + suffix }
  },
}
