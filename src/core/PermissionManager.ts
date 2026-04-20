// 权限管理器 —— 控制工具调用是否需要用户确认

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join, resolve, extname } from 'path'

export type PermissionMode =
  | 'ask'      // 每次都询问用户
  | 'auto'     // 自动允许所有操作
  | 'plan'     // 计划模式：允许写文档类文件（.md/.txt/.json 等），禁止写代码/配置文件

export interface PermissionRequest {
  toolName: string
  description: string
  isReadonly: boolean
  // 可选：工具操作涉及的文件路径（用于路径级权限检查）
  filePath?: string
}

export type PermissionCallback = (req: PermissionRequest) => Promise<boolean>

const RULES_FILE = join(homedir(), '.hrids-agent', 'permission-rules.json')

// plan 模式下允许写入的文件扩展名（文档类）
const PLAN_MODE_ALLOWED_EXTENSIONS = new Set([
  '.md', '.txt', '.rst', '.adoc',           // 文档
  '.json', '.yaml', '.yml', '.toml',        // 结构化数据/配置草稿
  '.csv', '.tsv',                           // 数据文件
  '.html', '.htm',                          // 标记文档
])

// plan 模式下允许写入的目录前缀（相对路径或绝对路径均可）
const PLAN_MODE_ALLOWED_DIR_PATTERNS = [
  /[/\\]\.kiro[/\\]/,    // .kiro/ 目录（需求/设计/任务文档）
  /[/\\]docs[/\\]/,      // docs/ 目录
  /[/\\]spec[/\\]/,      // spec/ 目录
  /[/\\]design[/\\]/,    // design/ 目录
  /[/\\]plans[/\\]/,     // plans/ 目录
  /[/\\]notes[/\\]/,     // notes/ 目录
]

/**
 * 判断某个文件路径在 plan 模式下是否允许写入。
 * 规则：扩展名为文档类，或路径位于文档目录下。
 */
function isPlanModeWriteAllowed(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase()
  if (PLAN_MODE_ALLOWED_EXTENSIONS.has(ext)) return true
  // 路径中包含文档目录
  const normalized = filePath.replace(/\\/g, '/')
  return PLAN_MODE_ALLOWED_DIR_PATTERNS.some(pattern => pattern.test('/' + normalized + '/'))
}

// 持久化的权限规则
interface PersistedRules {
  alwaysAllow: string[]      // 永久允许的工具名
  alwaysDeny: string[]       // 永久拒绝的工具名
  alwaysAsk: string[]        // 永久询问的工具名（即使在 auto 模式下也询问）
  allowedPaths: string[]     // 允许写入的路径前缀（如 src/、tests/）
  deniedPaths: string[]      // 拒绝写入的路径前缀（如 .env、secrets/）
}

function loadRules(): PersistedRules {
  if (!existsSync(RULES_FILE)) return { alwaysAllow: [], alwaysDeny: [], alwaysAsk: [], allowedPaths: [], deniedPaths: [] }
  try {
    const raw = JSON.parse(readFileSync(RULES_FILE, 'utf-8')) as Partial<PersistedRules>
    return {
      alwaysAllow: raw.alwaysAllow ?? [],
      alwaysDeny: raw.alwaysDeny ?? [],
      alwaysAsk: raw.alwaysAsk ?? [],
      allowedPaths: raw.allowedPaths ?? [],
      deniedPaths: raw.deniedPaths ?? [],
    }
  } catch {
    return { alwaysAllow: [], alwaysDeny: [], alwaysAsk: [], allowedPaths: [], deniedPaths: [] }
  }
}

function saveRules(rules: PersistedRules) {
  const dir = join(homedir(), '.hrids-agent')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2), 'utf-8')
}

// 检查路径是否匹配某个前缀规则（支持 glob 风格的 * 通配）
function matchesPathRule(filePath: string, rule: string): boolean {
  const absFile = resolve(filePath)
  const absRule = resolve(rule)
  // 精确匹配或前缀匹配（目录）
  if (absFile === absRule) return true
  if (absFile.startsWith(absRule + '/') || absFile.startsWith(absRule + '\\')) return true
  // 文件名匹配（如规则 ".env" 匹配任意目录下的 .env）
  const basename = absFile.split(/[/\\]/).pop() ?? ''
  if (basename === rule || basename.startsWith(rule)) return true
  return false
}

