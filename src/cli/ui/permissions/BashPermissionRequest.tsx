import React from 'react'
import { Box, Text } from 'ink'
import { TONE, FG } from '../theme.js'
import type { PermissionDecision } from '../PermissionRequest.js'

// ─── 类型 ──────────────────────────────────────────────────────────────────

interface BashPermissionRequestProps {
  /** 要执行的命令 */
  command: string
  /** 命令描述 */
  description?: string
  /** 是否为危险命令 */
  isDangerous?: boolean
  /** 回调 */
  onDecision: (decision: PermissionDecision) => void
}

// ─── 组件 ─────────────────────────────────────────────────────────────────

/**
 * Bash 命令权限请求组件
 *
 * 显示命令执行权限请求，危险命令会有特殊警告。
 */
export function BashPermissionRequest({
  command,
  description,
  isDangerous = false,
  onDecision,
}: BashPermissionRequestProps) {
  return (
    <Box
      borderStyle="double"
      borderColor={isDangerous ? TONE.err : TONE.warn}
      flexDirection="column"
      paddingX={1}
      marginTop={1}
      width="100%"
    >
      {/* 标题 */}
      <Box>
        <Text color={isDangerous ? TONE.err : TONE.warn} bold>
          {isDangerous ? '⚠ 危险命令' : '⚠ 命令执行权限'}
        </Text>
      </Box>

      {/* 命令内容 */}
      <Box flexDirection="column" paddingLeft={1} marginTop={1}>
        <Text>
          <Text color={FG.faint}>命令: </Text>
          <Text color={TONE.accent} bold>$ {command}</Text>
        </Text>

        {description && (
          <Box marginTop={1}>
            <Text color={FG.sub}>{description}</Text>
          </Box>
        )}
      </Box>

      {/* 危险警告 */}
      {isDangerous && (
        <Box marginTop={1} paddingLeft={1}>
          <Text color={TONE.err}>
            ⚠ 此命令可能修改文件系统或执行不可逆操作
          </Text>
        </Box>
      )}

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
          <Text>
            <Text color={TONE.warn} bold>[L]</Text>
            <Text color={FG.body}> Always Allow</Text>
            <Text color={FG.faint}> — 始终允许此命令</Text>
          </Text>
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
