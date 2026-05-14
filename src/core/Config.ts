// 配置系统 —— 读写 ~/.hrids/config.yaml（YAML 优先，JSON 降级兼容）
// 所有运行时配置均从此文件读取，不再依赖 .env
import { existsSync, mkdirSync, readFileSync, statSync, renameSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { McpServerConfig } from '../tools/McpTool.js'
import type { CustomProviderConfig } from './providers/registry.js'
import { normalizeProvider } from './providers/registry.js'
import { loadYamlFile, saveYamlFile } from './YamlLoader.js'
import { loadProviderProfiles } from './providers/ProviderProfileLoader.js'

const OLD_CONFIG_DIR = join(homedir(), '.hrids-agent')
const CONFIG_DIR = join(homedir(), '.hrids')
const CONFIG_YAML_FILE = join(CONFIG_DIR, 'config.yaml')
const MCP_FILE = join(CONFIG_DIR, 'mcp.json')

// 启动时自动迁移旧目录
function migrateOldConfigDir() {
  if (existsSync(OLD_CONFIG_DIR) && !existsSync(CONFIG_DIR)) {
    try {
      renameSync(OLD_CONFIG_DIR, CONFIG_DIR)
      process.stderr.write(`[config] 已迁移配置目录 ${OLD_CONFIG_DIR} → ${CONFIG_DIR}\n`)
    } catch (err) {
      process.stderr.write(`[config] 目录迁移失败（将继续使用旧目录）: ${String(err)}\n`)
    }
  }
}
// 立即执行迁移（模块加载时）
migrateOldConfigDir()

// ── 模型 Fallback 配置 ────────────────────────────────────────

/**
 * 单个平台的 Fallback 配置
 * 示例：{ "provider": "aliyun", "models": ["qwen-plus", "qwen-max"] }
 */
export interface ModelFallbackGroup {
  provider: string
  models: string[]
  /** 覆盖该平台的 API Key（可选，不填则从 apiKeys 中按 provider 查找） */
  apiKey?: string
  /** 覆盖该平台的 Base URL（可选） */
  baseUrl?: string
}

// ── 模型类型配置 ──────────────────────────────────────────────

export interface ModelTypeConfig {
  /** 单一模型（无 Fallback 时使用） */
  model?: string
  /** 多平台 Fallback 链（优先级高于 model） */
  fallbacks?: ModelFallbackGroup[]
}

// ── Embedding 配置 ────────────────────────────────────────────

export interface EmbeddingConfig extends ModelTypeConfig {
  /** 向量维度（OpenAI 支持降维） */
  dimensions?: number
  /** 单一 embedding 提供商（无 fallbacks 时使用） */
  provider?: string
  /** 单一 embedding 模型 Base URL */
  baseUrl?: string
}

// ── 向量存储配置 ──────────────────────────────────────────────

export interface VectorStoreConfig {
  /** 后端：sqlite（默认）| pgvector | seekdb */
  backend?: 'sqlite' | 'pgvector' | 'seekdb'
  /** 连接 URL（pgvector / seekdb 需要） */
  url?: string
  /** 表名（默认 memory_vectors） */
  table?: string
}

// ── Agent 行为配置 ────────────────────────────────────────────

export interface AgentBehaviorConfig {
  /** 默认模型（无 llm.fallbacks 时使用，可被 -m 覆盖） */
  model?: string
  /** 权限模式：ask（每次确认）| craft（自主执行）| plan（只读计划） */
  permissionMode?: 'ask' | 'craft' | 'plan'
  /** 单次回复最大 token 数 */
  maxTokens?: number
  /** 单次任务最大对话轮数（防止无限循环） */
  maxTurns?: number
  /** 单次任务最大费用上限（USD，超出后中止） */
  maxBudgetUsd?: number
  /** 默认工作目录（可被 --cwd 覆盖） */
  cwd?: string
  /** 会话结束后用 LLM 提炼记忆 */
  memoryCondense?: boolean
  /** 自动将成功任务提炼为可复用技能（实验性） */
  autoDistillSkill?: boolean
  /** 自动压缩上下文的 token 阈值，超过后触发 LLM 摘要压缩。默认 100000 */
  autoCompactThreshold?: number
  /** 启动时自动清理过期会话，false 可完全禁用。默认 true */
  autoPruneSessions?: boolean
  /** 自动清理时至少保留的最近会话数，默认 50 */
  pruneKeepCount?: number
  /** 自动清理时保留的最大天数，超过此天数的旧会话将被删除，默认 90 */
  pruneMaxAgeDays?: number
}

// ── Gateway 配置 ──────────────────────────────────────────────

export interface GatewayUser {
  /** 用户名 */
  username: string
  /** 密码（支持明文或 scrypt 哈希格式：scrypt:hex(salt):hex(hash)） */
  password: string
}

export interface GatewayConfig {
  /** 监听端口（默认 3282） */
  port?: number
  /** 监听地址（默认 127.0.0.1） */
  host?: string
  /** 鉴权 Token（留空则不鉴权） */
  token?: string
  /** 用户列表（配置后启用用户名/密码登录，登录成功后颁发 token） */
  users?: GatewayUser[]
}

// ── 日志 / UI 配置 ────────────────────────────────────────────

export interface LoggingConfig {
  /** 日志级别：debug | info | warn | error */
  level?: 'debug' | 'info' | 'warn' | 'error'
  /** UI 主题：default | minimal */
  theme?: 'default' | 'minimal'
}

// ── SkillHub 配置 ─────────────────────────────────────────────

export interface SkillHubConfig {
  url?: string
  apiBase?: string
  searchUrl?: string
  primaryDownloadUrlTemplate?: string
}

// ── Web 搜索配置 ───────────────────────────────────────────────

export interface WebSearchConfig {
  /** 搜索引擎：searxng（默认）| mojeek */
  engine?: 'mojeek' | 'searxng'
  /** SearXNG 实例地址（engine=searxng 时必填），例如 https://xng.hrids.com */
  endpoint?: string
}

// ── 多智能体配置 ────────────────────────────────────────────────

/** 智能体角色模板 */
export interface AgentProfile {
  name: string
  description: string
  model?: string
  provider?: string
  apiKey?: string
  baseUrl?: string
  systemPrompt?: string
  systemPromptFile?: string
  allowedTools?: string[]
  maxTurns?: number
  maxBudgetUsd?: number
  isolated?: boolean
  autoSelectable?: boolean
  metadata?: Record<string, string>
}

export interface MultiAgentConfig {
  globalMaxConcurrent?: number
  defaultMaxTurns?: number
  defaultTimeoutMs?: number
  defaultModel?: string
  defaultProvider?: string
  profiles?: AgentProfile[]
  profileDirs?: string[]
  autoSelectProfiles?: boolean
  allowRecursiveAgent?: boolean
}

export interface ToolPermissionPolicy {
  defaultDenyList?: string[]
  profileOverrides?: Record<string, string[]>
  allowMcpTools?: boolean
}

// ── 命令安全配置 ────────────────────────────────────────────────

export interface CommandSafetyConfig {
  /** 是否启用命令安全分析（默认 true） */
  enabled?: boolean
  /** 最低风险等级时拦截执行：low | medium | high | critical（默认 'high'） */
  blockLevel?: 'low' | 'medium' | 'high' | 'critical'
  /** 额外的危险命令正则（追加到内置规则） */
  extraPatterns?: string[]
}

// ── 网络策略配置 ────────────────────────────────────────────────

export interface NetPolicyConfig {
  /** 是否启用网络策略（默认 true） */
  enabled?: boolean
  /** 白名单域名（设置后仅允许访问这些域名） */
  allowedDomains?: string[]
  /** 黑名单域名（默认阻止云平台 metadata 和 localhost） */
  blockedDomains?: string[]
  /** 白名单和黑名单都未设置时的默认行为（默认 'allow'） */
  defaultAction?: 'allow' | 'deny'
}

// ── 主配置接口 ────────────────────────────────────────────────

export interface AgentConfig {
  // ── 基础 ──────────────────────────────────────────────────
  /** @deprecated 请使用 agent.model */
  model?: string
  /** 显式指定提供商（支持内置 ID、别名、customProviders 中的名称） */
  provider?: string
  /** 直接内联 API Key（不推荐，建议在 fallbacks 中按提供商配置） */
  apiKey?: string
  /** 自定义 Base URL */
  baseUrl?: string

  // ── 模型配置 ───────────────────────────────────────────────
  /** 大语言模型（主对话引擎，必须配置） */
  llm?: ModelTypeConfig
  /** 视觉模型（图像理解，可选，未配置则复用 llm） */
  vision?: ModelTypeConfig
  /** 语音模型（TTS/STT，可选） */
  speech?: ModelTypeConfig
  /** Embedding 模型（记忆检索，可选，未配置则降级 TF-IDF） */
  embedding?: EmbeddingConfig

  // ── 存储 ──────────────────────────────────────────────────
  vectorStore?: VectorStoreConfig

  // ── 分组配置（新格式） ─────────────────────────────────────
  agent?: AgentBehaviorConfig
  gateway?: GatewayConfig
  logging?: LoggingConfig

  // ── 集成 ──────────────────────────────────────────────────
  skillHub?: SkillHubConfig
  mcpServers: McpServerConfig[]
  customProviders?: CustomProviderConfig[]

  // ── 多智能体 ───────────────────────────────────────────────
  multiAgent?: MultiAgentConfig
  toolPermissions?: ToolPermissionPolicy

  // ── 安全 ──────────────────────────────────────────────────
  /** 命令安全分析配置 */
  commandSafety?: CommandSafetyConfig
  /** 网络访问策略配置 */
  networkPolicy?: NetPolicyConfig
  /** Web 搜索引擎配置 */
  webSearch?: WebSearchConfig

  // ── 向后兼容：旧版扁平字段（已迁移到 agent / logging 分组） ──
  /** @deprecated 请使用 agent.permissionMode */
  permissionMode?: 'ask' | 'craft' | 'plan'
  /** @deprecated 请使用 agent.maxTokens */
  maxTokens?: number
  /** @deprecated 请使用 agent.maxTurns */
  maxTurns?: number
  /** @deprecated 请使用 agent.maxBudgetUsd */
  maxBudgetUsd?: number
  /** @deprecated 请使用 agent.cwd */
  agentCwd?: string
  /** @deprecated 请使用 agent.memoryCondense */
  memoryCondense?: boolean
  /** @deprecated 请使用 agent.autoDistillSkill */
  autoDistillSkill?: boolean
  /** @deprecated 请使用 logging.level */
  logLevel?: 'debug' | 'info' | 'warn' | 'error'
  /** @deprecated 请使用 logging.theme */
  theme?: 'default' | 'minimal'
  /** @deprecated API Key 已移入各模型 fallbacks 的 apiKey 字段 */
  apiKeys?: Record<string, string>
}

// ── 规范化后的运行时配置（扁平化，供内部使用） ────────────────

export interface ResolvedConfig extends AgentConfig {
  // agent 分组展开
  permissionMode: 'ask' | 'craft' | 'plan'
  maxTokens: number
  maxTurns: number
  autoCompactThreshold?: number
  // logging 分组展开
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  theme: 'default' | 'minimal'
}

// ── 硬编码兜底默认值 ──────────────────────────────────────────

const DEFAULTS = {
  model: 'qwen3.5-122b-a10b',
  agent: {
    model: 'qwen3.5-122b-a10b',
    permissionMode: 'ask' as const,
    maxTokens: 8096,
    maxTurns: 50,
    memoryCondense: true,
    autoDistillSkill: false,
    autoPruneSessions: true,
    pruneKeepCount: 50,
    pruneMaxAgeDays: 90,
  },
  gateway: {
    port: 3282,
    host: '127.0.0.1',
    token: '',
  },
  logging: {
    level: 'info' as const,
    theme: 'default' as const,
  },
  vectorStore: { backend: 'sqlite' as const },
  webSearch: { engine: 'searxng' as const },
  skillHub: {
    url: 'https://skillhub.cn',
    apiBase: 'https://api.skillhub.cn',
  },
  mcpServers: [] as McpServerConfig[],
  multiAgent: {
    globalMaxConcurrent: 10,
    defaultMaxTurns: 30,
    defaultTimeoutMs: 300000,
    autoSelectProfiles: true,
    allowRecursiveAgent: false,
    profiles: [],
    profileDirs: [],
  } as MultiAgentConfig,
  toolPermissions: {
    defaultDenyList: ['todo_write', 'todo_update', 'todo_append', 'todo_reset'],
    allowMcpTools: false,
  } as ToolPermissionPolicy,
}

// ── 单例缓存 ──────────────────────────────────────────────────
let _cachedConfig: ResolvedConfig | null = null
// 上次成功读取配置文件时的文件修改时间（ms），用于检测外部修改
let _cachedMtime = 0

function ensureConfigDir() {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true })
}

