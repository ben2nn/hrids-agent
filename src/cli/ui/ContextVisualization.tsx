import React from 'react'
import { Box, Text } from 'ink'
import { TONE, FG } from './theme.js'

// ─── 类型 ──────────────────────────────────────────────────────────────────

interface ContextVisualizationProps {
  /** 已使用的 tokens */
  usedTokens: number
  /** 总 tokens 上限 */
  totalTokens: number
  /** 消息数量 */
  messageCount: number
}

// ─── 组件 ─────────────────────────────────────────────────────────────────

/**
 * 上下文使用率可视化组件
 *
 * 显示上下文窗口的使用情况。
 */
export function ContextVisualization({
  usedTokens,
  totalTokens,
  messageCount,
}: ContextVisualizationProps) {
  const usage = totalTokens > 0 ? usedTokens / totalTokens : 0
  const percent = Math.min(1, usage) * 100
  const width = 20
  const filled = Math.round(usage * width)

  // 根据使用率选择颜色
  const barColor = usage < 0.5 ? TONE.ok
    : usage < 0.8 ? TONE.warn
    : TONE.err

  return (
    <Box flexDirection="column">
      {/* 标题 */}
      <Box marginBottom={1}>
        <Text color={TONE.brand} bold>上下文使用率</Text>
      </Box>

      {/* 进度条 */}
      <Box>
        <Text color={barColor}>{'█'.repeat(filled)}</Text>
        <Text color={FG.faint}>{'░'.repeat(width - filled)}</Text>
        <Text color={FG.faint}> {percent.toFixed(0)}%</Text>
      </Box>

      {/* 详细信息 */}
      <Box flexDirection="column" paddingLeft={1} marginTop={1}>
        <Text>
          <Text color={FG.faint}>已使用: </Text>
          <Text color={FG.body}>{usedTokens.toLocaleString()} tokens</Text>
        </Text>
        <Text>
          <Text color={FG.faint}>上限: </Text>
          <Text color={FG.body}>{totalTokens.toLocaleString()} tokens</Text>
        </Text>
        <Text>
          <Text color={FG.faint}>消息数: </Text>
          <Text color={FG.body}>{messageCount}</Text>
        </Text>
      </Box>

      {/* 警告 */}
      {usage > 0.8 && (
        <Box marginTop={1}>
          <Text color={TONE.warn}>
            ⚠ 上下文使用率较高，建议压缩历史或开新会话
          </Text>
        </Box>
      )}
    </Box>
  )
}
