import React from 'react'
import { Box, Text } from 'ink'
import { TONE, FG } from '../terminal/theme.js'
import type { PermissionDecision } from './PermissionRequest.js'

// ─── 类型 ──────────────────────────────────────────────────────────────────

interface FileEditPermissionRequestProps {
  /** 文件路径 */
  filePath: string
  /** 编辑类型 */
  editType: 'create' | 'modify' | 'delete'
  /** Diff 预览 */
  diffPreview?: string
  /** 回调 */
  onDecision: (decision: PermissionDecision) => void
}

// ─── 编辑类型标签 ──────────────────────────────────────────────────────────

const EDIT_TYPE_LABEL: Record<string, { label: string; color: string }> = {
  create: { label: '创建', color: TONE.ok },
  modify: { label: '修改', color: TONE.warn },
  delete: { label: '删除', color: TONE.err },
}

// ─── 组件 ─────────────────────────────────────────────────────────────────

/**
 * 文件编辑权限请求组件
 *
 * 显示文件编辑权限请求，包含 Diff 预览。
 */
export function FileEditPermissionRequest({
  filePath,
  editType,
  diffPreview,
  onDecision,
}: FileEditPermissionRequestProps) {
  const typeInfo = EDIT_TYPE_LABEL[editType] ?? EDIT_TYPE_LABEL.modify

  return (
    <Box
      borderStyle="double"
      borderColor={typeInfo.color}
      flexDirection="column"
      paddingX={1}
      marginTop={1}
      width="100%"
    >
      {/* 标题 */}
      <Box>
        <Text color={typeInfo.color} bold>⚠ 文件编辑权限</Text>
      </Box>

      {/* 文件信息 */}
      <Box flexDirection="column" paddingLeft={1} marginTop={1}>
        <Text>
          <Text color={FG.faint}>文件: </Text>
          <Text color={TONE.accent}>{filePath}</Text>
        </Text>
        <Text>
          <Text color={FG.faint}>操作: </Text>
          <Text color={typeInfo.color} bold>{typeInfo.label}</Text>
        </Text>
      </Box>

      {/* Diff 预览 */}
      {diffPreview && (
        <Box flexDirection="column" paddingLeft={1} marginTop={1}>
          <Text color={FG.faint}>─── 预览 ───</Text>
          {diffPreview.split('\n').slice(0, 15).map((line, i) => {
            const color = line.startsWith('+') ? 'green' as const
              : line.startsWith('-') ? 'red' as const
              : line.startsWith('@') ? 'magenta' as const
              : undefined
            return <Text key={i} color={color}>{line}</Text>
          })}
          {diffPreview.split('\n').length > 15 && (
            <Text color={FG.faint}>... ({diffPreview.split('\n').length} 行)</Text>
          )}
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
