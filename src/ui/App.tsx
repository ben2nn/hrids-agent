import React, { useState, useCallback, useRef, useEffect } from 'react'
import { Box, Text, useInput, useApp } from 'ink'
import TextInput from 'ink-text-input'
import type { QueryEngine, StreamEvent } from '../core/QueryEngine.js'
import type { CommandRegistry } from '../core/CommandRegistry.js'
import type { CommandContext } from '../core/CommandRegistry.js'
import { setCronTriggerCallback } from '../tools/ScheduleCronTool.js'
import type { CronJob } from '../tools/ScheduleCronTool.js'
import { listSessions, loadSession, generateSessionId, saveSession } from '../core/SessionStore.js'

interface Props {
  engine: QueryEngine
  commands: CommandRegistry
  sessionId: string
  onModelChange: (model: string) => void
  currentModel: string
  providerName: string
  // 可选：动态获取最新 provider 名称（用于 fallback 切换后刷新显示）
  getProviderName?: () => { name: string; model: string }
}

type MsgRole = 'user' | 'assistant' | 'tool' | 'system' | 'error' | 'cost'

interface DisplayMsg {
  role: MsgRole
  text: string
}

const ROLE_COLOR: Record<MsgRole, string> = {
  user:      'green',
  assistant: 'white',
  tool:      'cyan',
  system:    'gray',
  error:     'red',
  cost:      'yellow',
}

const ROLE_PREFIX: Record<MsgRole, string> = {
  user:      '你 › ',
  assistant: '',
  tool:      '',
  system:    '• ',
  error:     '✗ ',
  cost:      '$ ',
}

