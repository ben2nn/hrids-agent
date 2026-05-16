import React from 'react'
import { Box, Text } from 'ink'
import { TONE, FG } from '../terminal/theme.js'

// ─── 类型 ──────────────────────────────────────────────────────────────────

interface LoadingStateProps {
  /** 加载消息 */
  message?: string
  /** 加载类型 */
  variant?: 'spinner' | 'dots' | 'bar'
}

// ─── 动画帧 ────────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ['◐', '◓', '◑', '◒']
const DOTS_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

// ─── 组件 ─────────────────────────────────────────────────────────────────

/**
 * 加载状态组件
 *
 * 显示加载动画和消息。
 */
export function LoadingState({
  message = '加载中...',
  variant = 'spinner',
}: LoadingStateProps) {
  const [frame, setFrame] = React.useState(0)

  React.useEffect(() => {
    const frames = variant === 'dots' ? DOTS_FRAMES : SPINNER_FRAMES
    const timer = setInterval(() => {
      setFrame(prev => (prev + 1) % frames.length)
    }, 80)
    return () => clearInterval(timer)
  }, [variant])

  const frames = variant === 'dots' ? DOTS_FRAMES : SPINNER_FRAMES

  return (
    <Box>
      <Text color={TONE.brand}>{frames[frame]}</Text>
      <Text color={FG.sub}> {message}</Text>
    </Box>
  )
}
