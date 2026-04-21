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
// 工具卡片在上，说明文字在下，视觉上与 Kiro 保持一致。

export function AgentTurn({ messages, toolCardsMap, sessionId, showAvatar, streamingMessageId }: AgentTurnProps) {
  const toolMsgs = messages.filter((m) => m.type === 'tool')
  const assistantMsg = messages.find((m) => m.type === 'assistant')

  const hasTools = toolMsgs.length > 0
  const hasText = !!assistantMsg && (assistantMsg as { content: string }).content?.trim().length > 0

  // 纯说明文字（无工具调用）
  if (!hasTools && hasText) {
    const content = (assistantMsg as { content: string }).content
    const isStreaming = streamingMessageId && assistantMsg?.id === streamingMessageId
    return (
      <div className="flex flex-col px-4 py-1 animate-fade-in">
        {showAvatar && (
          <div className="flex items-center gap-2 mb-1.5">
            <AgentAvatar />
            <span className="text-xs font-semibold text-[var(--text-secondary)]">知了</span>
          </div>
        )}
        <div className="ml-10 mr-10">
          <div className="bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-2xl rounded-tl-sm px-4 py-3">
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

  // 纯工具调用（无说明文字）或工具 + 说明文字
  return (
    <div className="flex flex-col px-4 py-1 animate-fade-in">
      {showAvatar && (
        <div className="flex items-center gap-2 mb-1.5">
          <AgentAvatar />
          <span className="text-xs font-semibold text-[var(--text-secondary)]">知了</span>
        </div>
      )}
      <div className="ml-10 mr-10 flex flex-col gap-1">
        {/* 工具调用卡片列表 */}
        {toolMsgs.map((msg) => {
          if (msg.type !== 'tool') return null
          const toolCard = toolCardsMap?.get(msg.toolId)

          if (!toolCard) {
            // 工具卡片尚未就绪（极短暂的 pending 状态）
            return (
              <div
                key={msg.id}
                className="bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-xl px-3 py-2"
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
              onToggle={() =>
                useMessageStore.getState().toggleToolCard(sessionId, msg.toolId)
              }
            />
          )
        })}

        {/* 说明文字（紧接在工具卡片下方） */}
        {hasText && (() => {
          const content = (assistantMsg as { content: string }).content
          const isStreaming = streamingMessageId && assistantMsg?.id === streamingMessageId
          return (
            <div className="bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-2xl rounded-tl-sm px-4 py-3 mt-0.5">
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
        })()}
      </div>
    </div>
  )
}

export default AgentTurn
