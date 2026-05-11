import React, { useState, useCallback, useRef, useEffect } from 'react'
import { Box, Text, useInput, useApp } from 'ink'
import TextInput from 'ink-text-input'
import type { QueryEngine } from '../core/QueryEngine.js'
import type { CommandRegistry } from '../core/CommandRegistry.js'
import type { CommandContext } from '../core/CommandRegistry.js'
import { setCronTriggerCallback } from '../tools/ScheduleCronTool.js'
import type { CronJob } from '../tools/ScheduleCronTool.js'
import { listSessions, loadSessionEvents, generateSessionId, archiveSession, listArchives } from '../core/SessionStore.js'
import { getSessionWorkDirPath } from '../core/ContextBuilder.js'
import { setGlobalCwd } from '../tools/BashTool.js'
import { resolveAskUser, getPendingAskUser } from '../tools/AskUserTool.js'

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
}

type MsgRole = 'user' | 'assistant' | 'tool' | 'system' | 'error'

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
}

const ROLE_COLOR: Record<MsgRole, string> = {
  user:      'green',
  assistant: 'white',
  tool:      'cyan',
  system:    'gray',
  error:     'red',
}

const ROLE_PREFIX: Record<MsgRole, string> = {
  user:      '你 › ',
  assistant: '✦ ',
  tool:      '',
  system:    '• ',
  error:     '✗ ',
}

// ── 工具输出差异化格式化 ──────────────────────────────────────────────────────

/** web_search 输出格式化：识别 DuckDuckGo 卡片式结构 或 Anthropic 自然语言文本 */
function formatWebSearch(out: string): string {
  // DuckDuckGo 输出特征：包含 `---` 分隔符 + `**标题**` 格式
  if (out.includes('---') && out.includes('**')) {
    const blocks = out
      .split(/\n---+\n/)
      .map(b => b.trim())
      .filter(Boolean)

    // 找到实际结果块（跳过 "搜索结果（来源：...）：" 前缀行）
    const resultBlocks = blocks.filter(b => b.includes('**'))

    if (resultBlocks.length === 0) return out.slice(0, 500)

    const lines: string[] = []
    resultBlocks.forEach((block, idx) => {
      // 解析：第一行是 **标题**，第二行是摘要，第三行是 URL
      const parts = block.split('\n').map(l => l.trim()).filter(Boolean)
      const title = parts[0]?.replace(/^\*\*|\*\*$/g, '') ?? ''
      const snippet = parts[1] ?? ''
      const url = parts[2] ?? ''

      lines.push(`  ${idx + 1}. ${title}`)
      if (snippet) lines.push(`     ${snippet.length > 80 ? snippet.slice(0, 80) + '…' : snippet}`)
      if (url) lines.push(`     ${url}`)
    })

    lines.push(`  ─ 共 ${resultBlocks.length} 条结果`)
    return lines.join('\n')
  }

  // Anthropic 自然语言输出：直接截断展示
  return out.length > 600 ? out.slice(0, 600) + `\n  …（共 ${out.length} 字符）` : out
}

/** web_fetch 输出格式化：显示字数 + 正文预览 */
function formatWebFetch(out: string, url: string): string {
  const totalChars = out.length
  const isTruncated = out.includes('[内容已截断，共')

  // 提取实际正文（去掉末尾截断提示行）
  const bodyEnd = out.lastIndexOf('\n\n[内容已截断')
  const body = bodyEnd > 0 ? out.slice(0, bodyEnd) : out

  const preview = body.slice(0, 300)
  const previewLines = preview.split('\n').slice(0, 8).join('\n')

  const lines: string[] = []
  lines.push(`  来源: ${url}`)
  lines.push(`  字数: ${totalChars.toLocaleString()} 字符${isTruncated ? '（已截断）' : ''}`)
  lines.push(`  ${'─'.repeat(40)}`)
  lines.push(previewLines.split('\n').map(l => `  ${l}`).join('\n'))
  if (body.length > 300) lines.push(`  …（正文共 ${body.length.toLocaleString()} 字符）`)

  return lines.join('\n')
}

/** 按工具名称差异化格式化输出，其他工具保持原有截断逻辑 */
function formatToolOutput(toolName: string, out: string, toolInput?: Record<string, unknown>): string {
  if (!out) return ''
  if (toolName === 'web_search') return formatWebSearch(out)
  if (toolName === 'web_fetch') {
    const url = (toolInput?.url as string) ?? ''
    return formatWebFetch(out, url)
  }
  // 默认：超 500 字符截断
  return out.length > 500 ? out.slice(0, 500) + `\n…（共 ${out.length} 字符）` : out
}

