import { homedir } from 'os'
import { join } from 'path'
import { setupSystemProxy } from './core/proxySetup.js'
setupSystemProxy()

import { Command } from 'commander'
import { loadConfig, saveConfig } from './core/Config.js'
import { QueryEngine } from './core/QueryEngine.js'
import { PermissionManager } from './core/PermissionManager.js'
import { listSessions, pruneOldSessions } from './core/SessionStore.js'
import { buildSystemContext } from './core/ContextBuilder.js'
import { getCoordinatorSystemPrompt } from './core/coordinator/coordinatorPrompt.js'
import { ALL_TOOLS } from './tools/index.js'
import { getGlobalCwd } from './core/cwd.js'
import { restoreScheduledJobs } from './tools/ScheduleCronTool.js'
import { createAgentTool } from './tools/AgentTool.js'
import { loadMcpTools } from './tools/McpTool.js'
import { TeamManager } from './core/coordinator/TeamManager.js'
import { resetEmbeddingProvider } from './memory/index.js'
import { logger } from './core/logger.js'

import { setupProvider } from './bootstrap/setupProvider.js'
import { setupSession } from './bootstrap/setupSession.js'
import { runGatewayMode } from './modes/gatewayMode.js'
import { runPrintMode } from './modes/printMode.js'
import { runServerMode } from './modes/serverMode.js'
import { runInteractiveMode } from './modes/interactiveMode.js'
import { runInitCommand } from './commands/init.js'

// 启动配置校验：在实际调用 API 前提前检测缺失的必要配置
function validateStartupConfig(config: import('./core/Config.js').AgentConfig, cliApiKey?: string) {
  const isOllama = config.provider === 'ollama'
    || config.baseUrl?.includes('localhost')
    || config.baseUrl?.includes('127.0.0.1')

  if (!isOllama) {
    const hasAnyKey = !!(
      cliApiKey
      || config.apiKey
      || config.llm?.fallbacks?.some(g => g.apiKey)
    )
    if (!hasAnyKey) {
      process.stderr.write(
        `\x1b[33m[警告]\x1b[0m 未检测到任何 API Key，请在 config.json 的 llm.fallbacks 中为各提供商配置 apiKey\n`,
      )
    }
  }
}

// 启动时用基础层（不含扩展）构建初始 systemPrompt
// 每次用户发消息时，根据消息内容动态注入对应扩展块
// 注意：此处不含 MCP 工具（MCP 在 main() 内部加载），仅含内置工具
// 实际运行时每条消息前会调用 buildPromptForMessage 重新生成含完整工具列表的 prompt
const BASE_SYSTEM_PROMPT = getCoordinatorSystemPrompt(undefined, ALL_TOOLS)

