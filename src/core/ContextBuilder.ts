// 系统上下文构建器 —— 注入 Git 状态、AGENT.md 记忆文件等
import { exec, execSync } from 'child_process'
import { existsSync, readFileSync, mkdirSync, readdirSync, statSync } from 'fs'
import { promisify } from 'util'
import { homedir } from 'os'
import { join } from 'path'
import { getGlobalCwd } from './cwd.js'

const execAsync = promisify(exec)

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
// 结果按 cwd 分桶缓存 5 秒，避免每条消息都阻塞执行 3 次 git 命令
// Gateway 多会话模式下不同会话的 cwd 不同，分桶避免缓存污染
const _gitCacheMap = new Map<string, { result: string | null; ts: number }>()
const GIT_CACHE_TTL_MS = 5000
// 缓存条目上限，防止长期运行的 Gateway 进程内存泄漏
const GIT_CACHE_MAX_ENTRIES = 200

async function getGitContext(cwd?: string): Promise<string | null> {
  const key = cwd ?? ''
  const now = Date.now()
  const cached = _gitCacheMap.get(key)
  if (cached && now - cached.ts < GIT_CACHE_TTL_MS) {
    // LRU：命中时将条目移到 Map 末尾（删除再重新插入）
    _gitCacheMap.delete(key)
    _gitCacheMap.set(key, cached)
    return cached.result
  }
  const result = await _fetchGitContext(cwd)

  // 超出上限时，淘汰最旧（最久未访问）的条目（Map 迭代顺序即插入/访问顺序）
  if (!_gitCacheMap.has(key) && _gitCacheMap.size >= GIT_CACHE_MAX_ENTRIES) {
    const oldestKey = _gitCacheMap.keys().next().value
    if (oldestKey !== undefined) _gitCacheMap.delete(oldestKey)
  }

  _gitCacheMap.set(key, { result, ts: now })
  return result
}

async function _fetchGitContext(cwd?: string): Promise<string | null> {
  const opts = cwd ? { cwd } : {}
  try {
    const { stdout: isGitOut } = await execAsync('git rev-parse --is-inside-work-tree', opts)
    if (isGitOut.trim() !== 'true') return null

    const [{ stdout: branch }, { stdout: status }, { stdout: gitLog }] = await Promise.all([
      execAsync('git branch --show-current', opts),
      execAsync('git status --short', opts),
      execAsync('git log --oneline -5', opts),
    ])

    const parts = [`当前分支: ${branch.trim()}`]
    if (status.trim()) parts.push(`工作区变更:\n${status.trim()}`)
    if (gitLog.trim()) parts.push(`最近提交:\n${gitLog.trim()}`)
    return parts.join('\n')
  } catch {
    return null
  }
}

// 查找并读取项目记忆文件（AGENT.md）
// 搜索顺序：
//   1. {cwd}/AGENT.md          —— 项目级记忆（随代码库存放）
//   2. {cwd}/.hrids/AGENT.md   —— 项目级记忆（隐藏目录，适合不想提交到 git 的场景）
//   3. ~/.hrids-agent/AGENT.md —— 用户级全局记忆（跨项目通用规则）
//
// 结果按 cwd 分桶缓存 30 秒，避免每条消息都重复读磁盘
const _memFilesCacheMap = new Map<string, { result: string[]; ts: number }>()
const MEM_FILES_CACHE_TTL_MS = 30_000
const MEM_FILES_CACHE_MAX_ENTRIES = 100

function findMemoryFiles(cwd: string): string[] {
  const now = Date.now()
  const cached = _memFilesCacheMap.get(cwd)
  if (cached && now - cached.ts < MEM_FILES_CACHE_TTL_MS) {
    // LRU：命中时将条目移到 Map 末尾
    _memFilesCacheMap.delete(cwd)
    _memFilesCacheMap.set(cwd, cached)
    return cached.result
  }

  const result = _fetchMemoryFiles(cwd)

  if (!_memFilesCacheMap.has(cwd) && _memFilesCacheMap.size >= MEM_FILES_CACHE_MAX_ENTRIES) {
    const oldestKey = _memFilesCacheMap.keys().next().value
    if (oldestKey !== undefined) _memFilesCacheMap.delete(oldestKey)
  }
  _memFilesCacheMap.set(cwd, { result, ts: now })
  return result
}

