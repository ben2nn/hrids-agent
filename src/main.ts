import 'dotenv/config'
import { Command } from 'commander'
import { render } from 'ink'
import React from 'react'
import { loadConfig, saveConfig } from './core/Config.js'
import { QueryEngine } from './core/QueryEngine.js'
import { PermissionManager } from './core/PermissionManager.js'
import { CommandRegistry, createBuiltinCommands } from './core/CommandRegistry.js'
import { generateSessionId, loadSession, listSessions, saveSession, getLastSessionId } from './core/SessionStore.js'
import { buildSystemContext, getDynamicContext, getDefaultAgentCwd } from './core/ContextBuilder.js'
import { createProvider, createProviderFromEnv } from './core/providers/index.js'
import { TeamManager } from './core/coordinator/TeamManager.js'
import { getCoordinatorSystemPrompt } from './core/coordinator/coordinatorPrompt.js'
import { ALL_TOOLS } from './tools/index.js'
import { setGlobalCwd, getGlobalCwd } from './tools/BashTool.js'
import { resolveAskUser } from './tools/AskUserTool.js'
import { resolveDecision } from './tools/DecisionTool.js'
import { restoreScheduledJobs } from './tools/ScheduleCronTool.js'
import { createAgentTool } from './tools/AgentTool.js'
import { loadMcpTools, disconnectAllMcp } from './tools/McpTool.js'
import { App } from './ui/App.js'
import { createGateway } from './gateway/server.js'
import { runMemoryPipeline, resetEmbeddingProvider } from './memory/index.js'
import { registerAllBundledSkills, buildSkillRegistry } from './skills/index.js'
import { logger } from './core/logger.js'
import { mkdirSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const log = logger.child({ component: 'main' })

// ── 启动配置校验 ──────────────────────────────────────────────
// 在实际调用 API 前提前检测缺失的必要配置，给出明确提示
function validateStartupConfig(opts: Record<string, string | boolean | undefined>, model: string) {
  const warnings: string[] = []

  // 检查是否有任何 API Key（Ollama 除外）
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
      warnings.push('未检测到任何 API Key，请设置对应的环境变量（如 ANTHROPIC_API_KEY）或使用 --api-key 参数')
    }
  }

  if (warnings.length > 0) {
    for (const w of warnings) {
      process.stderr.write(`\x1b[33m[警告]\x1b[0m ${w}\n`)
    }
  }
}

// 会话结束后自动提炼记忆（后台静默执行，不阻塞主流程）
async function autoExtractMemories(
  engine: QueryEngine,
  sessionId: string,
  provider: import('./core/providers/index.js').LLMProvider,
  condense: boolean,
) {
  try {
    const history = engine.getHistory()
    await runMemoryPipeline(history as never, {
      condense,
      provider: condense ? provider : undefined,
      sessionId,
    })
  } catch {
    // 静默失败，不影响主流程
  }
}

