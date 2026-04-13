// 配置系统 —— 读写 ~/.hrids-agent/config.json
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { McpServerConfig } from '../tools/McpTool.js'

const CONFIG_DIR = join(homedir(), '.hrids-agent')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

export interface AgentConfig {
  model: string
  provider?: string
  apiKey?: string
  baseUrl?: string
  permissionMode: 'ask' | 'auto' | 'readonly'
  maxTokens: number
  maxTurns: number
  maxBudgetUsd?: number          // 单次会话成本上限（USD），不设则无限制
  autoCompactThreshold?: number  // 自动压缩触发的 token 估算阈值
  agentCwd?: string              // 持久化工作目录（不设则使用 ~/.hrids-agent/work/）
  memoryCondense?: boolean       // 会话结束后是否用 LLM 提炼记忆（消耗少量 token，默认 false）
  mcpServers: McpServerConfig[]
  theme: 'default' | 'minimal'
}

const DEFAULTS: AgentConfig = {
  model: 'claude-sonnet-4-5',
  permissionMode: 'ask',
  maxTokens: 8096,
  maxTurns: 50,
  mcpServers: [],
  theme: 'default',
}

function ensureConfigDir() {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true })
}

export function loadConfig(): AgentConfig {
  ensureConfigDir()
  if (!existsSync(CONFIG_FILE)) return { ...DEFAULTS }

  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as Partial<AgentConfig>
    return { ...DEFAULTS, ...raw }
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveConfig(config: Partial<AgentConfig>) {
  ensureConfigDir()
  const current = loadConfig()
  const updated = { ...current, ...config }
  writeFileSync(CONFIG_FILE, JSON.stringify(updated, null, 2), 'utf-8')
}

export function getConfigDir(): string {
  return CONFIG_DIR
}