export function App({ engine, commands, sessionId: initialSessionId, onModelChange, currentModel, providerName, getProviderName, onStderrReady }: Props) {
  const { exit } = useApp()
  const [input, setInput] = useState('')
  const [sessionId, setSessionId] = useState(initialSessionId)
  const [msgs, setMsgs] = useState<DisplayMsg[]>([
    { role: 'system', text: `会话已启动 (${initialSessionId})  输入 /help 查看命令` },
  ])
  const [loading, setLoading] = useState(false)
  const [streamBuf, setStreamBuf] = useState('')   // 当前流式文本缓冲
  const [toolProgress, setToolProgress] = useState('')  // 工具执行中的临时日志，不写入 msgs
  const [askUserPrompt, setAskUserPrompt] = useState<string | null>(null)  // ask_user 等待时的提示文字
  const [costInfo, setCostInfo] = useState<CostInfo | null>(null)
  const modelRef = useRef(currentModel)
  const [displayProvider, setDisplayProvider] = useState(providerName)

  const push = useCallback((msg: DisplayMsg) => {
    setMsgs(prev => [...prev, msg])
  }, [])

  // 原地更新指定 id 的消息；若找不到对应 id，则降级追加 fallback 消息
  const updateMsg = useCallback((id: string, updater: (prev: DisplayMsg) => DisplayMsg, fallback?: DisplayMsg) => {
    setMsgs(prev => {
      const idx = prev.findIndex(m => m.id === id)
      if (idx !== -1) {
        // 找到：原地更新
        return prev.map((m, i) => i === idx ? updater(m) : m)
      }
      // 未找到：降级追加 fallback 消息（若提供）
      if (fallback) return [...prev, fallback]
      return prev
    })
  }, [])

  // cron 触发队列：避免在 loading 时直接调用，排队等待
  const cronQueueRef = useRef<CronJob[]>([])
  const loadingRef = useRef(false)
  // tool_log 批量缓冲：避免每行都触发重渲染导致 Ink 卡死
  const toolLogBufRef = useRef<string[]>([])
  const toolLogFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 每个工具执行期间的日志，用于 tool_end 时持久化到历史
  const currentToolLogsRef = useRef<string[]>([])
  // 缓存当前工具的 input，供 tool_end 格式化时使用
  const currentToolInputRef = useRef<Record<string, unknown>>({})
  // 每个工具最多保留的日志行数（避免爬虫等大量输出撑爆界面）
  const MAX_TOOL_LOG_LINES = 30

  const flushToolLog = useCallback(() => {
    if (toolLogBufRef.current.length === 0) return
    const lines = toolLogBufRef.current.splice(0)
    // 只更新临时进度状态，不写入 msgs 历史
    setToolProgress(lines.join('\n'))
    toolLogFlushRef.current = null
  }, [])

  const bufferToolLog = useCallback((line: string) => {
    // 过滤 stderr 行，不在 CLI UI 中显示
    if (line.trimStart().startsWith('[stderr]')) return
    // 同时记录到当前工具日志缓冲，供 tool_end 持久化
    currentToolLogsRef.current.push(line)
    toolLogBufRef.current.push(line)
    // 50ms 内的日志合并成一条，超过 20 行立即 flush
    if (toolLogBufRef.current.length >= 20) {
      if (toolLogFlushRef.current) clearTimeout(toolLogFlushRef.current)
      flushToolLog()
    } else if (!toolLogFlushRef.current) {
      toolLogFlushRef.current = setTimeout(flushToolLog, 50)
    }
  }, [flushToolLog])

  // 公共 engine 执行逻辑，供用户消息和 cron 触发共用
  const runEngine = useCallback(async (prompt: string, displayAs?: string) => {
    if (displayAs !== undefined) push({ role: 'system', text: displayAs, color: displayAs.startsWith('⏰') ? 'yellow' : undefined })
    setLoading(true)
    loadingRef.current = true
    setStreamBuf('')
    let assistantText = ''
    try {
      for await (const ev of engine.send(prompt)) {
        switch (ev.type) {
          case 'text_delta': assistantText += ev.delta; setStreamBuf(assistantText); break
          case 'tool_start':
            currentToolLogsRef.current = [] // 重置当前工具日志缓冲
            currentToolInputRef.current = (ev.input as Record<string, unknown>) ?? {}
            push({ id: ev.id, role: 'tool', text: `⚙ ${ev.name}  ${ev.description}` })
            // ask_user 工具：切换输入框为回答模式
            if (ev.name === 'ask_user') {
              // tool_start 在 execute() 之前触发，pendingQuestion 尚未设置
              // 直接从 tool_start 的 input 读取问题内容
              const askInput = ev.input as { question?: string; options?: string[] }
              const question = askInput?.question ?? ''
              const options = askInput?.options ?? []
              const hint = options.length > 0
                ? `❓ ${question}\n选项: ${options.map((o, i) => `${i + 1}. ${o}`).join('  ')}`
                : `❓ ${question}`
              setAskUserPrompt(hint)
              setLoading(false)           // 解锁输入框，让用户可以输入
              loadingRef.current = false  // 同步更新 ref，防止 Ctrl+C 误触发 abort
            }
            break
          case 'tool_log': bufferToolLog(`  ${ev.line}`); break
          case 'tool_end': {
            flushToolLog() // 确保残留日志先 flush
            setToolProgress('') // 清空临时进度
            setAskUserPrompt(null) // 清除 ask_user 提示（如果有）
            if (ev.name === 'ask_user') {
              setLoading(true)           // 恢复 loading 状态，继续执行后续工具
              loadingRef.current = true  // 同步更新 ref
            }
            const logs = currentToolLogsRef.current
            currentToolLogsRef.current = []
            // 日志截断：超过 MAX_TOOL_LOG_LINES 行时保留最后 N 行并插入省略提示
            const kept = logs.length > MAX_TOOL_LOG_LINES
              ? [`  …（省略前 ${logs.length - MAX_TOOL_LOG_LINES} 行）`, ...logs.slice(-MAX_TOOL_LOG_LINES)]
              : logs
            const logSuffix = kept.length > 0 ? '\n' + kept.join('\n') : ''
            const result = ev.result
            if (result.type === 'error') {
              // 失败：追加日志 + 错误行，整块变红；降级时 push 独立消息
              updateMsg(ev.id, prev => ({
                ...prev,
                text: prev.text + logSuffix + `\n✗ ${ev.name}: ${result.message}`,
                color: 'red',
              }), { role: 'error', text: `✗ ${ev.name}: ${result.message}` })
            } else {
              // 成功：按工具类型差异化格式化输出
              const out = result.output ?? ''
              const preview = formatToolOutput(ev.name, out, currentToolInputRef.current)
              updateMsg(ev.id, prev => ({
                ...prev,
                text: prev.text + logSuffix + `\n✓ ${ev.name}${preview ? '\n' + preview : ''}`,
              }), { role: 'tool', text: `✓ ${ev.name}${preview ? '\n' + preview : ''}` })
            }
            break
          }
          case 'permission_denied': push({ role: 'system', text: `⚠ 已拒绝: ${ev.description}`, color: 'yellow' }); break
          case 'usage': setCostInfo({ inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, costUsd: ev.costUsd }); break
          case 'compact_start': push({ role: 'system', text: '⟳ 上下文过长，正在自动压缩历史...' }); break
          case 'compact_done': {
            const archives = listArchives(sessionId)
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
          case 'done':
            if (assistantText) { setStreamBuf(''); push({ role: 'assistant', text: assistantText }); assistantText = '' }
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

  // 注册 stderr 拦截回调：将 process.stderr 输出显示为系统消息，避免破坏 Ink 渲染
  useEffect(() => {
    if (!onStderrReady) return
    onStderrReady((text: string) => {
      // 过滤空行和纯空白
      const clean = text.trim()
      if (!clean) return
      // 截断过长的 stderr 输出
      const display = clean.length > 500 ? clean.slice(0, 500) + '…' : clean
      push({ role: 'system', text: display, color: 'gray' })
    })
  }, [onStderrReady, push])

  // 构建命令上下文
  const cmdCtx: CommandContext = {
    clearHistory: () => engine.clearHistory(),
    compactHistory: async (summary: string) => {
      engine.compactHistory(summary)
    },
    generateCompactSummary: async () => {
      return engine.generateCompactSummary()
    },
    getHistoryLength: () => engine.store.getEventCount(),
    getEstimatedTokens: () => engine.getEstimatedTokens(),
    getCostSummary: () => engine.costs.getSummary(),
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
    listArchives: () => listArchives(sessionId),
    newSession: () => {
      const newId = generateSessionId()
      engine.clearHistory()
      setSessionId(newId)
      // 重置工作目录到新的独立子目录，防止旧任务文件污染新任务
      const newWorkDir = getSessionWorkDirPath(newId)
      setGlobalCwd(newWorkDir)
      try { process.chdir(newWorkDir) } catch { /* 忽略 */ }
      push({ role: 'system', text: `已创建新会话 (${newId})\n工作目录: ${newWorkDir}` })
    },
    switchSession: (id: string) => {
      const events = loadSessionEvents(id)
      if (!events) return false
      engine.store.replaceEvents(events)
      setSessionId(id)
      push({ role: 'system', text: `已切换到会话 ${id}（${events.length} 条事件）` })
      return true
    },
  }

  const handleSubmit = useCallback(async (value: string) => {
    const text = value.trim()
    if (!text || loading) return
    setInput('')

    // 优先检查是否有待处理的 ask_user（工具在等待用户回答）
    const pending = getPendingAskUser()
    if (pending) {
      push({ role: 'user', text })
      resolveAskUser(text)
      return
    }

    // 处理斜杠命令
    const parsed = commands.parse(text)
    if (parsed) {
      if (parsed.name === 'help') {
        const helpText = commands.getAll()
          .map(c => `  /${c.name}${c.argumentHint ? ' ' + c.argumentHint : ''}  —  ${c.description}`)
          .join('\n')
        push({ role: 'system', text: `可用命令:\n${helpText}` })
        return
      }

      const cmd = commands.find(parsed.name)
      if (!cmd) {
        push({ role: 'error', text: `未知命令: /${parsed.name}，输入 /help 查看可用命令` })
        return
      }

      const result = await cmd.execute(parsed.args, cmdCtx)
      if (result.type === 'exit') { exit(); return }
      if (result.type === 'message') { push({ role: 'system', text: result.text }); return }
      if (result.type === 'noop') return

      // inject：将 skill prompt 作为用户消息发给 LLM
      if (result.type === 'inject') {
        push({ role: 'user', text: `/${parsed.name}${parsed.args ? ' ' + parsed.args : ''}` })
        await runEngine(result.prompt)
        return
      }
      return
    }

    // 普通消息 → 发给 LLM
    push({ role: 'user', text })
    await runEngine(text)
  }, [loading, commands, engine, push, exit, cmdCtx])

  useInput((_, key) => {
    // useInput 作为备用，处理空闲状态下的 Ctrl+C 退出
    if (key.ctrl && (key as { name?: string }).name === 'c') {
      if (!loadingRef.current) {
        exit()
      }
    }
  })

  // 直接监听 stdin 原始字节，确保 loading 期间也能捕获 Ctrl+C（\x03）
  useEffect(() => {
    const handler = (data: Buffer) => {
      // \x03 = Ctrl+C
      if (data.length === 1 && data[0] === 0x03) {
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
    }
    process.stdin.on('data', handler)
    return () => { process.stdin.off('data', handler) }
  }, [engine, exit, push])

  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      {/* 消息历史 */}
      <Box flexDirection="column" marginBottom={1}>
        {msgs.map((m, i) => (
          <Box key={m.id ?? i} marginBottom={0}>
            <Text color={m.color ?? ROLE_COLOR[m.role]}>
              {ROLE_PREFIX[m.role]}{m.text}
            </Text>
          </Box>
        ))}
      </Box>

      {/* 工具执行中的临时进度日志（tool_end 后自动清空，不留在历史里） */}
      {loading && toolProgress && (
        <Box marginBottom={1}>
          <Text color="cyan" dimColor>{toolProgress}</Text>
        </Box>
      )}

      {/* 流式输出中的实时文本 */}
      {loading && streamBuf && (
        <Box marginBottom={1}>
          <Text color="white">✦ {streamBuf}</Text>
        </Box>
      )}

      {/* 状态栏 */}
      <Box marginBottom={0}>
        {askUserPrompt
          ? (
            <Box flexDirection="column">
              <Text color="yellow">{askUserPrompt}</Text>
              <Box>
                <Text color="cyan">{'› '}</Text>
                <TextInput
                  value={input}
                  onChange={setInput}
                  onSubmit={handleSubmit}
                  placeholder="输入回答..."
                />
              </Box>
            </Box>
          )
          : loading
          ? <Text color="yellow" dimColor>▸ 思考中...</Text>
          : (
            <Box>
              <Text color="cyan">{'› '}</Text>
              <TextInput
                value={input}
                onChange={setInput}
                onSubmit={handleSubmit}
                placeholder="输入消息或 /命令..."
              />
            </Box>
          )
        }
      </Box>

      {/* 底部状态栏 */}
      <Box marginTop={0}>
        <Text dimColor>
          {displayProvider}  {modelRef.current}
          {costInfo && ` 输入 ${costInfo.inputTokens} / 输出 ${costInfo.outputTokens} tokens  累计 ${costInfo.costUsd.toFixed(4)}`}
          {loading ? '  Ctrl+C 中断' : '  Ctrl+C 退出'}
        </Text>
      </Box>
    </Box>
  )
}
