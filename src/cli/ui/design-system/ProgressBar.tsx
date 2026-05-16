import React from 'react'
import { Box, Text } from 'ink'
import { TONE, FG } from '../terminal/theme.js'

// ─── 类型 ──────────────────────────────────────────────────────────────────

interface ProgressBarProps {
  /** 进度值（0-1） */
  value: number
  /** 宽度（字符数） */
  width?: number
  /** 显示百分比 */
  showPercent?: boolean
  /** 标签 */
  label?: string
}

// ─── 组件 ─────────────────────────────────────────────────────────────────

/**
 * 进度条组件
 *
 * 显示进度条和可选的百分比。
 */
export function ProgressBar({
  value,
  width = 20,
  showPercent = true,
  label,
}: ProgressBarProps) {
  const percent = Math.max(0, Math.min(1, value))
  const filled = Math.round(percent * width)
  const empty = width - filled

  return (
    <Box>
      {label && (
        <Text color={FG.body}>{label} </Text>
      )}
      <Text color={TONE.accent}>{'█'.repeat(filled)}</Text>
      <Text color={FG.faint}>{'░'.repeat(empty)}</Text>
      {showPercent && (
        <Text color={FG.faint}> {(percent * 100).toFixed(0)}%</Text>
      )}
    </Box>
  )
}
