import { spawn } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import { homedir } from 'os'
import { z } from 'zod'
import type { ToolDef, ToolContext } from '../core/Tool.js'
import { auditLog } from '../core/audit.js'
import { logger } from '../core/logger.js'

const log = logger.child({ component: 'bash-tool' })

const isWindows = process.platform === 'win32'

// 持久化工作目录，在当前 session 进程内跨命令调用保持 cd 状态
// 默认使用 ~/.hrids-agent/work/，由 setGlobalCwd 覆盖
function initDefaultCwd(): string {
  const dir = path.join(homedir(), '.hrids-agent', 'work')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

let persistentCwd: string = initDefaultCwd()

// 供 main.ts server 模式在处理 set_cwd 指令时同步更新
export function setGlobalCwd(dir: string) {
  persistentCwd = dir
}

export function getGlobalCwd(): string {
  return persistentCwd
}

const inputSchema = z.object({
  command: z.string().describe('要执行的 shell 命令'),
  timeout: z.number().optional().describe('超时时间（毫秒），默认 30000'),
})

// 危险命令黑名单（加强版）
const BLOCKED_PATTERNS = [
  /rm\s+-rf\s+\/(?!\w)/,           // rm -rf /
  /rm\s+-rf\s+~\s*$/,              // rm -rf ~
  /:\(\)\{.*\}/,                    // fork bomb
  /dd\s+if=.*of=\/dev\//,          // 覆写磁盘
  /mkfs\./,                         // 格式化磁盘
  />\s*\/dev\/(s|h|v|xv)d[a-z]/,  // 覆写块设备
  /chmod\s+-R\s+777\s+\//,         // 递归 777 根目录
  /chown\s+-R.*\s+\//,             // 递归 chown 根目录
  /shutdown|reboot|halt|poweroff/, // 系统关机
  /passwd\s+root/,                  // 修改 root 密码
  /curl.*\|\s*(ba)?sh/,            // 管道执行远程脚本
  /wget.*\|\s*(ba)?sh/,            // 管道执行远程脚本
]

export const BashTool: ToolDef<typeof inputSchema> = {
  name: 'bash',
  description: '在 shell 中执行命令，返回 stdout 和 stderr',
  inputSchema,
  readonly: false,

  describe(input) {
    return `执行命令: ${input.command}`
  },

  async checkPermission(input) {
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(input.command)) {
        return { granted: false, reason: `命令包含危险模式: ${pattern}` }
      }
    }
    return { granted: true }
  },

  async execute(input, ctx?: ToolContext) {
    const permCheck = await BashTool.checkPermission!(input)
    if (!permCheck.granted) {
      return { type: 'error', message: permCheck.reason }
    }

    // 记录 bash 执行审计日志
    auditLog({ action: 'bash_execute', resource: input.command.slice(0, 200), result: 'allowed' })
    log.info('执行命令', { command: input.command.slice(0, 200), cwd: persistentCwd })

    const logLine = (line: string, isStderr = false) => {
      // server 模式下 stdout 是 JSON 通信通道，不能直接写明文
      // CLI 模式下由 Ink UI 的 tool_log 事件渲染，不直接写 stdout/stderr
      if (!process.env.AGENT_SERVER_MODE && !ctx) {
        // 仅在既非 server 模式、又没有 UI 上下文时（如 -p 非交互模式）才直接输出
        const out = isStderr ? process.stderr : process.stdout
        out.write(line.endsWith('\n') ? line : line + '\n')
      }
      ctx?.onLog?.(line.trimEnd())
    }

    // 拦截纯 cd 命令，直接更新持久目录
    const cdMatch = input.command.trim().match(/^cd\s+(.+)$/)
    if (cdMatch) {
      let target = cdMatch[1].trim().replace(/^["']|["']$/g, '').trim()
      // Windows 下将正斜杠转为反斜杠，避免路径解析错误
      if (isWindows) target = target.replace(/\//g, '\\')
      // path.resolve 在 Windows 下能正确处理绝对路径（含跨盘符）和相对路径
      const newDir = path.resolve(persistentCwd, target)
      if (fs.existsSync(newDir) && fs.statSync(newDir).isDirectory()) {
        persistentCwd = newDir
        logLine(`[bash] 切换目录: ${persistentCwd}`)
        return { type: 'success', output: persistentCwd }
      } else {
        return { type: 'error', message: `目录不存在: ${newDir}` }
      }
    }

    const timeout = input.timeout ?? 30000
    const startTime = Date.now()
    logLine(`[bash] 开始执行: ${input.command}`)
    logLine(`[bash] 工作目录: ${persistentCwd}`)

    return new Promise<ReturnType<typeof BashTool.execute> extends Promise<infer R> ? R : never>((resolve) => {
      let shell: string
      let shellArgs: string[]

      if (isWindows) {
        // 用 PowerShell 代替 cmd.exe，使用 -EncodedCommand 避免特殊字符转义问题
        // Base64 编码整个脚本块，彻底规避分号/引号/空格等导致的参数解析错误
        const script = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::InputEncoding = [System.Text.Encoding]::UTF8; ${input.command}`
        const encoded = Buffer.from(script, 'utf16le').toString('base64')
        shell = 'powershell.exe'
        shellArgs = [
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          encoded,
        ]
      } else {
        shell = '/bin/sh'
        shellArgs = ['-c', input.command]
      }

      const child = spawn(shell, shellArgs, {
        cwd: persistentCwd,
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          // PowerShell / Linux 均使用 UTF-8
          PYTHONUTF8: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        // Windows 下让 Node 以 UTF-8 处理子进程 I/O
        ...(isWindows ? { windowsHide: true } : {}),
      })

      // Windows PowerShell 输出已是 UTF-8，统一用 utf-8 解码
      const decode = (chunk: Buffer): string => chunk.toString('utf-8')

      const outputChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []

      child.stdout.on('data', (chunk: Buffer) => {
        const text = decode(chunk)
        text.split('\n').filter(l => l).forEach(l => logLine(`[stdout] ${l}`))
        outputChunks.push(chunk)
      })

      child.stderr.on('data', (chunk: Buffer) => {
        let text = decode(chunk)
        // PowerShell 的 stderr 是 CLIXML 格式，提取其中的纯文本错误信息
        if (text.includes('#< CLIXML')) {
          const match = text.match(/<S S="Error">([\s\S]*?)<\/S>/g)
          if (match) {
            text = match
              .map(s => s.replace(/<S S="Error">|<\/S>/g, '').replace(/_x000D__x000A_/g, '\n').trim())
              .join('\n')
          } else {
            text = text.replace(/<[^>]+>/g, '').replace(/^#< CLIXML\s*/m, '').trim()
          }
        }
        const trimmed = text.trim()
        if (!trimmed) return
        trimmed.split('\n').filter(l => l).forEach(l => logLine(`[stderr] ${l}`, true))
        // stderr 单独收集，不混入 outputChunks，避免污染 CLI 回复内容
        stderrChunks.push(Buffer.from(trimmed, 'utf-8'))
      })

      const timer = setTimeout(() => {
        logLine(`[bash] 超时 (${timeout}ms)，强制终止`)
        child.kill()
        resolve({ type: 'error', message: `命令超时（${timeout}ms）` })
      }, timeout)

      child.on('close', (code) => {
        clearTimeout(timer)
        const elapsed = Date.now() - startTime
        logLine(`[bash] 完成，退出码: ${code}，耗时: ${elapsed}ms`)
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
        logLine(`[bash] 启动失败: ${err.message}`)
        resolve({ type: 'error', message: `启动失败: ${err.message}` })
      })
    })
  },
}
