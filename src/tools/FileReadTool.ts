import { readFileSync, existsSync, statSync } from 'fs'
import { resolve } from 'path'
import { z } from 'zod'
import type { ToolDef } from '../core/Tool.js'
import { getGlobalCwd } from '../core/cwd.js'

const inputSchema = z.object({
  path: z.string().describe('要读取的文件路径'),
  startLine: z.number().optional().describe('起始行号（从 1 开始）'),
  endLine: z.number().optional().describe('结束行号'),
  showLineNumbers: z.boolean().optional().describe('是否显示行号，默认 true'),
})

const MAX_LINES = 2000
const MAX_FILE_SIZE = 1024 * 1024 // 1MB

export const FileReadTool: ToolDef<typeof inputSchema> = {
  name: 'file_read',
  description: `读取文件内容。用这个而不是 bash cat。
适用场景：查看代码、配置文件、日志、数据文件
不适用场景：搜索文件中的文本 → 用 grep | 查找文件路径 → 用 glob`,
  inputSchema,
  readonly: true,
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

      const content = readFileSync(filePath, 'utf-8')
      const allLines = content.split('\n')
      const totalLines = allLines.length

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
}
