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
  | { kind: 'agent-turn'; messages: DisplayMessage[]; cronDescription?: string }
  | { kind: 'single'; message: DisplayMessage }   // system / error / compact
  | { kind: 'streaming' }

// ─── 消息分组逻辑 ──────────────────────────────────────────────────────────
// 将扁平的消息列表转换为虚拟列表条目，按 requestId 分组：
// - user 消息：独立条目
// - 同一 requestId 的 assistant 和 tool 消息：合并为一个 agent-turn 条目
// - cron_trigger 消息：不单独显示，将描述附加到紧随其后的 agent-turn
// - compact / error / system：独立条目

function groupMessages(messages: DisplayMessage[]): VirtualEntry[] {
  const entries: VirtualEntry[] = []
  let i = 0

  while (i < messages.length) {
    const msg = messages[i]

    // user 消息：独立条目
    if (msg.type === 'user') {
      entries.push({ kind: 'user', message: msg })
      i++
      continue
    }

    // request_start 消息：跳过，不显示
    if (msg.type === 'request_start') {
      i++
      continue
    }

    // cron_trigger 消息：记录描述，附加到下一个 agent-turn（实时消息路径）
    if (msg.type === 'cron_trigger') {
      const cronDescription = msg.description
      i++
      // 收集紧随其后同一 requestId 的 assistant/tool 消息
      if (i < messages.length && (messages[i].type === 'assistant' || messages[i].type === 'tool')) {
        const requestId = (messages[i] as { requestId?: string }).requestId
        const turnMsgs: DisplayMessage[] = []
        while (
          i < messages.length &&
          (messages[i].type === 'assistant' || messages[i].type === 'tool') &&
          (messages[i] as { requestId?: string }).requestId === requestId
        ) {
          turnMsgs.push(messages[i])
          i++
        }
        entries.push({ kind: 'agent-turn', messages: turnMsgs, cronDescription })
      }
      continue
    }

    // assistant 或 tool 消息：按 requestId 分组
    // 历史消息路径：通过消息自身的 isCron/cronDescription 字段识别定时任务
    if (msg.type === 'assistant' || msg.type === 'tool') {
      const requestId = msg.requestId
      const turnMsgs: DisplayMessage[] = []

      while (
        i < messages.length &&
        (messages[i].type === 'assistant' || messages[i].type === 'tool') &&
        (messages[i] as { requestId?: string }).requestId === requestId
      ) {
        turnMsgs.push(messages[i])
        i++
      }

      // 检测是否为 cron 触发：任意一条消息带 isCron 标记即可
      const isCron = turnMsgs.some((m) => (m as { isCron?: boolean }).isCron)
      const cronDescription = isCron
        ? turnMsgs.reduce<string | undefined>((acc, m) => {
            if (acc) return acc
            return (m as { cronDescription?: string }).cronDescription
          }, undefined)
        : undefined

      entries.push({ kind: 'agent-turn', messages: turnMsgs, ...(isCron ? { cronDescription: cronDescription ?? '' } : {}) })
      continue
    }

    // compact 消息：归档分隔线
    if (msg.type === 'compact') {
      entries.push({ kind: 'single', message: msg })
      i++
      if (!(msg as { expanded?: boolean }).expanded) {
        const prefix = `arc-msg-${msg.id}-`
        while (i < messages.length && (messages[i].id ?? '').startsWith(prefix)) {
          i++
        }
      }
      continue
    }

    // system / error / 其他 single 类型
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
  // 新逻辑：流式文字始终作为独立的新 turn，不合并到已有 turn
  // （因为 tool_start 时已经把文字切断固化了，流式缓冲里只有"当前段"的文字）
  const streamingMergesIntoLastTurn = false

  // 虚拟列表总条目数：有流式文字时追加一个独立的流式占位
  const totalCount = entries.length + (hasStreaming ? 1 : 0)

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

          // ── 独立流式占位 ──────────────────────────────────────────────
          if (isStreamingItem) {
            // 流式输出始终显示头像（独立的新回合）
            const streamingShowAvatar = true

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
              <div className="flex flex-col px-4 py-2 animate-fade-in">
                  {streamingShowAvatar && (
                    <div className="flex items-center gap-2 mb-2">
                      <div className="relative w-8 h-8 shrink-0">
                        <div className="w-8 h-8 rounded-full overflow-hidden border border-[var(--border-subtle)]">
                          <img src="/avatar.png" alt="知了" className="w-full h-full object-cover" />
                        </div>
                        <div className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 bg-amber-400 rounded-full flex items-center justify-center shadow-sm">
                          <div className="flex gap-[2px]">
                            <span className="w-[3px] h-[3px] bg-white rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                            <span className="w-[3px] h-[3px] bg-white rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                            <span className="w-[3px] h-[3px] bg-white rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                          </div>
                        </div>
                      </div>
                      <span className="text-xs font-semibold text-[var(--text-secondary)] tracking-wide">知了</span>
                    </div>
                  )}
                  <div className="ml-10 w-[calc(100%-2.5rem)] mr-6">
                    <div className="agent-bubble px-4 py-3.5">
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
          // 每个 agent-turn 都独立显示头像（不同 requestId 不合并）
          let showAvatar = false
          if (entry.kind === 'agent-turn') {
            showAvatar = true
          }

          // ── 判断是否正在运行 ────────────────────────────────────────
          // 最后一个 agent-turn 如果有流式输出或工具正在执行，则为运行中
          const isLastEntry = virtualItem.index === entries.length - 1
          const isRunning = entry.kind === 'agent-turn' && isLastEntry && (hasStreaming || (() => {
            // 检查是否有工具正在执行
            const toolMsgs = entry.messages.filter(m => m.type === 'tool')
            return toolMsgs.some(m => {
              const card = toolCardsMap?.get(m.toolId)
              return !card || card.status === 'pending'
            })
          })())

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
                  cronDescription={entry.cronDescription}
                  isRunning={isRunning}
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
