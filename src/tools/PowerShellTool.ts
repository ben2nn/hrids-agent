// PowerShell 工具 —— 专用于 Windows 环境下的命令执行
// Linux/macOS 请使用 BashTool
import { spawn } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import { z } from 'zod'
import type { ToolDef, ToolContext } from '../core/Tool.js'
import { auditLog } from '../core/audit.js'
import { logger } from '../core/logger.js'
import { getGlobalCwd, setGlobalCwd } from '../core/cwd.js'

const log = logger.child({ component: 'powershell-tool' })

import { isDangerousRemovalPath } from '../core/pathSafety.js'

const inputSchema = z.object({
  command: z.string().describe('要执行的 PowerShell 命令'),
  timeout: z.number().optional().describe('超时时间（毫秒），默认 60000。长时间任务（如编译、爬虫）可设置更大的值，例如 1800000（30分钟）'),
})

// 危险命令黑名单（Windows/PowerShell）
const BLOCKED_PATTERNS = [
  /Remove-Item\s+-Recurse\s+-Force\s+[Cc]:\\/i,  // 递归删除 C 盘
  /Remove-Item\s+-Recurse\s+-Force\s+\/$/,         // 递归删除根目录
  /Format-Volume/i,                                 // 格式化磁盘
  /Stop-Computer|Restart-Computer/i,               // 关机/重启
  /Set-ExecutionPolicy\s+Unrestricted/i,           // 放开执行策略
  /Invoke-Expression.*http/i,                       // 远程执行脚本（iex）
  /iex.*http/i,                                     // iex 简写
  /\bNet\s+user\s+.*\/add/i,                       // 添加系统用户
  /shutdown\s+\/[srh]/i,                            // cmd 风格关机
]

