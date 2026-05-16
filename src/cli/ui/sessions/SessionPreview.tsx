import React from 'react'
import { Box, Text } from 'ink'
import { TONE, FG, STRIPE_BORDER } from '../terminal/theme.js'

// ─── 类型 ──────────────────────────────────────────────────────────────────

interface Message {
  role: 'user' | 'assistant' | 'system'
  content: string
}

interface SessionPreviewProps {
  /** 会话 ID */
  sessionId: string
  /** 会话消息 */
  messages: Message[]
  /** 最大预览行数 */
  maxLines?: number
}

// ─── 组件 ─────────────────────────────────────────────────────────────────

/**
 * 会话预览组件
 *
 * 显示会话的消息历史预览。
 */
export function SessionPreview({ sessionId, messages, maxLines = 20 }: SessionPreviewProps) {
  // 计算显示的消息
  const displayMessages = messages.slice(-maxLines)
  const truncated = messages.length > maxLines

  return (
    <Box flexDirection="column">
      {/* 标题 */}
      <Box marginBottom={1}>
        <Text color={TONE.brand} bold>会话预览</Text>
        <Text color={FG.faint}> — {sessionId.slice(0, 12)}</Text>
      </Box>

      {/* 消息统计 */}
      <Box marginBottom={1}>
        <Text color={FG.sub}>
          共 {messages.length} 条消息
          {truncated && ` (显示最近 ${maxLines} 条)`}
        </Text>
      </Box>

      {/* 消息列表 */}
      <Box
        borderStyle={STRIPE_BORDER}
        borderColor={FG.faint}
        flexDirection="column"
        paddingX={1}
      >
        {displayMessages.map((msg, i) => {
          const roleColor = msg.role === 'user' ? TONE.accent
            : msg.role === 'assistant' ? TONE.brand
            : FG.sub
          const roleLabel = msg.role === 'user' ? '你'
            : msg.role === 'assistant' ? '助手'
            : '系统'

          return (
            <Box key={i} marginBottom={1}>
              {/* 角色标签 */}
              <Box width={6}>
                <Text color={roleColor} bold>{roleLabel}</Text>
              </Box>

              {/* 消息内容 */}
              <Box flexDirection="column" paddingLeft={1}>
                {msg.content.split('\n').slice(0, 3).map((line, j) => (
                  <Text key={j} color={FG.body}>
                    {line.length > 60 ? line.slice(0, 60) + '...' : line}
                  </Text>
                ))}
                {msg.content.split('\n').length > 3 && (
                  <Text color={FG.faint}>...</Text>
                )}
              </Box>
            </Box>
          )
        })}
      </Box>

      {/* 底部提示 */}
      <Box marginTop={1}>
        <Text color={FG.faint} dimColor>
          ESC 关闭预览
        </Text>
      </Box>
    </Box>
  )
}
