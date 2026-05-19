import { readFileSync, existsSync, statSync } from 'fs'
import { resolve } from 'path'
import { z } from 'zod'
import { buildTool } from '../core/Tool.js'
import { getGlobalCwd } from '../shared/cwd.js'

const inputSchema = z.object({
  path: z.string().describe('要读取的文件路径'),
  startLine: z.number().optional().describe('起始行号（从 1 开始）'),
  endLine: z.number().optional().describe('结束行号'),
  showLineNumbers: z.boolean().optional().describe('是否显示行号，默认 true'),
})

const MAX_LINES = 2000
const MAX_FILE_SIZE = 1024 * 1024 // 1MB

// 大文件自动预览常量（参考 DeepSeek-Reasonix read_file 设计）
const AUTO_PREVIEW_THRESHOLD = 200  // 超过此行数触发自动预览
const PREVIEW_HEAD_LINES = 80
const PREVIEW_TAIL_LINES = 40
const OUTLINE_MAX_ENTRIES = 30

const EXPORT_RE = /^export\s+(default\s+)?(async\s+)?(function|class|const|let|var|interface|type|enum)\s+(\w+)/

function extractExportOutline(lines: string[]): string | null {
  const entries: Array<{ line: number; text: string }> = []
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(EXPORT_RE)
    if (match) {
      entries.push({ line: i + 1, text: match[0].replace(/\s*\{.*/, '').replace(/\s*=\s*.*/, '') })
    }
  }
  if (entries.length === 0) return null

  const display = entries.length > OUTLINE_MAX_ENTRIES
    ? [...entries.slice(0, 25), { line: -1, text: `... ${entries.length - 25} more ...` }, ...entries.slice(-5)]
    : entries

  return display
    .map(e => e.line === -1 ? e.text : `  L${String(e.line).padStart(4)}: ${e.text}`)
    .join('\n')
}

/**
 * 文件读取缓存（参考 claude-code-main 的 readFileState 设计）
 *
 * 缓存已读取的文件内容和 mtime，避免重复读取相同文件浪费 token。
 * 写操作（FileWriteTool、FileEditTool）应调用 invalidateCache() 清除缓存。
 */
interface FileCacheEntry {
  content: string
  timestamp: number  // mtime (ms)
  totalLines: number
}

const MAX_CACHE_ENTRIES = 50
const readFileState = new Map<string, FileCacheEntry>()

function getFromCache(key: string): FileCacheEntry | undefined {
  const entry = readFileState.get(key)
  if (!entry) return undefined
  // LRU：命中时移到末尾
  readFileState.delete(key)
  readFileState.set(key, entry)
  return entry
}

function setCache(key: string, entry: FileCacheEntry): void {
  if (readFileState.size >= MAX_CACHE_ENTRIES) {
    // 淘汰最旧的条目
    const oldest = readFileState.keys().next().value
    if (oldest) readFileState.delete(oldest)
  }
  readFileState.set(key, entry)
}

/**
 * 使文件缓存失效（供写操作调用）
 * @param filePath 文件路径（绝对路径）
 */
export function invalidateFileCache(filePath: string): void {
  readFileState.delete(filePath)
}

/**
 * 使所有缓存失效（会话切换时调用）
 */
export function clearFileCache(): void {
  readFileState.clear()
}

