import React from 'react'
import { Box, Text } from 'ink'
import { TONE, FG } from '../terminal/theme.js'

// ─── 类型 ──────────────────────────────────────────────────────────────────

interface ToolCanceledMessageProps {
  /** 工具名称 */
  toolName: string
  /** 取消原因 */
  reason?: string
}

// ─── 组件 ─────────────────────────────────────────────────────────────────

/**
 * 工具取消消息组件
 *
 * 当工具执行被取消时显示（如用户拒绝权限）。
 */
export function ToolCanceledMessage({ toolName, reason }: ToolCanceledMessageProps) {
  return (
    <Box marginTop={0} paddingLeft={0}>
      <Text color={FG.faint}>
        <Text color={TONE.warn}>⊘ </Text>
        <Text color={TONE.brand}>{toolName}</Text>
        <Text> 已取消</Text>
        {reason && <Text> — {reason}</Text>}
      </Text>
    </Box>
  )
}
