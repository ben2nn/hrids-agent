import React, { useRef, useEffect, useMemo } from 'react'
import { Box, Text, measureElement } from 'ink'
import type { DOMElement } from 'ink'
import { MessageRow } from './MessageRow.js'
import { SplashScreen } from './SplashScreen.js'
import { useScrollStore } from '../terminal/ScrollProvider.js'
import { FG } from '../terminal/theme.js'
import type { DisplayMsg } from '../app/AppState.js'

interface CardStreamProps {
  msgs: DisplayMsg[]
  cols: number
}

// ─── MeasuredCard ──────────────────────────────────────────────────────────

function MeasuredCard({ msg, cols }: { msg: DisplayMsg; cols: number }) {
  const ref = useRef<DOMElement>(null)
  const store = useScrollStore()
  const prevHeightRef = useRef(0)

  // 仅在消息内容或列宽变化时重新测量
  useEffect(() => {
    if (!ref.current) return
    const { height } = measureElement(ref.current)
    if (height > 0 && height !== prevHeightRef.current) {
      prevHeightRef.current = height
      store.registerHeight(msg.id!, height)
    }
  }, [msg.text, msg.role, cols, store, msg.id])

  return (
    <Box ref={ref} flexShrink={0}>
      {msg.role === 'splash' && msg.splashProps
        ? <SplashScreen {...msg.splashProps} cols={cols} />
        : <MessageRow msg={msg} columns={cols} />
      }
    </Box>
  )
}

// ─── CardStream ────────────────────────────────────────────────────────────

export function CardStream({ msgs, cols }: CardStreamProps) {
  const store = useScrollStore()
  const outerRef = useRef<DOMElement>(null)
  const prevOuterHeight = useRef(0)

  // 为没有 id 的消息分配稳定 id
  const indexedMsgs = useMemo(() => {
    let counter = 0
    return msgs.map(m => ({
      ...m,
      id: m.id ?? `auto-${++counter}`,
    }))
  }, [msgs])

  // 测量外层容器实际高度（仅首次和消息数/列宽变化时）
  const [outerHeight, setOuterHeight] = React.useState(0)
  useEffect(() => {
    if (!outerRef.current) return
    const { height } = measureElement(outerRef.current)
    if (height > 0 && height !== prevOuterHeight.current) {
      prevOuterHeight.current = height
      setOuterHeight(height)
    }
  }, [indexedMsgs.length, cols])

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

  // 计算视口状态（outerHeight=0 时用估算高度兜底）
  const viewport = store.getViewportState(indexedMsgs, outerHeight || 999, cols)

  // 同步 maxScroll 到 store
  useEffect(() => {
    store.setMaxScroll(viewport.maxScroll)
  }, [viewport.maxScroll, store])

  // 外层高度未测量到时，先渲染所有消息（避免空白）
  if (outerHeight === 0) {
    return (
      <Box ref={outerRef} flexDirection="column" flexGrow={1} overflow="hidden" flexShrink={0}>
        <Box flexDirection="column" flexShrink={0}>
          {indexedMsgs.map(msg => (
            <MeasuredCard key={msg.id} msg={msg} cols={cols} />
          ))}
        </Box>
      </Box>
    )
  }

  if (indexedMsgs.length === 0) return null

  // 滚动位置百分比
  const pinned = store.getState().pinned
  const scrollPct = viewport.maxScroll > 0
    ? Math.round((viewport.scrollOffset / viewport.maxScroll) * 100)
    : 100

  // 参照 DeepSeek-Reasonix：外层 overflow=hidden 裁剪，内层 marginTop=-scrollOffset 定位
  return (
    <Box ref={outerRef} flexDirection="column" flexGrow={1} overflow="hidden" flexShrink={0}>
      {/* 滚动位置指示器：仅在非自动滚动时显示 */}
      {!pinned && viewport.maxScroll > 0 && (
        <Box justifyContent="flex-end" flexShrink={0}>
          <Text color={FG.faint} dimColor>{scrollPct === 100 ? '▼' : scrollPct === 0 ? '▲' : '▌'} {scrollPct}%</Text>
        </Box>
      )}
      <Box flexDirection="column" marginTop={-viewport.scrollOffset} flexShrink={0}>
        {viewport.items.map((item, i) => {
          if (item.type === 'spacer') {
            return <Box key={`spacer-${i}`} height={item.height} flexShrink={0} />
          }
          const msg = indexedMsgs[item.index]
          return msg ? <MeasuredCard key={item.msgId} msg={msg} cols={cols} /> : null
        })}
      </Box>
    </Box>
  )
}
