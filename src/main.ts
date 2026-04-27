import 'dotenv/config'
import { setupSystemProxy } from './core/proxySetup.js'
setupSystemProxy()

import { Command } from 'commander'
import { loadConfig, saveConfig } from './core/Config.js'
import { QueryEngine } from './core/QueryEngine.js'
import { PermissionManager } from './core/PermissionManager.js'
import { listSessions, pruneOldSessions } from './core/SessionStore.js'
import { buildSystemContext, getDynamicContext } from './core/ContextBuilder.js'
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

// 启动配置校验：在实际调用 API 前提前检测缺失的必要配置
function validateStartupConfig(opts: Record<string, string | boolean | undefined>) {
  const isOllama = opts.provider === 'ollama'
    || (opts.baseUrl as string | undefined)?.includes('localhost')
    || (opts.baseUrl as string | undefined)?.includes('127.0.0.1')

  if (!isOllama) {
    const hasAnyKey = !!(
      opts.apiKey
      || process.env.ANTHROPIC_API_KEY
      || process.env.OPENAI_API_KEY
      || process.env.DEEPSEEK_API_KEY
      || process.env.GROQ_API_KEY
      || process.env.DASHSCOPE_API_KEY
      || process.env.ZHIPU_API_KEY
      || process.env.NVIDIA_API_KEY
      || process.env.CUSTOM_API_KEY
    )
    if (!hasAnyKey) {
      process.stderr.write(
        `\x1b[33m[警告]\x1b[0m 未检测到任何 API Key，请设置对应的环境变量（如 ANTHROPIC_API_KEY）或使用 --api-key 参数\n`,
      )
    }
  }
}

// 启动时用基础层（不含扩展）构建初始 systemPrompt
// 每次用户发消息时，根据消息内容动态注入对应扩展块
const BASE_SYSTEM_PROMPT = getCoordinatorSystemPrompt()

async function main() {
  const program = new Command()

  program
    .name('hrids-agent')
    .description('原创智能体 CLI，支持 Anthropic / OpenAI / DeepSeek / Groq / Ollama')
    .version('0.1.0')
    .option('-m, --model <model>', '模型名称（自动识别提供商）', process.env.DEFAULT_MODEL ?? 'claude-sonnet-4-5')
    .option('--provider <provider>', '显式指定提供商：anthropic | openai | deepseek | groq | ollama | aliyun | custom')
    .option('--api-key <key>', 'API Key（也可通过环境变量设置）')
    .option('--base-url <url>', '自定义 API 端点（Ollama / 本地代理）')
    .option('--craft', '自主执行模式（无需确认写操作，agent 独立完成任务）')
    .option('--plan', '计划模式（只读，写操作需手动确认后执行）')
    .option('--resume <sessionId>', '恢复之前的会话')
    .option('--list-sessions', '列出最近的会话')
    .option('--new-session', '强制创建新会话（默认自动恢复上次会话）')
    .option('-p, --print <message>', '非交互模式：执行一条消息后退出')
    .option('--server', 'Server 模式：持续从 stdin 读取消息（NDJSON），保持会话历史')
    .option('--gateway', 'Gateway 模式：启动 HTTP + WebSocket 服务，供前端或远程客户端连接')
    .option('--gateway-port <port>', 'Gateway 监听端口（默认 3282）', '3282')
    .option('--gateway-host <host>', 'Gateway 监听地址（默认 127.0.0.1）', '127.0.0.1')
    .option('--gateway-token <token>', 'Gateway 鉴权 Token（可选）')
    .option('--embedding-provider <provider>', 'Embedding 提供商：openai | ollama | tfidf（默认 tfidf）')
    .option('--embedding-model <model>', 'Embedding 模型名称')
    .option('--embedding-base-url <url>', 'Embedding API 端点（Ollama 用）')
    .option('--cwd <dir>', '设置工作目录（覆盖配置文件中的 agentCwd）')
    .option('--max-chars <n>', '非交互模式（-p）输出字符上限，超出后截断（默认不限制）')
    .addHelpText('after', `
示例:
  # Anthropic（自动识别）
  ANTHROPIC_API_KEY=sk-ant-... npx tsx src/main.ts

  # OpenAI
  OPENAI_API_KEY=sk-... npx tsx src/main.ts -m gpt-4o

  # DeepSeek
  DEEPSEEK_API_KEY=sk-... npx tsx src/main.ts -m deepseek-chat

  # Groq（免费）
  GROQ_API_KEY=gsk_... npx tsx src/main.ts -m llama-3.3-70b-versatile

  # 阿里云百炼（DashScope）
  DASHSCOPE_API_KEY=sk-... npx tsx src/main.ts -m qwen-max

  # Ollama 本地模型（无需 API Key）
  npx tsx src/main.ts -m qwen2.5-coder:7b --provider ollama

  # 自定义端点
  npx tsx src/main.ts -m my-model --provider custom --base-url http://localhost:8080/v1 --api-key token
    `)
    .action(async (opts) => {
      validateStartupConfig(opts as Record<string, string | boolean | undefined>)

      // 初始化 Embedding 提供商
      if (opts.embeddingProvider && opts.embeddingProvider !== 'tfidf') {
        resetEmbeddingProvider({
          provider: opts.embeddingProvider,
          model: opts.embeddingModel,
          baseUrl: opts.embeddingBaseUrl,
          apiKey: opts.apiKey ?? process.env.OPENAI_API_KEY,
        })
      }

      // Gateway 模式：独立启动，不需要 provider/engine
      if (opts.gateway) {
        await runGatewayMode({
          gatewayPort: opts.gatewayPort,
          gatewayHost: opts.gatewayHost,
          gatewayToken: opts.gatewayToken,
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

      const config = loadConfig()
      const model = opts.model ?? config.model
      const memoryCondense = process.env.MEMORY_CONDENSE === 'true' || (config.memoryCondense ?? false)
      const skillDistill = process.env.AUTO_DISTILL_SKILL === 'true' || (config.autoDistillSkill ?? false)

      // 后台清理过期会话（默认保留最近 30 个）
      setImmediate(() => { try { pruneOldSessions() } catch { /* 忽略 */ } })

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
          model,
          apiKey: opts.apiKey ?? config.apiKey,
          baseUrl: opts.baseUrl || config.baseUrl || undefined,
          provider: opts.provider ?? config.provider,
        })
      } catch (err) {
        console.error(`\n错误: ${String(err)}\n`)
        console.error('支持的提供商及对应环境变量：')
        console.error('  Anthropic  -> ANTHROPIC_API_KEY')
        console.error('  OpenAI     -> OPENAI_API_KEY')
        console.error('  DeepSeek   -> DEEPSEEK_API_KEY')
        console.error('  Groq       -> GROQ_API_KEY')
        console.error('  阿里云     -> DASHSCOPE_API_KEY（模型如 qwen-max、qwen-plus）')
        console.error('  Ollama     -> 无需 Key，使用 --provider ollama')
        console.error('  自定义     -> --provider custom --base-url <url> --api-key <key>')
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
        createAgentTool(opts.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '', model),
        ...mcpTools,
      ]

      // 初始化全局 TeamManager（多智能体协调）
      TeamManager.init(provider, tools)

      const systemPrompt = await buildSystemContext(BASE_SYSTEM_PROMPT)

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
        const { classifyTask } = await import('./core/coordinator/coordinatorPrompt.js')
        const taskPrompt = getCoordinatorSystemPrompt(msg)
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
