import React from 'react'
import { Box, Text } from 'ink'
import { TONE, FG } from '../terminal/theme.js'
import type { CostInfo } from '../app/AppState.js'

// ─── 类型 ──────────────────────────────────────────────────────────────────

interface StatusNoticesProps {
  sessionId: string
  messageCount: number
  providerName: string
  model: string
  costInfo: CostInfo | null
  loading: boolean
  stderrOutput?: string
  statusBarContent?: string
  cols?: number
}

// ─── 组件 ─────────────────────────────────────────────────────────────────

function StatusNoticesImpl({
  sessionId,
  messageCount,
  providerName,
  model,
  costInfo,
  loading,
  stderrOutput,
  statusBarContent,
  cols = 90,
}: StatusNoticesProps) {
  const separatorLen = Math.min(cols, 90)
  return (
    <Box flexDirection="column">
      {/* 分隔线 */}
      <Box marginTop={0}>
        <Text color={FG.faint}>{'─'.repeat(separatorLen)}</Text>
      </Box>

      {/* 状态栏 */}
      <Box marginTop={0}>
        <Text color={FG.meta}>
          {/* 会话信息 */}
          <Text color={FG.faint}>会话: </Text>
          <Text color={TONE.accent}>{sessionId}</Text>
          {messageCount > 1 && (
            <>
              <Text color={FG.faint}> · </Text>
              <Text>{messageCount} 消息</Text>
            </>
          )}

          {/* Provider/Model */}
          <Text color={FG.faint}> | </Text>
          {providerName}
          <Text color={FG.faint}> · </Text>
          <Text color={TONE.brand}>{model}</Text>

          {/* 成本信息 */}
          {costInfo && (
            <>
              <Text color={FG.faint}> | </Text>
              <Text color={TONE.accent}>▸ ${costInfo.costUsd.toFixed(4)}</Text>
              <Text color={FG.faint}> · </Text>
              <Text>{costInfo.inputTokens.toLocaleString()} in / {costInfo.outputTokens.toLocaleString()} out</Text>
            </>
          )}

          {/* 加载状态 */}
          <Text color={FG.faint}> | </Text>
          <Text color={loading ? TONE.warn : FG.faint}>
            {loading ? '◐ Ctrl+C 中断' : 'Ctrl+C 退出'}
          </Text>
        </Text>
      </Box>

      {/* stderr 输出 */}
      {stderrOutput && (
        <Box marginTop={0}>
          <Text color={FG.faint}>⚠ {stderrOutput}</Text>
        </Box>
      )}

      {/* 状态栏下方的交互信息 */}
      {statusBarContent && (
        <Box flexDirection="column" marginTop={0}>
          {statusBarContent.split('\n').map((line, i) => (
            <Text key={i} color={FG.sub}>{line}</Text>
          ))}
        </Box>
      )}
    </Box>
  )
}

export const StatusNotices = React.memo(StatusNoticesImpl)
