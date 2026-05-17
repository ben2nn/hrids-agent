import { readdirSync, statSync, existsSync } from 'fs'
import { join } from 'path'
import type { SlashCommand, CommandResult } from '../../core/CommandRegistry.js'
import { getGlobalCwd, ensureWorkDirForCurrentCwd } from '../../core/cwd.js'
import { getConfigDir } from '../../core/Config.js'

export function createWorkdirCommands(): SlashCommand[] {
  return [
    {
      name: 'workdir',
      description: '工作目录管理',
      argumentHint: '<init|list|deliver|cleanup> [参数...]',
      async execute(args): Promise<CommandResult> {
        const parts = args.trim().split(/\s+/)
        const sub = (parts[0] || '').toLowerCase()
        const rest = parts.slice(1).join(' ')

        switch (sub) {
          case 'init':
            return cmdInit()
          case 'list':
            return cmdList()
          case 'deliver':
            return cmdDeliver(rest)
          case 'cleanup':
            return cmdCleanup()
          default:
            return {
              type: 'message',
              text: [
                '用法: /workdir <子命令>',
                '',
                '  init             创建工作目录（含 git 仓库）',
                '  list             列出所有工作目录',
                '  deliver <摘要>   整理产出物并生成交付摘要',
                '  cleanup          清理当前工作目录',
              ].join('\n'),
            }
        }
      },
    },
  ]
}

function cmdInit(): CommandResult {
  const cwd = getGlobalCwd()
  const created = ensureWorkDirForCurrentCwd()
  return {
    type: 'message',
    text: created ? `工作目录已创建: ${cwd}` : `工作目录已存在: ${cwd}`,
  }
}

function cmdList(): CommandResult {
  const workRoot = join(getConfigDir(), 'work')

  if (!existsSync(workRoot)) {
    return { type: 'message', text: '暂无工作目录' }
  }

  const entries = readdirSync(workRoot)
    .filter(f => {
      try { return statSync(join(workRoot, f)).isDirectory() } catch { return false }
    })
    .sort()
    .reverse()

  if (entries.length === 0) {
    return { type: 'message', text: '暂无工作目录' }
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

  return { type: 'message', text: `## 工作目录列表（共 ${entries.length} 个）\n\n${lines.join('\n')}` }
}

function cmdDeliver(summary: string): CommandResult {
  if (!summary.trim()) {
    return { type: 'message', text: '用法: /workdir deliver <任务完成摘要>' }
  }
  return {
    type: 'inject',
    prompt: `请调用 workdir_deliver 工具，参数 summary 为：${summary}，outputs 列出本次任务的产出文件路径（相对于工作目录）。`,
    allowedTools: ['workdir_deliver'],
  }
}

function cmdCleanup(): CommandResult {
  return {
    type: 'inject',
    prompt: '请调用 workdir_cleanup 工具清理当前工作目录。',
    allowedTools: ['workdir_cleanup'],
  }
}
