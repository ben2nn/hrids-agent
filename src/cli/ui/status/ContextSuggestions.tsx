import React from 'react'
import { Box, Text } from 'ink'
import { TONE, FG } from './theme.js'

// ─── 类型 ──────────────────────────────────────────────────────────────────

interface ContextSuggestionsProps {
  /** 上下文使用率（0-1） */
  usage: number
  /** 建议操作的回调 */
  onAction?: (action: string) => void
}

interface Suggestion {
  action: string
  label: string
  description: string
}

// ─── 建议列表 ──────────────────────────────────────────────────────────────

function getSuggestions(usage: number): Suggestion[] {
  const suggestions: Suggestion[] = []

  if (usage > 0.5) {
    suggestions.push({
      action: 'compact',
      label: '压缩历史',
      description: '使用 /compact 命令压缩历史消息',
    })
  }

  if (usage > 0.7) {
    suggestions.push({
      action: 'new-session',
      label: '开新会话',
      description: '使用 /new 命令创建新会话',
    })
  }

  if (usage > 0.9) {
    suggestions.push({
      action: 'clear',
      label: '清空历史',
      description: '使用 /clear 命令清空历史消息',
    })
  }

  return suggestions
}

// ─── 组件 ─────────────────────────────────────────────────────────────────

/**
 * 上下文优化建议组件
 *
 * 根据上下文使用率提供优化建议。
 */
export function ContextSuggestions({ usage, onAction }: ContextSuggestionsProps) {
  const suggestions = getSuggestions(usage)

  if (suggestions.length === 0) {
    return null
  }

  return (
    <Box flexDirection="column">
      {/* 标题 */}
      <Box marginBottom={1}>
        <Text color={TONE.warn} bold>优化建议</Text>
      </Box>

      {/* 建议列表 */}
      <Box flexDirection="column" paddingLeft={1}>
        {suggestions.map((suggestion) => (
          <Box key={suggestion.action} marginBottom={1}>
            <Text color={TONE.accent}>• </Text>
            <Text
              color={TONE.accent}
              bold
            >
              {suggestion.label}
            </Text>
            <Text color={FG.faint}> — {suggestion.description}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  )
}
