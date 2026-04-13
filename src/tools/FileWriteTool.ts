import { writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { z } from 'zod'
import type { ToolDef } from '../core/Tool.js'
import { auditLog } from '../core/audit.js'

const inputSchema = z.object({
  path: z.string().describe('要写入的文件路径'),
  content: z.string().describe('文件内容'),
})

export const FileWriteTool: ToolDef<typeof inputSchema> = {
  name: 'file_write',
  description: '创建或覆盖写入文件，自动创建父目录',
  inputSchema,
  readonly: false,

  describe(input) {
    return `写入文件: ${input.path}`
  },

  getFilePath(input) {
    return input.path
  },

  async execute(input) {
    try {
      mkdirSync(dirname(input.path), { recursive: true })
      writeFileSync(input.path, input.content, 'utf-8')
      auditLog({ action: 'file_write', resource: input.path, result: 'allowed' })
      return { type: 'success', output: `文件已写入: ${input.path}` }
    } catch (err) {
      auditLog({ action: 'file_write', resource: input.path, result: 'error', details: { error: String(err) } })
      return { type: 'error', message: `写入失败: ${String(err)}` }
    }
  },
}
