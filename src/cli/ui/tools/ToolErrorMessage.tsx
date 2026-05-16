import React, { useState } from 'react'
import { Box, Text } from 'ink'
import { TONE, FG, STRIPE_BORDER } from '../terminal/theme.js'

// ─── 类型 ──────────────────────────────────────────────────────────────────

interface ToolErrorMessageProps {
  /** 工具名称 */
  toolName: string
  /** 错误消息 */
  message: string
  /** 错误详情（可选，展开时显示） */
  details?: string
  /** 最大截断行数 */
  maxLines?: number
}

// ─── 组件 ─────────────────────────────────────────────────────────────────

/**
 * 工具错误消息组件
 *
 * 显示工具执行错误，支持截断和展开详情。
 */
export function ToolErrorMessage({
  toolName,
  message,
  details,
  maxLines = 5,
}: ToolErrorMessageProps) {
  const [isExpanded, setIsExpanded] = useState(false)

  const lines = message.split('\n')
  const shouldTruncate = lines.length > maxLines && !isExpanded
  const displayLines = shouldTruncate ? lines.slice(0, maxLines) : lines

  return (
    <Box
      borderStyle={STRIPE_BORDER}
      borderColor={TONE.err}
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      paddingLeft={1}
      marginTop={1}
      width="100%"
      flexDirection="column"
    >
      {/* 错误标题 */}
      <Box>
        <Text color={TONE.err} bold>✗ </Text>
        <Text color={TONE.brand}>{toolName}</Text>
        <Text color={TONE.err}> 错误</Text>
      </Box>

      {/* 错误消息 */}
      <Box paddingLeft={2} flexDirection="column">
        {displayLines.map((line, i) => (
          <Text key={i} color="red">{line}</Text>
        ))}
      </Box>

      {/* 截断提示 */}
      {shouldTruncate && (
        <Box paddingLeft={2}>
          <Text
            color={FG.faint}
            dimColor
          >
            ... 已截断 {lines.length - maxLines} 行
          </Text>
        </Box>
      )}

      {/* 详情（展开时显示） */}
      {isExpanded && details && (
        <Box paddingLeft={2} flexDirection="column" marginTop={1}>
          <Text color={FG.faint}>─── 详情 ───</Text>
          {details.split('\n').map((line, i) => (
            <Text key={i} color={FG.sub}>{line}</Text>
          ))}
        </Box>
      )}

      {/* 展开/折叠按钮 */}
      {(lines.length > maxLines || details) && (
        <Box paddingLeft={2}>
          <Text color={FG.faint} dimColor>
            {isExpanded ? '[-] 折叠' : '[+] 展开详情'}
          </Text>
        </Box>
      )}
    </Box>
  )
}
