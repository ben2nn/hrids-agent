// Server 模式 —— 持续从 stdin 读取 NDJSON 消息，保持会话历史
import { saveSession, generateSessionId, loadSession, listSessions, listArchives, archiveSession } from '../core/SessionStore.js'
import { getSessionWorkDir } from '../core/ContextBuilder.js'
import { setGlobalCwd, getGlobalCwd } from '../core/cwd.js'
import { CommandRegistry, createBuiltinCommands } from '../core/CommandRegistry.js'
import { resolveAskUser } from '../tools/AskUserTool.js'
import { resolveDecision } from '../tools/DecisionTool.js'
import { disconnectAllMcp } from '../tools/McpTool.js'
import { autoExtractMemories, autoDistillSkill } from '../core/postRunHooks.js'
import { registerAllBundledSkills, buildSkillRegistry } from '../skills/index.js'
import { getDynamicContext } from '../core/ContextBuilder.js'
import type { QueryEngine } from '../core/QueryEngine.js'
import type { LLMProvider } from '../core/providers/index.js'

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

  let { sessionId } = opts
  const { initialCwd, model, permMode, memoryCondense, skillDistill, buildPromptForMessage } = opts

  // 注册压缩前归档回调
  engine.onBeforeCompact = async (summary: string) => {
    saveSession(sessionId, engine.getHistory(), model, initialCwd)
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
          getHistoryLength: () => engine.getHistory().length,
          getEstimatedTokens: () => engine.getEstimatedTokens(),
          getCostSummary: () => engine.costs.getSummary(),
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
            const newWorkDir = getSessionWorkDir(newId)
            setGlobalCwd(newWorkDir)
            // 不调用 process.chdir，避免影响全局进程工作目录
          },
          switchSession: (id: string) => {
            const messages = loadSession(id)
            if (!messages) return false
            engine.setHistory(messages)
            return true
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
            for await (const ev of engine.send(result.prompt)) {
              emit(ev)
            }
            saveSession(sessionId, engine.getHistory(), model, initialCwd)
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

      const msgWithCtx = msg + getDynamicContext(getGlobalCwd())
      try {
        await buildPromptForMessage(msg)
        for await (const ev of engine.send(msgWithCtx)) {
          emit(ev)
        }
        saveSession(sessionId, engine.getHistory(), model, initialCwd)
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
