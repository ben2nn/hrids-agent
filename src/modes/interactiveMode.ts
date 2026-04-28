// 交互模式 —— Ink React UI
import React from 'react'
import { render } from 'ink'
import { saveSession, generateSessionId, loadSession, listSessions, listArchives, archiveSession } from '../core/SessionStore.js'
import { getSessionWorkDir } from '../core/ContextBuilder.js'
import { setGlobalCwd } from '../core/cwd.js'
import { CommandRegistry, createBuiltinCommands } from '../core/CommandRegistry.js'
import { disconnectAllMcp } from '../tools/McpTool.js'
import { autoExtractMemories, autoDistillSkill } from '../core/postRunHooks.js'
import { registerAllBundledSkills, buildSkillRegistry } from '../skills/index.js'
import { saveConfig } from '../core/Config.js'
import { App } from '../tui/App.js'
import type { QueryEngine } from '../core/QueryEngine.js'
import type { LLMProvider } from '../core/providers/index.js'

export interface InteractiveModeOpts {
  sessionId: string
  initialCwd: string
  model: string
  memoryCondense: boolean
  skillDistill: boolean
  providerName: string
  buildPromptForMessage: (msg: string) => Promise<void>
}

export async function runInteractiveMode(
  engine: QueryEngine,
  provider: LLMProvider,
  opts: InteractiveModeOpts,
): Promise<void> {
  const { sessionId, initialCwd, memoryCondense, skillDistill, buildPromptForMessage } = opts
  let { model } = opts

  // 注册斜杠命令
  const registry = new CommandRegistry()
  createBuiltinCommands('', model).forEach(c => registry.register(c))

  // 初始化 skills 系统
  registerAllBundledSkills()
  const skillRegistry = buildSkillRegistry(initialCwd)
  registry.registerSkills(skillRegistry)

  // 注册压缩前归档回调
  engine.onBeforeCompact = async (summary: string) => {
    saveSession(sessionId, engine.getHistory(), model, initialCwd)
    archiveSession(sessionId, summary)
  }

  // 自动保存会话 + 自动沉淀 skill + 动态注入扩展 prompt
  const originalSend = engine.send.bind(engine)
  engine.send = async function* (msg: string) {
    await buildPromptForMessage(msg)
    yield* originalSend(msg)
    saveSession(sessionId, engine.getHistory(), model, initialCwd)
    void autoExtractMemories(engine, sessionId, provider, memoryCondense)
    void autoDistillSkill(engine, provider, skillDistill)
  }

  const { waitUntilExit } = render(
    React.createElement(App, {
      engine,
      commands: registry,
      sessionId,
      currentModel: model,
      providerName: opts.providerName,
      getProviderName: () => ({ name: provider.name, model: provider.model }),
      onModelChange: (m: string) => {
        model = m
        saveConfig({ model: m })
      },
    }),
  )

  await waitUntilExit()
  await disconnectAllMcp()
}
