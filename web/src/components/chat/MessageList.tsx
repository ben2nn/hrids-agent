import { useRef, useEffect, useMemo } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useMessageStore } from '../../store/messageStore.js'
import { MessageItem } from './MessageItem.js'
import { AgentTurn } from './AgentTurn.js'
import type { DisplayMessage } from '../../lib/types.js'

// ─── 稳定的空数组/空字符串默认值（避免每次渲染产生新引用） ────────────────

const EMPTY_MESSAGES: DisplayMessage[] = []
const EMPTY_STRING = ''

// ─── Props 接口 ────────────────────────────────────────────────────────────

interface MessageListProps {
  sessionId: string
}

// ─── 虚拟列表条目类型 ──────────────────────────────────────────────────────

type VirtualEntry =
  | { kind: 'user'; message: DisplayMessage }
  | { kind: 'agent-turn'; messages: DisplayMessage[] }
  | { kind: 'single'; message: DisplayMessage }   // system / error / compact
  | { kind: 'streaming' }

// ─── 消息分组逻辑 ──────────────────────────────────────────────────────────
// 将扁平的消息列表转换为虚拟列表条目：
// - user 消息：独立条目
// - 连续的 tool / assistant 消息：合并为一个 agent-turn 条目
// - system / error / compact：独立条目（不渲染或特殊渲染）

function groupMessages(messages: DisplayMessage[]): VirtualEntry[] {
  const entries: VirtualEntry[] = []
  let i = 0

  while (i < messages.length) {
    const msg = messages[i]

    if (msg.type === 'user') {
      entries.push({ kind: 'user', message: msg })
      i++
      continue
    }

    if (msg.type === 'tool' || msg.type === 'assistant') {
      // 收集连续的 tool / assistant 消息作为一个 agent 回合
      const turnMsgs: DisplayMessage[] = []
      while (
        i < messages.length &&
        (messages[i].type === 'tool' || messages[i].type === 'assistant')
      ) {
        turnMsgs.push(messages[i])
        i++
      }
      entries.push({ kind: 'agent-turn', messages: turnMsgs })
      continue
    }

    // system / error / compact
    entries.push({ kind: 'single', message: msg })
    i++
  }

  return entries
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
  const messages = useMessageStore((s) => s.messages.get(sessionId) ?? EMPTY_MESSAGES)
  const streamingText = useMessageStore((s) => s.streamingText.get(sessionId) ?? EMPTY_STRING)
  const toolCardsMap = useMessageStore((s) => s.toolCards.get(sessionId) ?? null)

  const hasStreaming = streamingText.length > 0

  // ── 消息分组 ──────────────────────────────────────────────────────────
  // 将扁平消息列表转换为虚拟列表条目（合并 agent 回合）
  const entries = useMemo(() => groupMessages(messages), [messages])

  // 判断流式输出是否应该合并到最后一个 agent-turn 里
  const lastEntry = entries.length > 0 ? entries[entries.length - 1] : null
  const streamingMergesIntoLastTurn = hasStreaming && lastEntry?.kind === 'agent-turn'

  // 虚拟列表总条目数：
  // - 流式合并到最后一个 agent-turn：条目数不变（流式占位替换最后一个 agent-turn）
  // - 否则：条目数 + 1（独立的流式占位）
  const totalCount = streamingMergesIntoLastTurn
    ? entries.length          // 最后一个 agent-turn 会被流式版本替换
    : entries.length + (hasStreaming ? 1 : 0)

  // 虚拟滚动容器 ref
  const parentRef = useRef<HTMLDivElement>(null)

  // 用于判断是否应该自动滚底
  const shouldAutoScrollRef = useRef(true)
  const isUserScrollingRef = useRef(false)

  // ── 虚拟滚动配置 ──────────────────────────────────────────────────────
  const virtualizer = useVirtualizer({
    count: totalCount,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => {
      if (index === entries.length) return 80  // 流式占位
      const entry = entries[index]
      if (!entry) return 60

      if (entry.kind === 'user') {
        const content = (entry.message as { content: string }).content ?? ''
        return Math.max(60, Math.ceil(content.length / 60) * 24 + 40)
      }
      if (entry.kind === 'agent-turn') {
        // 工具数 * 48 + 可选说明文字高度
        const toolCount = entry.messages.filter((m) => m.type === 'tool').length
        const assistantMsg = entry.messages.find((m) => m.type === 'assistant')
        const textHeight = assistantMsg
          ? Math.max(80, Math.ceil(((assistantMsg as { content: string }).content?.length ?? 0) / 80) * 24 + 60)
          : 0
        return toolCount * 48 + textHeight + 40
      }
      if (entry.kind === 'single') {
        if (entry.message.type === 'compact') {
          return (entry.message as { expanded?: boolean }).expanded ? 400 : 48
        }
        return 40
      }
      return 60
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
          const isStreamingItem = !streamingMergesIntoLastTurn && virtualItem.index === entries.length
          const entry = entries[virtualItem.index]

          // ── 独立流式占位（前面没有 agent-turn 可合并） ──────────────
          if (isStreamingItem) {
            const lastEnt = entries.length > 0 ? entries[entries.length - 1] : null
            const streamingShowAvatar = !lastEnt || lastEnt.kind === 'user'

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
              </div>
            )
          }

          if (!entry) return null

          // ── 判断是否显示头像 ────────────────────────────────────────
          let showAvatar = false
          if (entry.kind === 'agent-turn') {
            const prevEntry = virtualItem.index > 0 ? entries[virtualItem.index - 1] : null
            showAvatar = !prevEntry || prevEntry.kind === 'user' || prevEntry.kind === 'single'
          }

          // ── 最后一个 agent-turn + 流式合并：把流式文字附加进去渲染 ──
          const isLastTurnWithStreaming =
            streamingMergesIntoLastTurn &&
            entry.kind === 'agent-turn' &&
            virtualItem.index === entries.length - 1

          if (isLastTurnWithStreaming && entry.kind === 'agent-turn') {
            const streamingAsAssistant: DisplayMessage = {
              id: '__streaming__',
              type: 'assistant',
              content: streamingText,
              timestamp: Date.now(),
            }
            const mergedMessages = [...entry.messages, streamingAsAssistant]

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
                <AgentTurn
                  messages={mergedMessages}
                  toolCardsMap={toolCardsMap}
                  sessionId={sessionId}
                  showAvatar={showAvatar}
                  streamingMessageId="__streaming__"
                />
              </div>
            )
          }

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
              {entry.kind === 'agent-turn' ? (
                <AgentTurn
                  messages={entry.messages}
                  toolCardsMap={toolCardsMap}
                  sessionId={sessionId}
                  showAvatar={showAvatar}
                />
              ) : (entry.kind === 'user' || entry.kind === 'single') ? (
                <MessageItem
                  message={entry.message}
                  showAvatar={false}
                  sessionId={sessionId}
                />
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default MessageList
