// run 子命令 —— 非交互模式：执行一条消息后退出
import { saveSessionMeta, extractSessionTitle } from '../../core/session-store.js'
import { disconnectAllMcp } from '../../tools/mcp-tool.js'
import { autoExtractMemories, autoDistillSkill } from '../../core/post-run-hooks.js'
import type { QueryEngine } from '../../core/query-engine.js'
import type { LLMProvider } from '../../providers/index.js'
import { initCli, type BaseCliOpts } from './shared.js'

export interface RunCommandOpts extends BaseCliOpts {
  craft?: boolean
  maxChars?: string
  profile?: string
}

export interface PrintModeOpts {
  message: string
  maxChars?: number
  sessionId: string
  initialCwd: string
  model: string
  memoryCondense: boolean
  skillDistill: boolean
}

export async function runPrintMode(
  engine: QueryEngine,
  provider: LLMProvider,
  opts: PrintModeOpts,
): Promise<void> {
  const maxChars = opts.maxChars ?? Infinity
  let totalChars = 0
  let truncated = false

  for await (const ev of engine.run(opts.message)) {
    if (ev.type === 'text_delta') {
      if (truncated) continue
      const remaining = maxChars - totalChars
      if (ev.delta.length > remaining) {
        process.stdout.write(ev.delta.slice(0, remaining))
        process.stdout.write(
          `\n...[输出已截断，共超过 ${maxChars} 字符，使用 --max-chars 调整上限]`,
        )
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
  const { title, lastUserMessage } = extractSessionTitle(engine.store.getMessages())
  saveSessionMeta(opts.sessionId, { model: opts.model, workDir: opts.initialCwd, messageCount: engine.store.getMessageCount(), title, lastUserMessage })
  void autoExtractMemories(engine, opts.sessionId, provider, opts.memoryCondense)
  void autoDistillSkill(engine, provider, opts.skillDistill)
  await disconnectAllMcp()
}

export async function runRunCommand(message: string, opts: RunCommandOpts): Promise<void> {
  const ctx = await initCli({ ...opts, permMode: 'craft', autoApprove: true })

  const parsedMaxChars = opts.maxChars ? parseInt(opts.maxChars, 10) : NaN
  const maxChars = Number.isFinite(parsedMaxChars) && parsedMaxChars > 0 ? parsedMaxChars : Infinity
  let totalChars = 0
  let truncated = false

  await ctx.buildPromptForMessage(message)

  for await (const ev of ctx.engine.run(message)) {
    if (ev.type === 'text_delta') {
      if (truncated) continue
      const remaining = maxChars - totalChars
      if (ev.delta.length > remaining) {
        process.stdout.write(ev.delta.slice(0, remaining))
        process.stdout.write(`\n...[输出已截断，共超过 ${maxChars} 字符]`)
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
  const { title, lastUserMessage } = extractSessionTitle(ctx.engine.store.getMessages())
  saveSessionMeta(ctx.sessionId, {
    model: ctx.model, workDir: ctx.initialCwd,
    messageCount: ctx.engine.store.getMessageCount(), title, lastUserMessage,
  })
  await Promise.allSettled([
    autoExtractMemories(ctx.engine, ctx.sessionId, ctx.provider, ctx.config.agent?.memoryCondense ?? false),
    autoDistillSkill(ctx.engine, ctx.provider, ctx.config.agent?.autoDistillSkill ?? false),
  ])
  await disconnectAllMcp()
}
