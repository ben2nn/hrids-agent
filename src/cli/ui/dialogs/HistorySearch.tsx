import React, { useState, useMemo } from 'react'
import { Box, Text, useInput } from 'ink'
import { TONE, FG } from '../terminal/theme.js'

// ─── 类型 ──────────────────────────────────────────────────────────────────

interface HistoryItem {
  id: string
  text: string
  timestamp: string
  role: 'user' | 'assistant'
}

interface HistorySearchProps {
  /** 历史记录 */
  history: HistoryItem[]
  /** 选择历史项的回调 */
  onSelect: (text: string) => void
  /** 取消回调 */
  onCancel: () => void
  /** 最大显示数量 */
  maxItems?: number
}

// ─── 组件 ─────────────────────────────────────────────────────────────────

/**
 * 历史搜索组件
 *
 * 支持模糊搜索历史记录，键盘导航和选择。
 */
export function HistorySearch({ history, onSelect, onCancel, maxItems = 10 }: HistorySearchProps) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)

  // 过滤历史记录
  const filtered = useMemo(() => {
    if (!query) return history.slice(0, maxItems)

    const lowerQuery = query.toLowerCase()
    return history
      .filter(item => item.text.toLowerCase().includes(lowerQuery))
      .slice(0, maxItems)
  }, [history, query, maxItems])

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
        onSelect(item.text)
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
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      {/* 标题 */}
      <Box marginBottom={1}>
        <Text color={TONE.brand} bold>历史搜索</Text>
        <Text color={FG.faint}> (Ctrl+R)</Text>
      </Box>

      {/* 搜索输入框 */}
      <Box marginBottom={1}>
        <Text color={FG.faint}>搜索: </Text>
        <Text color={TONE.accent}>{query}</Text>
        <Text color={FG.faint}>▏</Text>
      </Box>

      {/* 搜索结果 */}
      <Box flexDirection="column">
        {filtered.length === 0 ? (
          <Text color={FG.faint}>没有匹配的历史记录</Text>
        ) : (
          filtered.map((item, i) => (
            <Box key={item.id}>
              {/* 选中指示器 */}
              <Text color={i === selectedIndex ? TONE.accent : FG.faint}>
                {i === selectedIndex ? '▸ ' : '  '}
              </Text>

              {/* 历史内容 */}
              <Text
                color={i === selectedIndex ? TONE.accent : FG.body}
                dimColor={i !== selectedIndex}
              >
                {item.text.length > 60
                  ? item.text.slice(0, 60) + '...'
                  : item.text
                }
              </Text>
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
