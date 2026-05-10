import { useRef, useEffect, useMemo } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useMessageStore } from '../../store/messageStore.js'
import { MessageItem } from './MessageItem.js'
import { AgentTurn } from './AgentTurn.js'
import type { DisplayMessage, AgentTurnData, ToolCardState } from '../../lib/types.js'

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
  | { kind: 'agent-turn'; data: AgentTurnData }
  | { kind: 'single'; message: DisplayMessage }   // system / error / compact

// ─── 工具状态判断（分组阶段用） ────────────────────────────────────────────

function isToolPending(msg: DisplayMessage, toolCardsMap: Map<string, ToolCardState> | null): boolean {
  if (msg.type !== 'tool') return false
  const card = toolCardsMap?.get(msg.toolId)
  return !card || card.status === 'pending'
}

// ─── 消息分组 + 规范化 ─────────────────────────────────────────────────────
//
// 将扁平的 DisplayMessage[] 转换为规范化的 VirtualEntry[]：
//
// - user 消息          → { kind: 'user' }，同时作为 agent-turn 的分隔边界
// - assistant / tool   → 合并为 { kind: 'agent-turn', data: AgentTurnData }
//   · processMessages  = 工具调用 + 中间说明文字（除最后一条 assistant 外的所有消息）
//   · finalMessage     = 最后一条有内容的 assistant 消息（运行中时为 null）
//   · isRunning        = 有工具处于 pending 状态，或有流式文字输出
//   · startTime/endTime 从消息时间戳推算
// - cron_trigger       → 描述附加到紧随其后的 agent-turn
// - request_start      → 跳过（不打断 agent-turn 合并）
// - compact/error/sys  → { kind: 'single' }

