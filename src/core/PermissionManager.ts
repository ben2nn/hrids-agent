// 权限管理器 —— 控制工具调用是否需要用户确认

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { join, resolve } from 'path'
import { getConfigDir } from './Config.js'

// 进程内写锁，防止并发 read-then-write 竞态
let _rulesWriteLock: Promise<void> = Promise.resolve()

export type PermissionMode =
  | 'ask'      // 每次都询问用户
  | 'craft'    // 自主执行模式：agent 独立完成任务，无需用户确认
  | 'plan'     // 计划模式：只允许只读，写操作需要先进入 plan 确认

export interface PermissionRequest {
  toolName: string
  description: string
  isReadonly: boolean
  isDestructive?: boolean
  // 工具操作涉及的文件路径（用于路径级权限检查）
  filePath?: string
  // 用于规则内容匹配的字符串（bash 工具传命令内容，文件工具传路径）
  ruleContent?: string
}

export type PermissionCallback = (req: PermissionRequest) => Promise<boolean>

const RULES_FILE = join(getConfigDir(), 'permission-rules.json')

// 持久化的权限规则
// 规则格式：
//   "bash"           → 匹配工具 bash 的所有调用
//   "bash(git *)"    → 匹配 bash 工具中以 git 开头的命令（通配符）
//   "bash(npm run)"  → 精确匹配 bash 工具中的 npm run 命令
//   "file_write"     → 匹配所有 file_write 调用
interface PersistedRules {
  alwaysAllow: string[]      // 永久允许的规则
  alwaysDeny: string[]       // 永久拒绝的规则
  alwaysAsk: string[]        // 永久询问的规则（即使在 auto 模式下也询问）
  allowedPaths: string[]     // 允许写入的路径前缀（如 src/、tests/）
  deniedPaths: string[]      // 拒绝写入的路径前缀（如 .env、secrets/）
}

// ── 规则解析 ──────────────────────────────────────────────────────────────────

interface ParsedRule {
  toolName: string
  ruleContent?: string  // 括号内的内容，如 "git *"
}

/**
 * 解析规则字符串为结构化对象。
 * "bash"         → { toolName: 'bash' }
 * "bash(git *)"  → { toolName: 'bash', ruleContent: 'git *' }
 */
function parseRule(rule: string): ParsedRule {
  const match = rule.match(/^([^(]+)\((.+)\)$/)
  if (match) {
    return { toolName: match[1].trim(), ruleContent: match[2].trim() }
  }
  return { toolName: rule.trim() }
}

/**
 * 检查命令/内容是否匹配规则内容。
 * 支持三种匹配模式：
 *   精确匹配：  "git add"    → 完全相等
 *   前缀匹配：  "git:*"      → 以 "git" 开头（旧语法兼容）
 *   通配符匹配："git *"      → 支持 * 作为任意字符序列
 */
function matchesRuleContent(actual: string, ruleContent: string): boolean {
  const trimmed = actual.trim()
  const pattern = ruleContent.trim()

  // 旧语法：prefix:* 前缀匹配
  const prefixMatch = pattern.match(/^(.+):\*$/)
  if (prefixMatch) {
    const prefix = prefixMatch[1]
    return trimmed === prefix || trimmed.startsWith(prefix + ' ') || trimmed.startsWith(prefix + '\t')
  }

  // 无通配符：精确匹配
  if (!pattern.includes('*')) {
    return trimmed === pattern
  }

  // 通配符匹配：将 * 转为正则 .*
  // 转义正则特殊字符（除 * 外）
  const regexStr = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
  // 末尾 " .*" 变为可选（"git *" 同时匹配 "git" 和 "git add"）
  const finalRegex = regexStr.endsWith(' .*')
    ? regexStr.slice(0, -4) + '( .*)?'
    : regexStr
  // 截断超长输入防止 ReDoS（规则匹配通常针对短命令）
  const testStr = trimmed.length > 5000 ? trimmed.slice(0, 5000) : trimmed
  return new RegExp(`^${finalRegex}$`, 's').test(testStr)
}

/**
 * 检查一条权限请求是否匹配某条规则字符串。
 */
function requestMatchesRule(req: PermissionRequest, rule: string): boolean {
  const parsed = parseRule(rule)

  // 工具名不匹配，直接跳过
  if (parsed.toolName !== req.toolName) return false

  // 规则无内容限定 → 匹配该工具的所有调用
  if (!parsed.ruleContent) return true

  // 规则有内容限定 → 需要与 ruleContent 字段匹配
  if (!req.ruleContent) return false
  return matchesRuleContent(req.ruleContent, parsed.ruleContent)
}

// ── 路径匹配 ──────────────────────────────────────────────────────────────────

function matchesPathRule(filePath: string, rule: string): boolean {
  const absFile = resolve(filePath)
  const absRule = resolve(rule)
  if (absFile === absRule) return true
  if (absFile.startsWith(absRule + '/') || absFile.startsWith(absRule + '\\')) return true
  // 文件名精确匹配（如规则 ".env" 只匹配文件名恰好为 ".env" 的文件，不匹配 ".envrc"）
  const basename = absFile.split(/[/\\]/).pop() ?? ''
  if (basename === rule) return true
  return false
}

// ── 持久化 ────────────────────────────────────────────────────────────────────

function loadRules(): PersistedRules {
  if (!existsSync(RULES_FILE)) {
    return { alwaysAllow: [], alwaysDeny: [], alwaysAsk: [], allowedPaths: [], deniedPaths: [] }
  }
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
  const dir = getConfigDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  // 原子写入：防止并发写入时规则文件损坏
  const tmp = RULES_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(rules, null, 2), 'utf-8')
  renameSync(tmp, RULES_FILE)
}