async function main() {
  const program = new Command()

  program
    .name('hrids-agent')
    .description('原创智能体 CLI，支持 Anthropic / OpenAI / DeepSeek / Groq / Ollama')
    .version('0.1.0')

  // ── init 子命令 ──────────────────────────────────────────────
  program
    .command('init')
    .description('初始化配置文件（~/.hrids-agent/config.json）')
    .option('--force', '强制覆盖已有配置文件')
    .action(async (opts) => {
      await runInitCommand({ force: opts.force })
    })

  // ── 主命令 ──────────────────────────────────────────────────
  program
    .option('-m, --model <model>', '模型名称（自动识别提供商）', 'qwen-plus-2025-07-28')
    .option('--provider <provider>', '显式指定提供商：anthropic | openai | deepseek | groq | aliyun | zhipu | nvidia | kimi | minimax | google | openrouter | ollama | custom')
    .option('--api-key <key>', 'API Key（覆盖 config.json 中的配置）')
    .option('--base-url <url>', '自定义 API 端点（Ollama / 本地代理）')
    .option('--craft', '自主执行模式（无需确认写操作，agent 独立完成任务）')
    .option('--plan', '计划模式（只读，写操作需手动确认后执行）')
    .option('--resume <sessionId>', '恢复之前的会话')
    .option('--list-sessions', '列出最近的会话')
    .option('--new-session', '强制创建新会话（默认自动恢复上次会话）')
    .option('-p, --print <message>', '非交互模式：执行一条消息后退出')
    .option('--server', 'Server 模式：持续从 stdin 读取消息（NDJSON），保持会话历史')
    .option('--gateway', 'Gateway 模式：启动 HTTP + WebSocket 服务，供前端或远程客户端连接')
    .option('--gateway-port <port>', 'Gateway 监听端口（覆盖 config.json gateway.port，默认 3282）')
    .option('--gateway-host <host>', 'Gateway 监听地址（覆盖 config.json gateway.host，默认 127.0.0.1）')
    .option('--gateway-token <token>', 'Gateway 鉴权 Token（覆盖 config.json gateway.token）')
    .option('--embedding-provider <provider>', 'Embedding 提供商：openai | aliyun | ollama | tfidf（默认 tfidf）')
    .option('--embedding-model <model>', 'Embedding 模型名称')
    .option('--embedding-base-url <url>', 'Embedding API 端点（Ollama 用）')
    .option('--cwd <dir>', '设置工作目录（覆盖 config.json agent.cwd）')
    .option('--max-chars <n>', '非交互模式（-p）输出字符上限，超出后截断（默认不限制）')
    .addHelpText('after', `
配置:
  首次运行会自动生成 ~/.hrids-agent/config.json
  也可运行 hrids-agent init 手动初始化配置文件

示例:
  # 使用 config.json 中配置的默认模型和 API Key（推荐）
  hrids-agent

  # 临时指定模型（不修改配置文件）
  hrids-agent -m deepseek-chat
  hrids-agent -m qwen-max --provider aliyun

  # Ollama 本地模型（无需 API Key）
  hrids-agent -m qwen2.5-coder:7b --provider ollama

  # 自定义端点
  hrids-agent -m my-model --provider custom --base-url http://localhost:8080/v1 --api-key token

  # 非交互模式
  hrids-agent -p "帮我写一个 hello world"

  # 启动 Gateway 服务
  hrids-agent --gateway
`)
    .action(async (opts) => {
      const config = loadConfig()
      process.stderr.write(`[config] 配置目录: ${join(homedir(), '.hrids-agent')}\n`)
      validateStartupConfig(config, opts.apiKey)

      // 初始化 Embedding 提供商
      if (opts.embeddingProvider && opts.embeddingProvider !== 'tfidf') {
        resetEmbeddingProvider({
          provider: opts.embeddingProvider,
          model: opts.embeddingModel,
          baseUrl: opts.embeddingBaseUrl,
          apiKey: opts.apiKey,
        })
      }

      // Gateway 模式：独立启动，不需要 provider/engine
      // CLI 参数优先，其次读 config.gateway，最后用内置默认值
      if (opts.gateway) {
        await runGatewayMode({
          gatewayPort: opts.gatewayPort ?? String(config.gateway?.port ?? 3282),
          gatewayHost: opts.gatewayHost ?? config.gateway?.host ?? '127.0.0.1',
          gatewayToken: opts.gatewayToken ?? config.gateway?.token,
          gatewayUsers: config.gateway?.users,
        })
        return
      }

      // 列出会话
      if (opts.listSessions) {
        const sessions = listSessions()
        if (sessions.length === 0) {
          console.log('没有保存的会话。')
        } else {
          console.log('最近的会话:')
          sessions.slice(0, 10).forEach(s => {
            console.log(`  ${s.id}  ${s.updatedAt.slice(0, 16)}  ${s.title}`)
          })
        }
        return
      }

      const model = opts.model ?? config.model
      const memoryCondense = config.memoryCondense ?? false
      const skillDistill = config.autoDistillSkill ?? false

      // 后台清理过期会话（可通过 agent.autoPruneSessions 关闭，keepCount/maxAgeDays 可调）
      if (config.agent?.autoPruneSessions !== false) {
        setImmediate(() => {
          try {
            pruneOldSessions({
              keepCount:   config.agent?.pruneKeepCount,
              maxAgeDays:  config.agent?.pruneMaxAgeDays,
            })
          } catch { /* 忽略 */ }
        })
      }

      // 初始化会话和工作目录
      const { sessionId, initialMessages, initialCwd } = await setupSession({
        resume: opts.resume,
        newSession: opts.newSession,
        cwd: opts.cwd,
        agentCwd: config.agentCwd,
      })

      // 创建 LLM 提供商
      let provider
      try {
        provider = setupProvider({
          model: opts.model,
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl || undefined,
          provider: opts.provider,
          config,
        })
      } catch (err) {
        console.error(`\n错误: ${String(err)}\n`)
        console.error('请在 ~/.hrids-agent/config.json 中配置 llm.fallbacks 和各提供商的 apiKey')
        process.exit(1)
      }

      // 权限模式
      const permMode = opts.plan ? 'plan'
        : opts.craft ? 'craft'
        : config.permissionMode

      const permissions = new PermissionManager(permMode, async (req) => {
        process.stdout.write(`\n允许执行 "${req.description}"? [y/N/always] `)
        return new Promise(resolve => {
          const handler = (data: Buffer) => {
            process.stdin.removeListener('data', handler)
            const ans = data.toString().trim().toLowerCase()
            if (ans === 'always') {
              permissions.approvePermanent(req.toolName)
              resolve(true)
            } else {
              resolve(ans === 'y')
            }
          }
          process.stdin.once('data', handler)
        })
      })

      // 加载 MCP 工具
      const mcpTools = config.mcpServers.length > 0
        ? await loadMcpTools(config.mcpServers)
        : []

      const tools = [
        ...ALL_TOOLS,
        createAgentTool(opts.apiKey ?? config.apiKey ?? '', model),
        ...mcpTools,
      ]

      // 初始化全局 TeamManager（多智能体协调）
      TeamManager.init(provider, tools)

      // 用完整工具列表（含 MCP）构建初始 systemPrompt
      const initialPrompt = getCoordinatorSystemPrompt(undefined, tools)
      const systemPrompt = await buildSystemContext(initialPrompt)

      const engine = new QueryEngine({
        provider,
        systemPrompt,
        tools,
        permissions,
        maxTokens: config.maxTokens,
        maxTurns: config.maxTurns,
        maxBudgetUsd: config.maxBudgetUsd,
        autoCompactThreshold: config.autoCompactThreshold,
        initialMessages,
      })

      // 根据用户消息动态更新 systemPrompt（按任务类型注入扩展块）
      const buildPromptForMessage = async (msg: string): Promise<void> => {
        const taskPrompt = getCoordinatorSystemPrompt(msg, tools)
        const fullPrompt = await buildSystemContext(taskPrompt, getGlobalCwd())
        engine.setSystemPrompt(fullPrompt)
      }

      // 恢复持久化的定时任务
      restoreScheduledJobs()

      const modeOpts = {
        sessionId,
        initialCwd,
        model,
        memoryCondense,
        skillDistill,
        buildPromptForMessage,
      }

      // 非交互模式（-p）
      if (opts.print) {
        await buildPromptForMessage(opts.print)
        await runPrintMode(engine, provider, {
          ...modeOpts,
          message: opts.print,
          maxChars: opts.maxChars ? parseInt(opts.maxChars, 10) : undefined,
        })
        return
      }

      // Server 模式
      if (opts.server) {
        await runServerMode(engine, provider, {
          ...modeOpts,
          permMode,
        })
        return
      }

      // 交互模式（默认）
      await runInteractiveMode(engine, provider, {
        ...modeOpts,
        providerName: provider.name,
      })
    })

  await program.parseAsync()
}

main().catch(err => {
  logger.error('启动失败', { error: String(err) })
  console.error('启动失败:', err)
  process.exit(1)
})

// 全局未捕获异常保护（非 gateway/server 模式）
// Gateway 模式会在启动后覆盖这两个处理器（不退出进程）
process.on('uncaughtException', (err) => {
  logger.error('未捕获异常', { error: err.message, stack: err.stack })
  if (!process.argv.includes('--gateway')) {
    process.exit(1)
  }
})
process.on('unhandledRejection', (reason) => {
  logger.error('未处理的 Promise 拒绝', { reason: String(reason) })
})