/**
 * 将原始配置规范化为 ResolvedConfig：
 * - 新格式（agent / logging 分组）优先
 * - 旧版扁平字段自动迁移（向后兼容）
 * - 过滤掉 _comment / _example 等注释字段
 * - 旧版 apiKeys 自动迁移：将 apiKeys[provider] 注入对应 fallback 条目（若该条目未设置 apiKey）
 */
function normalize(raw: Partial<AgentConfig>): ResolvedConfig {
  // 过滤注释字段
  const clean = Object.fromEntries(
    Object.entries(raw).filter(([k]) => !k.startsWith('_'))
  ) as Partial<AgentConfig>

  // 旧版 apiKeys 迁移：将 key 注入各模型 fallbacks（不覆盖已有的 apiKey）
  const legacyApiKeys = clean.apiKeys ?? {}
  function injectApiKeys(cfg: ModelTypeConfig | undefined): ModelTypeConfig | undefined {
    if (!cfg?.fallbacks) return cfg
    return {
      ...cfg,
      fallbacks: cfg.fallbacks.map(fb => {
        if (fb.apiKey) return fb
        const key = legacyApiKeys[normalizeProvider(fb.provider)]
          ?? legacyApiKeys[fb.provider]
        return key ? { ...fb, apiKey: key } : fb
      }),
    }
  }

  // 过滤 mcpServers / customProviders 中的示例条目
  if (clean.mcpServers) {
    clean.mcpServers = (clean.mcpServers as Array<McpServerConfig & { _example?: boolean }>)
      .filter(s => !s._example)
  }
  if (clean.customProviders) {
    clean.customProviders = (clean.customProviders as Array<CustomProviderConfig & { _example?: boolean }>)
      .filter(p => !p._example)
  }

  // 合并 agent 分组（新格式优先，旧字段兜底）
  const agent: Omit<Required<AgentBehaviorConfig>, 'maxBudgetUsd'> & { maxBudgetUsd?: number } = {
    model:          clean.agent?.model           ?? clean.model           ?? DEFAULTS.agent.model,
    permissionMode: clean.agent?.permissionMode ?? clean.permissionMode ?? DEFAULTS.agent.permissionMode,
    maxTokens:      clean.agent?.maxTokens      ?? clean.maxTokens      ?? DEFAULTS.agent.maxTokens,
    maxTurns:       clean.agent?.maxTurns        ?? clean.maxTurns        ?? DEFAULTS.agent.maxTurns,
    maxBudgetUsd:   clean.agent?.maxBudgetUsd    ?? clean.maxBudgetUsd    ?? undefined,
    cwd:            clean.agent?.cwd             ?? clean.agentCwd        ?? '',
    memoryCondense: clean.agent?.memoryCondense  ?? clean.memoryCondense  ?? DEFAULTS.agent.memoryCondense,
    autoDistillSkill: clean.agent?.autoDistillSkill ?? clean.autoDistillSkill ?? DEFAULTS.agent.autoDistillSkill,
    autoPruneSessions: clean.agent?.autoPruneSessions ?? DEFAULTS.agent.autoPruneSessions,
    pruneKeepCount:    clean.agent?.pruneKeepCount    ?? DEFAULTS.agent.pruneKeepCount,
    pruneMaxAgeDays:   clean.agent?.pruneMaxAgeDays   ?? DEFAULTS.agent.pruneMaxAgeDays,
    autoCompactThreshold: clean.agent?.autoCompactThreshold ?? 100000,
  }

  // 合并 logging 分组
  const logging: Required<LoggingConfig> = {
    level: clean.logging?.level ?? clean.logLevel ?? DEFAULTS.logging.level,
    theme: clean.logging?.theme ?? clean.theme    ?? DEFAULTS.logging.theme,
  }

  // 合并 gateway 分组
  const gateway: GatewayConfig = {
    ...DEFAULTS.gateway,
    ...clean.gateway,
  }

  // 深合并 vectorStore / skillHub / multiAgent / toolPermissions
  const vectorStore: VectorStoreConfig = { ...DEFAULTS.vectorStore, ...clean.vectorStore }
  const skillHub: SkillHubConfig = { ...DEFAULTS.skillHub, ...clean.skillHub }
  const webSearch: WebSearchConfig = { ...DEFAULTS.webSearch, ...clean.webSearch }
  const multiAgent: MultiAgentConfig = {
    ...DEFAULTS.multiAgent,
    ...clean.multiAgent,
    // 内联 profiles 深度合并（用户配置覆盖默认）
    profiles: clean.multiAgent?.profiles ?? DEFAULTS.multiAgent?.profiles ?? [],
    profileDirs: clean.multiAgent?.profileDirs ?? DEFAULTS.multiAgent?.profileDirs ?? [],
  }
  const toolPermissions: ToolPermissionPolicy = {
    ...DEFAULTS.toolPermissions,
    ...clean.toolPermissions,
    profileOverrides: {
      ...(DEFAULTS.toolPermissions?.profileOverrides ?? {}),
      ...(clean.toolPermissions?.profileOverrides ?? {}),
    },
  }

  return {
    // 基础字段（model 新规范位置为 agent.model，顶层 model 向后兼容）
    model:    agent.model,
    provider: clean.provider,
    apiKey:   clean.apiKey,
    baseUrl:  clean.baseUrl,
    // 模型配置
    llm:        injectApiKeys(clean.llm),
    vision:     injectApiKeys(clean.vision),
    speech:     injectApiKeys(clean.speech),
    embedding:  injectApiKeys(clean.embedding) as EmbeddingConfig | undefined,
    // 存储
    vectorStore,
    // 分组配置
    agent,
    gateway,
    logging,
    // 集成
    skillHub,
    webSearch,
    // 安全
    commandSafety: clean.commandSafety,
    networkPolicy:  clean.networkPolicy,
    mcpServers:      clean.mcpServers      ?? DEFAULTS.mcpServers,
    customProviders: clean.customProviders ?? [],
    // 多智能体
    multiAgent,
    toolPermissions,
    // 展开扁平字段（供旧代码直接访问）
    permissionMode:   agent.permissionMode,
    maxTokens:        agent.maxTokens,
    maxTurns:         agent.maxTurns,
    maxBudgetUsd:     agent.maxBudgetUsd ?? undefined,
    agentCwd:         agent.cwd || undefined,
    memoryCondense:   agent.memoryCondense,
    autoDistillSkill: agent.autoDistillSkill,
    autoCompactThreshold: agent.autoCompactThreshold,
    logLevel:         logging.level,
    theme:            logging.theme,
  }
}