export class PermissionManager {
  private mode: PermissionMode
  // 会话内临时批准（不持久化）
  private sessionApproved: Set<string> = new Set()
  // 持久化规则
  private rules: PersistedRules
  private onAsk: PermissionCallback

  constructor(mode: PermissionMode, onAsk: PermissionCallback) {
    this.mode = mode
    this.onAsk = onAsk
    this.rules = loadRules()
  }

  async check(req: PermissionRequest): Promise<boolean> {
    // 只读操作始终允许
    if (req.isReadonly) return true

    // 永久拒绝规则（优先级最高）
    if (this.rules.alwaysDeny.includes(req.toolName)) return false

    // 路径级拒绝规则（次高优先级）
    if (req.filePath && this.rules.deniedPaths.length > 0) {
      for (const rule of this.rules.deniedPaths) {
        if (matchesPathRule(req.filePath, rule)) {
          return false
        }
      }
    }

    // 路径级允许规则（仅在设置了 allowedPaths 时生效，相当于白名单）
    if (req.filePath && this.rules.allowedPaths.length > 0) {
      const allowed = this.rules.allowedPaths.some(rule => matchesPathRule(req.filePath!, rule))
      if (!allowed) {
        // 路径不在白名单内，降级为询问
        return this.onAsk(req)
      }
    }

    // 永久允许规则（在非 alwaysAsk 覆盖时生效）
    if (this.rules.alwaysAllow.includes(req.toolName) && !this.rules.alwaysAsk.includes(req.toolName)) return true

    // alwaysAsk：无论模式如何，都强制询问
    if (this.rules.alwaysAsk.includes(req.toolName)) {
      return this.onAsk(req)
    }

    switch (this.mode) {
      case 'auto':
        return true

      case 'plan':
        // plan 模式：文档类文件允许写入，其他写操作一律拒绝
        if (req.filePath && isPlanModeWriteAllowed(req.filePath)) return true
        return false

      case 'ask': {
        // 会话内已批准
        if (this.sessionApproved.has(req.toolName)) return true
        return this.onAsk(req)
      }
    }
  }

  // 会话内临时批准
  approveSession(toolName: string) {
    this.sessionApproved.add(toolName)
  }

  // 永久批准（持久化到磁盘）
  approvePermanent(toolName: string) {
    if (!this.rules.alwaysAllow.includes(toolName)) {
      this.rules.alwaysAllow.push(toolName)
      saveRules(this.rules)
    }
  }

  // 永久拒绝
  denyPermanent(toolName: string) {
    if (!this.rules.alwaysDeny.includes(toolName)) {
      this.rules.alwaysDeny.push(toolName)
      saveRules(this.rules)
    }
  }

  // 永久强制询问（即使在 auto 模式下）
  askPermanent(toolName: string) {
    if (!this.rules.alwaysAsk.includes(toolName)) {
      this.rules.alwaysAsk.push(toolName)
      saveRules(this.rules)
    }
  }

  // 添加路径白名单（只允许写这些路径）
  allowPath(pathPrefix: string) {
    const p = resolve(pathPrefix)
    if (!this.rules.allowedPaths.includes(p)) {
      this.rules.allowedPaths.push(p)
      saveRules(this.rules)
    }
  }

  // 添加路径黑名单（禁止写这些路径）
  denyPath(pathPrefix: string) {
    const p = resolve(pathPrefix)
    if (!this.rules.deniedPaths.includes(p)) {
      this.rules.deniedPaths.push(p)
      saveRules(this.rules)
    }
  }

  // 移除路径规则
  clearPathRule(pathPrefix: string) {
    const p = resolve(pathPrefix)
    this.rules.allowedPaths = this.rules.allowedPaths.filter(r => r !== p)
    this.rules.deniedPaths = this.rules.deniedPaths.filter(r => r !== p)
    saveRules(this.rules)
  }

  // 移除某工具的所有持久化规则
  clearRules(toolName: string) {
    this.rules.alwaysAllow = this.rules.alwaysAllow.filter(t => t !== toolName)
    this.rules.alwaysDeny = this.rules.alwaysDeny.filter(t => t !== toolName)
    this.rules.alwaysAsk = this.rules.alwaysAsk.filter(t => t !== toolName)
    saveRules(this.rules)
  }

  getRules(): Readonly<PersistedRules> {
    return { ...this.rules }
  }

  setMode(mode: PermissionMode) {
    this.mode = mode
  }

  getMode(): PermissionMode {
    return this.mode
  }

  isPlanMode(): boolean {
    return this.mode === 'plan'
  }
}
