import React from 'react'
import { Box, Text } from 'ink'
import { ROLE_TONE, ROLE_GLYPH, FG, STRIPE_BORDER } from '../terminal/theme.js'
import type { MsgRole, DisplayMsg } from '../app/app-state.js'

// ─── 角色标签 ──────────────────────────────────────────────────────────────

const ROLE_LABEL: Record<MsgRole, string> = {
  user:      '你',
  assistant: '助手',
  tool:      '工具',
  system:    '系统',
  error:     '错误',
  splash:    '',
}

// ─── Props ────────────────────────────────────────────────────────────────

interface MessageRowProps {
  msg: DisplayMsg
  columns: number
  isLoading?: boolean
}

// ─── 组件 ─────────────────────────────────────────────────────────────────

function MessageRowImpl({ msg, columns, isLoading }: MessageRowProps) {
  // SplashScreen 不渲染内容（由 CardStream 内部处理）
  if (msg.role === 'splash') return null

  const tone = msg.color ?? ROLE_TONE[msg.role]
  const glyph = ROLE_GLYPH[msg.role]
  const label = ROLE_LABEL[msg.role]

  // 错误消息特殊样式
  const isError = msg.role === 'error'
  // 系统消息使用柔和颜色
  const isSystem = msg.role === 'system'

  return (
    <Box
      borderStyle={STRIPE_BORDER}
      borderColor={tone}
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      paddingLeft={1}
      width="100%"
      flexDirection="column"
    >
      {/* Header：glyph + 标签 */}
      <Box>
        <Text color={tone} bold>{glyph} </Text>
        <Text color={tone} bold>{label}</Text>
        {isLoading && msg.role === 'assistant' && (
          <Text color={FG.faint}> (流式输出中...)</Text>
        )}
      </Box>

      {/* Body：消息正文 */}
      <Box paddingLeft={2} flexDirection="column">
        {msg.text.split('\n').map((line, i) => (
          <Text
            key={i}
            color={isError ? 'red' : isSystem ? FG.sub : undefined}
          >
            {line}
          </Text>
        ))}
      </Box>
    </Box>
  )
}

export const MessageRow = React.memo(MessageRowImpl)