export function App({ engine, commands, sessionId: initialSessionId, onModelChange, currentModel, providerName, getProviderName }: Props) {
  const { exit } = useApp()
  const [input, setInput] = useState('')
  const [sessionId, setSessionId] = useState(initialSessionId)
  const [msgs, setMsgs] = useState<DisplayMsg[]>([
    { role: 'system', text: `会话已启动 (${initialSessionId})  输入 /help 查看命令` },
  ])
  const [loading, setLoading] = useState(false)
  const [streamBuf, setStreamBuf] = useState('')   // 当前流式文本缓冲
  const [toolProgress, setToolProgress] = useState('')  // 工具执行中的临时日志，不写入 msgs
  const modelRef = useRef(currentModel)
  const [displayProvider, setDisplayProvider] = useState(providerName)

  const push = useCallback((role: MsgRole, text: string) => {
    setMsgs(prev => [...prev, { role, text }])
  }, [])

  // cron 触发队列：避免在 loading 时直接调用，排队等待
  const cronQueueRef = useRef<CronJob[]>([])
  const loadingRef = useRef(false)
  // tool_log 批量缓冲：避免每行都触发重渲染导致 Ink 卡死
  const toolLogBufRef = useRef<string[]>([])
  const toolLogFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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
    if (displayAs !== undefined) push('system', displayAs)
    setLoading(true)
    loadingRef.current = true
    setStreamBuf('')
    let assistantText = ''
    try {
      for await (const ev of engine.send(prompt)) {
        switch (ev.type) {
          case 'text_delta': assistantText += ev.delta; setStreamBuf(assistantText); break
          case 'tool_start': push('tool', `⚙ ${ev.name}`); break
          case 'tool_log': bufferToolLog(`  ${ev.line}`); break
          case 'tool_end':
            flushToolLog() // 确保残留日志先 flush
            setToolProgress('') // 清空临时进度
            if (ev.result.type === 'error') push('error', `✗ ${ev.name}: ${ev.result.message}`)
            else {
              // output 截断显示，避免大量文本撑爆 Ink 渲染
              const out = ev.result.output ?? ''
              const preview = out.length > 500 ? out.slice(0, 500) + `\n…（共 ${out.length} 字符）` : out
              push('tool', `✓ ${ev.name}${preview ? `\n${preview}` : ''}`)
            }
            break
          case 'permission_denied': push('system', `⚠ 已拒绝: ${ev.description}`); break
          case 'usage': push('cost', `输入 ${ev.inputTokens} / 输出 ${ev.outputTokens} tokens  累计 $${ev.costUsd.toFixed(4)}`); break
          case 'compact_start': push('system', '⟳ 上下文过长，正在自动压缩历史...'); break
          case 'compact_done': push('system', `✓ 历史已压缩（约 ${engine.getEstimatedTokens().toLocaleString()} tokens）`); break
          case 'budget_exceeded': push('error', `⚠ 已超出成本预算 $${ev.limitUsd.toFixed(2)}（当前 $${ev.costUsd.toFixed(4)}），任务已停止`); break
          case 'error': push('error', ev.message); break
          case 'done':
            if (assistantText) { setStreamBuf(''); push('assistant', assistantText); assistantText = '' }
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
      push('error', String(err))
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

  // 构建命令上下文
  const cmdCtx: CommandContext = {
    clearHistory: () => engine.clearHistory(),
    compactHistory: async (summary: string) => {
      engine.compactHistory(summary)
    },
    generateCompactSummary: async () => {
      return engine.generateCompactSummary()
    },
    getHistoryLength: () => engine.getHistory().length,
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
    newSession: () => {
      const newId = generateSessionId()
      engine.clearHistory()
      setSessionId(newId)
      push('system', `已创建新会话 (${newId})`)
    },
    switchSession: (id: string) => {
      const messages = loadSession(id)
      if (!messages) return false
      engine.setHistory(messages)
      setSessionId(id)
      push('system', `已切换到会话 ${id}（${messages.length} 条消息）`)
      return true
    },
  }

  const handleSubmit = useCallback(async (value: string) => {
    const text = value.trim()
    if (!text || loading) return
    setInput('')

    // 处理斜杠命令
    const parsed = commands.parse(text)
    if (parsed) {
      if (parsed.name === 'help') {
        const helpText = commands.getAll()
          .map(c => `  /${c.name}${c.argumentHint ? ' ' + c.argumentHint : ''}  —  ${c.description}`)
          .join('\n')
        push('system', `可用命令:\n${helpText}`)
        return
      }

      const cmd = commands.find(parsed.name)
      if (!cmd) {
        push('error', `未知命令: /${parsed.name}，输入 /help 查看可用命令`)
        return
      }

      const result = await cmd.execute(parsed.args, cmdCtx)
      if (result.type === 'exit') { exit(); return }
      if (result.type === 'message') { push('system', result.text); return }
      if (result.type === 'noop') return

      // inject：将 skill prompt 作为用户消息发给 LLM
      if (result.type === 'inject') {
        push('user', `/${parsed.name}${parsed.args ? ' ' + parsed.args : ''}`)
        await runEngine(result.prompt)
        return
      }
      return
    }

    // 普通消息 → 发给 LLM
    push('user', text)
    await runEngine(text)
  }, [loading, commands, engine, push, exit, cmdCtx])

  useInput((_, key) => {
    if (key.ctrl && (key as { name?: string }).name === 'c') {
      if (loading) {
        // 任务运行中：中断任务而非退出
        engine.abort()
        setLoading(false)
        setStreamBuf('')
        setToolProgress('')
        push('system', '⚠ 任务已中断（Ctrl+C）')
      } else {
        exit()
      }
    }
  })

  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      {/* 消息历史 */}
      <Box flexDirection="column" marginBottom={1}>
        {msgs.map((m, i) => (
          <Box key={i} marginBottom={0}>
            <Text color={ROLE_COLOR[m.role]}>
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
          <Text color="white">{streamBuf}</Text>
        </Box>
      )}

      {/* 状态栏 */}
      <Box marginBottom={0}>
        {loading
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
          {loading ? '  Ctrl+C 中断' : '  Ctrl+C 退出'}
        </Text>
      </Box>
    </Box>
  )
}