export function loadConfig(): ResolvedConfig {
  // 检测活跃的配置文件
  const activeFile = existsSync(CONFIG_YAML_FILE) ? CONFIG_YAML_FILE : null

  // 检查文件是否被外部修改（mtime 变化则使缓存失效）
  if (_cachedConfig && activeFile) {
    try {
      const mtime = statSync(activeFile).mtimeMs
      if (mtime === _cachedMtime) return _cachedConfig
      process.stderr.write(`[config] 检测到配置文件变更，重新加载\n`)
      _cachedConfig = null
    } catch {
      // 文件不存在等异常，继续走下面的逻辑
    }
  }

  ensureConfigDir()

  // 配置文件不存在：自动生成 YAML
  if (!activeFile) {
    const generated = normalize({})
    try {
      saveYamlFile(CONFIG_YAML_FILE, generated)
      process.stderr.write(`[config] 首次启动，已生成配置文件: ${CONFIG_YAML_FILE}\n`)
    } catch (err) {
      process.stderr.write(`[config] 写入配置文件失败（将使用内存配置）: ${String(err)}\n`)
    }
    const mcpFileServers = loadMcpFile()
    if (mcpFileServers.length > 0) generated.mcpServers = mcpFileServers

    // 合并目录加载的自定义提供商
    const dirProviders = loadProviderProfiles(process.cwd())
    if (dirProviders.length > 0) {
      generated.customProviders = dirProviders
      process.stderr.write(`[providers] 从目录加载了 ${dirProviders.length} 个自定义提供商\n`)
    }

    _cachedConfig = generated
    _cachedMtime = existsSync(CONFIG_YAML_FILE) ? statSync(CONFIG_YAML_FILE).mtimeMs : 0
    return generated
  }

  // 读取配置文件
  try {
    const raw = loadYamlFile<Partial<AgentConfig>>(CONFIG_YAML_FILE)
    const config = normalize(raw)

    // 合并 mcp.json
    const mcpFileServers = loadMcpFile()
    if (mcpFileServers.length > 0) {
      const existingNames = new Set(config.mcpServers.map(s => s.name))
      config.mcpServers = [
        ...config.mcpServers,
        ...mcpFileServers.filter(s => !existingNames.has(s.name)),
      ]
    }

    // 合并目录加载的自定义提供商（~/.hrids/providers/ + .hrids/providers/）
    const dirProviders = loadProviderProfiles(config.agent?.cwd || process.cwd())
    if (dirProviders.length > 0) {
      const existingNames = new Set((config.customProviders ?? []).map(p => p.name.toLowerCase()))
      const newProviders = dirProviders.filter(p => !existingNames.has(p.name.toLowerCase()))
      if (newProviders.length > 0) {
        config.customProviders = [...(config.customProviders ?? []), ...newProviders]
        process.stderr.write(`[providers] 从目录加载了 ${newProviders.length} 个自定义提供商\n`)
      }
    }

    _cachedConfig = config
    _cachedMtime = statSync(activeFile).mtimeMs
    return config
  } catch (err) {
    process.stderr.write(`[config] 配置文件解析失败: ${String(err)}，使用默认配置\n`)
    // 注意：解析失败时不缓存，下次调用仍会重试读取文件（修复文件后无需重启）
    return normalize({})
  }
}

