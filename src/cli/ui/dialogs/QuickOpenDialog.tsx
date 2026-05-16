import React, { useState, useMemo } from 'react'
import { Box, Text, useInput } from 'ink'
import { TONE, FG } from '../terminal/theme.js'

// ─── 类型 ──────────────────────────────────────────────────────────────────

interface FileItem {
  path: string
  name: string
  directory: string
}

interface QuickOpenDialogProps {
  /** 文件列表 */
  files: FileItem[]
  /** 选择文件的回调 */
  onSelect: (filePath: string) => void
  /** 取消回调 */
  onCancel: () => void
  /** 最大显示数量 */
  maxItems?: number
}

// ─── 组件 ─────────────────────────────────────────────────────────────────

/**
 * 快速打开文件对话框
 *
 * Ctrl+Shift+P 触发，支持模糊搜索文件。
 */
export function QuickOpenDialog({
  files,
  onSelect,
  onCancel,
  maxItems = 10,
}: QuickOpenDialogProps) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)

  // 过滤文件
  const filtered = useMemo(() => {
    if (!query) return files.slice(0, maxItems)

    const lowerQuery = query.toLowerCase()
    return files
      .filter(file =>
        file.name.toLowerCase().includes(lowerQuery) ||
        file.path.toLowerCase().includes(lowerQuery)
      )
      .slice(0, maxItems)
  }, [files, query, maxItems])

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
      const file = filtered[selectedIndex]
      if (file) {
        onSelect(file.path)
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
        <Text color={TONE.brand} bold>快速打开</Text>
        <Text color={FG.faint}> (Ctrl+Shift+P)</Text>
      </Box>

      {/* 搜索输入框 */}
      <Box marginBottom={1}>
        <Text color={FG.faint}>文件: </Text>
        <Text color={TONE.accent}>{query}</Text>
        <Text color={FG.faint}>▏</Text>
      </Box>

      {/* 文件列表 */}
      <Box flexDirection="column">
        {filtered.length === 0 ? (
          <Text color={FG.faint}>没有匹配的文件</Text>
        ) : (
          filtered.map((file, i) => (
            <Box key={file.path}>
              {/* 选中指示器 */}
              <Text color={i === selectedIndex ? TONE.accent : FG.faint}>
                {i === selectedIndex ? '▸ ' : '  '}
              </Text>

              {/* 文件信息 */}
              <Box flexDirection="column">
                <Text
                  color={i === selectedIndex ? TONE.accent : FG.body}
                  bold={i === selectedIndex}
                >
                  {file.name}
                </Text>
                <Box paddingLeft={4}>
                  <Text color={FG.sub}>{file.directory}</Text>
                </Box>
              </Box>
            </Box>
          ))
        )}
      </Box>

      {/* 底部提示 */}
      <Box marginTop={1}>
        <Text color={FG.faint} dimColor>
          ↑↓ 导航 · Enter 打开 · ESC 取消
        </Text>
      </Box>
    </Box>
  )
}
