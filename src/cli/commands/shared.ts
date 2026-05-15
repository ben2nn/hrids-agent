// shared —— CLI 命令公共初始化逻辑
import { loadConfig, getConfigDir, hasMainAgentConfig } from '../../core/Config.js'
import { QueryEngine } from '../../core/QueryEngine.js'
import { PermissionManager } from '../../core/PermissionManager.js'
import { pruneOldSessions } from '../../core/SessionStore.js'
import { buildSystemContext } from '../../core/ContextBuilder.js'
import { getCoordinatorSystemPrompt, classifyTask } from '../../core/coordinator/coordinatorPrompt.js'
import { initProfileLoader, listProfiles } from '../../core/coordinator/ProfileLoader.js'
import { ALL_TOOLS } from '../../tools/index.js'
import { ToolRegistry } from '../../core/ToolRegistry.js'
import { getGlobalCwd } from '../../core/cwd.js'
import { createAgentTool, createAgentSpawnTool, createAgentWaitTool, createAgentCancelTool, createAgentListTool } from '../../tools/AgentTool.js'
import { loadMcpTools } from '../../tools/McpTool.js'
import { TeamManager } from '../../core/coordinator/TeamManager.js'
import { migrateOldMemoryStore } from '../../memory/index.js'
import { logger } from '../../core/logger.js'
import { setupProvider } from '../../bootstrap/setupProvider.js'
import { prepareSession, initSessionStorage } from '../../bootstrap/setupSession.js'
import type { LLMProvider } from '../../core/providers/index.js'
import type { ConversationStore } from '../../core/ConversationStore.js'

export interface BaseCliOpts {
  model?: string
  provider?: string
  apiKey?: string
  baseUrl?: string
  cwd?: string
}

export interface InitResult {
  config: ReturnType<typeof loadConfig>
  provider: LLMProvider
  engine: QueryEngine
  sessionId: string
  store: ConversationStore
  initialCwd: string
  model: string
  buildPromptForMessage: (msg: string) => Promise<void>
  /** 延迟初始化会话存储（首次提问时调用，传入当前 sessionId） */
  initSession: (sessionId: string) => void
}

export function fallbackStatusHandler(event: { type: string; provider: string; model: string; delayMs?: number; reason?: string }) {
  if (event.type === 'rate_limited' && event.delayMs) {
    process.stderr.write(`\r[providers] API 限流，等待 ${Math.round(event.delayMs / 1000)}s 后重试 (${event.provider}/${event.model})...\n`)
  } else if (event.type === 'retrying') {
    process.stderr.write(`\r[providers] 重试中: ${event.provider}/${event.model} (${event.reason ?? '未知错误'})\n`)
  } else if (event.type === 'switching') {
    process.stderr.write(`\r[providers] 切换到备用模型: ${event.provider}/${event.model}\n`)
  }
}

export async function initCli(opts: BaseCliOpts & {
  resume?: string
  newSession?: boolean
  permMode?: 'ask' | 'craft' | 'plan'
  autoApprove?: boolean
}): Promise<InitResult> {
  const config = loadConfig()
  logger.info(`配置目录: ${getConfigDir()}`)

  if (!hasMainAgentConfig()) {
    logger.warn('主智能体提示词未初始化，请运行: hrids-agent init')
  }

  migrateOldMemoryStore()

  const isOllama = config.provider === 'ollama'
    || config.baseUrl?.includes('localhost')
    || config.baseUrl?.includes('127.0.0.1')
  if (!isOllama) {
    const hasAnyKey = !!(opts.apiKey || config.apiKey || config.llm?.fallbacks?.some(g => g.apiKey))
    if (!hasAnyKey) {
      logger.warn('未检测到任何 API Key，请在 config.yaml 的 llm.fallbacks 中为各提供商配置 apiKey')
    }
  }

  const model = opts.model ?? config.model ?? 'qwen3.5-122b-a10b'

  if (config.agent?.autoPruneSessions !== false) {
    setImmediate(() => {
      try {
        pruneOldSessions({ keepCount: config.agent?.pruneKeepCount, maxAgeDays: config.agent?.pruneMaxAgeDays })
      } catch { /* 忽略 */ }
    })
  }

  const { sessionId, initialCwd } = prepareSession({
    resume: opts.resume,
    newSession: opts.newSession,
    cwd: opts.cwd,
    agentCwd: config.agent?.cwd,
  })

  let provider: LLMProvider
  try {
    provider = setupProvider({
      model: opts.model,
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl || undefined,
      provider: opts.provider,
      config,
      onStatus: fallbackStatusHandler,
    })
  } catch (err) {
    console.error(`\n错误: ${String(err)}\n`)
    console.error('请在 ~/.hrids/config.yaml 中配置 llm.fallbacks 和各提供商的 apiKey')
    process.exit(1)
  }

  const permMode = opts.permMode ?? config.agent?.permissionMode ?? 'ask'
  const permissions = opts.autoApprove
    ? new PermissionManager(permMode, async () => true)
    : new PermissionManager(permMode)

  const mcpTools = config.mcpServers.length > 0 ? await loadMcpTools(config.mcpServers) : []
  const tools = [
    ...ALL_TOOLS,
    createAgentTool(), createAgentSpawnTool(), createAgentWaitTool(), createAgentCancelTool(), createAgentListTool(),
    ...mcpTools,
  ]

  initProfileLoader(config.multiAgent?.profileDirs, process.cwd())
  TeamManager.init(provider, tools)

  const availableProfiles = listProfiles(config.multiAgent?.profiles)
  const initialPrompt = getCoordinatorSystemPrompt(undefined, tools, undefined, availableProfiles)
  const systemPrompt = await buildSystemContext(initialPrompt)

  const registry = new ToolRegistry().registerAll(tools)
  const engine = new QueryEngine({
    provider, systemPrompt, registry, permissions,
    maxTokens: config.agent?.maxTokens, maxTurns: config.agent?.maxTurns,
    maxBudgetUsd: config.agent?.maxBudgetUsd, autoCompactThreshold: config.agent?.autoCompactThreshold,
  })

  // 立即初始化会话存储（确保事件从第一条消息就开始持久化）
  initSessionStorage(engine, sessionId)

  const initSession = (sid: string) => initSessionStorage(engine, sid)

  const buildPromptForMessage = async (msg: string): Promise<void> => {
    const types = classifyTask(msg)
    engine.setChatMode(types.includes('chat'))
    const taskPrompt = getCoordinatorSystemPrompt(msg, tools, undefined, availableProfiles)
    const fullPrompt = await buildSystemContext(taskPrompt, getGlobalCwd())
    engine.setSystemPrompt(fullPrompt)
  }

  return { config, provider, engine, sessionId, store: engine.store, initialCwd, model, buildPromptForMessage, initSession }
}
