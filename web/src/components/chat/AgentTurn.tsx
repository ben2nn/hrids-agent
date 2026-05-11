import { useState, useEffect } from 'react'
import type { DisplayMessage, ToolCardState, AgentTurnData } from '../../lib/types.js'
import { MarkdownRenderer } from '../../lib/markdown.js'
import { ToolCard } from './ToolCard.js'

// ─── Props ─────────────────────────────────────────────────────────────────

interface AgentTurnProps {
  data: AgentTurnData
  toolCardsMap: Map<string, ToolCardState> | null
  sessionId: string
  showAvatar: boolean
  streamingText?: string
}

// ─── 头像 ──────────────────────────────────────────────────────────────────

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

// ─── 执行计时器 ────────────────────────────────────────────────────────────
// 完成时：显示 endTime - startTime 的实际耗时
// 运行中：从 0 开始每秒 +1（避免历史消息 startTime 导致初始值偏大）

function ExecutionTimer({ startTime, endTime }: { startTime: number; endTime?: number }) {
  const [elapsed, setElapsed] = useState(() =>
    endTime ? Math.floor((endTime - startTime) / 1000) : 0,
  )
  useEffect(() => {
    if (endTime) {
      setElapsed(Math.floor((endTime - startTime) / 1000))
      return
    }
    setElapsed(0)
    const id = setInterval(() => setElapsed(s => s + 1), 1000)
    return () => clearInterval(id)
  }, [startTime, endTime])
  return <span className="text-[11px] text-[var(--text-muted)] font-mono tabular-nums">{elapsed}s</span>
}

// ─── 流式光标 ──────────────────────────────────────────────────────────────

function StreamingCursor() {
  return (
    <span className="inline-block w-[2px] h-[1em] bg-[var(--text-primary)] align-middle animate-pulse ml-0.5" aria-hidden="true">
      ▋
    </span>
  )
}

// ─── 工具名称映射 ──────────────────────────────────────────────────────────

const TOOL_LABEL_MAP: Record<string, string> = {
  file_read: '读取文件', file_write: '写入文件', file_edit: '编辑文件',
  glob: '查找文件', grep: '搜索内容', web_search: '网络搜索', web_fetch: '获取网页',
  bash: '执行命令', powershell: '执行命令',
  todo_write: '创建任务', todo_update: '更新任务', todo_append: '追加任务', todo_reset: '重置任务', todo_read: '查看任务',
  ask_user: '询问用户', request_decision: '请求决策',
  skill: '调用技能', skill_list: '列出技能', skill_save: '保存技能',
  skillhub_search: '搜索技能库', skillhub_install: '安装技能',
  schedule_cron: '定时任务', agent: '子智能体', agent_spawn: '派生智能体',
  memory_add: '记住内容', memory_update: '更新记忆', memory_search: '搜索记忆',
  memory_recall: '回忆内容', memory_fact: '记录事实', memory_status: '记忆状态',
}

function getToolLabel(toolName: string): string {
  return TOOL_LABEL_MAP[toolName] ?? toolName
}

