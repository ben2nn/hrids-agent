// 系统上下文构建器 —— 注入 Git 状态、CLAUDE.md 记忆文件等
import { execSync } from 'child_process'
import { existsSync, readFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { getMemoryStack } from '../memory/index.js'

export interface ContextInfo {
  gitStatus: string | null
  memoryFiles: string[]
  platform: string
  cwd: string
  date: string
}

// 默认工作目录：~/.hrids-agent/work/
export function getDefaultAgentCwd(): string {
  const dir = join(homedir(), '.hrids-agent', 'work')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

// 读取 git 状态（分支、最近提交、工作区变更）
function getGitContext(): string | null {
  try {
    const isGit = execSync('git rev-parse --is-inside-work-tree 2>/dev/null', {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    if (isGit !== 'true') return null

    const [branch, status, log] = [
      execSync('git branch --show-current', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim(),
      execSync('git status --short', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim(),
      execSync('git log --oneline -5', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim(),
    ]

    const parts = [`当前分支: ${branch}`]
    if (status) parts.push(`工作区变更:\n${status}`)
    if (log) parts.push(`最近提交:\n${log}`)
    return parts.join('\n')
  } catch {
    return null
  }
}

// 查找并读取 CLAUDE.md / AGENT.md 记忆文件
// 搜索顺序：当前目录 → 父目录 → 用户主目录
function findMemoryFiles(cwd: string): string[] {
  const candidates = [
    join(cwd, 'CLAUDE.md'),
    join(cwd, 'AGENT.md'),
    join(cwd, '.claude', 'CLAUDE.md'),
    join(homedir(), 'CLAUDE.md'),
    join(homedir(), '.claude', 'CLAUDE.md'),
  ]

  const contents: string[] = []
  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, 'utf-8').trim()
        if (content) {
          contents.push(`[记忆文件: ${path}]\n${content}`)
        }
      } catch { /* 忽略读取错误 */ }
    }
  }
  return contents
}

// 构建完整的系统上下文字符串，注入到 system prompt
// cwd 参数可选，不传则使用 ~/.hrids-agent/work/（仅用于记忆文件查找）
export async function buildSystemContext(basePrompt: string, cwd?: string): Promise<string> {
  const resolvedCwd = cwd ?? getDefaultAgentCwd()
  const gitCtx = getGitContext()
  const memFiles = findMemoryFiles(resolvedCwd)

  const sections: string[] = [basePrompt]

  // 注入记忆文件内容
  if (memFiles.length > 0) {
    sections.push('## 项目记忆\n' + memFiles.join('\n\n'))
  }

  // 注入长期记忆（L0 身份 + L1 核心摘要）
  try {
    const stack = getMemoryStack()
    const { l0Identity, l1Essential, totalTokens } = stack.wakeUp()
    const stats = await stack.status()
    if (stats.totalMemories > 0) {
      sections.push(`## 长期记忆（共 ${stats.totalMemories} 条，约 ${totalTokens} tokens）\n${l0Identity}\n\n${l1Essential}`)
    }
  } catch {
    // 记忆系统不可用时静默跳过
  }

  // 注入环境信息（工作目录不在此处注入，由 getDynamicContext 动态提供）
  const platform = process.platform
  const isWindows = platform === 'win32'
  const isMac = platform === 'darwin'

  // 检测实际使用的 shell
  const shellEnv = process.env.SHELL ?? process.env.ComSpec ?? ''
  const shellName = isWindows
    ? (shellEnv.toLowerCase().includes('powershell') || process.env.PSModulePath ? 'PowerShell' : 'cmd.exe')
    : (shellEnv.split('/').pop() ?? 'sh')

  const osName = isWindows ? 'Windows' : isMac ? 'macOS' : 'Linux'

  const envInfo = [
    `操作系统: ${osName} (${platform})`,
    `Shell: ${shellName}`,
    `当前时间: ${new Date().toLocaleString('zh-CN')}`,
    `用户主目录: ${homedir()}`,
    `用户名: ${process.env.USERNAME ?? process.env.USER ?? process.env.LOGNAME ?? '未知'}`,
  ]

  if (isWindows) {
    envInfo.push('注意: Windows 环境，路径分隔符为 \\，使用 PowerShell 语法，例如 Get-ChildItem / Remove-Item / Copy-Item')
  } else if (isMac) {
    envInfo.push('注意: macOS 环境，使用 bash/zsh 命令')
  } else {
    envInfo.push('注意: Linux 环境，使用 bash 命令')
  }

  if (gitCtx) envInfo.push(`\nGit 状态:\n${gitCtx}`)

  sections.push('## 环境信息\n' + envInfo.join('\n'))

  return sections.join('\n\n---\n\n')
}

// 动态上下文：每次发消息前调用，返回最新工作目录信息
export function getDynamicContext(cwd: string): string {
  return `\n\n---\n\n## 当前工作目录\n${cwd}`
}
