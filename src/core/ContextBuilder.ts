// 系统上下文构建器 —— 注入 Git 状态、CLAUDE.md 记忆文件等
import { execSync } from 'child_process'
import { existsSync, readFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { getMemoryStack, getMemoryStackForSession } from '../memory/index.js'
import { getCurrentSessionId } from './sessionContext.js'

export interface ContextInfo {
  gitStatus: string | null
  memoryFiles: string[]
  platform: string
  cwd: string
  date: string
}

// 默认工作目录：~/.hrids-agent/work/（共享目录，不绑定会话）
export function getDefaultAgentCwd(): string {
  const dir = join(homedir(), '.hrids-agent', 'work')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

// 为指定会话创建独立工作目录：~/.hrids-agent/work/<YYYYMMDD-HHmmss>-<sessionId>/
export function getSessionWorkDir(sessionId: string): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const datePart = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const timePart = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const dirName = `${datePart}-${timePart}-${sessionId}`
  const dir = join(homedir(), '.hrids-agent', 'work', dirName)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    // 初始化 git 仓库，使差异功能可用
    try {
      execSync('git init', { cwd: dir, stdio: 'ignore' })
      execSync('git commit --allow-empty -m "init"', { cwd: dir, stdio: 'ignore' })
    } catch {
      // git 不可用时静默忽略
    }
  }
  return dir
}

// 读取 git 状态（分支、最近提交、工作区变更）
// 结果按 cwd 分桶缓存 5 秒，避免每条消息都同步阻塞执行 3 次 git 命令
// Gateway 多会话模式下不同会话的 cwd 不同，分桶避免缓存污染
const _gitCacheMap = new Map<string, { result: string | null; ts: number }>()
const GIT_CACHE_TTL_MS = 5000
// 缓存条目上限，防止长期运行的 Gateway 进程内存泄漏
const GIT_CACHE_MAX_ENTRIES = 200

function getGitContext(cwd?: string): string | null {
  const key = cwd ?? ''
  const now = Date.now()
  const cached = _gitCacheMap.get(key)
  if (cached && now - cached.ts < GIT_CACHE_TTL_MS) {
    return cached.result
  }
  const result = _fetchGitContext(cwd)

  // 超出上限时，淘汰最旧的条目（按插入顺序，Map 保证迭代顺序）
  if (!_gitCacheMap.has(key) && _gitCacheMap.size >= GIT_CACHE_MAX_ENTRIES) {
    const oldestKey = _gitCacheMap.keys().next().value
    if (oldestKey !== undefined) _gitCacheMap.delete(oldestKey)
  }

  _gitCacheMap.set(key, { result, ts: now })
  return result
}

function _fetchGitContext(cwd?: string): string | null {
  const execOpts = cwd
    ? { encoding: 'utf-8' as const, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'], cwd }
    : { encoding: 'utf-8' as const, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] }
  try {
    const isGit = execSync('git rev-parse --is-inside-work-tree 2>/dev/null', execOpts).trim()
    if (isGit !== 'true') return null

    const [branch, status, log] = [
      execSync('git branch --show-current', execOpts).trim(),
      execSync('git status --short', execOpts).trim(),
      execSync('git log --oneline -5', execOpts).trim(),
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
  const gitCtx = getGitContext(resolvedCwd)
  const memFiles = findMemoryFiles(resolvedCwd)

  const sections: string[] = [basePrompt]

  // 注入记忆文件内容
  if (memFiles.length > 0) {
    sections.push('## 项目记忆\n' + memFiles.join('\n\n'))
  }

  // 注入长期记忆（L0 身份 + L1 核心摘要）
  try {
    const sessionId = getCurrentSessionId()
    const stack = sessionId ? getMemoryStackForSession(sessionId) : getMemoryStack()
    const { l0Identity, l1Essential, totalTokens } = stack.wakeUp()
    const stats = await stack.status()
    if (stats.totalMemories > 0) {
      sections.push(`## 长期记忆（共 ${stats.totalMemories} 条，约 ${totalTokens} tokens）\n${l0Identity}\n\n${l1Essential}`)
    }
  } catch {
    // 记忆系统不可用时静默跳过
  }

  // 注入记忆触发规则（让 agent 知道何时必须主动写记忆）
  sections.push(`## 记忆规则
遇到以下情况时，必须立即调用 memory_add，不要等到会话结束：
- 用户表达偏好或习惯："以后都用X"、"不要用Y"、"我喜欢X风格" → type=preference
- 做出技术决策："选择X方案"、"用X替代Y"、"因为X所以用Y" → type=decision
- 完成重要任务："搞定了"、"上线了"、"终于解决了" → type=milestone
- 发现 bug 根因或解决方案 → type=problem
- 用户提到项目名、技术栈、团队成员等事实 → type=fact

如果新信息与已有记忆矛盾（用户改变了决策或偏好），先用 memory_search 找到旧记忆 ID，再调用 memory_update 替换，不要重复新增。

wing 填当前项目名（从工作目录或对话上下文推断），room 填具体主题（如 architecture、auth、deployment）。`)

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

  envInfo.push(`\nbash 工具超时设置（必须显式传入 timeout 参数，否则默认 60s）：
- 快速命令（ls/cat/echo）：不传或 timeout=10000
- 安装依赖（pip/npm install）：timeout=120000
- 运行脚本/爬虫（短任务）：timeout=300000
- 大批量处理/全量爬取：timeout=1800000（30分钟）
- 超长任务：timeout=3600000（1小时）`)

  if (gitCtx) envInfo.push(`\nGit 状态:\n${gitCtx}`)

  sections.push('## 环境信息\n' + envInfo.join('\n'))

  return sections.join('\n\n---\n\n')
}

// 动态上下文：每次发消息前调用，返回最新工作目录信息
export function getDynamicContext(cwd: string): string {
  return `\n\n---\n\n## 当前工作目录\n${cwd}`
}