function getToolSummary(toolName: string, input: unknown, result?: unknown): string {
  // todo_read 不依赖 input，优先处理
  if (toolName === 'todo_read') {
    if (result && typeof result === 'string') {
      const m = result.match(/（(\d+)\/(\d+)\s*已完成）/)
      if (m) return `共 ${m[2]} 项任务，${m[1]} 已完成`
    }
    return '查看任务列表'
  }

  if (!input || typeof input !== 'object') return ''
  const inp = input as Record<string, unknown>
  switch (toolName) {
    case 'file_read': case 'file_write': case 'file_edit': return String(inp.path ?? '')
    case 'glob':        return String(inp.pattern ?? '')
    case 'grep':        return String(inp.pattern ?? '')
    case 'web_search':  return String(inp.query ?? '')
    case 'web_fetch':   return String(inp.url ?? '')
    case 'bash': case 'powershell': {
      const cmd = String(inp.command ?? inp.cmd ?? '')
      return cmd.length > 40 ? cmd.slice(0, 40) + '…' : cmd
    }
    case 'ask_user':      return String(inp.question ?? '')
    case 'memory_add': {
      const content = String(inp.content ?? '')
      const type = String(inp.type ?? '')
      const typeLabel: Record<string, string> = { decision: '决策', preference: '偏好', milestone: '里程碑', problem: '问题', emotional: '情感', fact: '事实' }
      const prefix = typeLabel[type] ? `[${typeLabel[type]}] ` : ''
      const text = content.length > 40 ? content.slice(0, 40) + '…' : content
      return prefix + text
    }
    case 'memory_update': {
      const content = String(inp.content ?? '')
      return content.length > 40 ? content.slice(0, 40) + '…' : content
    }
    case 'memory_search': return String(inp.query ?? '')
    case 'memory_recall': {
      const parts = [inp.wing, inp.room].filter(Boolean).map(String)
      return parts.length > 0 ? parts.join(' / ') : '全部记忆'
    }
    case 'memory_fact': {
      const parts = [inp.subject, inp.predicate, inp.object].filter(Boolean).map(String)
      return parts.length > 0 ? parts.join(' → ') : '记录事实'
    }
    case 'memory_status': return '记忆状态'
    case 'todo_write': {
      const todos = Array.isArray(inp.todos) ? inp.todos as Array<Record<string, unknown>> : []
      return todos.length > 0 ? `共 ${todos.length} 项` : '创建任务计划'
    }
    case 'todo_update': {
      const id = inp.id ? `#${inp.id}` : ''
      const statusMap: Record<string, string> = { pending: '待处理', in_progress: '进行中', completed: '已完成' }
      const status = inp.status ? (statusMap[String(inp.status)] ?? String(inp.status)) : ''
      return [id, status].filter(Boolean).join(' → ')
    }
    case 'todo_append': {
      const todos = Array.isArray(inp.todos) ? inp.todos as Array<Record<string, unknown>> : []
      return todos.length > 0 ? `追加 ${todos.length} 项` : '追加任务'
    }
    case 'todo_reset': return '重置任务计划'
    case 'skill':      return String(inp.skill_name ?? '')
    case 'skill_list': return '列出所有技能'
    case 'skill_save': {
      const scope = inp.scope === 'project' ? '项目级' : '用户级'
      return `${inp.name ?? ''} (${scope})`
    }
    case 'skillhub_search':    return String(inp.query ?? '')
    case 'skillhub_install':   return String(inp.skill_id ?? '')
    case 'skillhub_uninstall': return String(inp.skill_id ?? '')
    case 'skillhub_upgrade':   return String(inp.skill_id ?? '')
    case 'skillhub_list':      return '已安装技能'
    case 'skillhub_recommend': {
      const task = String(inp.task ?? '')
      return task.length > 40 ? task.slice(0, 40) + '…' : task
    }
    case 'schedule_cron': {
      if (inp.action === 'create') return String(inp.description ?? '')
      if (inp.action === 'delete') return `删除 ${inp.id ?? ''}`
      if (inp.action === 'toggle') return `${inp.enabled ? '启用' : '禁用'} ${inp.id ?? ''}`
      return '查看列表'
    }
    case 'agent':       return String(inp.description ?? '')
    case 'agent_spawn': {
      const parts = [inp.team, inp.name].filter(Boolean).map(String)
      return parts.length > 0 ? parts.join(' / ') : '派生智能体'
    }
    case 'team_create': return String(inp.name ?? '')
    case 'team_delete': return String(inp.name ?? '')
    case 'team_status': return String(inp.team ?? '')
    case 'team_wait':   return String(inp.team ?? '')
    case 'send_message': {
      const to = String(inp.to ?? '')
      const content = String(inp.content ?? '')
      return `→ ${to}: ${content.length > 40 ? content.slice(0, 40) + '…' : content}`
    }
    case 'receive_message': return '等待接收消息'
    case 'request_decision': {
      const title = String(inp.title ?? '')
      return title.length > 40 ? title.slice(0, 40) + '…' : title
    }
    default: return ''
  }
}

// ─── ProcessPanel：运行过程折叠卡片 ───────────────────────────────────────
//
// 折叠时：最新工具名 + 摘要 + 计时器
// 展开时：按原始顺序渲染过程消息（工具卡片 + 中间说明文字）

