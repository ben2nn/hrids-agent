// server 子命令 —— 持续从 stdin 读取消息（NDJSON）
import { saveSessionMeta, extractSessionTitle, generateSessionId, loadSessionMessages, listSessions, listArchives, archiveSession } from '../../core/SessionStore.js'
import { getSessionWorkDirPath } from '../../core/ContextBuilder.js'
import { setGlobalCwd, getGlobalCwd } from '../../core/cwd.js'
import { CommandRegistry, createBuiltinCommands } from '../../core/CommandRegistry.js'
import { createWorkdirCommands } from './WorkdirCommands.js'
import { resolveAskUser } from '../../tools/AskUserTool.js'
import { resolveDecision } from '../../tools/DecisionTool.js'
import { disconnectAllMcp } from '../../tools/McpTool.js'
import { autoExtractMemories, autoDistillSkill } from '../../core/postRunHooks.js'
import { registerAllBundledSkills, buildSkillRegistry } from '../../skills/index.js'
import { loadConfig } from '../../core/Config.js'
import type { QueryEngine } from '../../core/QueryEngine.js'
import type { LLMProvider } from '../../core/providers/index.js'
import { initCli, type BaseCliOpts } from './shared.js'

export interface ServerCommandOpts extends BaseCliOpts {
  craft?: boolean
  plan?: boolean
  profile?: string
}

export async function runServerCommand(opts: ServerCommandOpts): Promise<void> {
  const permMode = opts.plan ? 'plan' : opts.craft ? 'craft' : undefined
  const ctx = await initCli({ ...opts, permMode, autoApprove: true })

  await runServerMode(ctx.engine, ctx.provider, {
    sessionId: ctx.sessionId,
    initialCwd: ctx.initialCwd,
    model: ctx.model,
    permMode: permMode ?? ctx.config.agent?.permissionMode ?? 'ask',
    memoryCondense: ctx.config.agent?.memoryCondense ?? false,
    skillDistill: ctx.config.agent?.autoDistillSkill ?? false,
    buildPromptForMessage: ctx.buildPromptForMessage,
  })
}

// ─── Server 模式实现 ──────────────────────────────────────────────────────

export interface ServerModeOpts {
  sessionId: string
  initialCwd: string
  model: string
  permMode: string
  memoryCondense: boolean
  skillDistill: boolean
  buildPromptForMessage: (msg: string) => Promise<void>
}

