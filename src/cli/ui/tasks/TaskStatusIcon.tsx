import React from 'react'
import { Text } from 'ink'
import { TONE, FG } from '../terminal/theme.js'

// ─── 类型 ──────────────────────────────────────────────────────────────────

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'canceled'

interface TaskStatusIconProps {
  /** 任务状态 */
  status: TaskStatus
  /** 是否显示动画 */
  animated?: boolean
}

// ─── 状态图标 ──────────────────────────────────────────────────────────────

const STATUS_GLYPH: Record<TaskStatus, string> = {
  pending: '○',
  running: '◐',
  completed: '✓',
  failed: '✗',
  canceled: '⊘',
}

const STATUS_COLOR: Record<TaskStatus, string> = {
  pending: FG.faint,
  running: TONE.warn,
  completed: TONE.ok,
  failed: TONE.err,
  canceled: FG.faint,
}

// ─── 组件 ─────────────────────────────────────────────────────────────────

/**
 * 任务状态图标组件
 *
 * 显示任务状态的图标和颜色。
 */
export function TaskStatusIcon({ status, animated = false }: TaskStatusIconProps) {
  const [frame, setFrame] = React.useState(0)

  // 动画效果（仅 running 状态）
  React.useEffect(() => {
    if (!animated || status !== 'running') return

    const frames = ['◐', '◓', '◑', '◒']
    const timer = setInterval(() => {
      setFrame(prev => (prev + 1) % frames.length)
    }, 80)
    return () => clearInterval(timer)
  }, [animated, status])

  const glyph = animated && status === 'running'
    ? ['◐', '◓', '◑', '◒'][frame]
    : STATUS_GLYPH[status]

  return (
    <Text color={STATUS_COLOR[status]}>
      {glyph}
    </Text>
  )
}
