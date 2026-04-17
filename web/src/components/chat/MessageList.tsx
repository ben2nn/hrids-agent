import { useRef, useEffect } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useMessageStore } from '../../store/messageStore.js'
import { MessageItem } from './MessageItem.js'
import type { DisplayMessage } from '../../lib/types.js'

// ─── 稳定的空数组/空字符串默认值（避免每次渲染产生新引用） ────────────────

const EMPTY_MESSAGES: DisplayMessage[] = []
const EMPTY_STRING = ''

// ─── Props 接口 ────────────────────────────────────────────────────────────

interface MessageListProps {
  sessionId: string
}

// ─── 欢迎提示（无消息时显示） ──────────────────────────────────────────────

function WelcomeHint() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 text-center px-8 animate-fade-in">
      <div className="w-12 h-12 rounded-full overflow-hidden border border-[var(--border-subtle)]">
        <img src="/avatar.png" alt="Agent" className="w-full h-full object-cover" />
      </div>
      <div>
        <p className="text-[var(--text-primary)] text-base font-semibold mb-1.5 tracking-tight">
          开始与 Agent 对话
        </p>
        <p className="text-[var(--text-secondary)] text-sm leading-relaxed">
          在下方输入框中输入消息，Agent 将为你执行任务
        </p>
      </div>
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

// ─── MessageList 组件 ──────────────────────────────────────────────────────

export function MessageList({ sessionId }: MessageListProps) {
  // 用稳定的模块级常量作为默认值，避免每次渲染产生新引用触发无限循环
  const messages = useMessageStore((s) => s.messages.get(sessionId) ?? EMPTY_MESSAGES)
  const streamingText = useMessageStore((s) => s.streamingText.get(sessionId) ?? EMPTY_STRING)
  // toolCardsMap：直接取 Map 实例，Object.is 比较实例引用，store 替换实例时才重渲染
  const toolCardsMap = useMessageStore((s) => s.toolCards.get(sessionId) ?? null)

  // 是否有流式内容正在输出
  const hasStreaming = streamingText.length > 0

  // 虚拟滚动容器 ref
  const parentRef = useRef<HTMLDivElement>(null)

  // 用于判断是否应该自动滚底
  const shouldAutoScrollRef = useRef(true)
  const isUserScrollingRef = useRef(false)

  // 虚拟列表的总条目数：消息数 + 流式输出占位（若有）
  const totalCount = messages.length + (hasStreaming ? 1 : 0)

  // ── 虚拟滚动配置 ──────────────────────────────────────────────────────
  const virtualizer = useVirtualizer({
    count: totalCount,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => {
      if (index === messages.length) return 80
      const msg = messages[index]
      if (!msg) return 60
      switch (msg.type) {
        case 'user':
          return Math.max(60, Math.ceil((msg.content?.length ?? 0) / 60) * 24 + 40)
        case 'assistant':
          return Math.max(80, Math.ceil((msg.content?.length ?? 0) / 80) * 24 + 60)
        case 'tool':
          return 64
        case 'system':
          return 40
        case 'error':
          return 72
        default:
          return 60
      }
    },
    overscan: 5,
  })

  // ── 检测用户手动上滚，暂停自动滚底 ───────────────────────────────────
  function handleScroll() {
    const el = parentRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distanceFromBottom > 50) {
      shouldAutoScrollRef.current = false
      isUserScrollingRef.current = true
    } else {
      shouldAutoScrollRef.current = true
      isUserScrollingRef.current = false
    }
  }

  // ── 新消息或流式更新时自动滚底 ────────────────────────────────────────
  useEffect(() => {
    if (!shouldAutoScrollRef.current) return
    if (totalCount === 0) return
    virtualizer.scrollToIndex(totalCount - 1, { align: 'end', behavior: 'smooth' })
  }, [totalCount, streamingText, virtualizer])

  // ── 会话切换时重置滚动状态并滚底 ──────────────────────────────────────
  useEffect(() => {
    shouldAutoScrollRef.current = true
    isUserScrollingRef.current = false
    if (totalCount > 0) {
      requestAnimationFrame(() => {
        virtualizer.scrollToIndex(totalCount - 1, { align: 'end' })
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // ── 无消息时显示欢迎提示 ──────────────────────────────────────────────
  if (totalCount === 0) {
    return <WelcomeHint />
  }

  const virtualItems = virtualizer.getVirtualItems()

  return (
    <div
      ref={parentRef}
      className="h-full overflow-y-auto"
      onScroll={handleScroll}
      role="log"
      aria-label="消息列表"
      aria-live="polite"
    >
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualItems.map((virtualItem) => {
          const isStreamingItem = virtualItem.index === messages.length
          const msg = messages[virtualItem.index]

          // 判断是否显示头像：
          // Agent 消息（tool/assistant）在以下情况显示头像：
          //   - 是第一条消息
          //   - 前一条是 user 消息
          //   - 前一条是 system/error（忽略类型，视为新回合）
          const isAgentMsg = !isStreamingItem && (msg?.type === 'tool' || msg?.type === 'assistant')
          let showAvatar = false
          if (isAgentMsg) {
            const prevMsg = virtualItem.index > 0 ? messages[virtualItem.index - 1] : null
            showAvatar = !prevMsg || prevMsg.type === 'user' || prevMsg.type === 'system' || prevMsg.type === 'error'
          }
          // 流式消息：前一条是 user 或无消息时显示头像
          const streamingShowAvatar = isStreamingItem && (
            messages.length === 0 || messages[messages.length - 1]?.type === 'user'
          )

          return (
            <div
              key={virtualItem.key}
              data-index={virtualItem.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
              {isStreamingItem ? (
                <div className="flex flex-col px-4 py-1 animate-fade-in">
                  {streamingShowAvatar && (
                    <div className="flex items-center gap-2 mb-1.5">
                      <div className="w-8 h-8 rounded-full overflow-hidden border border-[var(--border-subtle)] shrink-0">
                        <img src="/avatar.png" alt="知了" className="w-full h-full object-cover" />
                      </div>
                      <span className="text-xs font-semibold text-[var(--text-secondary)]">知了</span>
                    </div>
                  )}
                  <div className="ml-10 w-[calc(100%-2.5rem)]">
                    <div className="bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-2xl rounded-tl-sm px-4 py-3">
                      <span className="text-[var(--text-primary)] text-sm whitespace-pre-wrap break-words leading-relaxed">
                        {streamingText}
                      </span>
                      <StreamingCursor />
                    </div>
                  </div>
                </div>
              ) : (
                <MessageItem
                  message={msg}
                  showAvatar={showAvatar}
                  toolCard={
                    msg?.type === 'tool'
                      ? toolCardsMap?.get((msg as { toolId: string }).toolId)
                      : undefined
                  }
                  onToggleToolCard={
                    msg?.type === 'tool'
                      ? () => useMessageStore.getState().toggleToolCard(
                          sessionId,
                          (msg as { toolId: string }).toolId,
                        )
                      : undefined
                  }
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default MessageList
