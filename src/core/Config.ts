// 配置系统 —— 读写 ~/.hrids-agent/config.json
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { McpServerConfig } from '../tools/McpTool.js'

const CONFIG_DIR = join(homedir(), '.hrids-agent')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')
const MCP_FILE = join(CONFIG_DIR, 'mcp.json')

export interface AgentConfig {
  model: string
  provider?: string
  apiKey?: string
  baseUrl?: string
  permissionMode: 'ask' | 'craft' | 'plan'
  maxTokens: number
  maxTurns: number
  maxBudgetUsd?: number          // 单次会话成本上限（USD），不设则无限制
  autoCompactThreshold?: number  // 自动压缩触发的 token 估算阈值
  agentCwd?: string              // 持久化工作目录（不设则使用 ~/.hrids-agent/work/）
  memoryCondense?: boolean       // 会话结束后是否用 LLM 提炼记忆（消耗少量 token，默认 false）
  autoDistillSkill?: boolean     // 会话结束后是否自动沉淀 skill（消耗少量 token，默认 false）
  mcpServers: McpServerConfig[]
  theme: 'default' | 'minimal'
}

// 硬编码的兜底默认值（不依赖任何环境变量）
const HARDCODED_DEFAULTS: AgentConfig = {
  model: 'qwen3.5-122b-a10b',
  permissionMode: 'ask',
  maxTokens: 8096,
  maxTurns: 50,
  mcpServers: [],
  theme: 'default',
}

function ensureConfigDir() {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true })
}

/**
 * 从当前环境变量推导出配置对象。
 * 仅在 config.json 不存在时调用，用于首次生成配置文件。
 */
function buildConfigFromEnv(): AgentConfig {
  // 模型：优先 DEFAULT_MODEL，否则用硬编码兜底
  const model = process.env.DEFAULT_MODEL ?? HARDCODED_DEFAULTS.model

  // 记忆提炼开关
  const memoryCondense = process.env.MEMORY_CONDENSE === 'true' ? true : undefined

  // 向量存储后端（仅记录，不影响 AgentConfig 结构，但可扩展）
  // process.env.VECTOR_STORE 已在 memory 模块中直接读取，此处不需要映射

  return {
    ...HARDCODED_DEFAULTS,
    model,
    ...(memoryCondense !== undefined ? { memoryCondense } : {}),
  }
}

export function loadConfig(): AgentConfig {
  ensureConfigDir()

  if (!existsSync(CONFIG_FILE)) {
    // 首次启动：根据 .env 生成配置并持久化
    const generated = buildConfigFromEnv()
    try {
      writeFileSync(CONFIG_FILE, JSON.stringify(generated, null, 2), 'utf-8')
      process.stderr.write(`[config] 首次启动，已根据 .env 生成配置文件: ${CONFIG_FILE}\n`)
    } catch (err) {
      process.stderr.write(`[config] 写入配置文件失败（将使用内存配置）: ${String(err)}\n`)
    }
    // 合并 mcp.json（若存在）
    const mcpFileServers = loadMcpFile()
    if (mcpFileServers.length > 0) {
      generated.mcpServers = [...generated.mcpServers, ...mcpFileServers]
    }
    return generated
  }

  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as Partial<AgentConfig>
    // 已有配置文件：用硬编码默认值补全缺失字段，不覆盖用户已设置的值
    const config = { ...HARDCODED_DEFAULTS, ...raw }
    // 合并 mcp.json（若存在）：将其中的服务器追加到 config.json 的 mcpServers 中，去重
    const mcpFileServers = loadMcpFile()
    if (mcpFileServers.length > 0) {
      const existingNames = new Set(config.mcpServers.map(s => s.name))
      const newServers = mcpFileServers.filter(s => !existingNames.has(s.name))
      config.mcpServers = [...config.mcpServers, ...newServers]
    }
    return config
  } catch {
    process.stderr.write(`[config] 配置文件解析失败，使用默认配置\n`)
    return { ...HARDCODED_DEFAULTS }
  }
}

/**
 * 读取 ~/.hrids-agent/mcp.json，支持两种格式：
 *   1. { "mcpServers": { "name": { command, args, env } } }  （对象格式，兼容 Claude Desktop）
 *   2. McpServerConfig[]  （数组格式，与 config.json 一致）
 */
function loadMcpFile(): McpServerConfig[] {
  if (!existsSync(MCP_FILE)) return []
  try {
    const raw = JSON.parse(readFileSync(MCP_FILE, 'utf-8'))
    // 格式一：{ mcpServers: { name: { command, args, env } } }
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.mcpServers && !Array.isArray(raw.mcpServers)) {
      return Object.entries(raw.mcpServers as Record<string, Omit<McpServerConfig, 'name'>>).map(
        ([name, cfg]) => ({ name, ...cfg })
      )
    }
    // 格式二：McpServerConfig[]
    if (Array.isArray(raw)) return raw as McpServerConfig[]
    // 格式三：{ mcpServers: McpServerConfig[] }
    if (raw?.mcpServers && Array.isArray(raw.mcpServers)) return raw.mcpServers as McpServerConfig[]
    process.stderr.write(`[config] mcp.json 格式无法识别，已忽略\n`)
    return []
  } catch (err) {
    process.stderr.write(`[config] mcp.json 解析失败: ${String(err)}\n`)
    return []
  }
}

export function saveConfig(config: Partial<AgentConfig>) {
  ensureConfigDir()
  const current = loadConfig()
  const updated = { ...current, ...config }
  // 原子写入：先写临时文件，再 rename，避免并发写入时配置文件损坏
  const tmpFile = CONFIG_FILE + '.tmp'
  writeFileSync(tmpFile, JSON.stringify(updated, null, 2), 'utf-8')
  renameSync(tmpFile, CONFIG_FILE)
}

export function getConfigDir(): string {
  return CONFIG_DIR
}
