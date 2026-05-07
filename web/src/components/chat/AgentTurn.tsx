import { useState, useEffect, useMemo } from 'react'
import type { DisplayMessage, ToolCardState } from '../../lib/types.js'
import { MarkdownRenderer } from '../../lib/markdown.js'
import { ToolCard } from './ToolCard.js'

// ─── Props 接口 ────────────────────────────────────────────────────────────

interface AgentTurnProps {
  /** 本回合包含的消息（tool* + 可选 assistant） */
  messages: DisplayMessage[]
  /** 工具卡片状态 Map */
  toolCardsMap: Map<string, ToolCardState> | null
  /** 所属会话 ID */
  sessionId: string
  /** 是否显示头像（回合第一条才显示） */
  showAvatar: boolean
  /** 流式消息的 id，匹配时在文字末尾显示光标 */
  streamingMessageId?: string
  /** 定时任务描述（有值时表示本回合由定时任务触发） */
  cronDescription?: string
  /** 是否正在运行中 */
  isRunning?: boolean
}

// ─── 头像组件（带思考动画） ────────────────────────────────────────────────

function AgentAvatar({ thinking }: { thinking?: boolean }) {
  return (
    <div className="relative w-8 h-8 shrink-0">
      <div className="w-8 h-8 rounded-full overflow-hidden border border-[var(--border-subtle)]">
        <img src="/avatar.png" alt="Agent" className="w-full h-full object-cover" />
      </div>
      {thinking && (
        <div className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 bg-amber-400 rounded-full flex items-center justify-center shadow-sm">
          <div className="flex gap-[2px]">
            <span className="w-[3px] h-[3px] bg-white rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
            <span className="w-[3px] h-[3px] bg-white rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
            <span className="w-[3px] h-[3px] bg-white rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
          </div>
        </div>
      )}
    </div>
  )
}

// ─── 执行时间计时器 ──────────────────────────────────────────────────────────

function ExecutionTimer({ startTime, endTime }: { startTime: number; endTime?: number }) {
  const [elapsed, setElapsed] = useState(() => {
    if (endTime) return Math.floor((endTime - startTime) / 1000)
    return Math.floor((Date.now() - startTime) / 1000)
  })

  useEffect(() => {
    if (endTime) return // 历史数据不需要更新
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000))
    }, 1000)
    return () => clearInterval(interval)
  }, [startTime, endTime])

  return (
    <span className="text-[11px] text-[var(--text-muted)] font-mono tabular-nums">
      {elapsed}s
    </span>
  )
}

// ─── 流式光标 ──────────────────────────────────────────────────────────────

function StreamingCursor() {
  return (
    <span
      className="inline-block w-[2px] h-[1em] bg-[var(--text-primary)] align-middle animate-pulse ml-0.5"
      aria-hidden="true"
    >
      ▋
    </span>
  )
}

// ─── 工具名称映射（与 ToolCard 保持一致） ───────────────────────────────────

const TOOL_LABEL_MAP: Record<string, string> = {
  file_read: '读取文件', file_write: '写入文件', file_edit: '编辑文件',
  glob: '查找文件', grep: '搜索内容', web_search: '网络搜索', web_fetch: '获取网页',
  bash: '执行命令', powershell: '执行命令',
  todo_write: '创建任务', todo_update: '更新任务', todo_append: '追加任务', todo_reset: '重置任务', todo_read: '查看任务',
  ask_user: '询问用户', request_decision: '请求决策',
  skill: '调用技能', skill_list: '列出技能', skill_save: '保存技能',
  skillhub_search: '搜索技能库', skillhub_install: '安装技能',
  schedule_cron: '定时任务', agent: '子智能体', agent_spawn: '派生智能体',
  memory_add: '记住内容', memory_update: '更新记忆', memory_search: '搜索记忆', memory_recall: '回忆内容', memory_fact: '记录事实', memory_status: '记忆状态',
}

// ─── 获取工具状态 ──────────────────────────────────────────────────────────

function getToolStatus(msg: DisplayMessage, toolCardsMap: Map<string, ToolCardState> | null): 'pending' | 'success' | 'error' | 'denied' {
  if (msg.type !== 'tool') return 'pending'
  const card = toolCardsMap?.get(msg.toolId)
  if (!card) return 'pending'
  return card.status
}

// ─── 获取工具显示名称 ──────────────────────────────────────────────────────