// 会话结束后自动提炼 skill（后台静默执行，不阻塞主流程）
// 启发式判断：工具调用次数 >= 5 且会话有实质内容，才尝试提炼
async function autoDistillSkill(engine: QueryEngine, provider: import('./core/providers/index.js').LLMProvider): Promise<void> {
  try {
    const history = engine.getHistory()

    // 统计工具调用次数
    let toolCallCount = 0
    for (const msg of history) {
      if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue
      for (const b of msg.content as import('./core/QueryEngine.js').ContentBlock[]) {
        if (b.type === 'tool_use') toolCallCount++
      }
    }

    // 门槛：工具调用 < 5 次，不值得沉淀
    if (toolCallCount < 5) return

    // 序列化对话历史（只保留文本和工具调用摘要，控制 token）
    const lines: string[] = []
    for (const msg of history) {
      if (typeof msg.content === 'string') {
        lines.push(`[${msg.role === 'user' ? '用户' : '助手'}]: ${msg.content.slice(0, 500)}`)
        continue
      }
      const parts: string[] = []
      for (const b of msg.content as import('./core/QueryEngine.js').ContentBlock[]) {
        if (b.type === 'text') parts.push(b.text.slice(0, 300))
        else if (b.type === 'tool_use') parts.push(`[调用工具: ${b.name}]`)
      }
      if (parts.length > 0) {
        lines.push(`[${msg.role === 'user' ? '用户' : '助手'}]: ${parts.join(' ')}`)
      }
    }
    const condensed = lines.join('\n').slice(0, 6000)

    // 调用 LLM 判断是否值得沉淀，并提炼 skill
    const distillPrompt = `以下是一段 agent 完成任务的对话历史（共 ${toolCallCount} 次工具调用）。

请判断这个工作流是否值得沉淀为可复用的 skill。

**值得沉淀的条件（满足任一即可）：**
- 包含 3 个以上不同工具的协作使用
- 克服了错误或障碍后找到了可行方案
- 包含可重复的、有价值的操作模式

**不值得沉淀：**
- 简单的问答或单一工具操作
- 高度特定于当前项目、无法复用的内容

如果不值得沉淀，只输出：null

如果值得沉淀，输出以下 JSON（不要包含任何其他内容）：
{
  "name": "英文小写连字符名称，描述任务类型",
  "description": "一句话描述这个 skill 的用途（中文）",
  "when_to_use": "什么情况下应该使用这个 skill（中文）",
  "prompt": "完整的 Markdown 格式执行步骤，用占位符替换具体路径/项目名，如 <目标文件>、<项目名>"
}

对话历史：
${condensed}`

    let raw = ''
    for await (const chunk of provider.stream(
      [{ role: 'user', content: distillPrompt }],
      [],
      '你是一个 skill 提炼助手，只输出 null 或 JSON，不输出任何其他内容。',
      2000,
    )) {
      if (chunk.type === 'text_delta' && chunk.delta) raw += chunk.delta
    }

    const trimmed = raw.trim()
    if (!trimmed || trimmed === 'null') return

    // 解析 JSON（容忍 markdown 代码块包裹）
    const jsonStr = trimmed.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
    let parsed: { name: string; description: string; when_to_use?: string; prompt: string }
    try {
      parsed = JSON.parse(jsonStr)
    } catch {
      return // 解析失败静默跳过
    }

    if (!parsed.name || !parsed.prompt) return

    // 检查是否已有同名 skill（避免重复沉淀）
    const skillsDir = join(homedir(), '.hrids-agent', 'skills')
    const skillDir = join(skillsDir, parsed.name)
    const skillMdPath = join(skillDir, 'SKILL.md')
    const isUpdate = existsSync(skillMdPath)

    // 构建 SKILL.md
    const frontmatter = [
      '---',
      `description: "${parsed.description}"`,
      parsed.when_to_use ? `when-to-use: "${parsed.when_to_use}"` : null,
      '---',
    ].filter(Boolean).join('\n')

    const content = frontmatter + '\n\n' + parsed.prompt.trim() + '\n'

    mkdirSync(skillDir, { recursive: true })
    writeFileSync(skillMdPath, content, 'utf-8')

    log.info(`自动沉淀 skill: ${parsed.name}（${isUpdate ? '更新' : '新建'}）`, { path: skillMdPath })
  } catch {
    // 静默失败，不影响主流程
  }
}

const BASE_SYSTEM_PROMPT = getCoordinatorSystemPrompt()

