import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { TONE, FG } from '../theme.js'

// ─── 类型 ──────────────────────────────────────────────────────────────────

interface SelectOption {
  label: string
  value: string
  description?: string
}

interface SelectProps {
  /** 选项列表 */
  options: SelectOption[]
  /** 当前选中值 */
  value?: string
  /** 选择回调 */
  onSelect: (value: string) => void
  /** 取消回调 */
  onCancel?: () => void
  /** 是否支持多选 */
  multiSelect?: boolean
}

// ─── 组件 ─────────────────────────────────────────────────────────────────

/**
 * 选择列表组件
 *
 * 支持键盘导航和单选/多选。
 */
export function Select({
  options,
  value,
  onSelect,
  onCancel,
  multiSelect = false,
}: SelectProps) {
  const initialIndex = options.findIndex(o => o.value === value)
  const [selectedIndex, setSelectedIndex] = useState(initialIndex >= 0 ? initialIndex : 0)
  const [selectedValues, setSelectedValues] = useState<Set<string>>(
    value ? new Set([value]) : new Set()
  )

  // 键盘处理
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      onCancel?.()
      return
    }

    if (key.upArrow) {
      setSelectedIndex(prev => Math.max(0, prev - 1))
      return
    }

    if (key.downArrow) {
      setSelectedIndex(prev => Math.min(options.length - 1, prev + 1))
      return
    }

    if (key.return) {
      if (multiSelect) {
        // 多选模式：切换选中状态
        const option = options[selectedIndex]
        if (option) {
          setSelectedValues(prev => {
            const next = new Set(prev)
            if (next.has(option.value)) {
              next.delete(option.value)
            } else {
              next.add(option.value)
            }
            return next
          })
        }
      } else {
        // 单选模式：直接选择
        const option = options[selectedIndex]
        if (option) {
          onSelect(option.value)
        }
      }
      return
    }

    // 多选模式：空格键切换
    if (multiSelect && input === ' ') {
      const option = options[selectedIndex]
      if (option) {
        setSelectedValues(prev => {
          const next = new Set(prev)
          if (next.has(option.value)) {
            next.delete(option.value)
          } else {
            next.add(option.value)
          }
          return next
        })
      }
    }
  })

  return (
    <Box flexDirection="column">
      {/* 选项列表 */}
      <Box flexDirection="column">
        {options.map((option, i) => {
          const isSelected = i === selectedIndex
          const isChecked = multiSelect && selectedValues.has(option.value)

          return (
            <Box key={option.value}>
              {/* 选中指示器 */}
              <Text color={isSelected ? TONE.accent : FG.faint}>
                {isSelected ? '▸ ' : '  '}
              </Text>

              {/* 多选复选框 */}
              {multiSelect && (
                <Text color={isChecked ? TONE.ok : FG.faint}>
                  {isChecked ? '☑ ' : '☐ '}
                </Text>
              )}

              {/* 选项内容 */}
              <Box flexDirection="column">
                <Text
                  color={isSelected ? TONE.accent : FG.body}
                  bold={isSelected}
                >
                  {option.label}
                </Text>
                {option.description && (
                  <Box paddingLeft={4}>
                    <Text color={FG.sub}>{option.description}</Text>
                  </Box>
                )}
              </Box>
            </Box>
          )
        })}
      </Box>

      {/* 底部提示 */}
      <Box marginTop={1}>
        <Text color={FG.faint} dimColor>
          {multiSelect
            ? '↑↓ 导航 · Space 切换 · Enter 确认'
            : '↑↓ 导航 · Enter 选择'
          }
        </Text>
      </Box>
    </Box>
  )
}