// 提取 Remove-Item 命令的目标路径，用于危险路径检测
function extractRemovalTarget(command: string): string | null {
  const match = command.match(/Remove-Item\s+(?:-[a-zA-Z]+\s+)*(.+?)(?:\s+-|$)/i)
  if (match) return match[1].trim().replace(/^["']|["']$/g, '')
  return null
}

export const PowerShellTool: ToolDef<typeof inputSchema> = {
  name: 'bash',  // 对外统一命名为 bash，LLM 无需感知平台差异；实际由 powershell.exe 执行
  description: '执行 shell 命令（当前平台：Windows PowerShell），返回 stdout 和 stderr。',
  inputSchema,
  readonly: false,

  describe(input) {
    return `执行 PowerShell 命令: ${input.command}`
  },

  getRuleContent(input) {
    return input.command
  },

  async checkPermission(input) {
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(input.command)) {
        return { granted: false, reason: `命令包含危险模式: ${pattern}` }
      }
    }
    // 危险删除路径检测
    const removalTarget = extractRemovalTarget(input.command)
    if (removalTarget && isDangerousRemovalPath(removalTarget)) {
      return { granted: false, reason: `危险的删除目标路径: ${removalTarget}` }
    }
    return { granted: true }
  },

  async execute(input, ctx?: ToolContext) {
    const persistentCwd = getGlobalCwd()

    // 记录审计日志
    auditLog({ action: 'powershell_execute', resource: input.command.slice(0, 200), result: 'allowed' })
    log.info('执行 PowerShell 命令', { command: input.command.slice(0, 200), cwd: persistentCwd })

    const logLine = (line: string, isStderr = false) => {
      // server 模式下 stdout 是 JSON 通信通道，不能直接写明文
      if (!process.env.AGENT_SERVER_MODE && !ctx) {
        const out = isStderr ? process.stderr : process.stdout
        out.write(line.endsWith('\n') ? line : line + '\n')
      }
      ctx?.onLog?.(line.trimEnd())
    }

    // 拦截纯 cd / Set-Location 命令，直接更新持久目录
    const cdMatch = input.command.trim().match(/^(?:cd|Set-Location)\s+(.+)$/i)
    if (cdMatch) {
      // 将正斜杠转为反斜杠，兼容 Windows 路径
      let target = cdMatch[1].trim().replace(/^["']|["']$/g, '').trim()
      target = target.replace(/\//g, '\\')
      const newDir = path.resolve(persistentCwd, target)
      if (fs.existsSync(newDir) && fs.statSync(newDir).isDirectory()) {
        setGlobalCwd(newDir)
        logLine(`[powershell] 切换目录: ${newDir}`)
        return { type: 'success', output: newDir }
      } else {
        return { type: 'error', message: `目录不存在: ${newDir}` }
      }
    }

    const timeout = input.timeout ?? 60000
    const startTime = Date.now()
    logLine(`[powershell] 开始执行: ${input.command}`)
    logLine(`[powershell] 工作目录: ${persistentCwd}`)

    return new Promise<ReturnType<typeof PowerShellTool.execute> extends Promise<infer R> ? R : never>((resolve) => {
      // 用 -EncodedCommand 避免特殊字符转义问题
      // Base64 编码整个脚本块，彻底规避分号/引号/空格等导致的参数解析错误
      const script = [
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        '[Console]::InputEncoding = [System.Text.Encoding]::UTF8',
        '$OutputEncoding = [System.Text.Encoding]::UTF8',
        input.command,
      ].join('; ')
      const encoded = Buffer.from(script, 'utf16le').toString('base64')

      const child = spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        encoded,
      ], {
        cwd: persistentCwd,
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })

      const decodeStderr = (chunk: Buffer): string => {
        // 跳过 UTF-8 BOM（0xEF 0xBB 0xBF），如有
        const data = (chunk.length >= 3 && chunk[0] === 0xEF && chunk[1] === 0xBB && chunk[2] === 0xBF)
          ? chunk.slice(3)
          : chunk
        return data.toString('utf-8')
      }

      const outputChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []

      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8')
        text.split('\n').filter(l => l).forEach(l => logLine(`[stdout] ${l}`))
        outputChunks.push(chunk)
      })

      child.stderr.on('data', (chunk: Buffer) => {
        let text = decodeStderr(chunk)

        // PowerShell 的 stderr 是 CLIXML 格式，提取其中的纯文本错误信息
        if (text.includes('#< CLIXML')) {
          const match = text.match(/<S S="Error">([\s\S]*?)<\/S>/g)
          if (match) {
            text = match
              .map(s => s.replace(/<S S="Error">|<\/S>/g, '').replace(/_x000D__x000A_/g, '\n').trim())
              .join('\n')
          } else {
            // 非 Error 类型的 CLIXML（进度条、状态等）对用户无意义，直接丢弃
            text = ''
          }
        }
        // PowerShell 进度条/模块加载信息以 <Objs ...> XML 开头，直接丢弃
        if (text.trimStart().startsWith('<Objs ')) {
          text = ''
        }

        const trimmed = text.trim()
        if (!trimmed) return
        trimmed.split('\n').filter(l => l).forEach(l => logLine(`[stderr] ${l}`, true))
        // stderr 单独收集，不混入 outputChunks，避免污染 CLI 回复内容
        stderrChunks.push(Buffer.from(trimmed, 'utf-8'))
      })

      const timer = setTimeout(() => {
        logLine(`[powershell] 超时 (${timeout}ms)，强制终止`)
        child.kill()
        resolve({ type: 'error', message: `命令超时（${timeout}ms）` })
      }, timeout)

      child.on('close', (code) => {
        clearTimeout(timer)
        const elapsed = Date.now() - startTime
        logLine(`[powershell] 完成，退出码: ${code}，耗时: ${elapsed}ms`)
        const output = Buffer.concat(outputChunks).toString('utf-8')
        const stderrOutput = Buffer.concat(stderrChunks).toString('utf-8')
        if (code === 0) {
          resolve({ type: 'success', output: output || '（命令执行成功，无输出）' })
        } else {
          // 非零退出码时优先用 stderr 作为错误信息，stdout 作为补充
          const errorMsg = stderrOutput || output || `命令退出码: ${code}`
          resolve({ type: 'error', message: errorMsg })
        }
      })

      child.on('error', (err) => {
        clearTimeout(timer)
        logLine(`[powershell] 启动失败: ${err.message}`)
        resolve({ type: 'error', message: `启动失败: ${err.message}` })
      })
    })
  },
}