function _fetchMemoryFiles(cwd: string): string[] {
  const candidates = [
    join(cwd, 'AGENT.md'),
    join(cwd, '.hrids', 'AGENT.md'),
    join(homedir(), '.hrids-agent', 'AGENT.md'),
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

// 构建完整的系统上下文，注入动态内容（记忆、环境信息）
// 接受 string[]，追加动态 section 后返回 string[]
// cwd 参数可选，不传则使用 ~/.hrids-agent/work/（仅用于记忆文件查找）
// sessionId 参数可选，传入时注入会话级记忆（Gateway 多会话隔离），否则注入全局记忆
export async function buildSystemContext(basePrompt: string[], cwd?: string, sessionId?: string): Promise<string[]> {
  const resolvedCwd = cwd ?? getDefaultAgentCwd()
  const [gitCtx, memFiles] = await Promise.all([
    getGitContext(resolvedCwd),
    Promise.resolve(findMemoryFiles(resolvedCwd)),
  ])

  // 动态 section 追加到静态层之后，不影响静态层缓存
  const dynamicSections: string[] = []

  // 注入记忆文件内容
  if (memFiles.length > 0) {
    dynamicSections.push('## 项目记忆\n' + memFiles.join('\n\n'))
  }

  // 注入长期记忆（L0 身份 + L1 核心摘要）
  // Gateway 多会话模式：使用会话级记忆（按 sessionId 隔离，防止跨用户泄漏）
  // CLI 单会话模式：使用全局记忆（跨会话积累知识）
  try {
    const { getMemoryStackForSession, getMemoryStack } = await import('../memory/index.js')
    const stack = sessionId ? getMemoryStackForSession(sessionId) : getMemoryStack()
    const { l0Identity, l1Essential, totalTokens } = stack.wakeUp()
    const stats = await stack.status()
    if (stats.totalMemories > 0) {
      dynamicSections.push(`## 长期记忆（共 ${stats.totalMemories} 条，约 ${totalTokens} tokens）\n${l0Identity}\n\n${l1Essential}`)
    }
  } catch {
    // 记忆系统不可用时静默跳过
  }

  // 注入环境信息
  const platform = process.platform
  const isWindows = platform === 'win32'
  const isMac = platform === 'darwin'

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
    // 注入实时工作目录（getGlobalCwd() 反映最新的 cd 状态，比 resolvedCwd 更准确）
    `当前工作目录 (cwd): ${getGlobalCwd()}`,
  ]

  if (isWindows) {
    envInfo.push('注意: Windows 环境，路径分隔符为 \\，使用 PowerShell 语法，例如 Get-ChildItem / Remove-Item / Copy-Item')
  } else if (isMac) {
    envInfo.push('注意: macOS 环境，使用 bash/zsh 命令')
  } else {
    envInfo.push('注意: Linux 环境，使用 bash 命令')
  }

  // 安全边界说明：告知 LLM 工作目录约束和禁止操作
  envInfo.push(
    '\n## 安全边界\n' +
    `- 所有文件操作应在当前工作目录（${getGlobalCwd()}）内进行\n` +
    '- 禁止操作系统关键目录（/etc、/usr、/bin、/sbin、/boot、/dev 等）\n' +
    '- 禁止修改用户主目录根层级文件\n' +
    '- 禁止执行 shutdown/reboot/halt 等系统命令\n' +
    '- 长时间任务（编译/下载）请在 bash 工具的 timeout 参数中设置合适的超时时间（毫秒）\n' +
    '- 如需安装依赖，优先在项目目录内安装（npm install、pip install -r requirements.txt 等）'
  )

  if (gitCtx) envInfo.push(`\nGit 状态:\n${gitCtx}`)

  dynamicSections.push('## 环境信息\n' + envInfo.join('\n'))

  // 注入 .cache/ 目录中的上传文件列表，让 LLM 知道可以用 @.cache/filename 引用
  const cacheDir = join(resolvedCwd, '.cache')
  if (existsSync(cacheDir)) {
    try {
      const cacheFiles = readdirSync(cacheDir)
        .filter(f => {
          try { return statSync(join(cacheDir, f)).isFile() } catch { return false }
        })
      if (cacheFiles.length > 0) {
        const fileList = cacheFiles.map(f => `  - @.cache/${f}`).join('\n')
        dynamicSections.push(
          `## 已上传的附件文件（位于 cwd/.cache/）\n` +
          `以下文件已上传到当前会话工作目录，可直接用 @.cache/<文件名> 语法引用：\n${fileList}\n` +
          `例如：分析 @.cache/${cacheFiles[0]}`
        )
      }
    } catch {
      // 读取失败时静默忽略
    }
  }

  return [...basePrompt, ...dynamicSections]
}


