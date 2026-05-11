import { readFileSync, writeFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { execFileSync } from 'child_process'
import { z } from 'zod'
import type { ToolDef } from '../core/Tool.js'
import { auditLog } from '../core/audit.js'
import { checkWritePath } from '../core/pathSafety.js'
import { getGlobalCwd } from '../core/cwd.js'
import { getCurrentAgentName } from '../core/coordinator/agentContext.js'
import { getFileLeaseManager } from '../core/FileLeaseManager.js'

const inputSchema = z.object({
  path: z.string().describe('要编辑的文件路径'),
  oldStr: z.string().describe('要替换的原始字符串（必须在文件中唯一存在）'),
  newStr: z.string().describe('替换后的新字符串'),
})

export const FileEditTool: ToolDef<typeof inputSchema> = {
  name: 'file_edit',
  description: `对已有文件做精确的字符串替换。用这个而不是 bash sed/awk。
适用场景：修改代码中的函数、更新配置项、修复 bug
不适用场景：创建新文件 → 用 file_write | 整个文件重写 → 用 file_write`,
  inputSchema,
  readonly: false,
  capabilities: { parallelSafe: false },

  describe(input) {
    return `编辑文件: ${input.path}`
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
      const result = lease.acquire(agentName, input.path, '编辑文件')
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
      auditLog({ action: 'file_edit', resource: input.path, result: 'error', details: { error: safety.reason } })
      return { type: 'error', message: safety.reason }
    }

    // 相对路径基于当前工作目录（persistentCwd）解析，绝对路径保持不变
    const filePath = resolve(cwd, input.path)
    if (!existsSync(filePath)) {
      return { type: 'error', message: `文件不存在: ${filePath}` }
    }

    try {
      const content = readFileSync(filePath, 'utf-8')
      const count = content.split(input.oldStr).length - 1

      if (count === 0) {
        return { type: 'error', message: '未找到要替换的字符串' }
      }
      if (count > 1) {
        return { type: 'error', message: `找到 ${count} 处匹配，oldStr 必须唯一` }
      }

      const updated = content.replace(input.oldStr, input.newStr)

      // 写入前先将当前状态提交到 git，使 HEAD 保留修改前内容
      try {
        execFileSync('git', ['add', input.path], { cwd, stdio: 'ignore' })
        execFileSync('git', ['commit', '-m', `file_edit: ${input.path}`], { cwd, stdio: 'ignore' })
      } catch {
        // 非 git 仓库或无变更时静默忽略
      }

      writeFileSync(filePath, updated, 'utf-8')
      auditLog({ action: 'file_edit', resource: filePath, result: 'allowed' })
      if (agentName) getFileLeaseManager().release(agentName, input.path)
      return { type: 'success', output: `文件已更新: ${filePath}` }
    } catch (err) {
      auditLog({ action: 'file_edit', resource: filePath, result: 'error', details: { error: String(err) } })
      if (agentName) getFileLeaseManager().release(agentName, input.path)
      return { type: 'error', message: `编辑失败: ${String(err)}` }
    }
  },
}