// ── 拒绝追踪 ──────────────────────────────────────────────────────────────────

interface DenialState {
  consecutive: number   // 连续拒绝次数（成功后重置）
  total: number         // 会话内总拒绝次数
}

const DENIAL_LIMITS = {
  maxConsecutive: 3,   // 连续拒绝超过此值，给 LLM 附加提示
  maxTotal: 20,        // 总拒绝超过此值，给 LLM 附加提示
} as const

// ── PermissionManager ─────────────────────────────────────────────────────────

export class PermissionManager {
  private mode: PermissionMode
  // 会话内临时批准（不持久化）
  private sessionApproved: Set<string> = new Set()
  // 持久化规则
  private rules: PersistedRules
  private onAsk: PermissionCallback
  // 拒绝追踪（会话内，不持久化）
  private denial: DenialState = { consecutive: 0, total: 0 }

  constructor(mode: PermissionMode, onAsk: PermissionCallback) {
    this.mode = mode
    this.onAsk = onAsk
    this.rules = loadRules()
  }

  async check(req: PermissionRequest): Promise<boolean> {
    // 只读操作无需检查规则，直接放行（同时避免不必要的磁盘 I/O）
    if (req.isReadonly) {
      this.denial.consecutive = 0
      return true
    }

    // 写操作：重新读取磁盘规则，确保能看到其他会话写入的最新规则
    // 性能影响：loadRules() 是同步文件读取，但只读工具已在上方短路，
    // 写操作频率远低于读操作，实际 I/O 开销可接受
    this.rules = loadRules()

    const result = await this._check(req)

    // 更新拒绝追踪
    if (result) {
      this.denial.consecutive = 0  // 成功则重置连续计数
    } else {
      this.denial.consecutive++
      this.denial.total++
    }

    return result
  }

  private async _check(req: PermissionRequest): Promise<boolean> {
    // 只读操作始终允许
    if (req.isReadonly) return true

    // 永久拒绝规则（优先级最高）
    if (this.rules.alwaysDeny.some(rule => requestMatchesRule(req, rule))) return false

    // 路径级拒绝规则（次高优先级）
    if (req.filePath && this.rules.deniedPaths.length > 0) {
      for (const rule of this.rules.deniedPaths) {
        if (matchesPathRule(req.filePath, rule)) return false
      }
    }

    // 路径级允许规则（仅在设置了 allowedPaths 时生效，相当于白名单）
    // 注意：此白名单只对携带 filePath 的工具有效（file_write、file_edit 等）。
    // bash/powershell 工具不填 filePath，其路径限制应通过 alwaysDeny/alwaysAllow
    // 规则实现，例如 "bash(rm *)" 或 "bash(git *)"。
    if (req.filePath && this.rules.allowedPaths.length > 0) {
      const allowed = this.rules.allowedPaths.some(rule => matchesPathRule(req.filePath!, rule))
      if (!allowed) {
        return this.onAsk(req)
      }
    }

    // 永久允许规则（在非 alwaysAsk 覆盖时生效）
    // 注意：plan 模式下 alwaysAllow 无效，plan 模式是绝对只读的安全阀。
    const isAlwaysAllow = this.rules.alwaysAllow.some(rule => requestMatchesRule(req, rule))
    const isAlwaysAsk = this.rules.alwaysAsk.some(rule => requestMatchesRule(req, rule))

    if (isAlwaysAllow && !isAlwaysAsk && this.mode !== 'plan') return true

    // alwaysAsk：无论模式如何，都强制询问（plan 模式下直接拒绝，不询问）
    if (isAlwaysAsk && this.mode !== 'plan') return this.onAsk(req)

    switch (this.mode) {
      case 'craft':
        return true

      case 'plan':
        // plan 模式：所有写操作一律拒绝，alwaysAllow/alwaysAsk 均无效
        return false

      case 'ask': {
        // 会话内已批准：先查内容级 key，再查工具级 key（向后兼容）
        const contentKey = req.ruleContent ? `${req.toolName}::${req.ruleContent}` : null
        if (contentKey && this.sessionApproved.has(contentKey)) return true
        if (this.sessionApproved.has(req.toolName)) return true
        return this.onAsk(req)
      }
    }
  }

