/**
 * Bash 工具 —— shell:false 架构，跨平台统一
 *
 * 对外统一命名为 'bash'，LLM 无需感知平台差异。
 * 底层使用 shell:false 直接 spawn，不调用真实 shell，
 * 通过 quote-aware tokenizer 解析命令，白名单机制控制自动执行。
 *
 * 平台差异仅在安全规则层：
 * - BLOCKED_PATTERNS：POSIX + Windows 危险命令黑名单
 * - cd 拦截：POSIX 用 cd，Windows 额外支持 Set-Location
 * - 删除目标提取：POSIX 用 rm，Windows 额外支持 Remove-Item
 *
 * 执行层（shell/exec.ts）已统一处理 Windows 兼容：
 * - PATHEXT 解析、cmd.exe 包装 .cmd/.bat、PowerShell UTF-8 注入
 */

import * as path from 'path'
import * as fs from 'fs'
import { z } from 'zod'
import type { ToolDef, ToolContext } from '../core/Tool.js'
import { auditLog } from '../core/audit.js'
import { logger } from '../core/logger.js'
import { getGlobalCwd, setGlobalCwd } from '../core/cwd.js'
import { isDangerousRemovalPath } from '../core/pathSafety.js'
import { checkCommandSafetyPermission } from '../core/CommandSafety.js'
import { clearFileCache } from './FileReadTool.js'
import { isCommandAllowed, isAllowed } from './shell/parse.js'
import { runCommand } from './shell/exec.js'

// 向后兼容：重新导出 cwd 管理（App.tsx 等模块依赖）
export { getGlobalCwd, setGlobalCwd, runWithCwd } from '../core/cwd.js'

const log = logger.child({ component: 'bash-tool' })

const isWin = process.platform === 'win32'

const inputSchema = z.object({
  command: z.string().describe('要执行的 shell 命令'),
  timeout: z.number().optional().describe(
    '超时时间（毫秒），默认 120000（2分钟）。' +
    '长时间任务请主动设置更大的值：\n' +
    '  - npm install / pip install 等依赖安装：600000（10分钟）\n' +
    '  - cargo build / tsc / webpack 等编译：1800000（30分钟）\n' +
    '  - 大文件下载 / 爬虫任务：3600000（60分钟）\n' +
    '  - 不确定时宁可设大，超时会强制终止进程',
  ),
})

// ── 危险命令黑名单（硬编码，始终生效） ──────────────────────────

// 通用（跨平台）
const BLOCKED_COMMON = [
  /shutdown|reboot|halt|poweroff/i,
  /curl.*\|\s*(ba)?sh/i,
  /wget.*\|\s*(ba)?sh/i,
]

// POSIX 专用
const BLOCKED_POSIX = [
  /rm\s+-rf\s+\/(?!\w)/,
  /rm\s+(-[rRf]\s*){2,}\s+\/(?!\w)/,
  /rm\s+--recursive\s+--force\s+\/(?!\w)/,
  /rm\s+-rf\s+~\s*$/,
  /:\(\)\{.*\}/,                    // fork bomb
  /dd\s+if=.*of=\/dev\//,
  /mkfs\./,
  />\s*\/dev\/(s|h|v|xv)d[a-z]/,
  /chmod\s+-R\s+777\s+\//,
  /chown\s+-R.*\s+\//,
  /passwd\s+root/,
  /\bsudo\s+rm\s+-rf/,
  /\bsudo\s+rm\s+--recursive\s+--force/,
  /\bsudo\s+dd\b/,
  /\bsudo\s+mkfs\b/,
  /\bsudo\s+chmod\s+-R\s+777/,
  /\bnohup\b.*&\s*$|&\s*disown/,
  /\bscreen\b|\btmux\b/,
  /\bkillall\b|\bpkill\b/,
  /\bcrontab\s+-[re]\b/,
  /\biptables\b|\bnftables\b/,
  /\bsystemctl\s+(stop|disable|mask)\b/,
]

// Windows 专用
const BLOCKED_WIN32 = [
  /Remove-Item\s+-Recurse\s+-Force\s+[A-Za-z]:[/\\]/i,
  /Remove-Item\s+-Recurse\s+-Force\s+\/$/i,
  /Format-Volume/i,
  /Stop-Computer|Restart-Computer/i,
  /Set-ExecutionPolicy\s+Unrestricted/i,
  /Invoke-Expression.*http/i,
  /iex.*http/i,
  /\bNet\s+user\s+.*\/add/i,
  /shutdown\s+\/[srh]/i,
]

const BLOCKED_PATTERNS = isWin
  ? [...BLOCKED_COMMON, ...BLOCKED_WIN32, ...BLOCKED_POSIX]
  : [...BLOCKED_COMMON, ...BLOCKED_POSIX]

// ── 删除目标提取 ──────────────────────────────────────────────

