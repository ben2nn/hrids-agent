import { spawn } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import { z } from 'zod'
import type { ToolDef, ToolContext } from '../core/Tool.js'
import { auditLog } from '../core/audit.js'
import { logger } from '../core/logger.js'
import { isDangerousRemovalPath } from '../core/pathSafety.js'
import { checkCommandSafetyPermission } from '../core/CommandSafety.js'
import { clearFileCache } from './FileReadTool.js'

// cwd 管理已迁移到 src/core/cwd.ts，此处重新导出保持向后兼容
export { getGlobalCwd, setGlobalCwd, runWithCwd } from '../core/cwd.js'
import { getGlobalCwd, setGlobalCwd } from '../core/cwd.js'

const log = logger.child({ component: 'bash-tool' })

const inputSchema = z.object({
  command: z.string().describe('要执行的 shell 命令（bash/sh 语法）'),
  timeout: z.number().optional().describe(
    '超时时间（毫秒），默认 120000（2分钟）。' +
    '长时间任务请主动设置更大的值：\n' +
    '  - npm install / pip install 等依赖安装：600000（10分钟）\n' +
    '  - cargo build / tsc / webpack 等编译：1800000（30分钟）\n' +
    '  - 大文件下载 / 爬虫任务：3600000（60分钟）\n' +
    '  - 不确定时宁可设大，超时会强制终止进程'
  ),
})

