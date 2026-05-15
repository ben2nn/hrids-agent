import React, { useRef, useEffect, useMemo } from 'react'
import { Box, measureElement } from 'ink'
import type { DOMElement } from 'ink'
import { MessageCard } from './MessageCard.js'
import type { MessageRole } from './MessageCard.js'
import { useScrollStore } from './ScrollProvider.js'

// ─── 类型 ──────────────────────────────────────────────────────────────────

interface DisplayMsg {
  id?: string
  role: string
  text: string
  color?: string
}

interface CardStreamProps {
  msgs: DisplayMsg[]
  viewportHeight: number
  cols: number
}

// ─── MeasuredCard ──────────────────────────────────────────────────────────

function MeasuredCard({ msg }: { msg: DisplayMsg }) {
  const ref = useRef<DOMElement>(null)
  const store = useScrollStore()
  const prevHeightRef = useRef(0)

  useEffect(() => {
    if (!ref.current) return
    const { height } = measureElement(ref.current)
    if (height > 0 && height !== prevHeightRef.current) {
      prevHeightRef.current = height
      store.registerHeight(msg.id!, height)
    }
  })

  return (
    <Box ref={ref} flexShrink={0} marginBottom={1}>
      <MessageCard
        role={msg.role as MessageRole}
        text={msg.text}
        color={msg.color}
      />
    </Box>
  )
}

// ─── CardStream ────────────────────────────────────────────────────────────

export function CardStream({ msgs, viewportHeight, cols }: CardStreamProps) {
  const store = useScrollStore()

  // 为没有 id 的消息分配稳定 id
  const indexedMsgs = useMemo(() => {
    let counter = 0
    return msgs.map(m => ({
      ...m,
      id: m.id ?? `auto-${++counter}`,
    }))
  }, [msgs])

  // 订阅滚动状态（仅用于触发重渲染）
  const scrollVersion = React.useSyncExternalStore(
    store.subscribe,
    () => store.getState().scrollVersion,
  )

  // 剪枝已移除消息的高度缓存
  useEffect(() => {
    const liveIds = new Set(indexedMsgs.map(m => m.id!))
    store.pruneHeights(liveIds)
  }, [indexedMsgs, store])

  // 计算视口状态
  const viewport = store.getViewportState(indexedMsgs, viewportHeight, cols)

  // 同步 maxScroll 到 store
  useEffect(() => {
    store.setMaxScroll(viewport.maxScroll)
  }, [viewport.maxScroll, store])

  const visibleMsgs = indexedMsgs.slice(viewport.startIndex, viewport.endIndex)

  if (indexedMsgs.length === 0) return null

  return (
    <Box height={viewportHeight} overflow="hidden" flexDirection="column" flexShrink={0}>
      <Box flexDirection="column" marginTop={viewport.marginTop} flexShrink={0}>
        {/* 上方不可见区域占位 */}
        {viewport.topSpacer > 0 && <Box height={viewport.topSpacer} flexShrink={0} />}
        {/* 可见卡片 */}
        {visibleMsgs.map(msg => (
          <MeasuredCard key={msg.id} msg={msg} />
        ))}
        {/* 下方不可见区域占位 */}
        {viewport.bottomSpacer > 0 && <Box height={viewport.bottomSpacer} flexShrink={0} />}
      </Box>
    </Box>
  )
}
