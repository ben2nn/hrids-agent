import type { DisplayMessage, ToolCardState } from '../../lib/types.js'
import { MarkdownRenderer } from '../../lib/markdown.js'
import { ToolCard } from './ToolCard.js'
import { useMessageStore } from '../../store/messageStore.js'

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
}

// ─── 头像组件 ──────────────────────────────────────────────────────────────

function AgentAvatar() {
  return (
    <div className="w-8 h-8 rounded-full overflow-hidden shrink-0 border border-[var(--border-subtle)]">
      <img src="/avatar.png" alt="Agent" className="w-full h-full object-cover" />
    </div>
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

// ─── AgentTurn 组件 ────────────────────────────────────────────────────────
// 将一个 Agent 回合（若干工具调用 + 可选说明文字）合并渲染在同一个容器内，
// 说明文字在上，工具卡片在下，视觉上与 Kiro 保持一致。

export function AgentTurn({ messages, toolCardsMap, sessionId, showAvatar, streamingMessageId, cronDescription }: AgentTurnProps) {
  const hasTools = messages.some((m) => m.type === 'tool')
  const assistantMsgs = messages.filter((m) => m.type === 'assistant')
  const hasText = assistantMsgs.some((m) => (m as { content: string }).content?.trim().length > 0)

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
            {hasTools && (
              <div className="mt-2 flex flex-col gap-1.5">
                {messages.filter((m) => m.type === 'tool').map((msg) => {
                  if (msg.type !== 'tool') return null
                  const toolCard = toolCardsMap?.get(msg.toolId)
                  if (!toolCard) return (
                    <div key={msg.id} className="tool-card-base px-3 py-2">
                      <div className="flex items-center gap-2">
                        <svg className="animate-spin text-amber-400 shrink-0" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                        </svg>
                        <span className="text-xs text-[var(--text-secondary)]">{msg.toolName}</span>
                      </div>
                    </div>
                  )
                  return (
                    <ToolCard key={msg.id} toolName={toolCard.toolName} input={toolCard.input} status={toolCard.status} logs={toolCard.logs} result={toolCard.result} isExpanded={toolCard.isExpanded}
                      sessionId={sessionId}
                      onToggle={() => useMessageStore.getState().toggleToolCard(sessionId, msg.toolId)} />
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  // 纯说明文字（无工具调用，且只有一条 assistant 消息）
  if (!hasTools && assistantMsgs.length === 1 && hasText) {
    const assistantMsg = assistantMsgs[0]
    const content = (assistantMsg as { content: string }).content
    const isStreaming = streamingMessageId && assistantMsg?.id === streamingMessageId
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
  return (
    <div className="flex flex-col px-4 py-2 animate-fade-in">
      {showAvatar && (
        <div className="flex items-center gap-2 mb-2">
          <AgentAvatar />
          <span className="text-xs font-semibold text-[var(--text-secondary)] tracking-wide">知了</span>
        </div>
      )}
      <div className="ml-10 mr-6 flex flex-col gap-1.5">
        {messages.map((msg) => {
          // assistant 文字气泡
          if (msg.type === 'assistant') {
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

          // 工具调用卡片
          if (msg.type === 'tool') {
            const toolCard = toolCardsMap?.get(msg.toolId)

            if (!toolCard) {
              // 工具卡片尚未就绪（极短暂的 pending 状态）
              return (
                <div
                  key={msg.id}
                  className="tool-card-base px-3 py-2"
                >
                  <div className="flex items-center gap-2">
                    <svg
                      className="animate-spin text-amber-400 shrink-0"
                      width="11" height="11" viewBox="0 0 24 24"
                      fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
                    >
                      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                    </svg>
                    <span className="text-xs text-[var(--text-secondary)]">{msg.toolName}</span>
                  </div>
                </div>
              )
            }

            return (
              <ToolCard
                key={msg.id}
                toolName={toolCard.toolName}
                input={toolCard.input}
                status={toolCard.status}
                logs={toolCard.logs}
                result={toolCard.result}
                isExpanded={toolCard.isExpanded}
                sessionId={sessionId}
                onToggle={() =>
                  useMessageStore.getState().toggleToolCard(sessionId, msg.toolId)
                }
              />
            )
          }

          return null
        })}
      </div>
    </div>
  )
}

export default AgentTurn
