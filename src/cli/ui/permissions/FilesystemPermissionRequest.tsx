import React from 'react'
import { Box, Text } from 'ink'
import { TONE, FG } from '../theme.js'
import type { PermissionDecision } from '../PermissionRequest.js'

// ─── 类型 ──────────────────────────────────────────────────────────────────

interface FilesystemPermissionRequestProps {
  /** 工具名称 */
  toolName: string
  /** 操作描述 */
  operation: string
  /** 目标路径 */
  path?: string
  /** 是否为只读操作 */
  isReadOnly?: boolean
  /** 回调 */
  onDecision: (decision: PermissionDecision) => void
}

// ─── 组件 ─────────────────────────────────────────────────────────────────

/**
 * 文件系统权限请求组件
 *
 * 显示文件系统操作权限请求（如读取、列出目录等）。
 */
export function FilesystemPermissionRequest({
  toolName,
  operation,
  path,
  isReadOnly = true,
  onDecision,
}: FilesystemPermissionRequestProps) {
  return (
    <Box
      borderStyle="double"
      borderColor={isReadOnly ? TONE.accent : TONE.warn}
      flexDirection="column"
      paddingX={1}
      marginTop={1}
      width="100%"
    >
      {/* 标题 */}
      <Box>
        <Text color={isReadOnly ? TONE.accent : TONE.warn} bold>
          {isReadOnly ? '📖 文件系统权限' : '⚠ 文件系统权限'}
        </Text>
      </Box>

      {/* 操作信息 */}
      <Box flexDirection="column" paddingLeft={1} marginTop={1}>
        <Text>
          <Text color={FG.faint}>工具: </Text>
          <Text color={TONE.brand}>{toolName}</Text>
        </Text>
        <Text>
          <Text color={FG.faint}>操作: </Text>
          <Text color={FG.body}>{operation}</Text>
        </Text>
        {path && (
          <Text>
            <Text color={FG.faint}>路径: </Text>
            <Text color={TONE.accent}>{path}</Text>
          </Text>
        )}
      </Box>

      {/* 只读提示 */}
      {isReadOnly && (
        <Box marginTop={1} paddingLeft={1}>
          <Text color={FG.sub}>此操作为只读，不会修改文件系统</Text>
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
            <Text color={FG.faint}> — 始终允许此操作</Text>
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