// 只读命令白名单（plan-mode 下允许执行）
// 排除链式命令（;、&&、||、|、`、$()），防止 ls; rm -rf / 绕过
const READONLY_COMMANDS_RE = /^(ls|cat|head|tail|wc|file|stat|which|whereis|type|echo|printf|date|whoami|hostname|uname|pwd|env|printenv|set|alias|history|df|du|free|uptime|id|groups|finger|last|lastlog|w|who|ps|top|htop|pgrep|lsof|netstat|ss|ip|ifconfig|ping|traceroute|dig|nslookup|host)\b/
const CHAIN_OPERATORS = /[;&|`]|&&|\|\||\$\(/
function isReadonlyCommand(cmd: string): boolean {
  if (CHAIN_OPERATORS.test(cmd)) return false
  return READONLY_COMMANDS_RE.test(cmd)
}

// 危险命令黑名单（Linux/macOS）
const BLOCKED_PATTERNS = [
  /rm\s+-rf\s+\/(?!\w)/,           // rm -rf /
  /rm\s+(-[rRf]\s*){2,}\s*\/(?!\w)/, // rm -r -f / （分散 flags）
  /rm\s+--recursive\s+--force\s+\/(?!\w)/, // rm --recursive --force /
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
  // 追加：更多高危操作
  /\bsudo\s+rm\s+-rf/,             // sudo rm -rf
  /\bsudo\s+rm\s+--recursive\s+--force/, // sudo rm --recursive --force
  /\bsudo\s+dd\b/,                 // sudo dd
  /\bsudo\s+mkfs\b/,               // sudo mkfs
  /\bsudo\s+chmod\s+-R\s+777/,    // sudo chmod -R 777
  /\bnohup\b.*&\s*$|&\s*disown/,  // 后台脱离进程（可能逃逸超时控制）
  /\bscreen\b|\btmux\b/,           // 会话复用（可能逃逸超时控制）
  /\bkillall\b|\bpkill\b/,         // 批量杀进程（可能误杀 agent 自身）
  /\bcrontab\s+-[re]\b/,           // 修改 crontab（应通过 schedule_cron 工具）
  /\biptables\b|\bnftables\b/,     // 修改防火墙规则
  /\bsystemctl\s+(stop|disable|mask)\b/, // 停止系统服务
]

// 提取 rm/rmdir 命令的所有目标路径，用于危险路径检测
// 支持短选项（-rf）、长选项（--recursive --force）和分散 flags（-r -f）
function extractRemovalTargets(command: string): string[] {
  const match = command.match(/\brm\s+(?:(?:-[a-zA-Z]+|--[a-zA-Z-]+)\s+)*(.+)$/)
  if (!match) return []
  return match[1].trim().split(/\s+/).filter(Boolean)
}

export const BashTool: ToolDef<typeof inputSchema> = {
  name: 'bash',
  description: `执行 shell 命令。适合运行脚本、安装依赖、git 操作、系统管理等无法用专用工具完成的任务。
适用场景：运行程序/脚本、安装包（pip/npm install）、git 操作、进程管理、网络诊断
不适用场景：读取文件 → 用 file_read | 搜索文件 → 用 glob | 搜索内容 → 用 grep
             编辑文件 → 用 file_edit | 创建文件 → 用 file_write
             问候/闲聊/简单问答 → 不需要任何工具，直接回复`,
  inputSchema,
  readonly: false,
  capabilities: { requiresShell: true, parallelSafe: false, maxExecutionTimeMs: 120_000 },

  /**
   * 动态只读检查：白名单命令在 plan-mode 下视为只读
   *  readOnlyCheck 设计
   */
  readOnlyCheck(input) {
    const cmd = input.command.trim()
    return isReadonlyCommand(cmd)
  },

  describe(input) {
    return `执行命令: ${input.command}`
  },

  getRuleContent(input) {
    return input.command
  },

  async checkPermission(input) {
    // 危险命令黑名单（硬编码，始终生效）
    // 将换行符替换为空格后再匹配，防止跨行绕过 BLOCKED_PATTERNS
    const normalized = input.command.replace(/[\r\n]+/g, ' ')
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(normalized)) {
        return { granted: false, reason: `命令包含危险模式: ${pattern}` }
      }
    }
    // 危险删除路径检测（检查所有目标路径）
    for (const target of extractRemovalTargets(input.command)) {
      if (isDangerousRemovalPath(target)) {
        return { granted: false, reason: `危险的删除目标路径: ${target}` }
      }
    }

    // 命令安全分析（可配置，补充规则覆盖 high/medium 级别）
    return checkCommandSafetyPermission(input.command)
  },

  async execute(input, ctx?: ToolContext) {
    // 记录 bash 执行审计日志
    auditLog({ action: 'bash_execute', resource: input.command.slice(0, 200), result: 'allowed' })
    const cwd = getGlobalCwd()
    log.info('执行命令', { command: input.command.slice(0, 200), cwd })

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

    // 拦截 cd 命令（纯 cd 或 "cd dir; rest" / "cd dir && rest" 复合形式）
    // 匹配：cd <dir>  |  cd <dir>; rest  |  cd <dir> && rest
    const cdMatch = input.command.trim().match(/^cd\s+((?:"[^"]*"|'[^']*'|[^;&|])+?)(?:\s*(?:;|&&)\s*(.+))?$/)
    if (cdMatch) {
      const target = cdMatch[1].trim().replace(/^["']|["']$/g, '').trim()
      const rest = cdMatch[2]?.trim()
      const newDir = path.resolve(cwd, target)
      if (fs.existsSync(newDir) && fs.statSync(newDir).isDirectory()) {
        setGlobalCwd(newDir)
        logLine(`[bash] 切换目录: ${newDir}`)
        if (!rest) {
          // 纯 cd，直接返回
          return { type: 'success', output: newDir }
        }
        // 有后续命令，先对 rest 部分执行安全检查
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

    const timeout = input.timeout ?? 120000  // 默认 2 分钟（原 60s 太短，下载/编译场景常超时）
    const startTime = Date.now()
    logLine(`[bash] 开始执行: ${input.command}`)
    logLine(`[bash] 工作目录: ${cwd}`)

    return new Promise<ReturnType<typeof BashTool.execute> extends Promise<infer R> ? R : never>((resolve) => {
      const child = spawn('/bin/sh', ['-c', input.command], {
        cwd,
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,  // 创建进程组，超时时可杀死整个组
      })

      const outputChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []

      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8')
        text.split('\n').filter(l => l).forEach(l => logLine(`[stdout] ${l}`))
        outputChunks.push(chunk)
      })

      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8').trim()
        if (!text) return
        text.split('\n').filter(l => l).forEach(l => logLine(`[stderr] ${l}`, true))
        stderrChunks.push(Buffer.from(text, 'utf-8'))
      })

      const timer = setTimeout(() => {
        logLine(`[bash] 超时 (${timeout}ms)，强制终止进程组`)
        try { process.kill(-child.pid!, 'SIGKILL') } catch { child.kill('SIGKILL') }
        resolve({ type: 'error', message: `命令超时（${timeout}ms）` })
      }, timeout)

      child.on('close', (code) => {
        clearTimeout(timer)
        const elapsed = Date.now() - startTime
        logLine(`[bash] 完成，退出码: ${code}，耗时: ${elapsed}ms`)
        const output = Buffer.concat(outputChunks).toString('utf-8')
        const stderrOutput = Buffer.concat(stderrChunks).toString('utf-8')
        if (code === 0) {
          // 写命令成功后清除文件缓存（shell 可能修改了任意文件）
          if (!isReadonlyCommand(input.command.trim())) {
            clearFileCache()
          }
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
