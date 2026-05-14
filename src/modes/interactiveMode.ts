// 交互模式 —— Ink React UI
import React from 'react'
import { render } from 'ink'
import { saveSessionMeta, extractSessionTitle, archiveSession } from '../core/SessionStore.js'
import { CommandRegistry, createBuiltinCommands } from '../core/CommandRegistry.js'
import { createWorkdirCommands } from '../commands/WorkdirCommands.js'
import { disconnectAllMcp } from '../tools/McpTool.js'
import { autoExtractMemories, autoDistillSkill } from '../core/postRunHooks.js'
import { registerAllBundledSkills, buildSkillRegistry } from '../skills/index.js'
import { saveConfig } from '../core/Config.js'
import { App } from '../cli/ui/App.js'
import { KeystrokeProvider } from '../cli/ui/KeystrokeContext.js'
import { getStdinReader } from '../cli/ui/StdinReader.js'
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

// ── stderr 拦截器 ──────────────────────────────────────────────────────────
// 将 process.stderr.write 重定向到回调，避免破坏 Ink 的终端渲染。
// 参考 claude-code 的 patchStderr() 方案。
type StderrListener = (text: string) => void
let stderrListener: StderrListener | null = null
const originalStderrWrite = process.stderr.write.bind(process.stderr)

function patchStderr(listener: StderrListener) {
  stderrListener = listener
  process.stderr.write = ((chunk: string | Buffer) => {
    const text = typeof chunk === 'string' ? chunk : String(chunk)
    // 过滤 ANSI 转义序列（避免颜色码干扰 Ink 渲染）
    // eslint-disable-next-line no-control-regex
    const clean = text.replace(/\x1b\[[0-9;]*m/g, '').trimEnd()
    if (clean && stderrListener) {
      stderrListener(clean)
    }
    return true
  }) as typeof process.stderr.write
}

function restoreStderr() {
  stderrListener = null
  process.stderr.write = originalStderrWrite
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
  createWorkdirCommands().forEach(c => registry.register(c))

  // 初始化 skills 系统
  registerAllBundledSkills()
  const skillRegistry = buildSkillRegistry(initialCwd)
  registry.registerSkills(skillRegistry)

  // 注册压缩前归档回调
  engine.onBeforeCompact = async (summary: string) => {
    engine.store.saveToDisk()
    archiveSession(sessionId, summary)
  }

  // 每次 send 前：动态注入扩展 prompt
  engine.onBeforeSend = async (msg: string) => {
    await buildPromptForMessage(msg)
  }

  // 每次 send 后：保存会话 + 后台钩子
  engine.onAfterSend = () => {
    const { title, lastUserMessage } = extractSessionTitle(engine.store.getEventLog())
    saveSessionMeta(sessionId, { model, workDir: initialCwd, eventCount: engine.store.getEventCount(), title, lastUserMessage })
    void autoExtractMemories(engine, sessionId, provider, memoryCondense)
    void autoDistillSkill(engine, provider, skillDistill)
  }

  // ── 进入 alternate screen（参考 claude-code 的 DEC 1049 方案）──
  // StdinReader 会在 KeystrokeProvider 挂载时自动设置 raw mode
  process.stdout.write('\x1b[?1049h\x1b[H')

  // stderr 回调容器：App 挂载后设置 listener
  let stderrCallback: StderrListener | null = null
  const earlyStderrBuffer: string[] = []  // App 挂载前的 stderr 输出缓冲
  patchStderr((text) => {
    if (stderrCallback) {
      stderrCallback(text)
    } else {
      // App 还没挂载，先缓冲起来
      earlyStderrBuffer.push(text)
    }
  })

  try {
    const { waitUntilExit } = render(
      React.createElement(KeystrokeProvider, null,
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
          onStderrReady: (cb: StderrListener) => {
            stderrCallback = cb
            // 将 App 挂载前缓冲的 stderr 输出发送给 App
            for (const text of earlyStderrBuffer) {
              cb(text)
            }
            earlyStderrBuffer.length = 0
          },
        }),
      ),
    )

    await waitUntilExit()
  } finally {
    // ── 清理：恢复 stderr + 退出 alternate screen ──
    restoreStderr()
    process.stdout.write('\x1b[?1049l')
    // 销毁 StdinReader（恢复 raw mode + pause stdin）并移除所有残留监听器
    getStdinReader().destroy()
    process.stdin.removeAllListeners('data')
    // unref stdin，防止阻止进程退出
    process.stdin.unref()
    await disconnectAllMcp()
  }
}
