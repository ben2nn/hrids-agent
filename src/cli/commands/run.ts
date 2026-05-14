// run 子命令 —— 非交互模式：执行一条消息后退出
import { saveSessionMeta, extractSessionTitle } from '../../core/SessionStore.js'
import { disconnectAllMcp } from '../../tools/McpTool.js'
import { autoExtractMemories, autoDistillSkill } from '../../core/postRunHooks.js'
import { initCli, type BaseCliOpts } from './shared.js'

export interface RunCommandOpts extends BaseCliOpts {
  craft?: boolean
  maxChars?: string
  profile?: string
}

export async function runRunCommand(message: string, opts: RunCommandOpts): Promise<void> {
  const ctx = await initCli({ ...opts, permMode: 'craft', autoApprove: true })

  const parsedMaxChars = opts.maxChars ? parseInt(opts.maxChars, 10) : NaN
  const maxChars = Number.isFinite(parsedMaxChars) && parsedMaxChars > 0 ? parsedMaxChars : Infinity
  let totalChars = 0
  let truncated = false

  await ctx.buildPromptForMessage(message)

  for await (const ev of ctx.engine.send(message)) {
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
  const { title, lastUserMessage } = extractSessionTitle(ctx.engine.store.getEventLog())
  saveSessionMeta(ctx.sessionId, {
    model: ctx.model, workDir: ctx.initialCwd,
    eventCount: ctx.engine.store.getEventCount(), title, lastUserMessage,
  })
  await Promise.allSettled([
    autoExtractMemories(ctx.engine, ctx.sessionId, ctx.provider, ctx.config.memoryCondense ?? false),
    autoDistillSkill(ctx.engine, ctx.provider, ctx.config.autoDistillSkill ?? false),
  ])
  await disconnectAllMcp()
}