/** 提取 rm / Remove-Item 命令的目标路径 */
function extractRemovalTargets(command: string): string[] {
  const targets: string[] = []
  // POSIX: rm
  const rmMatch = command.match(/\brm\s+(?:(?:-[a-zA-Z]+|--[a-zA-Z-]+)\s+)*(.+)$/)
  if (rmMatch) {
    targets.push(...rmMatch[1].trim().split(/\s+/).filter(Boolean))
  }
  // Windows: Remove-Item
  if (isWin) {
    const riMatch = command.match(/Remove-Item\s+(?:(?:-[a-zA-Z]+\s+(?:\S+\s+)?)*)\s*([^\s-][^\s]*)/i)
    if (riMatch) {
      targets.push(riMatch[1].trim().replace(/^["']|["']$/g, ''))
    }
  }
  return targets
}

// ── 工具定义 ──────────────────────────────────────────────────

export const BashTool: ToolDef<typeof inputSchema> = {
  name: 'bash',
  description: `执行 shell 命令。适合运行脚本、安装依赖、git 操作、系统管理等无法用专用工具完成的任务。
适用场景：运行程序/脚本、安装包（pip/npm install）、git 操作、进程管理、网络诊断
不适用场景：读取文件 → 用 file_read | 搜索文件 → 用 glob | 搜索内容 → 用 grep
             编辑文件 → 用 file_edit | 创建文件 → 用 file_write
             问候/闲聊/简单问答 → 不需要任何工具，直接回复

注意：本工具使用 shell:false 模式，不调用真实 shell。
• 支持链式操作符 | / || / && / ;（每段独立白名单检查）
• 支持文件重定向 > / >> / < / 2> / 2>> / 2>&1 / &>
• 不支持：后台 &、heredoc <<、命令替换 $()、子 shell ()、$VAR 展开、glob 展开
• cd 不会在链式命令中生效，使用命令自带的 cwd 参数（如 git -C <dir>）`,
  inputSchema,
  readonly: false,
  capabilities: { requiresShell: true, parallelSafe: false, maxExecutionTimeMs: 120_000 },

  readOnlyCheck(input) {
    const cmd = input.command.trim()
    if (!cmd) return false
    return isCommandAllowed(cmd)
  },

  describe(input) {
    return `执行命令: ${input.command}`
  },

  getRuleContent(input) {
    return input.command
  },

  async checkPermission(input) {
    const normalized = input.command.replace(/[\r\n]+/g, ' ')

    // 危险命令黑名单
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(normalized)) {
        return { granted: false, reason: `命令包含危险模式: ${pattern}` }
      }
    }

    // 危险删除路径检测
    for (const target of extractRemovalTargets(normalized)) {
      if (isDangerousRemovalPath(target)) {
        return { granted: false, reason: `危险的删除目标路径: ${target}` }
      }
    }

    // 命令安全分析（可配置）
    return checkCommandSafetyPermission(normalized)
  },

  async execute(input, ctx?: ToolContext) {
    auditLog({ action: 'bash_execute', resource: input.command.slice(0, 200), result: 'allowed' })
    const cwd = getGlobalCwd()
    log.info('执行命令', { command: input.command.slice(0, 200), cwd })

    const logLine = (line: string, isStderr = false) => {
      if (!process.env.AGENT_SERVER_MODE && !ctx) {
        const out = isStderr ? process.stderr : process.stdout
        out.write(line.endsWith('\n') ? line : line + '\n')
      }
      ctx?.onLog?.(line.trimEnd())
    }

    // cd / Set-Location 拦截
    // 匹配：cd <dir> | cd <dir>; rest | cd <dir> && rest
    // Windows 额外支持 Set-Location
    const cdPattern = isWin
      ? /^(?:cd|Set-Location)\s+((?:"[^"]*"|'[^']*'|[^;&|])+?)(?:\s*(?:;|&&)\s*(.+))?$/i
      : /^cd\s+((?:"[^"]*"|'[^']*'|[^;&|])+?)(?:\s*(?:;|&&)\s*(.+))?$/
    const cdMatch = input.command.trim().match(cdPattern)
    if (cdMatch) {
      let target = cdMatch[1].trim().replace(/^["']|["']$/g, '').trim()
      if (isWin) target = target.replace(/\//g, '\\')
      const rest = cdMatch[2]?.trim()
      const newDir = path.resolve(cwd, target)
      if (fs.existsSync(newDir) && fs.statSync(newDir).isDirectory()) {
        setGlobalCwd(newDir)
        logLine(`[bash] 切换目录: ${newDir}`)
        if (!rest) {
          return { type: 'success', output: newDir }
        }
        const restInput = { command: rest, timeout: input.timeout }
        const permCheck = await BashTool.checkPermission?.(restInput)
        if (permCheck && !permCheck.granted) {
          return { type: 'error', message: permCheck.reason }
        }
        logLine(`[bash] 在新目录下执行: ${rest}`)
        return BashTool.execute(restInput, ctx)
      } else {
        return { type: 'error', message: `目录不存在: ${newDir}` }
      }
    }

    const timeout = input.timeout ?? 120_000
    const timeoutSec = Math.max(1, Math.min(3600, Math.ceil(timeout / 1000)))
    const startTime = Date.now()
    logLine(`[bash] 开始执行: ${input.command}`)
    logLine(`[bash] 工作目录: ${cwd}`)

    try {
      const result = await runCommand(input.command, {
        cwd,
        timeoutSec,
        maxOutputChars: 32_000,
      })

      const elapsed = Date.now() - startTime
      logLine(`[bash] 完成，退出码: ${result.exitCode}，耗时: ${elapsed}ms`)

      if (result.exitCode === 0) {
        if (!isAllowed(input.command.trim())) {
          clearFileCache()
        }
        return { type: 'success', output: result.output || '（命令执行成功，无输出）' }
      } else {
        if (result.timedOut) {
          return { type: 'error', message: `命令超时（${timeout}ms）` }
        }
        return { type: 'error', message: result.output || `命令退出码: ${result.exitCode}` }
      }
    } catch (err: any) {
      const elapsed = Date.now() - startTime
      logLine(`[bash] 执行失败: ${err.message}，耗时: ${elapsed}ms`)
      return { type: 'error', message: `执行失败: ${err.message}` }
    }
  },
}
