import React from 'react'
import { Box, Text } from 'ink'
import type { SlashCommand } from '../../core/CommandRegistry.js'

interface Props {
  commands: SlashCommand[]
  filter: string  // 当前输入的过滤文本（去掉开头的 /）
  visible: boolean
}

export function CommandHint({ commands, filter, visible }: Props) {
  if (!visible || commands.length === 0) return null

  // 根据过滤文本筛选命令
  const filtered = filter
    ? commands.filter(c => c.name.startsWith(filter.toLowerCase()))
    : commands

  if (filtered.length === 0) return null

  // 最多显示 8 条，避免撑爆终端
  const displayed = filtered.slice(0, 8)
  const hasMore = filtered.length > 8

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text dimColor>可用命令:</Text>
      {displayed.map(cmd => (
        <Box key={cmd.name} paddingLeft={2}>
          <Text color="cyan">{`/${cmd.name}`}</Text>
          {cmd.argumentHint && (
            <Text dimColor>{` ${cmd.argumentHint}`}</Text>
          )}
          <Text dimColor>{`  —  ${cmd.description}`}</Text>
        </Box>
      ))}
      {hasMore && (
        <Text dimColor>{`  ...还有 ${filtered.length - 8} 个命令`}</Text>
      )}
    </Box>
  )
}