/**
 * 读取 ~/.hrids/mcp.json，支持两种格式：
 *   1. { "mcpServers": { "name": { command, args, env } } }  （对象格式，兼容 Claude Desktop）
 *   2. McpServerConfig[]  （数组格式，与 config.yaml 的 mcpServers 一致）
 */
function loadMcpFile(): McpServerConfig[] {
  if (!existsSync(MCP_FILE)) return []
  try {
    const raw = JSON.parse(readFileSync(MCP_FILE, 'utf-8'))
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.mcpServers && !Array.isArray(raw.mcpServers)) {
      return Object.entries(raw.mcpServers as Record<string, Omit<McpServerConfig, 'name'>>).map(
        ([name, cfg]) => ({ name, ...cfg })
      )
    }
    if (Array.isArray(raw)) return raw as McpServerConfig[]
    if (raw?.mcpServers && Array.isArray(raw.mcpServers)) return raw.mcpServers as McpServerConfig[]
    process.stderr.write(`[config] mcp.json 格式无法识别，已忽略\n`)
    return []
  } catch (err) {
    process.stderr.write(`[config] mcp.json 解析失败: ${String(err)}\n`)
    return []
  }
}

export function saveConfig(patch: Partial<AgentConfig>) {
  ensureConfigDir()
  const current = loadConfig()

  // 将顶层 model 字段同步到 agent.model（如果 patch 中有 model 但没有 agent.model）
  const mergedPatch = { ...patch }
  if (patch.model && !patch.agent?.model) {
    mergedPatch.agent = { ...patch.agent, model: patch.model }
  }

  const updated = normalize({ ...current, ...mergedPatch })
  saveYamlFile(CONFIG_YAML_FILE, updated)
  _cachedConfig = updated
  _cachedMtime = existsSync(CONFIG_YAML_FILE) ? statSync(CONFIG_YAML_FILE).mtimeMs : 0
}

/** 清除单例缓存（测试用） */
export function _resetConfigCache() {
  _cachedConfig = null
  _cachedMtime = 0
}

export function getConfigDir(): string {
  return CONFIG_DIR
}

/** 检查主智能体配置是否已初始化（agents/main/ 目录 + IDENTITY.md） */
export function hasMainAgentConfig(): boolean {
  const identityPath = join(CONFIG_DIR, 'agents', 'main', 'IDENTITY.md')
  return existsSync(identityPath)
}

// ── 便捷读取函数 ──────────────────────────────────────────────

/**
 * 按提供商 ID 查找 API Key。
 * 依次从 llm / vision / speech / embedding 的 fallbacks 中查找，
 * 最后兜底 config.apiKey（顶层内联 key）。
 */
export function getApiKey(providerId: string): string | undefined {
  const config = loadConfig()
  const canonical = normalizeProvider(providerId)
  const modelTypes: Array<ModelTypeConfig | undefined> = [
    config.llm, config.vision, config.speech, config.embedding,
  ]
  for (const mt of modelTypes) {
    const found = mt?.fallbacks?.find(fb => normalizeProvider(fb.provider) === canonical)
    if (found?.apiKey) return found.apiKey
  }
  return config.apiKey
}