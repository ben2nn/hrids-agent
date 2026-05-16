import React, { useState, useMemo } from 'react'
import { Box, Text, useInput } from 'ink'
import { TONE, FG } from '../terminal/theme.js'

// ─── 类型 ──────────────────────────────────────────────────────────────────

interface FuzzyItem {
  id: string
  label: string
  description?: string
}

interface FuzzyPickerProps {
  /** 可选项列表 */
  items: FuzzyItem[]
  /** 选择回调 */
  onSelect: (item: FuzzyItem) => void
  /** 取消回调 */
  onCancel: () => void
  /** 占位符 */
  placeholder?: string
  /** 最大显示数量 */
  maxItems?: number
}

// ─── 组件 ─────────────────────────────────────────────────────────────────

/**
 * 通用模糊搜索组件
 *
 * 支持实时过滤、键盘导航和选择。
 */
export function FuzzyPicker({
  items,
  onSelect,
  onCancel,
  placeholder = '搜索...',
  maxItems = 10,
}: FuzzyPickerProps) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)

  // 过滤项目
  const filtered = useMemo(() => {
    if (!query) return items.slice(0, maxItems)

    const lowerQuery = query.toLowerCase()
    return items
      .filter(item =>
        item.label.toLowerCase().includes(lowerQuery) ||
        item.description?.toLowerCase().includes(lowerQuery)
      )
      .slice(0, maxItems)
  }, [items, query, maxItems])

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
      setSelectedIndex(prev => Math.min(filtered.length - 1, prev + 1))
      return
    }

    if (key.return) {
      const item = filtered[selectedIndex]
      if (item) {
        onSelect(item)
      }
      return
    }

    // 退格键
    if (key.backspace || key.delete) {
      setQuery(prev => prev.slice(0, -1))
      setSelectedIndex(0)
      return
    }

    // 普通字符
    if (input && !key.ctrl && !key.meta) {
      setQuery(prev => prev + input)
      setSelectedIndex(0)
    }
  })

  return (
    <Box flexDirection="column">
      {/* 搜索输入框 */}
      <Box marginBottom={1}>
        <Text color={FG.faint}>{placeholder} </Text>
        <Text color={TONE.accent}>{query}</Text>
        <Text color={FG.faint}>▏</Text>
      </Box>

      {/* 结果列表 */}
      <Box flexDirection="column">
        {filtered.length === 0 ? (
          <Text color={FG.faint}>没有匹配项</Text>
        ) : (
          filtered.map((item, i) => (
            <Box key={item.id}>
              {/* 选中指示器 */}
              <Text color={i === selectedIndex ? TONE.accent : FG.faint}>
                {i === selectedIndex ? '▸ ' : '  '}
              </Text>

              {/* 项目内容 */}
              <Text
                color={i === selectedIndex ? TONE.accent : FG.body}
                bold={i === selectedIndex}
              >
                {item.label}
              </Text>
              {item.description && (
                <Text color={FG.faint}> — {item.description}</Text>
              )}
            </Box>
          ))
        )}
      </Box>

      {/* 底部提示 */}
      <Box marginTop={1}>
        <Text color={FG.faint} dimColor>
          ↑↓ 导航 · Enter 选择 · ESC 取消
        </Text>
      </Box>
    </Box>
  )
}
