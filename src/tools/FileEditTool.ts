import { readFileSync, writeFileSync, existsSync } from 'fs'
import { z } from 'zod'
import type { ToolDef } from '../core/Tool.js'
import { auditLog } from '../core/audit.js'

const inputSchema = z.object({
  path: z.string().describe('要编辑的文件路径'),
  oldStr: z.string().describe('要替换的原始字符串（必须在文件中唯一存在）'),
  newStr: z.string().describe('替换后的新字符串'),
})

export const FileEditTool: ToolDef<typeof inputSchema> = {
  name: 'file_edit',
  description: '对文件做精确的字符串替换，oldStr 必须在文件中唯一',
  inputSchema,
  readonly: false,

  describe(input) {
    return `编辑文件: ${input.path}`
  },

  getFilePath(input) {
    return input.path
  },

  async execute(input) {
    if (!existsSync(input.path)) {
      return { type: 'error', message: `文件不存在: ${input.path}` }
    }

    try {
      const content = readFileSync(input.path, 'utf-8')
      const count = content.split(input.oldStr).length - 1

      if (count === 0) {
        return { type: 'error', message: '未找到要替换的字符串' }
      }
      if (count > 1) {
        return { type: 'error', message: `找到 ${count} 处匹配，oldStr 必须唯一` }
      }

      const updated = content.replace(input.oldStr, input.newStr)
      writeFileSync(input.path, updated, 'utf-8')
      auditLog({ action: 'file_edit', resource: input.path, result: 'allowed' })
      return { type: 'success', output: `文件已更新: ${input.path}` }
    } catch (err) {
      auditLog({ action: 'file_edit', resource: input.path, result: 'error', details: { error: String(err) } })
      return { type: 'error', message: `编辑失败: ${String(err)}` }
    }
  },
}