  /**
   * 获取连续拒绝次数，供 QueryEngine 在拒绝提示中附加警告。
   */
  getDenialState(): Readonly<DenialState> {
    return { ...this.denial }
  }

  /**
   * 是否已触发拒绝阈值（连续或总量超限）。
   * QueryEngine 可据此在 denyReason 中附加更强的提示。
   */
  isDenialThresholdReached(): boolean {
    return (
      this.denial.consecutive >= DENIAL_LIMITS.maxConsecutive ||
      this.denial.total >= DENIAL_LIMITS.maxTotal
    )
  }

  // 会话内临时批准（工具级或内容级）
  // key 格式：
  //   "bash"           → 批准该会话内所有 bash 调用（工具级）
  //   "bash::git add"  → 只批准该会话内 bash 的 git add 命令（内容级）
  approveSession(toolName: string, ruleContent?: string) {
    const key = ruleContent ? `${toolName}::${ruleContent}` : toolName
    this.sessionApproved.add(key)
  }

  // 永久批准（持久化到磁盘）
  // 采用 read-then-write + 进程内锁，防止并发修改覆盖
  approvePermanent(rule: string) {
    _rulesWriteLock = _rulesWriteLock.then(async () => {
      const fresh = loadRules()
      if (!fresh.alwaysAllow.includes(rule)) {
        fresh.alwaysAllow.push(rule)
        saveRules(fresh)
      }
      this.rules = fresh
    })
    return _rulesWriteLock
  }

  // 永久拒绝
  denyPermanent(rule: string) {
    _rulesWriteLock = _rulesWriteLock.then(async () => {
      const fresh = loadRules()
      if (!fresh.alwaysDeny.includes(rule)) {
        fresh.alwaysDeny.push(rule)
        saveRules(fresh)
      }
      this.rules = fresh
    })
    return _rulesWriteLock
  }

  // 永久强制询问（即使在 auto 模式下）
  askPermanent(rule: string) {
    const fresh = loadRules()
    if (!fresh.alwaysAsk.includes(rule)) {
      fresh.alwaysAsk.push(rule)
      saveRules(fresh)
    }
    this.rules = fresh
  }

  // 添加路径白名单（只允许写这些路径）
  allowPath(pathPrefix: string) {
    const p = resolve(pathPrefix)
    const fresh = loadRules()
    if (!fresh.allowedPaths.includes(p)) {
      fresh.allowedPaths.push(p)
      saveRules(fresh)
    }
    this.rules = fresh
  }

  // 添加路径黑名单（禁止写这些路径）
  denyPath(pathPrefix: string) {
    const p = resolve(pathPrefix)
    const fresh = loadRules()
    if (!fresh.deniedPaths.includes(p)) {
      fresh.deniedPaths.push(p)
      saveRules(fresh)
    }
    this.rules = fresh
  }

  // 移除路径规则
  clearPathRule(pathPrefix: string) {
    const p = resolve(pathPrefix)
    const fresh = loadRules()
    fresh.allowedPaths = fresh.allowedPaths.filter(r => r !== p)
    fresh.deniedPaths = fresh.deniedPaths.filter(r => r !== p)
    saveRules(fresh)
    this.rules = fresh
  }

  // 移除某工具的所有持久化规则（兼容旧接口，按工具名前缀清除）
  clearRules(toolName: string) {
    const matches = (rule: string) => parseRule(rule).toolName === toolName
    const fresh = loadRules()
    fresh.alwaysAllow = fresh.alwaysAllow.filter(r => !matches(r))
    fresh.alwaysDeny = fresh.alwaysDeny.filter(r => !matches(r))
    fresh.alwaysAsk = fresh.alwaysAsk.filter(r => !matches(r))
    saveRules(fresh)
    this.rules = fresh
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
