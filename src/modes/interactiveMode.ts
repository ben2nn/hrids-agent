// 交互模式 —— Ink React UI
import React from 'react'
import { render } from 'ink'
import { saveSessionMeta, extractSessionTitle, archiveSession } from '../core/SessionStore.js'
import { CommandRegistry, createBuiltinCommands } from '../core/CommandRegistry.js'
import { disconnectAllMcp } from '../tools/McpTool.js'
import { autoExtractMemories, autoDistillSkill } from '../core/postRunHooks.js'
import { registerAllBundledSkills, buildSkillRegistry } from '../skills/index.js'
import { saveConfig } from '../core/Config.js'
import { App } from '../tui/App.js'
import { InkRenderer } from '../tui/InkRenderer.js'
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
  process.stderr.write = ((chunk: any) => {
    const text = typeof chunk === 'string' ? chunk : String(chunk)
    // 过滤 ANSI 转义序列（避免颜色码干扰 Ink 渲染）
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

  // ── 禁用终端回显 ──
  // 必须在 render() 前设置，防止击键被终端直接回显到光标位置（与 InkRenderer 冲突导致光标漂移）
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
    process.stdin.setRawMode(true)
  }

  // ── 进入 alternate screen（参考 claude-code 的 DEC 1049 方案）──
  // 必须在 render() 前发送，确保 Ink 的第一帧渲染到独立缓冲区
  process.stdout.write('\x1b[?1049h\x1b[H')

  // 创建 cell-level diff 渲染器（拦截 Ink 的 stdout，做增量 diff + DEC 2026 同步输出）
  const renderer = new InkRenderer(process.stdout)
  renderer.hideCursor()
  const proxyStdout = renderer.createProxyStream()

  // stderr 回调容器：App 挂载后设置 listener
  let stderrCallback: StderrListener | null = null
  patchStderr((text) => {
    if (stderrCallback) stderrCallback(text)
    else originalStderrWrite(`[stderr] ${text}\n`)
  })

  try {
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
        onStderrReady: (cb: StderrListener) => { stderrCallback = cb },
      }),
      { stdout: proxyStdout },
    )

    await waitUntilExit()
  } finally {
    // ── 清理：恢复光标 + stderr + raw mode + 退出 alternate screen ──
    renderer.showCursor()
    restoreStderr()
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
      process.stdin.setRawMode(false)
    }
    process.stdout.write('\x1b[?1049l')
    await disconnectAllMcp()
  }
}
