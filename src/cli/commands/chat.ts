// chat 子命令 —— 交互模式
import { resetEmbeddingProvider } from '../../memory/index.js'
import { restoreScheduledJobs } from '../../tools/ScheduleCronTool.js'
import { runInteractiveMode } from '../../modes/interactiveMode.js'
import { initCli, type BaseCliOpts } from './shared.js'

export interface ChatCommandOpts extends BaseCliOpts {
  craft?: boolean
  plan?: boolean
  resume?: string
  newSession?: boolean
  profile?: string
  embeddingProvider?: string
  embeddingModel?: string
  embeddingBaseUrl?: string
}

export async function runChatCommand(opts: ChatCommandOpts): Promise<void> {
  if (opts.embeddingProvider && opts.embeddingProvider !== 'tfidf') {
    resetEmbeddingProvider({
      provider: opts.embeddingProvider as 'openai' | 'ollama' | 'tfidf',
      model: opts.embeddingModel,
      baseUrl: opts.embeddingBaseUrl,
      apiKey: opts.apiKey,
    })
  }

  const permMode = opts.plan ? 'plan' : opts.craft ? 'craft' : undefined
  const ctx = await initCli({ ...opts, permMode })

  restoreScheduledJobs()

  await runInteractiveMode(ctx.engine, ctx.provider, {
    sessionId: ctx.sessionId,
    initialCwd: ctx.initialCwd,
    model: ctx.model,
    memoryCondense: ctx.config.memoryCondense ?? false,
    skillDistill: ctx.config.autoDistillSkill ?? false,
    providerName: ctx.provider.name,
    buildPromptForMessage: ctx.buildPromptForMessage,
  })
}
