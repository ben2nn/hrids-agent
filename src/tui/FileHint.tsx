import React, { useState, useEffect, useCallback } from 'react'
import { Box, Text } from 'ink'
import { glob } from 'glob'
import { getGlobalCwd } from '../core/cwd.js'
import { resolve, relative } from 'path'

interface Props {
  filter: string  // 当前输入的过滤文本（去掉开头的 @）
  visible: boolean
  onSelect: (filePath: string) => void  // 选择文件后的回调
}

// 常用文件类型，优先显示
const PRIORITY_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.py', '.md', '.json', '.yaml', '.yml']

export function FileHint({ filter, visible, onSelect }: Props) {
  const [files, setFiles] = useState<string[]>([])
  const [loading, setLoading] = useState(false)

  // 搜索文件
  const searchFiles = useCallback(async (pattern: string) => {
    setLoading(true)
    try {
      const cwd = getGlobalCwd()
      // 使用 pattern 进行搜索，如果没有 filter 则显示常用文件
      const searchPattern = pattern
        ? `**/*${pattern}*`
        : '**/*'

      const results = await glob(searchPattern, {
        cwd,
        nodir: true,
        absolute: true,
        ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**'],
      })

      // 转换为相对路径并排序
      const resolvedRoot = resolve(cwd) + (process.platform === 'win32' ? '\\' : '/')
      const relativePaths = results
        .filter(f => resolve(f).startsWith(resolvedRoot))
        .map(f => relative(cwd, f).replace(/\\/g, '/'))
        .sort((a, b) => {
          // 按文件扩展名优先级排序
          const extA = a.slice(a.lastIndexOf('.'))
          const extB = b.slice(b.lastIndexOf('.'))
          const priorityA = PRIORITY_EXTENSIONS.indexOf(extA)
          const priorityB = PRIORITY_EXTENSIONS.indexOf(extB)
          if (priorityA !== -1 && priorityB !== -1) return priorityA - priorityB
          if (priorityA !== -1) return -1
          if (priorityB !== -1) return 1
          return a.localeCompare(b)
        })

      setFiles(relativePaths.slice(0, 20))  // 最多显示 20 个文件
    } catch {
      setFiles([])
    }
    setLoading(false)
  }, [])

  // 当 filter 变化时搜索文件
  useEffect(() => {
    if (visible) {
      searchFiles(filter)
    }
  }, [filter, visible, searchFiles])

  if (!visible || files.length === 0) return null

  // 根据过滤文本筛选文件
  const filtered = filter
    ? files.filter(f => f.toLowerCase().includes(filter.toLowerCase()))
    : files

  if (filtered.length === 0) return null

  // 最多显示 8 条，避免撑爆终端
  const displayed = filtered.slice(0, 8)
  const hasMore = filtered.length > 8

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text dimColor>{loading ? '搜索文件中...' : '可用文件:'}</Text>
      {displayed.map(filePath => (
        <Box key={filePath} paddingLeft={2}>
          <Text color="green">@{filePath}</Text>
        </Box>
      ))}
      {hasMore && (
        <Text dimColor>{`  ...还有 ${filtered.length - 8} 个文件`}</Text>
      )}
    </Box>
  )
}