function getToolDisplayName(msg: DisplayMessage, toolCardsMap: Map<string, ToolCardState> | null): string {
  if (msg.type !== 'tool') return ''
  const card = toolCardsMap?.get(msg.toolId)
  return TOOL_LABEL_MAP[card?.toolName ?? msg.toolName] ?? card?.toolName ?? msg.toolName ?? ''
}

// ─── 获取工具输入摘要 ──────────────────────────────────────────────────────

function getToolSummary(toolName: string, input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const inp = input as Record<string, unknown>
  switch (toolName) {
    case 'file_read':
    case 'file_write':
    case 'file_edit':   return String(inp.path ?? '')
    case 'glob':        return String(inp.pattern ?? '')
    case 'grep':        return String(inp.pattern ?? '')
    case 'web_search':  return String(inp.query ?? '')
    case 'web_fetch':   return String(inp.url ?? '')
    case 'bash':
    case 'powershell': {
      const cmd = String(inp.command ?? inp.cmd ?? '')
      return cmd.length > 40 ? cmd.slice(0, 40) + '…' : cmd
    }
    case 'ask_user':    return String(inp.question ?? '')
    case 'memory_add':  return String(inp.content ?? '').slice(0, 30)
    case 'memory_search': return String(inp.query ?? '')
    default:            return ''
  }
}

// ─── 执行过程摘要（堆叠显示，只显示最新的） ────────────────────────────────

