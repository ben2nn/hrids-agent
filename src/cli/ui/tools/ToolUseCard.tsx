import React from 'react'
import { Box, Text } from 'ink'
import { TONE, FG, STRIPE_BORDER } from '../terminal/theme.js'

// ─── 类型 ──────────────────────────────────────────────────────────────────

export type ToolStatus = 'pending' | 'running' | 'success' | 'error' | 'rejected'

interface ToolUseCardProps {
  name: string
  input?: string
  output?: string
  status: ToolStatus
  elapsed?: number  // 毫秒
}

// ─── 状态图标 ──────────────────────────────────────────────────────────────

const STATUS_GLYPH: Record<ToolStatus, string> = {
  pending:  '○',
  running:  '◐',
  success:  '✓',
  error:    '✗',
  rejected: '⊘',
}

const STATUS_COLOR: Record<ToolStatus, string> = {
  pending:  FG.faint,
  running:  TONE.warn,
  success:  TONE.ok,
  error:    TONE.err,
  rejected: TONE.err,
}

// ─── 组件 ─────────────────────────────────────────────────────────────────

function ToolUseCardImpl({ name, input, output, status, elapsed }: ToolUseCardProps) {
  const glyph = STATUS_GLYPH[status]
  const color = STATUS_COLOR[status]
  const isRunning = status === 'running'

  const formatElapsed = (ms?: number) => {
    if (ms === undefined) return ''
    if (ms < 1000) return `${ms}ms`
    return `${(ms / 1000).toFixed(1)}s`
  }

  return (
    <Box
      borderStyle={STRIPE_BORDER}
      borderColor={color}
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      paddingLeft={1}
      marginTop={0}
      width="100%"
      flexDirection="column"
    >
      {/* Header：工具名 + 状态 + 耗时 */}
      <Box>
        <Text color={color} bold>{glyph} </Text>
        <Text color={TONE.brand} bold>{name}</Text>
        {elapsed !== undefined && (
          <Text color={FG.faint}> ({formatElapsed(elapsed)})</Text>
        )}
        {isRunning && (
          <Text color={TONE.warn}> 执行中...</Text>
        )}
      </Box>

      {/* 输入 */}
      {input && (
        <Box paddingLeft={2}>
          <Text color={FG.sub} dimColor>{input}</Text>
        </Box>
      )}

      {/* 输出 */}
      {output && (
        <Box paddingLeft={2} flexDirection="column" marginTop={1}>
          <Text color={FG.faint}>─── 输出 ───</Text>
          {output.split('\n').map((line, i) => (
            <Text key={i} color={FG.body}>{line}</Text>
          ))}
        </Box>
      )}
    </Box>
  )
}

export const ToolUseCard = React.memo(ToolUseCardImpl)
