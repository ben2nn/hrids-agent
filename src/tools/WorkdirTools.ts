import { z } from 'zod'
import { readdirSync, statSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import type { ToolDef, ToolContext, ToolResult } from '../core/Tool.js'
import { getGlobalCwd, ensureWorkDirForCurrentCwd } from '../core/cwd.js'
import { getConfigDir } from '../core/Config.js'
import { logger } from '../core/logger.js'

const log = logger.child({ component: 'workdir-tools' })

// ── workdir_init ──────────────────────────────────────────────────────────────

const initSchema = z.object({})

export const WorkdirInitTool: ToolDef<typeof initSchema> = {
  name: 'workdir_init',
  description: `为当前会话创建工作目录（含 git 仓库初始化）。
当你执行任务需要存储文件、运行代码、或进行任何文件操作时，先调用此工具创建工作空间。
如果目录已存在则直接返回路径，不会重复创建。
纯对话类任务无需调用此工具。`,
  inputSchema: initSchema,
  readonly: false,

  async execute(_input, _ctx?: ToolContext): Promise<ToolResult> {
    const cwd = getGlobalCwd()
    const created = ensureWorkDirForCurrentCwd()

    if (created) {
      log.info('工作目录已创建', { cwd })
      return { type: 'success', output: `工作目录已创建: ${cwd}` }
    }
    return { type: 'success', output: `工作目录已存在: ${cwd}` }
  },
}

// ── workdir_deliver ───────────────────────────────────────────────────────────

const deliverSchema = z.object({
  summary: z.string().describe('任务完成摘要'),
  outputs: z.array(z.string()).describe('产出文件路径列表（相对于工作目录）'),
})

export const WorkdirDeliverTool: ToolDef<typeof deliverSchema> = {
  name: 'workdir_deliver',
  description: `整理当前工作目录中的产出物，生成交付摘要。
在任务完成时调用，将结果汇总呈现给用户。`,
  inputSchema: deliverSchema,
  readonly: true,

  async execute(input, _ctx?: ToolContext): Promise<ToolResult> {
    const cwd = getGlobalCwd()
    const lines = [`## 任务完成\n${input.summary}\n`, `### 产出物`]

    for (const output of input.outputs) {
      const absPath = join(cwd, output)
      const exists = existsSync(absPath)
      lines.push(`- ${output}${exists ? '' : ' (未找到)'}`)
    }

    lines.push(`\n工作目录: ${cwd}`)
    return { type: 'success', output: lines.join('\n') }
  },
}

// ── workdir_cleanup ───────────────────────────────────────────────────────────

const cleanupSchema = z.object({})

export const WorkdirCleanupTool: ToolDef<typeof cleanupSchema> = {
  name: 'workdir_cleanup',
  description: `清理当前会话的工作目录。
仅在用户明确要求时调用。会先检查目录是否存在。`,
  inputSchema: cleanupSchema,
  readonly: false,
  isDestructive: true,

  async execute(_input, _ctx?: ToolContext): Promise<ToolResult> {
    const cwd = getGlobalCwd()

    if (!existsSync(cwd)) {
      return { type: 'success', output: `工作目录不存在: ${cwd}，无需清理` }
    }

    // 安全检查：只允许清理 work/ 下的子目录
    const workRoot = join(getConfigDir(), 'work')
    if (!cwd.startsWith(workRoot)) {
      return { type: 'error', message: `安全限制：只能清理 ${workRoot} 下的工作目录` }
    }

    try {
      rmSync(cwd, { recursive: true, force: true })
      log.info('工作目录已清理', { cwd })
      return { type: 'success', output: `工作目录已清理: ${cwd}` }
    } catch (err) {
      return { type: 'error', message: `清理失败: ${String(err)}` }
    }
  },
}

// ── workdir_list ──────────────────────────────────────────────────────────────

const listSchema = z.object({})

export const WorkdirListTool: ToolDef<typeof listSchema> = {
  name: 'workdir_list',
  description: `列出所有工作目录及其信息，方便用户管理和查找历史工作空间。`,
  inputSchema: listSchema,
  readonly: true,

  async execute(_input, _ctx?: ToolContext): Promise<ToolResult> {
    const workRoot = join(getConfigDir(), 'work')

    if (!existsSync(workRoot)) {
      return { type: 'success', output: '暂无工作目录' }
    }

    try {
      const entries = readdirSync(workRoot)
        .filter(f => {
          try { return statSync(join(workRoot, f)).isDirectory() } catch { return false }
        })
        .sort()
        .reverse() // 最新的在前

      if (entries.length === 0) {
        return { type: 'success', output: '暂无工作目录' }
      }

      const lines = entries.map(dir => {
        const fullPath = join(workRoot, dir)
        try {
          const stat = statSync(fullPath)
          const mtime = stat.mtime.toLocaleString('zh-CN')
          return `- ${dir}  (最后修改: ${mtime})`
        } catch {
          return `- ${dir}`
        }
      })

      return { type: 'success', output: `## 工作目录列表（共 ${entries.length} 个）\n\n${lines.join('\n')}` }
    } catch (err) {
      return { type: 'error', message: `读取失败: ${String(err)}` }
    }
  },
}