function ExecutionSummary({
  toolMsgs,
  toolCardsMap,
  sessionId,
  isRunning,
  startTime,
  endTime,
}: {
  toolMsgs: DisplayMessage[]
  toolCardsMap: Map<string, ToolCardState> | null
  sessionId: string
  isRunning: boolean
  startTime: number
  endTime?: number
}) {
  const [expanded, setExpanded] = useState(false)
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set())

  const toggleCard = (toolId: string) => {
    setExpandedCards(prev => {
      const next = new Set(prev)
      if (next.has(toolId)) {
        next.delete(toolId)
      } else {
        next.add(toolId)
      }
      return next
    })
  }

  // 工具名称摘要（去重）
  const uniqueNames = [...new Set(toolMsgs.map(m => getToolDisplayName(m, toolCardsMap)).filter(Boolean))]

  // 获取最新的工具消息（确保是 tool 类型）
  const latestToolMsg = toolMsgs[toolMsgs.length - 1]
  const latestToolId = latestToolMsg?.type === 'tool' ? latestToolMsg.toolId : undefined
  const latestToolCard = latestToolId ? toolCardsMap?.get(latestToolId) : null
  const latestToolName = latestToolMsg?.type === 'tool' ? latestToolMsg.toolName : ''
  const latestToolLabel = latestToolName ? getToolDisplayName(latestToolMsg!, toolCardsMap) : ''

  // 获取最新工具的摘要信息
  const latestToolSummary = latestToolCard ? getToolSummary(latestToolCard.toolName, latestToolCard.input) : ''

  // 运行中：显示最新调用信息 + 滚动计时
  if (isRunning) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-md" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)' }}>
        {/* 加载动画 */}
        <svg className="animate-spin shrink-0" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" style={{ color: 'var(--text-muted)' }}>
          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        </svg>

        {/* 工具名称 */}
        <span className="text-[12px] font-medium shrink-0" style={{ color: 'var(--text-secondary)' }}>
          {latestToolLabel || '执行中'}
        </span>

        {/* 摘要信息 */}
        {latestToolSummary && (
          <span className="text-[11px] font-mono truncate flex-1 min-w-0" style={{ color: 'var(--text-muted)' }}>
            {latestToolSummary}
          </span>
        )}

        {/* 滚动计时 */}
        <ExecutionTimer startTime={startTime} />
      </div>
    )
  }

  // 历史数据：摘要行 + 可展开
  return (
    <div className="rounded-lg overflow-hidden" style={{
      background: 'var(--bg-secondary)',
      border: '1px solid var(--border-subtle)',
    }}>
      {/* 摘要标题行 */}
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-white/[0.025] transition-colors select-none"
        onClick={() => setExpanded(v => !v)}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(v => !v) } }}
      >
        {/* 执行次数 */}
        <span className="text-[12px] font-medium shrink-0" style={{ color: 'var(--text-secondary)' }}>
          执行 {toolMsgs.length} 次
        </span>

        {/* 工具名称摘要 */}
        <span className="text-[11px] font-mono truncate flex-1 min-w-0" style={{ color: 'var(--text-muted)' }}>
          {uniqueNames.join(', ')}
        </span>

        {/* 执行时间 */}
        <ExecutionTimer startTime={startTime} endTime={endTime} />

        {/* 展开箭头 > */}
        <span
          className="shrink-0 transition-transform duration-200"
          style={{
            color: 'var(--text-muted)',
            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
          }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </span>
      </div>

      {/* 展开后显示所有工具卡片 */}
      {expanded && (
        <div className="flex flex-col gap-1.5 px-2.5 pb-2.5" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          {toolMsgs.map((msg) => {
            if (msg.type !== 'tool') return null
            const toolCard = toolCardsMap?.get(msg.toolId)
            if (!toolCard) {
              return (
                <div key={msg.id} className="px-3 py-2 mt-1.5 rounded-md" style={{ background: 'var(--bg-tertiary, rgba(0,0,0,0.06))' }}>
                  <div className="flex items-center gap-2">
                    <svg className="animate-spin text-amber-400 shrink-0" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                    </svg>
                    <span className="text-xs text-[var(--text-secondary)]">{msg.toolName}</span>
                  </div>
                </div>
              )
            }
            return (
              <div key={msg.id} className="mt-1.5">
                <ToolCard
                  toolName={toolCard.toolName}
                  input={toolCard.input}
                  status={toolCard.status}
                  logs={toolCard.logs}
                  result={toolCard.result}
                  isExpanded={expandedCards.has(msg.toolId)}
                  sessionId={sessionId}
                  onToggle={() => toggleCard(msg.toolId)}
                />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── AgentTurn 组件 ────────────────────────────────────────────────────────
// 将一个 Agent 回合（若干工具调用 + 可选说明文字）合并渲染在同一个容器内，
// 说明文字在上，工具卡片在下，视觉上与 Kiro 保持一致。

export function AgentTurn({ messages, toolCardsMap, sessionId, showAvatar, streamingMessageId, cronDescription, isRunning = false }: AgentTurnProps) {
  const hasTools = messages.some((m) => m.type === 'tool')
  const assistantMsgs = messages.filter((m) => m.type === 'assistant')
  const hasText = assistantMsgs.some((m) => (m as { content: string }).content?.trim().length > 0)

  // 计算执行时间（从第一条消息的时间戳开始）
  const startTime = useMemo(() => {
    const firstMsg = messages[0]
    if (!firstMsg) return Date.now()
    return (firstMsg as { timestamp?: number }).timestamp ?? Date.now()
  }, [messages])

  // 结束时间（如果所有工具都完成了）
  const endTime = useMemo(() => {
    if (isRunning) return undefined
    const toolMsgs = messages.filter(m => m.type === 'tool')
    if (toolMsgs.length === 0) return undefined
    // 检查是否所有工具都完成了
    const allCompleted = toolMsgs.every(m => {
      const status = getToolStatus(m, toolCardsMap)
      return status === 'success' || status === 'error'
    })
    if (!allCompleted) return undefined
    // 返回最后一条消息的时间戳
    const lastMsg = messages[messages.length - 1]
    return (lastMsg as { timestamp?: number }).timestamp ?? Date.now()
  }, [messages, toolCardsMap, isRunning])

  // ── 定时任务触发的消息：独立卡片样式 ──────────────────────────────────
  if (cronDescription) {
    const assistantMsg = assistantMsgs[0]
    const content = (assistantMsg as { content?: string } | undefined)?.content ?? ''
    const isStreaming = streamingMessageId && assistantMsg?.id === streamingMessageId
    return (
      <div className="px-4 py-2 animate-fade-in">
        <div className="border border-[var(--accent)]/30 rounded-xl overflow-hidden bg-[var(--accent)]/5">
          {/* 卡片头部：类别 + 任务名称 */}
          <div className="flex items-center gap-2 px-3.5 py-2 border-b border-[var(--accent)]/20 bg-[var(--accent)]/8">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--accent)] shrink-0">
              <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
            </svg>
            <span className="text-[11px] font-semibold text-[var(--accent)] tracking-wide uppercase">定时任务</span>
            <span className="text-[11px] text-[var(--text-muted)] opacity-60">·</span>
            <span className="text-[11px] text-[var(--text-secondary)] truncate">{cronDescription}</span>
          </div>
          {/* 卡片内容：提醒文字 */}
          <div className="px-3.5 py-3">
            {content.trim() ? (
              isStreaming ? (
                <span className="text-[var(--text-primary)] text-sm whitespace-pre-wrap break-words leading-relaxed">
                  {content}
                  <StreamingCursor />
                </span>
              ) : (
                <MarkdownRenderer content={content} />
              )
            ) : null}
            {/* 工具调用（定时任务触发时通常没有，但保留兼容） */}
            {hasTools && (() => {
              const toolMsgs = messages.filter((m): m is DisplayMessage & { type: 'tool' } => m.type === 'tool')
              return (
                <div className="mt-2">
                  <ExecutionSummary
                    toolMsgs={toolMsgs}
                    toolCardsMap={toolCardsMap}
                    sessionId={sessionId}
                    isRunning={isRunning}
                    startTime={startTime}
                    endTime={endTime}
                  />
                </div>
              )
            })()}
          </div>
        </div>
      </div>
    )
  }

  // 纯说明文字（无工具调用，且只有一条 assistant 消息）
  if (!hasTools && assistantMsgs.length === 1 && hasText) {
    const assistantMsg = assistantMsgs[0]
    const content = (assistantMsg as { content: string }).content
    const isStreaming = !!(streamingMessageId && assistantMsg?.id === streamingMessageId)
    return (
      <div className="flex flex-col px-4 py-2 animate-fade-in">
        {showAvatar && (
          <div className="flex items-center gap-2 mb-2">
            <AgentAvatar thinking={isStreaming} />
            <span className="text-xs font-semibold text-[var(--text-secondary)] tracking-wide">知了</span>
          </div>
        )}
        <div className="ml-10 mr-6">
          <div className="agent-bubble px-4 py-3.5">
            {isStreaming ? (
              <span className="text-[var(--text-primary)] text-sm whitespace-pre-wrap break-words leading-relaxed">
                {content}
                <StreamingCursor />
              </span>
            ) : (
              <MarkdownRenderer content={content} />
            )}
          </div>
        </div>
      </div>
    )
  }

  // 工具调用（含或不含说明文字），或多条 assistant 消息交错的情况
  // 按消息原始顺序渲染：assistant 文字气泡 + tool 卡片交错显示
  // 多个连续工具调用合并为一个可展开的摘要卡片

  // 将消息流分段：连续的 tool 消息归为一组，assistant 消息各自独立
  type Segment =
    | { kind: 'assistant'; msg: DisplayMessage }
    | { kind: 'tools'; msgs: DisplayMessage[] }
  const segments: Segment[] = []
  let toolBuf: DisplayMessage[] = []
  const flushToolBuf = () => {
    if (toolBuf.length > 0) {
      segments.push({ kind: 'tools', msgs: toolBuf })
      toolBuf = []
    }
  }
  for (const msg of messages) {
    if (msg.type === 'assistant') {
      flushToolBuf()
      segments.push({ kind: 'assistant', msg })
    } else if (msg.type === 'tool') {
      toolBuf.push(msg)
    }
  }
  flushToolBuf()

  // 判断是否有工具正在运行
  const hasRunningTools = messages.some(m => {
    if (m.type !== 'tool') return false
    const status = getToolStatus(m, toolCardsMap)
    return status === 'pending'
  })

  return (
    <div className="flex flex-col px-4 py-2 animate-fade-in">
      {showAvatar && (
        <div className="flex items-center gap-2 mb-2">
          <AgentAvatar thinking={isRunning || hasRunningTools} />
          <span className="text-xs font-semibold text-[var(--text-secondary)] tracking-wide">知了</span>
        </div>
      )}
      <div className="ml-10 mr-6 flex flex-col gap-1.5">
        {segments.map((seg, idx) => {
          if (seg.kind === 'assistant') {
            const msg = seg.msg
            const content = (msg as { content: string }).content
            if (!content?.trim()) return null
            const isStreaming = streamingMessageId && msg.id === streamingMessageId
            return (
              <div key={msg.id} className="agent-bubble px-4 py-3.5">
                {isStreaming ? (
                  <span className="text-[var(--text-primary)] text-sm whitespace-pre-wrap break-words leading-relaxed">
                    {content}
                    <StreamingCursor />
                  </span>
                ) : (
                  <MarkdownRenderer content={content} />
                )}
              </div>
            )
          }

          // tools 段：使用 ExecutionSummary 组件
          const toolMsgs = seg.msgs
          return (
            <ExecutionSummary
              key={`tools-${idx}`}
              toolMsgs={toolMsgs}
              toolCardsMap={toolCardsMap}
              sessionId={sessionId}
              isRunning={isRunning || hasRunningTools}
              startTime={startTime}
              endTime={endTime}
            />
          )
        })}
      </div>
    </div>
  )
}

export default AgentTurn