function groupMessages(
  messages: DisplayMessage[],
  toolCardsMap: Map<string, ToolCardState> | null,
  hasStreaming: boolean,
): VirtualEntry[] {
  const entries: VirtualEntry[] = []
  let i = 0

  // ── 将一段 assistant/tool 消息规范化为 AgentTurnData ──────────────────
  function buildAgentTurnData(
    turnMsgs: DisplayMessage[],
    cronDescription: string | undefined,
    isLastTurn: boolean,
  ): AgentTurnData {
    const assistantMsgs = turnMsgs.filter(
      (m): m is DisplayMessage & { type: 'assistant' } =>
        m.type === 'assistant' && !!(m as { content: string }).content?.trim(),
    )

    // 运行中判断：最后一个回合有 pending 工具，或有流式文字
    const running =
      isLastTurn &&
      (hasStreaming || turnMsgs.some(m => isToolPending(m, toolCardsMap)))

    // 最终报告：运行中时为 null（流式文字由外部 streamingText 传入）
    const finalMessage = running ? null : (assistantMsgs[assistantMsgs.length - 1] ?? null)

    // 过程消息：除最终报告外的所有消息
    const processMessages = finalMessage
      ? turnMsgs.filter(m => m.id !== finalMessage.id)
      : turnMsgs

    // 时间戳
    const startTime = (turnMsgs[0] as { timestamp?: number })?.timestamp ?? Date.now()
    const endTime = running
      ? undefined
      : (() => {
          const toolMsgs = turnMsgs.filter(m => m.type === 'tool')
          if (toolMsgs.length === 0) return undefined
          const allDone = toolMsgs.every(m => {
            const card = toolCardsMap?.get((m as { toolId: string }).toolId)
            return card && (card.status === 'success' || card.status === 'error' || card.status === 'denied')
          })
          if (!allDone) return undefined
          // 用最后一个工具消息的时间戳作为结束时间（更准确反映工具执行耗时）
          const lastToolMsg = toolMsgs[toolMsgs.length - 1]
          return (lastToolMsg as { timestamp?: number })?.timestamp ?? Date.now()
        })()

    return { processMessages, finalMessage, isRunning: running, startTime, endTime, cronDescription }
  }

  // ── 主循环 ────────────────────────────────────────────────────────────
  while (i < messages.length) {
    const msg = messages[i]

    // user 消息：独立条目
    if (msg.type === 'user') {
      entries.push({ kind: 'user', message: msg })
      i++
      continue
    }

    // request_start：跳过，不打断 agent-turn 合并
    if (msg.type === 'request_start') {
      i++
      continue
    }

    // cron_trigger：描述附加到紧随其后的 agent-turn
    if (msg.type === 'cron_trigger') {
      const cronDescription = msg.description
      i++
      const turnMsgs: DisplayMessage[] = []
      while (
        i < messages.length &&
        (messages[i].type === 'assistant' || messages[i].type === 'tool' || messages[i].type === 'request_start')
      ) {
        if (messages[i].type !== 'request_start') turnMsgs.push(messages[i])
        i++
      }
      if (turnMsgs.length > 0) {
        const isLast = i >= messages.length
        entries.push({ kind: 'agent-turn', data: buildAgentTurnData(turnMsgs, cronDescription, isLast) })
      }
      continue
    }

    // assistant / tool：收集整个回合
    if (msg.type === 'assistant' || msg.type === 'tool') {
      const turnMsgs: DisplayMessage[] = []
      while (
        i < messages.length &&
        (messages[i].type === 'assistant' || messages[i].type === 'tool' || messages[i].type === 'request_start')
      ) {
        if (messages[i].type !== 'request_start') turnMsgs.push(messages[i])
        i++
      }

      // 历史消息中通过 isCron 字段识别定时任务
      const isCron = turnMsgs.some(m => (m as { isCron?: boolean }).isCron)
      const cronDesc = isCron
        ? turnMsgs.reduce<string | undefined>((acc, m) => acc ?? (m as { cronDescription?: string }).cronDescription, undefined)
        : undefined

      const isLast = i >= messages.length
      entries.push({ kind: 'agent-turn', data: buildAgentTurnData(turnMsgs, cronDesc, isLast) })
      continue
    }

    // compact：归档分隔线
    if (msg.type === 'compact') {
      entries.push({ kind: 'single', message: msg })
      i++
      if (!(msg as { expanded?: boolean }).expanded) {
        const prefix = `arc-msg-${msg.id}-`
        while (i < messages.length && (messages[i].id ?? '').startsWith(prefix)) i++
      }
      continue
    }

    // system / error / 其他
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

  // ── 消息分组 + 规范化 ──────────────────────────────────────────────────
  const entries = useMemo(
    () => groupMessages(messages, toolCardsMap, hasStreaming),
    // toolCardsMap 引用稳定（Map 内部更新时 Zustand 会创建新 Map），hasStreaming 变化时重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messages, toolCardsMap, hasStreaming],
  )

  // 流式文字合并到最后一个 agent-turn（避免额外追加一个独立条目）
  const lastEntry = entries.length > 0 ? entries[entries.length - 1] : null
  const streamingMergesIntoLastTurn = hasStreaming && lastEntry?.kind === 'agent-turn'

  const totalCount = entries.length + (hasStreaming && !streamingMergesIntoLastTurn ? 1 : 0)

  // ── 虚拟滚动 ──────────────────────────────────────────────────────────
  const parentRef = useRef<HTMLDivElement>(null)
  const shouldAutoScrollRef = useRef(true)
  const isUserScrollingRef = useRef(false)

  const virtualizer = useVirtualizer({
    count: totalCount,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => {
      if (index === entries.length) return 80
      const entry = entries[index]
      if (!entry) return 60
      if (entry.kind === 'user') {
        const content = (entry.message as { content: string }).content ?? ''
        return Math.max(60, Math.ceil(content.length / 60) * 24 + 40)
      }
      if (entry.kind === 'agent-turn') {
        const { processMessages, finalMessage } = entry.data
        const toolCount = processMessages.filter(m => m.type === 'tool').length
        const finalLen = (finalMessage as { content?: string } | null)?.content?.length ?? 0
        return toolCount * 48 + Math.max(0, Math.ceil(finalLen / 80) * 24 + 60) + 60
      }
      if (entry.kind === 'single' && entry.message.type === 'compact') {
        return (entry.message as { expanded?: boolean }).expanded ? 400 : 48
      }
      return 40
    },
    overscan: 5,
  })

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

  useEffect(() => {
    if (!shouldAutoScrollRef.current) return
    if (totalCount === 0) return
    virtualizer.scrollToIndex(totalCount - 1, { align: 'end', behavior: 'smooth' })
  }, [totalCount, streamingText, virtualizer])

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

  if (totalCount === 0) return <WelcomeHint />

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

          // ── 独立流式占位（没有 agent-turn 时的纯流式输出） ────────────
          if (isStreamingItem) {
            const prevEntry = entries.length > 0 ? entries[entries.length - 1] : null
            const showAvatar = prevEntry?.kind !== 'agent-turn'
            return (
              <div
                key={virtualItem.key}
                data-index={virtualItem.index}
                ref={virtualizer.measureElement}
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${virtualItem.start}px)` }}
              >
                <div className="flex flex-col px-4 py-2 animate-fade-in">
                  {showAvatar && (
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

          // ── 头像：连续 agent-turn 只在第一个显示 ─────────────────────
          const prevEntry = virtualItem.index > 0 ? entries[virtualItem.index - 1] : null
          const showAvatar = entry.kind === 'agent-turn' && prevEntry?.kind !== 'agent-turn'

          // ── 流式文字合并到最后一个 agent-turn ────────────────────────
          const isLastEntry = virtualItem.index === entries.length - 1
          const mergedStreamingText =
            entry.kind === 'agent-turn' && isLastEntry && streamingMergesIntoLastTurn
              ? streamingText
              : undefined

          return (
            <div
              key={virtualItem.key}
              data-index={virtualItem.index}
              ref={virtualizer.measureElement}
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${virtualItem.start}px)` }}
            >
              {entry.kind === 'agent-turn' ? (
                <AgentTurn
                  data={entry.data}
                  toolCardsMap={toolCardsMap}
                  sessionId={sessionId}
                  showAvatar={showAvatar}
                  streamingText={mergedStreamingText}
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
