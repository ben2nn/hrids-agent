import { readFileSync, writeFileSync, existsSync } from 'fs'
import { resolve, join } from 'path'

/** 检查目录是否在 git 仓库中（向上查找 .git 目录） */
function isGitRepo(dir: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: dir, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
import { execFileSync } from 'child_process'
import { z } from 'zod'
import { buildTool } from '../core/Tool.js'
import { auditLog } from '../core/audit.js'
import { checkWritePath } from '../core/pathSafety.js'
import { getGlobalCwd } from '../core/cwd.js'
import { getCurrentAgentName } from '../core/coordinator/agentContext.js'
import { getFileLeaseManager } from '../core/FileLeaseManager.js'
import { invalidateFileCache } from './FileReadTool.js'

const inputSchema = z.object({
  path: z.string().describe('要编辑的文件路径'),
  oldStr: z.string().describe('要替换的原始字符串（必须在文件中唯一存在）'),
  newStr: z.string().describe('替换后的新字符串'),
})

export const FileEditTool = buildTool({
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
      // 用 indexOf 循环计数，避免 split() 在大文件上创建大量临时数组
      let count = 0
      let pos = 0
      while ((pos = content.indexOf(input.oldStr, pos)) !== -1) {
        count++
        pos += input.oldStr.length
      }

      if (count === 0) {
        return { type: 'error', message: '未找到要替换的字符串' }
      }
      if (count > 1) {
        return { type: 'error', message: `找到 ${count} 处匹配，oldStr 必须唯一` }
      }

      const updated = content.replace(input.oldStr, input.newStr)

      // 写入前先将当前状态提交到 git，使 HEAD 保留修改前内容
      // 仅在 git 仓库中执行，避免非仓库目录下无谓的 30s 超时等待
      if (isGitRepo(cwd)) {
        try {
          execFileSync('git', ['add', input.path], { cwd, stdio: 'ignore' })
          execFileSync('git', ['commit', '-m', `file_edit: ${input.path}`], { cwd, stdio: 'ignore' })
        } catch (gitErr) {
          if (gitErr instanceof Error && !gitErr.message.includes('not a git repository')) {
            process.stderr.write(`[FileEditTool] git 备份失败: ${gitErr.message}\n`)
          }
        }
      }

      writeFileSync(filePath, updated, 'utf-8')
      // 编辑成功，清除文件读取缓存
      invalidateFileCache(filePath)
      auditLog({ action: 'file_edit', resource: filePath, result: 'allowed' })
      if (agentName) getFileLeaseManager().release(agentName, input.path)
      return { type: 'success', output: `文件已更新: ${filePath}` }
    } catch (err) {
      auditLog({ action: 'file_edit', resource: filePath, result: 'error', details: { error: String(err) } })
      if (agentName) getFileLeaseManager().release(agentName, input.path)
      return { type: 'error', message: `编辑失败: ${String(err)}` }
    }
  },
})