export const FileReadTool = buildTool({
  name: 'file_read',
  description: `读取文件内容。用这个而不是 bash cat。
适用场景：查看代码、配置文件、日志、数据文件
不适用场景：搜索文件中的文本 → 用 grep | 查找文件路径 → 用 glob`,
  inputSchema,
  readonly: true,
  stormExempt: true,  // 只读操作，豁免风暴检测
  capabilities: { parallelSafe: true },

  describe(input) {
    const range = input.startLine
      ? ` (${input.startLine}-${input.endLine ?? '末尾'})`
      : ''
    return `读取文件: ${input.path}${range}`
  },

  async execute(input) {
    // 相对路径基于当前工作目录解析，绝对路径保持不变
    const filePath = resolve(getGlobalCwd(), input.path)
    if (!existsSync(filePath)) {
      return { type: 'error', message: `文件不存在: ${filePath}` }
    }

    try {
      // 检查文件大小，避免读取超大二进制文件
      const stat = statSync(filePath)
      if (stat.size > MAX_FILE_SIZE) {
        return {
          type: 'error',
          message: `文件过大（${(stat.size / 1024).toFixed(0)} KB），超过 1MB 限制。请使用 startLine/endLine 分段读取。`,
        }
      }

      const currentMtime = Math.floor(stat.mtimeMs)

      // 检查缓存：文件未变化且无范围参数时返回缓存提示
      const cached = getFromCache(filePath)
      if (cached && cached.timestamp === currentMtime && !input.startLine && !input.endLine) {
        return {
          type: 'success',
          output: `[文件未变化，使用缓存] 共 ${cached.totalLines} 行\n${cached.content.slice(0, 200)}${cached.content.length > 200 ? '...' : ''}`,
        }
      }

      const content = readFileSync(filePath, 'utf-8')
      const allLines = content.split('\n')
      const totalLines = allLines.length

      // 更新缓存（仅完整读取时）
      if (!input.startLine && !input.endLine) {
        setCache(filePath, {
          content,
          timestamp: currentMtime,
          totalLines,
        })
      }

      // 大文件自动预览：head+tail+outline，节省 token
      if (!input.startLine && !input.endLine && totalLines > AUTO_PREVIEW_THRESHOLD) {
        const lineNumWidth = String(totalLines).length
        const fmtLine = (num: number, text: string) =>
          `${String(num).padStart(lineNumWidth, ' ')} │ ${text}`

        const head = allLines.slice(0, PREVIEW_HEAD_LINES)
        const tail = allLines.slice(-PREVIEW_TAIL_LINES)
        const outline = extractExportOutline(allLines)
        const omitted = totalLines - PREVIEW_HEAD_LINES - PREVIEW_TAIL_LINES

        const preview = [
          `# 文件预览: ${input.path} (${totalLines} 行)`,
          `# 使用 startLine/endLine 参数读取特定范围\n`,
          ...head.map((line, i) => fmtLine(i + 1, line)),
          `\n... 省略 ${omitted} 行 ...\n`,
          ...tail.map((line, i) => fmtLine(totalLines - PREVIEW_TAIL_LINES + i + 1, line)),
          outline ? `\n# 导出符号轮廓\n${outline}` : '',
        ].join('\n')

        return { type: 'success', output: preview }
      }

      // 确定读取范围
      const startIdx = input.startLine !== undefined ? Math.max(0, input.startLine - 1) : 0
      const endIdx = input.endLine !== undefined
        ? Math.min(input.endLine, totalLines)
        : Math.min(startIdx + MAX_LINES, totalLines)

      const lines = allLines.slice(startIdx, endIdx)

      // 默认显示行号（showLineNumbers 默认 true）
      const showNums = input.showLineNumbers !== false
      const lineNumWidth = String(endIdx).length

      let output: string
      if (showNums) {
        output = lines
          .map((line, i) => {
            const lineNum = String(startIdx + i + 1).padStart(lineNumWidth, ' ')
            return `${lineNum} │ ${line}`
          })
          .join('\n')
      } else {
        output = lines.join('\n')
      }

      // 截断提示
      const truncated = endIdx < totalLines && input.endLine === undefined
      if (truncated) {
        output += `\n\n[文件共 ${totalLines} 行，已显示第 ${startIdx + 1}-${endIdx} 行。使用 startLine/endLine 读取其余部分]`
      }

      return { type: 'success', output }
    } catch (err) {
      return { type: 'error', message: `读取失败: ${String(err)}` }
    }
  },
})
