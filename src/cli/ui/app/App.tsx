import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
// SplashScreen 由 CardStream 内部根据 role='splash' 渲染
import { CommandSuggestions } from '../input/CommandSuggestions.js'
import { FileHint } from '../input/FileHint.js'
import { HelpView } from '../../commands/help/HelpView.js'
import { ConfigView } from '../../commands/config/ConfigView.js'
import { PromptInput } from '../input/PromptInput.js'
import { SessionList } from '../sessions/SessionList.js'
// MessageCard 由 CardStream 内部使用
import { Spinner } from './Spinner.js'
import { useKeystroke } from '../terminal/KeystrokeContext.js'
import { TONE, FG, STRIPE_BORDER, getToolDisplayName } from '../terminal/theme.js'
import { CardStream } from '../messages/CardStream.js'
import { useScrollStore, useScrollSnapshot } from '../terminal/ScrollProvider.js'
import { useTerminalSize } from '../terminal/useTerminalSize.js'
import { FullscreenLayout } from './FullscreenLayout.js'
import { StatusNotices } from '../status/StatusNotices.js'
import type { QueryEngine } from '../../../core/QueryEngine.js'
import type { CommandRegistry } from '../../../core/CommandRegistry.js'
import type { CommandContext } from '../../../core/CommandRegistry.js'
import { setCronTriggerCallback } from '../../../tools/ScheduleCronTool.js'
import type { CronJob } from '../../../tools/ScheduleCronTool.js'
import { listSessions, loadSessionMessages, generateSessionId, archiveSession, listArchives } from '../../../core/SessionStore.js'
import { projectForDisplay } from '../../../core/projections.js'
import { getSessionWorkDirPath } from '../../../core/ContextBuilder.js'
import { setGlobalCwd } from '../../../tools/BashTool.js'
import { resolveAskUser, getPendingAskUser } from '../../../tools/AskUserTool.js'
import { loadConfig } from '../../../core/Config.js'
import { modelLog } from '../../../core/logger.js'
import { recordCommandUse } from '../input/command-stats.js'

interface Props {
  engine: QueryEngine
  commands: CommandRegistry
  sessionId: string
  onModelChange: (model: string) => void
  currentModel: string
  providerName: string
  // 可选：动态获取最新 provider 名称（用于 fallback 切换后刷新显示）
  getProviderName?: () => { name: string; model: string }
  // 可选：stderr 拦截回调注册（由 interactiveMode 注入，将 stderr 输出显示为系统消息）
  onStderrReady?: (callback: (text: string) => void) => void
  // 可选：首次提问时延迟初始化会话存储（传入当前 sessionId）
  onFirstMessage?: (sessionId: string) => void
}

type MsgRole = 'user' | 'assistant' | 'tool' | 'system' | 'error' | 'splash'

interface CostInfo {
  inputTokens: number
  outputTokens: number
  costUsd: number
}

interface DisplayMsg {
  id?: string      // 工具消息专用，用于 updateMsg 定位
  role: MsgRole
  text: string
  color?: string   // 可选颜色覆盖（用于黄色 system 消息等）
  splashProps?: { version: string; model: string; providerName: string; projectPath: string }
}

