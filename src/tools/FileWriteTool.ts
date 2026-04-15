import { writeFileSync, mkdirSync } from 'fs'
import { dirname, resolve, isAbsolute } from 'path'
import { homedir } from 'os'
import { z } from 'zod'
import type { ToolDef } from '../core/Tool.js'
import { auditLog } from '../core/audit.js'
import { getGlobalCwd } from './BashTool.js'

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
    // 相对路径基于当前工作目录（persistentCwd）解析，绝对路径保持不变
    const filePath = resolve(getGlobalCwd(), input.path)

    // 防御性检查：禁止将文件写入用户主目录根层级
    // 允许写入主目录下的子目录（如 ~/.hrids-agent/），但禁止直接写到 ~/xxx.md
    const home = homedir()
    if (isAbsolute(input.path) && dirname(filePath) === home) {
      const suggestion = input.path.replace(/^.*[/\\]/, '')  // 提取文件名
      auditLog({ action: 'file_write', resource: filePath, result: 'error', details: { error: '路径被拒绝：目标为用户主目录根层级' } })
      return {
        type: 'error',
        message: `路径被拒绝：不允许直接写入用户主目录 (${home})。\n请使用相对路径（如 "${suggestion}"），文件将写入当前工作目录 ${getGlobalCwd()}。`,
      }
    }

    try {
      mkdirSync(dirname(filePath), { recursive: true })
      writeFileSync(filePath, input.content, 'utf-8')
      auditLog({ action: 'file_write', resource: filePath, result: 'allowed' })
      return { type: 'success', output: `文件已写入: ${filePath}` }
    } catch (err) {
      auditLog({ action: 'file_write', resource: filePath, result: 'error', details: { error: String(err) } })
      return { type: 'error', message: `写入失败: ${String(err)}` }
    }
  },
}
