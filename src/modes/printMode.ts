// 非交互模式（-p）—— 执行一条消息后退出
import { saveSession } from '../core/SessionStore.js'
import { disconnectAllMcp } from '../tools/McpTool.js'
import { autoExtractMemories, autoDistillSkill } from '../core/postRunHooks.js'
import type { QueryEngine } from '../core/QueryEngine.js'
import type { LLMProvider } from '../core/providers/index.js'

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

  for await (const ev of engine.send(opts.message)) {
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
  saveSession(opts.sessionId, engine.getHistory(), opts.model, opts.initialCwd)
  void autoExtractMemories(engine, opts.sessionId, provider, opts.memoryCondense)
  void autoDistillSkill(engine, provider, opts.skillDistill)
  await disconnectAllMcp()
}
