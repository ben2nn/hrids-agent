import React from 'react'
import { Box, Text } from 'ink'
import { TONE, FG } from '../theme.js'
import { TaskStatusIcon, type TaskStatus } from './TaskStatusIcon.js'

// ─── 类型 ──────────────────────────────────────────────────────────────────

interface TaskProgressProps {
  /** 任务名称 */
  name: string
  /** 任务状态 */
  status: TaskStatus
  /** 进度消息 */
  message?: string
  /** 已用时间（毫秒） */
  elapsed?: number
  /** 进度百分比（0-1） */
  progress?: number
}

// ─── 工具函数 ──────────────────────────────────────────────────────────────

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const mins = Math.floor(ms / 60000)
  const secs = Math.floor((ms % 60000) / 1000)
  return `${mins}m${secs}s`
}

// ─── 组件 ─────────────────────────────────────────────────────────────────

/**
 * 任务进度组件
 *
 * 显示单个任务的进度信息。
 */
export function TaskProgress({
  name,
  status,
  message,
  elapsed,
  progress,
}: TaskProgressProps) {
  return (
    <Box flexDirection="column">
      {/* 任务头 */}
      <Box>
        <TaskStatusIcon status={status} animated />
        <Text color={FG.body}> {name}</Text>
        {elapsed !== undefined && (
          <Text color={FG.faint}> ({formatElapsed(elapsed)})</Text>
        )}
      </Box>

      {/* 进度消息 */}
      {message && (
        <Box paddingLeft={2}>
          <Text color={FG.sub}>{message}</Text>
        </Box>
      )}

      {/* 进度条 */}
      {progress !== undefined && (
        <Box paddingLeft={2}>
          <Text color={TONE.accent}>
            {'█'.repeat(Math.round(progress * 10))}
          </Text>
          <Text color={FG.faint}>
            {'░'.repeat(10 - Math.round(progress * 10))}
          </Text>
          <Text color={FG.faint}> {(progress * 100).toFixed(0)}%</Text>
        </Box>
      )}
    </Box>
  )
}