async function main() {
  const program = new Command()

  program
    .name('hrids-agent')
    .description('原创智能体 CLI，支持 Anthropic / OpenAI / DeepSeek / Groq / Ollama')
    .version('0.1.0')
    .option('-m, --model <model>', '模型名称（自动识别提供商）', process.env.DEFAULT_MODEL ?? 'claude-sonnet-4-5')
    .option('--provider <provider>', '显式指定提供商: anthropic | openai | deepseek | groq | ollama | aliyun | custom')
    .option('--api-key <key>', 'API Key（也可通过环境变量设置）')
    .option('--base-url <url>', '自定义 API 端点（Ollama / 本地代理）')
    .option('--auto', '自动模式（无需确认写操作）')
    .option('--readonly', '只读模式')
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
    .option('--embedding-provider <provider>', 'Embedding 提供商: openai | ollama | tfidf（默认 tfidf）')
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
  DASHSCOPE_API_KEY=sk-... npx tsx src/main.ts -m qwen-plus --provider aliyun

  # Ollama 本地模型（无需 API Key）
  npx tsx src/main.ts -m qwen2.5-coder:7b --provider ollama

  # 自定义端点
  npx tsx src/main.ts -m my-model --provider custom --base-url http://localhost:8080/v1 --api-key token
    `)
    .action(async (opts) => {
      // 启动配置校验
      validateStartupConfig(opts as Record<string, string | boolean | undefined>, opts.model)

      // 初始化 Embedding 提供商（影响记忆系统的 L3 搜索质量）
      if (opts.embeddingProvider && opts.embeddingProvider !== 'tfidf') {
        resetEmbeddingProvider({
          provider: opts.embeddingProvider,
          model: opts.embeddingModel,
          baseUrl: opts.embeddingBaseUrl,
          apiKey: opts.apiKey ?? process.env.OPENAI_API_KEY,
        })
      }

      // Gateway 模式：独立启动，不需要 provider/engine，由 SessionManager 按需创建
      if (opts.gateway) {
        const gateway = createGateway({
          port: parseInt(opts.gatewayPort, 10),
          host: opts.gatewayHost,
          authToken: opts.gatewayToken,
        })
        await gateway.start()
        console.log(`[gateway] 端点:`)
        console.log(`  REST  http://${opts.gatewayHost}:${opts.gatewayPort}/sessions`)
        console.log(`  WS    ws://${opts.gatewayHost}:${opts.gatewayPort}/sessions/:id/stream`)
        if (opts.gatewayToken) {
          console.log(`  Token ${opts.gatewayToken}`)
        }
        // 保持进程运行，监听退出信号
        const shutdown = async (signal: string) => {
          log.info(`收到 ${signal}，开始优雅关闭...`)
          process.stdout.write(`\n[gateway] 正在关闭（${signal}）...\n`)
          try {
            await gateway.stop(15000)
          } catch (err) {
            log.error('关闭失败', { error: String(err) })
          }
          process.exit(0)
        }
        process.on('SIGINT', () => void shutdown('SIGINT'))
        process.on('SIGTERM', () => void shutdown('SIGTERM'))
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
      // 记忆提炼开关：环境变量优先，其次 config.json
      const memoryCondense = process.env.MEMORY_CONDENSE === 'true' || (config.memoryCondense ?? false)

      // 初始化工作目录（优先级：--cwd > config.agentCwd > 默认）
      const initialCwd = opts.cwd ?? config.agentCwd ?? getDefaultAgentCwd()
      setGlobalCwd(initialCwd)
      try { process.chdir(initialCwd) } catch { /* 目录不存在时忽略 */ }

      // 创建 LLM 提供商：优先读取 LLM_FALLBACK_* 多模型配置，否则用单一 model
      let provider
      try {
        // 有 LLM_FALLBACK_* 配置时用 FallbackProvider，否则退回单一 provider
        const hasFallback = !!process.env.LLM_FALLBACK_1
        provider = hasFallback
          ? createProviderFromEnv()
          : createProvider({
              model,
              apiKey: opts.apiKey ?? config.apiKey,
              baseUrl: opts.baseUrl || config.baseUrl || undefined,
              provider: opts.provider ?? config.provider,
            })
      } catch (err) {
        console.error(`\n错误: ${String(err)}\n`)
        console.error('支持的提供商及对应环境变量:')
        console.error('  Anthropic  →  ANTHROPIC_API_KEY')
        console.error('  OpenAI     →  OPENAI_API_KEY')
        console.error('  DeepSeek   →  DEEPSEEK_API_KEY')
        console.error('  Groq       →  GROQ_API_KEY')
        console.error('  阿里云     →  DASHSCOPE_API_KEY（模型如 qwen-max、qwen-plus）')
        console.error('  Ollama     →  无需 Key，使用 --provider ollama')
        console.error('  自定义     →  --provider custom --base-url <url> --api-key <key>')
        process.exit(1)
      }

      // 权限模式
      const permMode = opts.readonly ? 'readonly'
        : opts.plan ? 'plan'
        : opts.auto ? 'auto'
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

      // 会话管理：优先 --resume，其次自动恢复上次会话，--new-session 强制新建
      const sessionId = opts.resume
        ?? (opts.newSession ? null : getLastSessionId())
        ?? generateSessionId()
      const initialMessages = (opts.resume || !opts.newSession)
        ? (loadSession(sessionId) ?? [])
        : []
      if (initialMessages.length > 0) {
        console.log(`已恢复会话 ${sessionId}（${initialMessages.length} 条消息）`)
      }

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

      // 恢复持久化的定时任务（回调由 App 组件内注册，避免绕过 Ink 渲染层）
      restoreScheduledJobs()

      // 非交互模式
      if (opts.print) {
        const maxChars = opts.maxChars ? parseInt(opts.maxChars, 10) : Infinity
        let totalChars = 0
        let truncated = false
        for await (const ev of engine.send(opts.print)) {
          if (ev.type === 'text_delta') {
            if (truncated) continue
            const remaining = maxChars - totalChars
            if (ev.delta.length > remaining) {
              process.stdout.write(ev.delta.slice(0, remaining))
              process.stdout.write(`\n...[输出已截断，共超过 ${maxChars} 字符，使用 --max-chars 调整上限]`)
              truncated = true
            } else {
              process.stdout.write(ev.delta)
              totalChars += ev.delta.length
            }
          } else if (ev.type === 'error') {
            process.stderr.write(`\n错误: ${ev.message}\n`)
          }
        }
        process.stdout.write('\n')
        saveSession(sessionId, engine.getHistory(), model)
        void autoExtractMemories(engine, sessionId, provider, memoryCondense)
        void autoDistillSkill(engine, provider)
        await disconnectAllMcp()
        return
      }

      // Server 模式：持续从 stdin 读取消息，保持会话历史
      if (opts.server) {
        process.env.AGENT_SERVER_MODE = '1'
        const { createInterface } = await import('readline')
        const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
        const emit = (obj: object) => {
          try {
            process.stdout.write(JSON.stringify(obj) + '\n')
          } catch (e) {
            process.stderr.write(`[emit error] ${String(e)}\n`)
          }
        }

        // 捕获未处理的异常，确保进程不会静默崩溃
        process.on('uncaughtException', (err) => {
          process.stderr.write(`[uncaughtException] ${String(err)}\n`)
          emit({ type: 'error', message: `进程内部错误: ${String(err)}` })
        })
        process.on('unhandledRejection', (reason) => {
          process.stderr.write(`[unhandledRejection] ${String(reason)}\n`)
          emit({ type: 'error', message: `未处理的异步错误: ${String(reason)}` })
        })

        emit({ type: 'ready' })

        // 初始化斜杠命令和 skills（server 模式同样支持）
        registerAllBundledSkills()
        const serverRegistry = new CommandRegistry()
        createBuiltinCommands('', model).forEach(c => serverRegistry.register(c))
        serverRegistry.registerSkills(buildSkillRegistry(getGlobalCwd()))

        // 用 Promise 链实现严格串行执行，彻底避免锁竞态
        // 每条消息都挂在上一条的 Promise 尾部，保证顺序且不并发
        let taskChain: Promise<void> = Promise.resolve()

        const enqueueMessage = (msg: string) => {
          taskChain = taskChain.then(async () => {
            // 处理斜杠命令（skill 注入等）
            const parsed = serverRegistry.parse(msg)
            if (parsed) {
              const cmd = serverRegistry.find(parsed.name)
              if (!cmd) {
                emit({ type: 'error', message: `未知命令: /${parsed.name}` })
                emit({ type: 'done' })
                return
              }
              // 构建最小 CommandContext（server 模式下部分功能不可用）
              const serverCtx = {
                clearHistory: () => engine.clearHistory(),
                compactHistory: async (s: string) => { engine.compactHistory(s) },
                generateCompactSummary: async () => engine.generateCompactSummary(),
                getHistoryLength: () => engine.getHistory().length,
                getEstimatedTokens: () => engine.getEstimatedTokens(),
                getCostSummary: () => engine.costs.getSummary(),
                getBudgetInfo: () => ({ spent: engine.costs.getCostUsd(), limit: undefined as number | undefined }),
                setModel: (m: string) => { /* server 模式暂不支持切换模型 */ },
                getModel: () => model,
                setMode: (_m: string) => {},
                getMode: () => permMode,
                sessionId,
                listSessions: () => listSessions(),
                newSession: () => { engine.clearHistory() },
                switchSession: (id: string) => {
                  const messages = loadSession(id)
                  if (!messages) return false
                  engine.setHistory(messages)
                  return true
                },
              }
              const result = await cmd.execute(parsed.args, serverCtx)
              if (result.type === 'exit') { process.exit(0) }
              if (result.type === 'message') { emit({ type: 'text_delta', delta: result.text }); emit({ type: 'done' }); return }
              if (result.type === 'noop') { emit({ type: 'done' }); return }
              if (result.type === 'inject') {
                // skill inject：将 skill prompt 发给 LLM
                try {
                  for await (const ev of engine.send(result.prompt)) {
                    emit(ev)
                  }
                  saveSession(sessionId, engine.getHistory(), model)
                  void autoExtractMemories(engine, sessionId, provider, memoryCondense)
                  void autoDistillSkill(engine, provider)
                } catch (err) {
                  emit({ type: 'error', message: `skill 执行失败: ${String(err)}` })
                  emit({ type: 'done' })
                }
                return
              }
              return
            }

            const msgWithCtx = msg + getDynamicContext(getGlobalCwd())
            try {
              for await (const ev of engine.send(msgWithCtx)) {
                emit(ev)
              }
              saveSession(sessionId, engine.getHistory(), model)
              void autoExtractMemories(engine, sessionId, provider, memoryCondense)
              void autoDistillSkill(engine, provider)
            } catch (err) {
              process.stderr.write(`[server] 消息处理异常: ${String(err)}\n`)
              emit({ type: 'error', message: `消息处理失败: ${String(err)}` })
              emit({ type: 'done' })
            }
          })
        }

        for await (const line of rl) {
          const trimmed = line.trim()
          if (!trimmed) continue
          let msg: string
          try {
            const parsed = JSON.parse(trimmed)
            // 处理用户对 ask_user 的回复（可在任务执行期间到达）
            if (parsed.type === 'user_reply') {
              resolveAskUser(parsed.answer ?? '')
              continue
            }
            // 处理用户对 request_decision 的回复
            if (parsed.type === 'decision_reply') {
              resolveDecision(parsed.answer ?? '')
              continue
            }
            // 处理中止指令（立即中止当前任务，不排队）
            if (parsed.type === 'abort') {
              engine.abort()
              continue
            }
            // 处理切换工作目录指令
            if (parsed.type === 'set_cwd' && parsed.cwd) {
              try {
                process.chdir(parsed.cwd)
                setGlobalCwd(parsed.cwd)
                emit({ type: 'cwd_changed', cwd: parsed.cwd })
              } catch (e) {
                emit({ type: 'error', message: `切换目录失败: ${String(e)}` })
              }
              continue
            }
            msg = parsed.message ?? trimmed
          } catch {
            msg = trimmed
          }

          // 加入 Promise 链，严格串行执行
          enqueueMessage(msg)
        }

        await disconnectAllMcp()
        return
      }

      // 注册斜杠命令
      const registry = new CommandRegistry()
      createBuiltinCommands('', model).forEach(c => registry.register(c))

      // 初始化 skills 系统，注册内置 skills 并加载用户/项目级 skills
      registerAllBundledSkills()
      const skillRegistry = buildSkillRegistry(getGlobalCwd())
      registry.registerSkills(skillRegistry)

      let currentModel = model

      // 自动保存会话 + 自动沉淀 skill
      const originalSend = engine.send.bind(engine)
      engine.send = async function* (msg: string) {
        yield* originalSend(msg)
        saveSession(sessionId, engine.getHistory(), currentModel)
        void autoExtractMemories(engine, sessionId, provider, memoryCondense)
        void autoDistillSkill(engine, provider)
      }

      const { waitUntilExit } = render(
        React.createElement(App, {
          engine,
          commands: registry,
          sessionId,
          currentModel,
          providerName: provider.name,
          getProviderName: () => ({ name: provider.name, model: provider.model }),
          onModelChange: (m: string) => {
            currentModel = m
            saveConfig({ model: m })
          },
        })
      )

      await waitUntilExit()
      await disconnectAllMcp()
    })

  await program.parseAsync()
}

main().catch(err => {
  log.error('启动失败', { error: String(err) })
  console.error('启动失败:', err)
  process.exit(1)
})

// 全局未捕获异常保护（非 server 模式）
process.on('uncaughtException', (err) => {
  log.error('未捕获异常', { error: err.message, stack: err.stack })
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  log.error('未处理的 Promise 拒绝', { reason: String(reason) })
})
