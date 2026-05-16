// MessageCard —— 卡片式消息组件（左侧竖条 + glyph + header）
import React from 'react'
import { Box, Text } from 'ink'
import { ROLE_TONE, ROLE_GLYPH, FG, STRIPE_BORDER } from '../terminal/theme.js'

export type MessageRole = 'user' | 'assistant' | 'tool' | 'system' | 'error'

interface MessageCardProps {
  role: MessageRole
  text: string
  color?: string
  /** 是否为活跃状态（显示竖条边框），默认 false（扁平显示） */
  active?: boolean
}

const ROLE_LABEL: Record<MessageRole, string> = {
  user:      '你',
  assistant: '助手',
  tool:      '工具',
  system:    '系统',
  error:     '错误',
}

export function MessageCard({ role, text, color, active = false }: MessageCardProps) {
  const tone = color ?? ROLE_TONE[role]
  const glyph = ROLE_GLYPH[role]
  const label = ROLE_LABEL[role]

  const content = (
    <Box flexDirection="column">
      {/* Header 行：glyph + 标签 */}
      <Box>
        <Text color={tone} bold>{glyph} </Text>
        <Text color={tone} bold>{label}</Text>
      </Box>
      {/* Body：消息正文，缩进对齐 */}
      <Box paddingLeft={2} flexDirection="column">
        {text.split('\n').map((line, i) => (
          <Text key={i} color={role === 'error' ? 'red' : role === 'system' ? FG.sub : undefined}>
            {line}
          </Text>
        ))}
      </Box>
    </Box>
  )

  // 活跃卡片：左侧竖条边框；非活跃：扁平显示
  if (active) {
    return (
      <Box
        borderStyle={STRIPE_BORDER}
        borderColor={tone}
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        paddingLeft={1}
        marginTop={1}
        width="100%"
      >
        {content}
      </Box>
    )
  }

  return (
    <Box marginTop={0} paddingLeft={0}>
      {content}
    </Box>
  )
}