function ProcessPanel({
  processMessages,
  toolCardsMap,
  sessionId,
  isRunning,
  startTime,
  endTime,
  cronDescription,
}: {
  processMessages: DisplayMessage[]
  toolCardsMap: Map<string, ToolCardState> | null
  sessionId: string
  isRunning: boolean
  startTime: number
  endTime?: number
  cronDescription?: string
}) {
  const [expanded, setExpanded] = useState(false)
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set())

  const toggleCard = (toolId: string) =>
    setExpandedCards(prev => {
      const next = new Set(prev)
      if (next.has(toolId)) next.delete(toolId); else next.add(toolId)
      return next
    })

  const toolMsgs = processMessages.filter((m): m is DisplayMessage & { type: 'tool' } => m.type === 'tool')
  const latestTool = toolMsgs[toolMsgs.length - 1]
  const latestCard = latestTool ? toolCardsMap?.get(latestTool.toolId) : null
  const latestLabel = latestTool ? getToolLabel(latestCard?.toolName ?? latestTool.toolName) : ''
  const latestSummary = latestCard
    ? getToolSummary(latestCard.toolName, latestCard.input, latestCard.result)
    : latestTool
      ? getToolSummary(latestTool.toolName, undefined, undefined)
      : ''

  // 运行中：单行状态条
  if (isRunning) {
    return (
      <div
        className="flex items-center gap-2 px-3 py-2 rounded-md"
        style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)' }}
      >
        <svg className="animate-spin shrink-0" width="13" height="13" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" style={{ color: 'var(--text-muted)' }}>
          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        </svg>
        <span className="text-[12px] font-medium shrink-0" style={{ color: 'var(--text-secondary)' }}>
          {latestLabel || '执行中'}
        </span>
        {latestSummary && (
          <span className="text-[11px] font-mono truncate flex-1 min-w-0" style={{ color: 'var(--text-muted)' }}>
            {latestSummary}
          </span>
        )}
        <ExecutionTimer startTime={startTime} />
      </div>
    )
  }

  // 完成：可折叠卡片（带堆叠层次感）
  return (
    <div className="relative">
      {/* 堆叠层 2（最底层，偏移最大） */}
      {!expanded && (
        <div
          className="absolute inset-x-0 bottom-0 rounded-lg"
          style={{
            height: '100%',
            transform: 'translateY(5px) scaleX(0.92)',
            transformOrigin: 'bottom center',
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-subtle)',
            opacity: 0.4,
            zIndex: 0,
          }}
        />
      )}
      {/* 堆叠层 1（中间层） */}
      {!expanded && (
        <div
          className="absolute inset-x-0 bottom-0 rounded-lg"
          style={{
            height: '100%',
            transform: 'translateY(3px) scaleX(0.96)',
            transformOrigin: 'bottom center',
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-subtle)',
            opacity: 0.65,
            zIndex: 1,
          }}
        />
      )}
      {/* 主卡片 */}
      <div className="relative rounded-lg overflow-hidden" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)', zIndex: 2 }}>
      {/* 折叠行 */}
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-white/[0.025] transition-colors select-none"
        onClick={() => setExpanded(v => !v)}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(v => !v) } }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          strokeLinecap="round" className="shrink-0 text-[var(--success)]">
          <polyline points="20 6 9 17 4 12" />
        </svg>
        <span className="text-[12px] font-medium shrink-0" style={{ color: 'var(--text-primary)' }}>
          {cronDescription || latestLabel || '执行完成'}
        </span>
        {latestSummary && (
          <span className="text-[11px] font-mono truncate flex-1 min-w-0" style={{ color: 'var(--text-muted)' }}>
            {latestSummary}
          </span>
        )}
        <ExecutionTimer startTime={startTime} endTime={endTime} />
        <span
          className="shrink-0 transition-transform duration-200"
          style={{ color: 'var(--text-muted)', transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </span>
      </div>

      {/* 展开内容：按原始顺序渲染工具卡片 + 中间说明文字 */}
      {expanded && (
        <div className="flex flex-col gap-1.5 px-2.5 pb-2.5" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          {processMessages.map(msg => {
            if (msg.type === 'tool') {
              const card = toolCardsMap?.get(msg.toolId)
              if (!card) {
                return (
                  <div key={msg.id} className="px-3 py-2 mt-1.5 rounded-md" style={{ background: 'var(--bg-tertiary, rgba(0,0,0,0.06))' }}>
                    <div className="flex items-center gap-2">
                      <svg className="animate-spin text-amber-400 shrink-0" width="11" height="11" viewBox="0 0 24 24"
                        fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
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
                    toolName={card.toolName}
                    input={card.input}
                    status={card.status}
                    logs={card.logs}
                    result={card.result}
                    isExpanded={expandedCards.has(msg.toolId)}
                    sessionId={sessionId}
                    onToggle={() => toggleCard(msg.toolId)}
                  />
                </div>
              )
            }
            if (msg.type === 'assistant') {
              const content = (msg as { content: string }).content
              if (!content?.trim()) return null
              return (
                <div key={msg.id} className="px-3 py-2 mt-1.5 text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                  <MarkdownRenderer content={content} />
                </div>
              )
            }
            return null
          })}
        </div>
      )}
    </div>
    </div>
  )
}

// ─── AgentTurn 主组件 ──────────────────────────────────────────────────────
//
// 渲染完全由 AgentTurnData 驱动，三种形态：
//   1. 定时任务回合  → 定时任务卡片
//   2. 纯文字回合    → 头像 + 文字气泡（无工具调用的简单回复）
//   3. 普通回合      → 头像 + ProcessPanel（折叠）+ 最终报告气泡

export function AgentTurn({ data, toolCardsMap, sessionId, showAvatar, streamingText }: AgentTurnProps) {
  const { processMessages, finalMessage, isRunning, startTime, endTime, cronDescription } = data

  const hasProcess = processMessages.length > 0
  const hasFinal = !!finalMessage
  const finalContent = (finalMessage as { content?: string } | null)?.content ?? ''

  // ── 1. 定时任务回合 ───────────────────────────────────────────────────
  if (cronDescription) {
    return (
      <div className="px-4 py-2 animate-fade-in">
        <div className="border border-[var(--accent)]/30 rounded-xl overflow-hidden bg-[var(--accent)]/5">
          <div className="flex items-center gap-2 px-3.5 py-2 border-b border-[var(--accent)]/20 bg-[var(--accent)]/8">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round" className="text-[var(--accent)] shrink-0">
              <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
            </svg>
            <span className="text-[11px] font-semibold text-[var(--accent)] tracking-wide uppercase">定时任务</span>
            <span className="text-[11px] text-[var(--text-muted)] opacity-60">·</span>
            <span className="text-[11px] text-[var(--text-secondary)] truncate">{cronDescription}</span>
          </div>
          <div className="px-3.5 py-3 flex flex-col gap-2">
            {hasProcess && (
              <ProcessPanel
                processMessages={processMessages}
                toolCardsMap={toolCardsMap}
                sessionId={sessionId}
                isRunning={isRunning}
                startTime={startTime}
                endTime={endTime}
                cronDescription={cronDescription}
              />
            )}
            {hasFinal && <MarkdownRenderer content={finalContent} />}
            {streamingText && (
              <span className="text-[var(--text-primary)] text-sm whitespace-pre-wrap break-words leading-relaxed">
                {streamingText}<StreamingCursor />
              </span>
            )}
          </div>
        </div>
      </div>
    )
  }

  // ── 2. 纯文字回合（无工具调用，只有最终消息） ─────────────────────────
  if (!hasProcess && hasFinal && !streamingText) {
    return (
      <div className="flex flex-col px-4 py-2 animate-fade-in">
        {showAvatar && (
          <div className="flex items-center gap-2 mb-2">
            <AgentAvatar />
            <span className="text-xs font-semibold text-[var(--text-secondary)] tracking-wide">知了</span>
          </div>
        )}
        <div className="ml-10 mr-6">
          <div className="agent-bubble px-4 py-3.5">
            <MarkdownRenderer content={finalContent} />
          </div>
        </div>
      </div>
    )
  }

  // ── 3. 普通回合（有工具调用，或运行中） ──────────────────────────────
  return (
    <div className="flex flex-col px-4 py-2 animate-fade-in">
      {showAvatar && (
        <div className="flex items-center gap-2 mb-2">
          <AgentAvatar thinking={isRunning} />
          <span className="text-xs font-semibold text-[var(--text-secondary)] tracking-wide">知了</span>
        </div>
      )}
      <div className="ml-10 mr-6 flex flex-col gap-2">
        {/* 运行过程：折叠卡片 */}
        {hasProcess && (
          <ProcessPanel
            processMessages={processMessages}
            toolCardsMap={toolCardsMap}
            sessionId={sessionId}
            isRunning={isRunning}
            startTime={startTime}
            endTime={endTime}
          />
        )}
        {/* 最终报告：独立气泡 */}
        {hasFinal && (
          <div className="agent-bubble px-4 py-3.5">
            <MarkdownRenderer content={finalContent} />
          </div>
        )}
        {/* 流式文字（运行中时的实时输出） */}
        {streamingText && (
          <div className="agent-bubble px-4 py-3.5">
            <span className="text-[var(--text-primary)] text-sm whitespace-pre-wrap break-words leading-relaxed">
              {streamingText}
            </span>
            <StreamingCursor />
          </div>
        )}
      </div>
    </div>
  )
}

export default AgentTurn
