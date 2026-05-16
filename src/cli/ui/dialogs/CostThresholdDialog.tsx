import React from 'react'
import { Box, Text, useInput } from 'ink'
import { TONE, FG, STRIPE_BORDER } from '../terminal/theme.js'

// ─── 类型 ──────────────────────────────────────────────────────────────────

interface CostThresholdDialogProps {
  /** 当前花费 */
  currentCost: number
  /** 阈值 */
  threshold: number
  /** 继续回调 */
  onContinue: () => void
  /** 停止回调 */
  onStop: () => void
}

// ─── 组件 ─────────────────────────────────────────────────────────────────

/**
 * 成本阈值警告对话框
 *
 * 当花费超过阈值时显示警告。
 */
export function CostThresholdDialog({
  currentCost,
  threshold,
  onContinue,
  onStop,
}: CostThresholdDialogProps) {
  // 键盘处理
  useInput((input, key) => {
    if (key.escape || input === 'n' || input === 'N') {
      onStop()
      return
    }

    if (key.return || input === 'y' || input === 'Y') {
      onContinue()
      return
    }
  })

  return (
    <Box
      borderStyle="double"
      borderColor={TONE.warn}
      flexDirection="column"
      paddingX={2}
      paddingY={1}
      marginTop={1}
      width="100%"
    >
      {/* 标题 */}
      <Box>
        <Text color={TONE.warn} bold>⚠ 成本警告</Text>
      </Box>

      {/* 成本信息 */}
      <Box flexDirection="column" paddingLeft={1} marginTop={1}>
        <Text>
          <Text color={FG.faint}>当前花费: </Text>
          <Text color={TONE.accent} bold>${currentCost.toFixed(4)}</Text>
        </Text>
        <Text>
          <Text color={FG.faint}>警告阈值: </Text>
          <Text color={FG.body}>${threshold.toFixed(2)}</Text>
        </Text>
      </Box>

      {/* 警告消息 */}
      <Box marginTop={1} paddingLeft={1}>
        <Text color={TONE.warn}>
          您的花费已超过设定阈值，是否继续？
        </Text>
      </Box>

      {/* 操作提示 */}
      <Box marginTop={1} flexDirection="column">
        <Text color={FG.faint}>请选择操作:</Text>
        <Box paddingLeft={2} flexDirection="column">
          <Text>
            <Text color={TONE.ok} bold>[Y]</Text>
            <Text color={FG.body}> Continue</Text>
            <Text color={FG.faint}> — 继续执行</Text>
          </Text>
          <Text>
            <Text color={TONE.err} bold>[N]</Text>
            <Text color={FG.body}> Stop</Text>
            <Text color={FG.faint}> — 停止执行</Text>
          </Text>
        </Box>
      </Box>

      {/* 按键提示 */}
      <Box marginTop={1}>
        <Text color={FG.faint} dimColor>
          按 Y/N 选择
        </Text>
      </Box>
    </Box>
  )
}