export async function runServerMode(
  engine: QueryEngine,
  provider: LLMProvider,
  opts: ServerModeOpts,
): Promise<void> {
  process.env.AGENT_SERVER_MODE = '1'

  const { sessionId } = opts
  const { initialCwd, model, permMode, memoryCondense, skillDistill, buildPromptForMessage } = opts

  // 注册压缩前归档回调
  engine.onBeforeCompact = async (summary: string) => {
    engine.store.saveToDisk()
    archiveSession(sessionId, summary)
  }

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

  // 初始化斜杠命令和 skills
  registerAllBundledSkills()
  const serverRegistry = new CommandRegistry()
  createBuiltinCommands('', model).forEach(c => serverRegistry.register(c))
  createWorkdirCommands().forEach(c => serverRegistry.register(c))
  serverRegistry.registerSkills(buildSkillRegistry(getGlobalCwd()))

  // 用 Promise 链实现严格串行执行，彻底避免锁竞争
  let taskChain: Promise<void> = Promise.resolve()

  const enqueueMessage = (msg: string) => {
    taskChain = taskChain.then(async () => {
      // 处理斜杠命令
      const parsed = serverRegistry.parse(msg)
      if (parsed) {
        const cmd = serverRegistry.find(parsed.name)
        if (!cmd) {
          emit({ type: 'error', message: `未知命令: /${parsed.name}` })
          emit({ type: 'done' })
          return
        }

        const serverCtx = {
          clearHistory: () => engine.clearHistory(),
          compactHistory: async (s: string) => { engine.compactHistory(s) },
          generateCompactSummary: async () => engine.generateCompactSummary(),
          getHistoryLength: () => engine.store.getMessageCount(),
          getEstimatedTokens: () => engine.getEstimatedTokens(),
          getCostSummary: () => {
            const usage = engine.costs.getUsage()
            return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: engine.costs.getCostUsd() }
          },
          getBudgetInfo: () => ({ spent: engine.costs.getCostUsd(), limit: undefined as number | undefined }),
          setModel: (_m: string) => { /* server 模式暂不支持切换模型 */ },
          getModel: () => model,
          setMode: (_m: string) => {},
          getMode: () => permMode,
          sessionId,
          listSessions: () => listSessions(),
          listArchives: () => listArchives(sessionId),
          newSession: () => {
            const newId = generateSessionId()
            engine.clearHistory()
            const newWorkDir = getSessionWorkDirPath(newId)
            setGlobalCwd(newWorkDir)
            // 不调用 process.chdir，避免影响全局进程工作目录
          },
          switchSession: (id: string) => {
            const messages = loadSessionMessages(id)
            if (!messages) return false
            engine.store.replaceMessages(messages)
            return true
          },
          getAvailableModels: () => {
            const config = loadConfig()
            const models: Array<{ provider: string; model: string; isDefault?: boolean }> = []
            const defaultModel = config.agent?.model

            // 从 llm.fallbacks 中提取所有模型
            if (config.llm?.fallbacks) {
              for (const group of config.llm.fallbacks) {
                for (const m of group.models) {
                  models.push({
                    provider: group.provider,
                    model: m,
                    isDefault: m === defaultModel,
                  })
                }
              }
            }

            // 如果没有 fallbacks，使用默认模型
            if (models.length === 0 && defaultModel) {
              models.push({
                provider: config.provider || 'unknown',
                model: defaultModel,
                isDefault: true,
              })
            }

            return models
          },
        }

        const result = await cmd.execute(parsed.args, serverCtx)
        if (result.type === 'exit') { process.exit(0) }
        if (result.type === 'message') {
          emit({ type: 'text_delta', delta: result.text })
          emit({ type: 'done' })
          return
        }
        if (result.type === 'noop') { emit({ type: 'done' }); return }
        if (result.type === 'inject') {
          try {
            await buildPromptForMessage(result.prompt)
            for await (const ev of engine.run(result.prompt)) {
              emit(ev)
            }
            const { title, lastUserMessage } = extractSessionTitle(engine.store.getMessages())
            saveSessionMeta(sessionId, { model, workDir: initialCwd, messageCount: engine.store.getMessageCount(), title, lastUserMessage })
            void autoExtractMemories(engine, sessionId, provider, memoryCondense)
            void autoDistillSkill(engine, provider, skillDistill)
          } catch (err) {
            emit({ type: 'error', message: `skill 执行失败: ${String(err)}` })
            emit({ type: 'done' })
          }
          return
        }
        return
      }

      const msgWithCtx = msg
      try {
        await buildPromptForMessage(msg)
        for await (const ev of engine.run(msgWithCtx)) {
          emit(ev)
        }
        saveSessionMeta(sessionId, { model, workDir: initialCwd, messageCount: engine.store.getMessageCount() })
        void autoExtractMemories(engine, sessionId, provider, memoryCondense)
        void autoDistillSkill(engine, provider, skillDistill)
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
      if (parsed.type === 'user_reply') {
        resolveAskUser(parsed.answer ?? '')
        continue
      }
      if (parsed.type === 'decision_reply') {
        resolveDecision(parsed.answer ?? '')
        continue
      }
      if (parsed.type === 'abort') {
        engine.abort()
        continue
      }
      if (parsed.type === 'set_cwd' && parsed.cwd) {
        try {
          // 只更新 AsyncLocalStorage 上下文中的 cwd，不调用 process.chdir（全局副作用）
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

    enqueueMessage(msg)
  }

  await disconnectAllMcp()
}
