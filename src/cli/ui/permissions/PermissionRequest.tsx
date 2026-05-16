import React from 'react'
import { Box, Text } from 'ink'
import { TONE, FG, STRIPE_BORDER } from '../terminal/theme.js'

// ─── 类型 ──────────────────────────────────────────────────────────────────

export type PermissionDecision = 'allow' | 'deny' | 'always_allow'

interface PermissionRequestProps {
  /** 工具名称 */
  toolName: string
  /** 工具输入摘要 */
  inputSummary?: string
  /** 权限描述 */
  description?: string
  /** 是否允许 "Always Allow" 选项 */
  allowAlways?: boolean
  /** 回调 */
  onDecision: (decision: PermissionDecision) => void
}

// ─── 组件 ─────────────────────────────────────────────────────────────────

/**
 * 权限请求对话框
 *
 * 显示工具权限请求，用户可以选择：
 * - Allow: 本次允许
 * - Deny: 本次拒绝
 * - Always Allow: 始终允许（可选）
 */
export function PermissionRequest({
  toolName,
  inputSummary,
  description,
  allowAlways = true,
  onDecision,
}: PermissionRequestProps) {
  return (
    <Box
      borderStyle="double"
      borderColor={TONE.warn}
      flexDirection="column"
      paddingX={1}
      marginTop={1}
      width="100%"
    >
      {/* 标题 */}
      <Box>
        <Text color={TONE.warn} bold>⚠ 权限请求</Text>
      </Box>

      {/* 工具信息 */}
      <Box flexDirection="column" paddingLeft={1} marginTop={1}>
        <Text>
          <Text color={FG.faint}>工具: </Text>
          <Text color={TONE.brand} bold>{toolName}</Text>
        </Text>

        {inputSummary && (
          <Text>
            <Text color={FG.faint}>输入: </Text>
            <Text color={FG.body}>{inputSummary}</Text>
          </Text>
        )}

        {description && (
          <Box marginTop={1}>
            <Text color={FG.sub}>{description}</Text>
          </Box>
        )}
      </Box>

      {/* 操作提示 */}
      <Box marginTop={1} flexDirection="column">
        <Text color={FG.faint}>请选择操作:</Text>
        <Box paddingLeft={2} flexDirection="column">
          <Text>
            <Text color={TONE.ok} bold>[A]</Text>
            <Text color={FG.body}> Allow</Text>
            <Text color={FG.faint}> — 本次允许</Text>
          </Text>
          <Text>
            <Text color={TONE.err} bold>[D]</Text>
            <Text color={FG.body}> Deny</Text>
            <Text color={FG.faint}> — 本次拒绝</Text>
          </Text>
          {allowAlways && (
            <Text>
              <Text color={TONE.warn} bold>[L]</Text>
              <Text color={FG.body}> Always Allow</Text>
              <Text color={FG.faint}> — 始终允许此工具</Text>
            </Text>
          )}
        </Box>
      </Box>

      {/* 按键提示 */}
      <Box marginTop={1}>
        <Text color={FG.faint} dimColor>
          按 A/D/L 选择，或 ESC 取消
        </Text>
      </Box>
    </Box>
  )
}
