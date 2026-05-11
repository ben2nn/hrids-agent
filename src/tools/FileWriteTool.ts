import { writeFileSync, mkdirSync } from 'fs'
import { dirname, resolve } from 'path'
import { z } from 'zod'
import type { ToolDef } from '../core/Tool.js'
import { auditLog } from '../core/audit.js'
import { checkWritePath } from '../core/pathSafety.js'
import { getGlobalCwd } from '../core/cwd.js'
import { getCurrentAgentName } from '../core/coordinator/agentContext.js'
import { getFileLeaseManager } from '../core/FileLeaseManager.js'

const inputSchema = z.object({
  path: z.string().describe('要写入的文件路径'),
  content: z.string().describe('文件内容'),
})

export const FileWriteTool: ToolDef<typeof inputSchema> = {
  name: 'file_write',
  description: `创建新文件或覆盖已有文件。用这个而不是 bash echo > file。
适用场景：创建新文件、生成报告、导出数据
不适用场景：修改已有文件的部分内容 → 用 file_edit | 读取文件 → 用 file_read`,
  inputSchema,
  readonly: false,
  isDestructive: true,
  capabilities: { parallelSafe: false },

  describe(input) {
    return `写入文件: ${input.path}`
  },

  getFilePath(input) {
    return input.path
  },

  getRuleContent(input) {
    return input.path
  },

  async execute(input) {
    const cwd = getGlobalCwd()

    // 文件租约检查（仅子智能体需要，主智能体跳过）
    const agentName = getCurrentAgentName()
    if (agentName) {
      const lease = getFileLeaseManager()
      const result = lease.acquire(agentName, input.path, '写入文件')
      if (!result.granted) {
        return {
          type: 'error',
          message: `文件 "${input.path}" 正被智能体 "${result.holder!.agentId}" 占用（${result.holder!.operation ?? '写入中'}），请稍后重试或协调任务分工`,
        }
      }
    }

    // 路径安全检查
    const safety = checkWritePath(input.path, cwd)
    if (!safety.safe) {
      auditLog({ action: 'file_write', resource: input.path, result: 'error', details: { error: safety.reason } })
      return { type: 'error', message: safety.reason }
    }

    const filePath = resolve(cwd, input.path)

    try {
      mkdirSync(dirname(filePath), { recursive: true })
      writeFileSync(filePath, input.content, 'utf-8')
      auditLog({ action: 'file_write', resource: filePath, result: 'allowed' })
      if (agentName) getFileLeaseManager().release(agentName, input.path)
      return { type: 'success', output: `文件已写入: ${filePath}` }
    } catch (err) {
      auditLog({ action: 'file_write', resource: filePath, result: 'error', details: { error: String(err) } })
      if (agentName) getFileLeaseManager().release(agentName, input.path)
      return { type: 'error', message: `写入失败: ${String(err)}` }
    }
  },
}
