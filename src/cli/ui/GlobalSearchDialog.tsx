import React, { useState, useMemo } from 'react'
import { Box, Text, useInput } from 'ink'
import { TONE, FG } from './theme.js'

// ─── 类型 ──────────────────────────────────────────────────────────────────

interface SearchResult {
  file: string
  line: number
  content: string
  context?: string
}

interface GlobalSearchDialogProps {
  /** 搜索结果 */
  results: SearchResult[]
  /** 选择结果的回调 */
  onSelect: (file: string, line: number) => void
  /** 取消回调 */
  onCancel: () => void
  /** 最大显示数量 */
  maxItems?: number
}

// ─── 组件 ─────────────────────────────────────────────────────────────────

/**
 * 全局搜索对话框
 *
 * Ctrl+Shift+F 触发，显示 ripgrep 搜索结果。
 */
export function GlobalSearchDialog({
  results,
  onSelect,
  onCancel,
  maxItems = 15,
}: GlobalSearchDialogProps) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const displayResults = results.slice(0, maxItems)

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
      setSelectedIndex(prev => Math.min(displayResults.length - 1, prev + 1))
      return
    }

    if (key.return) {
      const result = displayResults[selectedIndex]
      if (result) {
        onSelect(result.file, result.line)
      }
      return
    }
  })

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      {/* 标题 */}
      <Box marginBottom={1}>
        <Text color={TONE.brand} bold>全局搜索</Text>
        <Text color={FG.faint}> (Ctrl+Shift+F)</Text>
      </Box>

      {/* 结果统计 */}
      <Box marginBottom={1}>
        <Text color={FG.sub}>
          找到 {results.length} 个结果
          {results.length > maxItems && ` (显示前 ${maxItems} 个)`}
        </Text>
      </Box>

      {/* 结果列表 */}
      <Box flexDirection="column">
        {displayResults.length === 0 ? (
          <Text color={FG.faint}>没有搜索结果</Text>
        ) : (
          displayResults.map((result, i) => (
            <Box key={`${result.file}-${result.line}`}>
              {/* 选中指示器 */}
              <Text color={i === selectedIndex ? TONE.accent : FG.faint}>
                {i === selectedIndex ? '▸ ' : '  '}
              </Text>

              {/* 结果内容 */}
              <Box flexDirection="column">
                <Text>
                  <Text color={TONE.accent}>{result.file}</Text>
                  <Text color={FG.faint}>:{result.line}</Text>
                </Text>
                <Box paddingLeft={4}>
                  <Text color={FG.body}>{result.content}</Text>
                </Box>
                {result.context && (
                  <Box paddingLeft={4}>
                    <Text color={FG.sub} dimColor>{result.context}</Text>
                  </Box>
                )}
              </Box>
            </Box>
          ))
        )}
      </Box>

      {/* 底部提示 */}
      <Box marginTop={1}>
        <Text color={FG.faint} dimColor>
          ↑↓ 导航 · Enter 跳转 · ESC 取消
        </Text>
      </Box>
    </Box>
  )
}
