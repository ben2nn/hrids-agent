import React from 'react'
import { Box, Text } from 'ink'
import { TONE, FG } from '../terminal/theme.js'
import type { Command } from '../../commands/types.js'
import { isCommandVisible, getCommandName } from '../../commands/types.js'
import { getCommandCount } from './command-stats.js'

// ─── 类型 ──────────────────────────────────────────────────────────────────

interface CommandSuggestionsProps {
  /** 所有可用命令 */
  commands: Command[]
  /** 当前过滤文本（不包含前导 /） */
  filter: string
  /** 是否可见 */
  visible: boolean
  /** 最大显示数量 */
  maxItems?: number
}

interface SuggestionItem {
  name: string
  description: string
  argumentHint?: string
  category?: string
}

// ─── 过滤和排序 ────────────────────────────────────────────────────────────

function filterCommands(commands: Command[], filter: string): SuggestionItem[] {
  const visibleCommands = commands.filter(isCommandVisible)
  const lowerFilter = filter.toLowerCase()

  // 空过滤：按使用频率排序
  if (!lowerFilter) {
    return visibleCommands
      .map(cmd => ({
        cmd,
        name: getCommandName(cmd),
        description: cmd.description,
        argumentHint: cmd.argumentHint,
        category: cmd.category,
      }))
      .sort((a, b) => getCommandCount(b.name) - getCommandCount(a.name))
      .map(({ name, description, argumentHint, category }) => ({ name, description, argumentHint, category }))
  }

  // 过滤匹配
  const matched = visibleCommands
    .map(cmd => {
      const name = getCommandName(cmd).toLowerCase()
      const aliases = cmd.aliases?.map(a => a.toLowerCase()) ?? []
      const desc = cmd.description.toLowerCase()

      // 精确前缀匹配（最高优先级）
      if (name.startsWith(lowerFilter)) {
        return { cmd, score: 3 }
      }

      // 别名前缀匹配
      if (aliases.some(a => a.startsWith(lowerFilter))) {
        return { cmd, score: 2 }
      }

      // 名称包含匹配
      if (name.includes(lowerFilter)) {
        return { cmd, score: 1 }
      }

      // 描述包含匹配（最低优先级）
      if (desc.includes(lowerFilter)) {
        return { cmd, score: 0 }
      }

      return null
    })
    .filter((item): item is { cmd: Command; score: number } => item !== null)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return getCommandCount(getCommandName(b.cmd)) - getCommandCount(getCommandName(a.cmd))
    })

  return matched.map(({ cmd }) => ({
    name: getCommandName(cmd),
    description: cmd.description,
    argumentHint: cmd.argumentHint,
    category: cmd.category,
  }))
}

// ─── 分类标签 ──────────────────────────────────────────────────────────────

const CATEGORY_LABELS: Record<string, string> = {
  builtin: '内置',
  session: '会话',
  config: '配置',
  tools: '工具',
  custom: '自定义',
}

// ─── 组件 ─────────────────────────────────────────────────────────────────

function CommandSuggestionsImpl({
  commands,
  filter,
  visible,
  maxItems = 8,
}: CommandSuggestionsProps) {
  if (!visible) return null

  const suggestions = filterCommands(commands, filter).slice(0, maxItems)

  if (suggestions.length === 0) {
    return (
      <Box paddingLeft={2} marginTop={0}>
        <Text color={FG.faint}>没有匹配的命令</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" paddingLeft={2} marginTop={0}>
      {suggestions.map((item, i) => (
        <Box key={item.name}>
          {/* 命令名 */}
          <Text color={TONE.brand} bold>
            /{item.name}
          </Text>

          {/* 参数提示 */}
          {item.argumentHint && (
            <Text color={FG.faint}> {item.argumentHint}</Text>
          )}

          {/* 分类标签 */}
          {item.category && CATEGORY_LABELS[item.category] && (
            <Text color={FG.faint}> [{CATEGORY_LABELS[item.category]}]</Text>
          )}

          {/* 描述 */}
          <Text color={FG.sub}> — {item.description}</Text>
        </Box>
      ))}
    </Box>
  )
}

export const CommandSuggestions = React.memo(CommandSuggestionsImpl)
