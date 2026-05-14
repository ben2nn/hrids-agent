// server 子命令 —— 持续从 stdin 读取消息（NDJSON）
import { runServerMode } from '../../modes/serverMode.js'
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
