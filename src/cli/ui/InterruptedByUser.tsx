import React from 'react'
import { Box, Text } from 'ink'
import { TONE, FG, STRIPE_BORDER } from './theme.js'

// ─── 类型 ──────────────────────────────────────────────────────────────────

interface InterruptedByUserProps {
  /** 中断时正在执行的任务描述 */
  taskDescription?: string
  /** 用户输入新指令后的回调 */
  onContinue?: () => void
}

// ─── 组件 ─────────────────────────────────────────────────────────────────

/**
 * 用户中断提示组件
 *
 * 当用户按 Ctrl+C 中断正在执行的任务时显示。
 * 提示用户可以输入新指令或继续。
 */
export function InterruptedByUser({ taskDescription }: InterruptedByUserProps) {
  return (
    <Box
      borderStyle={STRIPE_BORDER}
      borderColor={TONE.warn}
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      paddingLeft={1}
      marginTop={1}
      width="100%"
      flexDirection="column"
    >
      {/* 中断提示 */}
      <Box>
        <Text color={TONE.warn} bold>⚠ 任务已中断</Text>
      </Box>

      {/* 任务描述 */}
      {taskDescription && (
        <Box paddingLeft={2}>
          <Text color={FG.sub}>中断的任务: {taskDescription}</Text>
        </Box>
      )}

      {/* 操作提示 */}
      <Box paddingLeft={2} marginTop={1}>
        <Text color={FG.body}>
          输入新指令继续，或按
          <Text color={TONE.accent} bold> Ctrl+C </Text>
          退出
        </Text>
      </Box>
    </Box>
  )
}