export function App({ engine, commands, sessionId: initialSessionId, onModelChange, currentModel, providerName, getProviderName, onStderrReady, onFirstMessage }: Props) {
  const { exit } = useApp()
  const [input, setInput] = useState('')
  const [sessionId, setSessionId] = useState(initialSessionId)
  const sessionIdRef = useRef(initialSessionId)
  const config = useMemo(() => loadConfig(), [])
  const showSplash = config.ui?.splash !== false
  const [msgs, setMsgs] = useState<DisplayMsg[]>(() => {
    const initial: DisplayMsg[] = []
    if (showSplash) {
      initial.push({ id: 'splash', role: 'splash', text: '', splashProps: { version: '1.0.0', model: currentModel, providerName, projectPath: process.cwd() } })
    }
    initial.push({ role: 'system', text: '输入 /help 查看命令' })
    return initial
  })
  const sessionReadyRef = useRef(false)
  const [loading, setLoading] = useState(false)
  const [streamBuf, setStreamBuf] = useState('')   // 当前流式文本缓冲
  const [toolProgress, setToolProgress] = useState('')  // 工具执行中的临时日志，不写入 msgs
  const [askUserPrompt, setAskUserPrompt] = useState<string | null>(null)  // ask_user 等待时的提示文字
  const [permissionRequest, setPermissionRequest] = useState<{
    key: string
    toolName: string
    description: string
    ruleContent?: string
    resolve: (granted: boolean) => void
    selectedIndex: number
  } | null>(null)
  const [costInfo, setCostInfo] = useState<CostInfo | null>(null)
  const modelRef = useRef(currentModel)
  const [displayProvider, setDisplayProvider] = useState(providerName)
  const [showCommandHint, setShowCommandHint] = useState(false)
  const [commandFilter, setCommandFilter] = useState('')
  const [showFileHint, setShowFileHint] = useState(false)
  const [fileFilter, setFileFilter] = useState('')
  const [stderrOutput, setStderrOutput] = useState('')
  const [statusBarContent, setStatusBarContent] = useState('')
  const [activeModal, setActiveModal] = useState<'help' | 'config' | null>(null)
  const [showSessionList, setShowSessionList] = useState(false)
  const [completedTools, setCompletedTools] = useState<Array<{ name: string; description: string; ok: boolean }>>([])
  const currentToolDescRef = useRef('')  // 当前执行中工具的描述
  const idCounterRef = useRef(0)
  const store = useScrollStore()
  const { cols: termCols, rows: termRows } = useTerminalSize()

  const push = useCallback((msg: DisplayMsg) => {
    const id = msg.id ?? `msg-${++idCounterRef.current}`
    modelLog.write('[App] push 调用', { role: msg.role, textLen: msg.text?.length ?? 0, id })
    setMsgs(prev => {
      const newMsgs = [...prev, { ...msg, id }]
      msgsLengthRef.current = newMsgs.length
      modelLog.write('[App] setMsgs 更新', { total: newMsgs.length, lastRole: msg.role })
      return newMsgs
    })
    if (store.getState().pinned) {
      store.scrollToBottom()
    }
  }, [store])

  const cronQueueRef = useRef<CronJob[]>([])
  const loadingRef = useRef(false)
  const msgsLengthRef = useRef(0)

  // 公共 engine 执行逻辑，供用户消息和 cron 触发共用
  const runEngine = useCallback(async (prompt: string, displayAs?: string) => {
    if (displayAs !== undefined) push({ role: 'system', text: displayAs, color: displayAs.startsWith('⏰') ? 'yellow' : undefined })
    setLoading(true)
    loadingRef.current = true
    setStreamBuf('')
    setCompletedTools([])
    let assistantText = ''
    let thinkingText = ''
    let eventCount = 0
    try {
      for await (const ev of engine.sendStreaming(prompt)) {
        eventCount++
        modelLog.write(`[App] 事件 #${eventCount}`, { type: ev.type, delta: 'delta' in ev ? String(ev.delta).slice(0, 50) : undefined })
        switch (ev.type) {
          case 'text_delta': assistantText += ev.delta; setStreamBuf(assistantText); break
          case 'thinking_delta': thinkingText += ev.delta; if (!assistantText) setStreamBuf(`💭 ${thinkingText.slice(-200)}`); break
          case 'tool_start':
            currentToolDescRef.current = ev.description
            setToolProgress(`${getToolDisplayName(ev.name)}: ${ev.description}`)
            // ask_user 工具：切换输入框为回答模式
            if (ev.name === 'ask_user') {
              const askInput = ev.input as { question?: string; options?: string[] }
              const question = askInput?.question ?? ''
              const options = askInput?.options ?? []
              const hint = options.length > 0
                ? `❓ ${question}\n选项: ${options.map((o, i) => `${i + 1}. ${o}`).join('  ')}`
                : `❓ ${question}`
              setAskUserPrompt(hint)
              setLoading(false)
              loadingRef.current = false
            }
            break
          case 'tool_log': break  // 隐藏工具日志
          case 'tool_end': {
            setCompletedTools(prev => [...prev, { name: ev.name, description: currentToolDescRef.current, ok: ev.result.type !== 'error' }])
            setToolProgress('')
            setAskUserPrompt(null)
            if (ev.name === 'ask_user') {
              setLoading(true)
              loadingRef.current = true
            }
            const result = ev.result
            // 只显示工具错误，隐藏成功详情
            if (result.type === 'error') {
              push({ role: 'error', text: `✗ ${getToolDisplayName(ev.name)} (${currentToolDescRef.current}): ${result.message}` })
            }
            break
          }
          case 'permission_denied': push({ role: 'system', text: `⚠ 已拒绝: ${ev.description}`, color: 'yellow' }); break
          case 'permission_request':
            // 权限请求通过 onPermissionRequest 回调处理，这里不需要额外处理
            break
          case 'usage': setCostInfo(prev => ({
  inputTokens: (prev?.inputTokens ?? 0) + ev.inputTokens,
  outputTokens: (prev?.outputTokens ?? 0) + ev.outputTokens,
  costUsd: ev.costUsd,
})); break
          case 'compact_start': push({ role: 'system', text: '⟳ 上下文过长，正在自动压缩历史...' }); break
          case 'compact_done': {
            const archives = listArchives(sessionIdRef.current)
            const archiveCount = archives.length
            const lastArchive = archives[archiveCount - 1]
            const msgCount = lastArchive?.messageCount ?? 0
            push({ role: 'system', text: `✓ 历史已压缩（归档了 ${msgCount} 条消息，当前约 ${engine.getEstimatedTokens().toLocaleString()} tokens）\n  输入 /history 查看归档历史` })
            break
          }
          case 'budget_exceeded': push({ role: 'error', text: `⚠ 已超出成本预算 ${ev.limitUsd.toFixed(2)}（当前 ${ev.costUsd.toFixed(4)}），任务已停止` }); break
          case 'continuation_needed':
            // 非自动模式：LLM 表达了继续意图，提示用户确认
            push({ role: 'system', text: '▸ 助手计划继续执行更多操作，发送"继续"确认，或输入新指令调整方向。', color: 'yellow' })
            break
          case 'error': push({ role: 'error', text: ev.message }); break
          case 'done': {
            const finalText = assistantText || thinkingText
            modelLog.write('[App] done 事件', { eventCount, textLen: assistantText.length, thinkLen: thinkingText.length, finalLen: finalText.length })
            if (finalText) {
              setStreamBuf('')
              push({ role: 'assistant', text: finalText })
              modelLog.write('[App] push assistant', { textLen: finalText.length, preview: finalText.slice(0, 50) })
              assistantText = ''; thinkingText = ''
            }
            }
            // 刷新 provider/model 显示（fallback 切换后同步更新）
            if (getProviderName) {
              const latest = getProviderName()
              setDisplayProvider(latest.name)
              modelRef.current = latest.model
            }
            break
        }
      }
    } catch (err) {
      push({ role: 'error', text: String(err) })
    }
    modelLog.write('[App] for-await 结束', { eventCount, textLen: assistantText.length, thinkLen: thinkingText.length })
    // 兜底：确保 assistant 消息一定被 push（sendStreaming 多轮时 done 事件可能不被消费）
    const fallbackText = assistantText || thinkingText
    if (fallbackText) {
      push({ role: 'assistant', text: fallbackText })
      assistantText = ''
      thinkingText = ''
    }
    setStreamBuf('')
    setToolProgress('')
    setLoading(false)
    loadingRef.current = false

    // 执行完后检查 cron 队列
    const next = cronQueueRef.current.shift()
    if (next) {
      void runEngine(
        `[定时任务触发] ${next.description}\n\n${next.task}`,
        `⏰ 定时任务触发: ${next.description}`
      )
    }
  }, [engine, push])

  // 注册 cron 触发回调，触发时走 React 状态管理
  useEffect(() => {
    setCronTriggerCallback((job) => {
      if (loadingRef.current) {
        // 当前有任务在跑，排队等待
        cronQueueRef.current.push(job)
        return
      }
      void runEngine(
        `[定时任务触发] ${job.description}\n\n${job.task}`,
        `⏰ 定时任务触发: ${job.description}`
      )
    })
  }, [runEngine])

  // 注册压缩前归档回调：保留完整历史，workDir 不变
  useEffect(() => {
    engine.onBeforeCompact = async (summary: string) => {
      engine.store.saveToDisk()
      archiveSession(sessionId, summary)
    }
    return () => { engine.onBeforeCompact = null }
  }, [engine, sessionId])

  // 注册权限请求回调：显示权限请求 UI
  useEffect(() => {
    engine.onPermissionRequest = async (req) => {
      const key = `${req.toolName}::${req.description}`
      return new Promise<boolean>((resolve) => {
        setPermissionRequest({
          key,
          toolName: req.toolName,
          description: req.description,
          ruleContent: req.ruleContent,
          resolve,
          selectedIndex: 0,
        })
      })
    }
    return () => { engine.onPermissionRequest = null }
  }, [engine])

  // 注册 stderr 拦截回调：将 process.stderr 输出存储到状态，在底部显示
  useEffect(() => {
    if (!onStderrReady) return
    onStderrReady((text: string) => {
      // 过滤空行和纯空白
      const clean = text.trim()
      if (!clean) return
      // 截断过长的 stderr 输出
      const display = clean.length > 500 ? clean.slice(0, 500) + '…' : clean
      setStderrOutput(display)
    })
  }, [onStderrReady])

  // 构建命令上下文（memoize 避免 handleSubmit 每次重建）
  const cmdCtx: CommandContext = useMemo(() => ({
    clearHistory: () => engine.clearHistory(),
    compactHistory: async (summary: string) => {
      engine.compactHistory(summary)
    },
    generateCompactSummary: async () => {
      return engine.generateCompactSummary()
    },
    getHistoryLength: () => engine.store.getMessageCount(),
    getEstimatedTokens: () => engine.getEstimatedTokens(),
    getCostSummary: () => {
      const usage = engine.costs.getUsage()
      return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: engine.costs.getCostUsd() }
    },
    getBudgetInfo: () => ({
      spent: engine.costs.getCostUsd(),
      limit: undefined,
    }),
    setModel: (m: string) => { modelRef.current = m; onModelChange(m) },
    getModel: () => modelRef.current,
    setMode: (_m: string) => { /* 模式切换通过 PermissionManager 处理 */ },
    getMode: () => 'ask',
    sessionId,
    listSessions: () => listSessions(),
    listArchives: () => listArchives(sessionIdRef.current),
    newSession: () => {
      const newId = generateSessionId()
      engine.clearHistory()
      setSessionId(newId)
      sessionIdRef.current = newId
      onFirstMessage?.(newId)
      sessionReadyRef.current = true
      const newWorkDir = getSessionWorkDirPath(newId)
      setGlobalCwd(newWorkDir)
      try { process.chdir(newWorkDir) } catch { /* 忽略 */ }
      const newMsgs: DisplayMsg[] = []
      if (showSplash) {
        newMsgs.push({ id: 'splash', role: 'splash', text: '', splashProps: { version: '1.0.0', model: modelRef.current, providerName: displayProvider, projectPath: newWorkDir } })
      }
      newMsgs.push({ role: 'system', text: `已创建新会话 (${newId})\n工作目录: ${newWorkDir}` })
      setMsgs(newMsgs)
      store.scrollToBottom()
    },
    switchSession: (id: string) => {
      const messages = loadSessionMessages(id)
      if (!messages) return false
      engine.store.replaceMessages(messages)
      setSessionId(id)
      sessionIdRef.current = id
      onFirstMessage?.(id)
      sessionReadyRef.current = true

      // 清空当前消息，载入历史会话内容
      const displayMsgs = projectForDisplay(messages)
      const converted: DisplayMsg[] = displayMsgs.map((dm, i) => ({
        id: `hist-${i}`,
        role: dm.role,
        text: dm.content,
      }))
      const switchMsgs: DisplayMsg[] = []
      if (showSplash) {
        switchMsgs.push({ id: 'splash', role: 'splash', text: '', splashProps: { version: '1.0.0', model: modelRef.current, providerName: displayProvider, projectPath: process.cwd() } })
      }
      switchMsgs.push({ role: 'system', text: `已载入会话 ${id.slice(0, 12)}（${messages.length} 条消息）载入成功` })
      switchMsgs.push(...converted)
      setMsgs(switchMsgs)

      // 重置滚动状态：锁定到底部，恢复输入框
      store.scrollToBottom()
      return true
    },
    getAvailableModels: () => {
      const config = loadConfig()
      const models: Array<{ provider: string; model: string; isDefault?: boolean }> = []
      const defaultModel = config.agent?.model

      if (config.llm?.fallbacks) {
        for (const group of config.llm.fallbacks) {
          for (const model of group.models) {
            models.push({
              provider: group.provider,
              model,
              isDefault: model === defaultModel,
            })
          }
        }
      }

      if (models.length === 0 && defaultModel) {
        models.push({
          provider: config.provider || 'unknown',
          model: defaultModel,
          isDefault: true,
        })
      }

      return models
    },
  }), [engine, sessionId, onModelChange, push, exit])

  // 处理输入变化，控制命令提示和文件提示显示
  const handleInputChange = useCallback((value: string) => {
    setInput(value)
    // 当输入以 / 开头时显示命令提示
    if (value.startsWith('/')) {
      setShowCommandHint(true)
      setCommandFilter(value.slice(1))
      setShowFileHint(false)
      setFileFilter('')
    }
    // 当输入以 @ 开头时显示文件提示
    else if (value.startsWith('@')) {
      setShowFileHint(true)
      setFileFilter(value.slice(1))
      setShowCommandHint(false)
      setCommandFilter('')
    }
    else {
      setShowCommandHint(false)
      setCommandFilter('')
      setShowFileHint(false)
      setFileFilter('')
    }
  }, [])

  // 处理文件选择
  const handleFileSelect = useCallback((filePath: string) => {
    setInput(`@${filePath} `)
    setShowFileHint(false)
    setFileFilter('')
  }, [])

  const handleSubmit = useCallback(async (value: string) => {
    const text = value.trim()
    if (!text || loadingRef.current) return
    setInput('')
    store.scrollToBottom()  // 发送消息时恢复自动滚动
    // 保留 SplashScreen，不在提交时隐藏
    setShowCommandHint(false)
    setCommandFilter('')
    setShowFileHint(false)
    setFileFilter('')

    // 优先检查是否有待处理的 ask_user（工具在等待用户回答）
    const pending = getPendingAskUser()
    if (pending) {
      push({ role: 'user', text })
      resolveAskUser(text)
      return
    }

    // 处理不带 / 前缀的 sessions 命令
    if (text.trim().toLowerCase() === 'sessions') {
      setShowSessionList(true)
      return
    }

    // 处理斜杠命令
    const parsed = commands.parse(text)
    if (parsed) {
      if (parsed.name === 'help') {
        setActiveModal('help')
        return
      }
      if (parsed.name === 'config') {
        setActiveModal('config')
        return
      }
      if (parsed.name === 'sessions') {
        setShowSessionList(true)
        return
      }

      const cmd = commands.find(parsed.name)
      if (!cmd) {
        push({ role: 'error', text: `未知命令: /${parsed.name}，输入 /help 查看可用命令` })
        return
      }

      recordCommandUse(parsed.name)
      const result = await cmd.execute(parsed.args, cmdCtx)
      if (result.type === 'exit') { exit(); return }
      if (result.type === 'message') { push({ role: 'system', text: result.text }); return }
      if (result.type === 'status') { setStatusBarContent(result.text); return }
      if (result.type === 'noop') return

      // inject：将 skill prompt 作为用户消息发给 LLM
      if (result.type === 'inject') {
        push({ role: 'user', text: `/${parsed.name}${parsed.args ? ' ' + parsed.args : ''}` })
        await runEngine(result.prompt)
        return
      }
      return
    }

    // 首次提问时延迟初始化会话存储
    if (!sessionReadyRef.current) {
      sessionReadyRef.current = true
      onFirstMessage?.(sessionIdRef.current)
      push({ role: 'system', text: `会话已启动 (${sessionIdRef.current})` })
    }

    // 普通消息 → 发给 LLM
    push({ role: 'user', text })
    await runEngine(text)
  }, [commands, engine, push, exit, cmdCtx, onFirstMessage])

  // Ctrl+C 通过 useKeystroke 处理（走 StdinReader 链路）
  useKeystroke((key) => {
    if (key.ctrl && key.name === 'c') {
      if (loadingRef.current) {
        engine.abort()
        setLoading(false)
        loadingRef.current = false
        setStreamBuf('')
        setToolProgress('')
        push({ role: 'system', text: '⚠ 任务已中断（Ctrl+C）' })
      } else {
        exit()
      }
    }
  })

  // 滚动通过 Ink 的 useInput 处理（与 Ink 渲染管线原生集成）
  useInput((input, key) => {
    // 权限请求模式：导航和选择处理
    if (permissionRequest) {
      if (key.upArrow) {
        setPermissionRequest(prev => prev ? { ...prev, selectedIndex: Math.max(0, prev.selectedIndex - 1) } : null)
      } else if (key.downArrow) {
        setPermissionRequest(prev => prev ? { ...prev, selectedIndex: Math.min(2, prev.selectedIndex + 1) } : null)
      } else if (input === 'a' || input === 'A') {
        permissionRequest.resolve(true)
        setPermissionRequest(null)
        return
      } else if (input === 'd' || input === 'D') {
        permissionRequest.resolve(false)
        setPermissionRequest(null)
        return
      } else if (input === 'l' || input === 'L') {
        engine.approveSessionPermission(permissionRequest.toolName, permissionRequest.ruleContent)
        permissionRequest.resolve(true)
        setPermissionRequest(null)
        return
      } else if (key.return) {
        const { selectedIndex, toolName, ruleContent, resolve } = permissionRequest
        if (selectedIndex === 0) {
          // Allow
          resolve(true)
        } else if (selectedIndex === 1) {
          // Deny
          resolve(false)
        } else {
          // Always Allow
          engine.approveSessionPermission(toolName, ruleContent)
          resolve(true)
        }
        setPermissionRequest(null)
      } else if (key.escape) {
        permissionRequest.resolve(false)
        setPermissionRequest(null)
      }
      return
    }

    if (key.pageUp) {
      store.setPinned(false)
      store.scroll(10)
    }
    if (key.pageDown) {
      store.scroll(-10)
    }
    if (key.upArrow && !loadingRef.current) {
      store.setPinned(false)
      store.scroll(3)
    }
    if (key.downArrow && !loadingRef.current) {
      store.scroll(-3)
    }
    // End 键回到底部（Ink 的 useInput 不直接提供 end，用 Ctrl+End 代替）
    if (input === '\x1b[F' || (key.ctrl && input === '>')) {
      store.scrollToBottom()
    }
  })

  // ─── 可滚动区域：消息历史 ────────────────────────────────────────────────
  const scrollableContent = (
    <Box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} paddingX={1}>
      <CardStream
        key={sessionId}
        msgs={msgs}
        cols={termCols}
      />
    </Box>
  )

  // ─── 底部固定区域：工具进度 + 命令提示 + 输入框 ──────────────────────────
  const bottomContent = (
    <Box flexDirection="column" paddingX={1}>
      {/* 工具进度 + 流式输出（统一容器） */}
      {loading && (completedTools.length > 0 || toolProgress || streamBuf) && (
        <Box
          borderStyle={STRIPE_BORDER}
          borderColor={TONE.brand}
          borderTop={false} borderRight={false} borderBottom={false}
          paddingLeft={1} marginTop={1} width="100%"
          flexDirection="column"
        >
          {/* 已完成工具：超过 3 个折叠为摘要 */}
          {completedTools.length > 0 && (
            completedTools.length > 3
              ? <Box>
                  <Text color={TONE.ok}>✓ </Text>
                  <Text color={FG.sub}>{completedTools.length} 个工具已完成</Text>
                </Box>
              : completedTools.map((t, i) => (
                  <Box key={i}>
                    <Text color={t.ok ? TONE.ok : TONE.err}>{t.ok ? '✓' : '✗'} </Text>
                    <Text color={FG.sub}>{getToolDisplayName(t.name)}</Text>
                    <Text color={FG.faint} dimColor>{' '}{t.description}</Text>
                  </Box>
                ))
          )}

          {/* 工具执行中 */}
          {toolProgress && (
            <Box>
              <Text color={TONE.brand} bold>{'▣ '}</Text>
              <Spinner color={TONE.brand} />
              <Text color={FG.sub}> 执行中...</Text>
              <Text color={FG.faint} dimColor>{' '}{toolProgress}</Text>
            </Box>
          )}

          {/* 流式写作 */}
          {streamBuf && (
            <Box flexDirection="column">
              <Box>
                <Text color={TONE.brand} bold>{'◈ '}</Text>
                <Spinner variant="circle" color={TONE.brand} />
                <Text color={FG.sub}> 写作中...</Text>
              </Box>
              <Box paddingLeft={2} flexDirection="column">
                {streamBuf.split('\n').slice(-Math.max(3, Math.floor(termRows * 0.25))).map((line, i) => (
                  <Text key={i} color={FG.body}>{line}</Text>
                ))}
              </Box>
            </Box>
          )}
        </Box>
      )}

      {/* 命令提示 */}
      <CommandSuggestions
        commands={commands.toCommands(cmdCtx)}
        filter={commandFilter}
        visible={showCommandHint}
      />

      {/* 文件提示 */}
      <FileHint
        filter={fileFilter}
        visible={showFileHint}
        onSelect={handleFileSelect}
      />

      {/* 输入区域 */}
      <Box marginBottom={0}>
        {!useScrollSnapshot(s => s.pinned)
          ? <Text color={FG.faint}>  ▸ 查看历史中 -- PgDn 返回底部 · ↑↓ 滚动</Text>
          : askUserPrompt
          ? (
            <Box flexDirection="column">
              <Text color="yellow">{askUserPrompt}</Text>
              <Box>
                <PromptInput
                  value={input}
                  onChange={setInput}
                  onSubmit={handleSubmit}
                  placeholder="输入回答..."
                />
              </Box>
            </Box>
          )
          : loading
          ? <Box><Spinner variant="circle" color={TONE.warn} /><Text color={TONE.warn}> 思考中...</Text></Box>
          : (
            <Box>
              <PromptInput
                value={input}
                onChange={handleInputChange}
                onSubmit={handleSubmit}
                disabled={loading}
                placeholder="输入消息或 /命令..."
              />
            </Box>
          )
        }
      </Box>
    </Box>
  )

  // ─── 状态栏 ──────────────────────────────────────────────────────────────
  const statusBar = (
    <StatusNotices
      sessionId={sessionIdRef.current}
      messageCount={msgs.length}
      providerName={displayProvider}
      model={modelRef.current}
      costInfo={costInfo}
      loading={loading}
      stderrOutput={stderrOutput}
      statusBarContent={statusBarContent}
      cols={termCols}
    />
  )

  // ─── 权限对话框（覆盖在状态栏下方）────────────────────────────────────────
  const permissionOverlay = permissionRequest ? (
    <Box flexDirection="column" borderStyle="double" borderColor={TONE.warn} paddingX={1} marginX={1}>
      <Text color={TONE.warn} bold>⚠ 权限请求</Text>
      <Box paddingLeft={1} marginTop={1}>
        <Text>
          <Text color={FG.faint}>工具: </Text>
          <Text color={TONE.brand} bold>{getToolDisplayName(permissionRequest.toolName)}</Text>
        </Text>
      </Box>
      <Box paddingLeft={1}>
        <Text>
          <Text color={FG.faint}>操作: </Text>
          <Text color={FG.body}>{permissionRequest.description}</Text>
        </Text>
      </Box>
      {permissionRequest.ruleContent && (
        <Box paddingLeft={1}>
          <Text>
            <Text color={FG.faint}>内容: </Text>
            <Text color={FG.sub}>{permissionRequest.ruleContent.slice(0, 100)}</Text>
          </Text>
        </Box>
      )}
      <Box marginTop={1} flexDirection="column" paddingLeft={1}>
        <Text color={permissionRequest.selectedIndex === 0 ? TONE.ok : FG.body}>
          {permissionRequest.selectedIndex === 0 ? '▸ ' : '  '}<Text bold>Allow</Text>
          <Text color={FG.faint}> — 本次允许</Text>
        </Text>
        <Text color={permissionRequest.selectedIndex === 1 ? TONE.err : FG.body}>
          {permissionRequest.selectedIndex === 1 ? '▸ ' : '  '}<Text bold>Deny</Text>
          <Text color={FG.faint}> — 本次拒绝</Text>
        </Text>
        <Text color={permissionRequest.selectedIndex === 2 ? TONE.warn : FG.body}>
          {permissionRequest.selectedIndex === 2 ? '▸ ' : '  '}<Text bold>Always Allow</Text>
          <Text color={FG.faint}> — 始终允许此操作</Text>
        </Text>
      </Box>
      <Box marginTop={1} paddingLeft={1}>
        <Text color={FG.faint} dimColor>↑↓/A/D/L 快捷 · Enter 选择 · Esc 取消</Text>
      </Box>
    </Box>
  ) : undefined

  // ─── 会话列表 ─────────────────────────────────────────────────────────────
  const handleSessionSelect = useCallback((selectedSessionId: string) => {
    setShowSessionList(false)
    // 切换到选中的会话
    if (selectedSessionId !== sessionIdRef.current) {
      const success = cmdCtx.switchSession(selectedSessionId)
      if (!success) {
        push({ role: 'error', text: `切换会话失败: ${selectedSessionId}` })
      }
    }
  }, [cmdCtx, push])

  const sessionListOverlay = showSessionList ? (
    <SessionList
      sessions={listSessions()}
      pageSize={5}
      onSelect={handleSessionSelect}
      onCancel={() => setShowSessionList(false)}
    />
  ) : undefined

  // ─── 模态内容 ──────────────────────────────────────────────────────────────
  const modalContent = activeModal === 'help'
    ? <HelpView commands={commands.toCommands(cmdCtx)} onClose={() => setActiveModal(null)} />
    : activeModal === 'config'
    ? <ConfigView ctx={cmdCtx as any} onClose={() => setActiveModal(null)} />
    : undefined

  // ─── 合并 overlay ─────────────────────────────────────────────────────────
  const overlay = permissionOverlay || sessionListOverlay

  return (
    <Box paddingX={0} paddingY={0}>
      <FullscreenLayout
        scrollable={scrollableContent}
        bottom={bottomContent}
        statusBar={statusBar}
        overlay={overlay}
        modal={modalContent}
      />
    </Box>
  )
}
