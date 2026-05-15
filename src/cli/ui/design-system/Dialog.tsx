import React, { type ReactNode } from 'react'
import { Box, Text } from 'ink'
import { TONE, FG } from '../theme.js'

// ─── 类型 ──────────────────────────────────────────────────────────────────

interface DialogProps {
  /** 对话框标题 */
  title: string
  /** 对话框内容 */
  children: ReactNode
  /** 宽度（百分比或固定值） */
  width?: string | number
  /** 是否显示边框 */
  bordered?: boolean
}

// ─── 组件 ─────────────────────────────────────────────────────────────────

/**
 * 基础对话框组件
 *
 * 提供统一的对话框样式，支持标题和内容。
 */
export function Dialog({
  title,
  children,
  width = '100%',
  bordered = true,
}: DialogProps) {
  return (
    <Box
      flexDirection="column"
      width={width}
      paddingX={2}
      paddingY={1}
      borderStyle={bordered ? 'double' : undefined}
      borderColor={bordered ? TONE.accent : undefined}
    >
      {/* 标题 */}
      <Box marginBottom={1}>
        <Text color={TONE.brand} bold>{title}</Text>
      </Box>

      {/* 内容 */}
      <Box flexDirection="column">
        {children}
      </Box>
    </Box>
  )
}

// ─── 对话框操作 ────────────────────────────────────────────────────────────

interface DialogActionsProps {
  /** 操作按钮 */
  actions: Array<{
    label: string
    key: string
    color?: string
  }>
}

/**
 * 对话框操作栏组件
 */
export function DialogActions({ actions }: DialogActionsProps) {
  return (
    <Box marginTop={1}>
      <Text color={FG.faint}>
        {actions.map((action, i) => (
          <React.Fragment key={action.key}>
            {i > 0 && <Text> · </Text>}
            <Text color={action.color ?? TONE.accent} bold>[{action.key}]</Text>
            <Text> {action.label}</Text>
          </React.Fragment>
        ))}
      </Text>
    </Box>
  )
}
