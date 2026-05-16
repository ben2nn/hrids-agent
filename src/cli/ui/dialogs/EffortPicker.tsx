import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { TONE, FG } from './theme.js'

// ─── 类型 ──────────────────────────────────────────────────────────────────

export type EffortLevel = 'low' | 'medium' | 'high'

interface EffortOption {
  level: EffortLevel
  label: string
  description: string
}

interface EffortPickerProps {
  /** 当前 Effort 级别 */
  currentEffort: EffortLevel
  /** 选择回调 */
  onSelect: (effort: EffortLevel) => void
  /** 取消回调 */
  onCancel: () => void
}

// ─── 常量 ──────────────────────────────────────────────────────────────────

const EFFORT_OPTIONS: EffortOption[] = [
  {
    level: 'low',
    label: 'Low',
    description: '快速响应，较少思考',
  },
  {
    level: 'medium',
    label: 'Medium',
    description: '平衡速度和质量',
  },
  {
    level: 'high',
    label: 'High',
    description: '深度思考，高质量输出',
  },
]

// ─── 组件 ─────────────────────────────────────────────────────────────────

/**
 * Effort 级别选择器
 *
 * 选择 AI 的思考深度级别。
 */
export function EffortPicker({ currentEffort, onSelect, onCancel }: EffortPickerProps) {
  const initialIndex = EFFORT_OPTIONS.findIndex(o => o.level === currentEffort)
  const [selectedIndex, setSelectedIndex] = useState(initialIndex >= 0 ? initialIndex : 1)

  // 键盘处理
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      onCancel()
      return
    }

    if (key.upArrow) {
      setSelectedIndex(prev => Math.max(0, prev - 1))
      return
    }

    if (key.downArrow) {
      setSelectedIndex(prev => Math.min(EFFORT_OPTIONS.length - 1, prev + 1))
      return
    }

    if (key.return) {
      const option = EFFORT_OPTIONS[selectedIndex]
      if (option) {
        onSelect(option.level)
      }
      return
    }
  })

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      {/* 标题 */}
      <Box marginBottom={1}>
        <Text color={TONE.brand} bold>选择 Effort 级别</Text>
        <Text color={FG.faint}> (↑↓ 导航，Enter 选择，ESC 取消)</Text>
      </Box>

      {/* 选项列表 */}
      <Box flexDirection="column">
        {EFFORT_OPTIONS.map((option, i) => (
          <Box key={option.level}>
            {/* 选中指示器 */}
            <Text color={i === selectedIndex ? TONE.accent : FG.faint}>
              {i === selectedIndex ? '▸ ' : '  '}
            </Text>

            {/* 选项信息 */}
            <Box flexDirection="column">
              <Text>
                <Text
                  color={i === selectedIndex ? TONE.accent : FG.body}
                  bold={i === selectedIndex}
                >
                  {option.label}
                </Text>
                {option.level === currentEffort && (
                  <Text color={TONE.accent}> [当前]</Text>
                )}
              </Text>
              <Box paddingLeft={4}>
                <Text color={FG.sub}>{option.description}</Text>
              </Box>
            </Box>
          </Box>
        ))}
      </Box>

      {/* 底部提示 */}
      <Box marginTop={1}>
        <Text color={FG.faint} dimColor>
          Effort 级别影响 AI 的思考深度和响应时间
        </Text>
      </Box>
    </Box>
  )
}
