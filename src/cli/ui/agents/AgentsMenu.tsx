import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { TONE, FG } from '../theme.js'

// ─── 类型 ──────────────────────────────────────────────────────────────────

interface Agent {
  id: string
  name: string
  description: string
  model?: string
  isActive?: boolean
}

interface AgentsMenuProps {
  /** Agent 列表 */
  agents: Agent[]
  /** 选择 Agent 的回调 */
  onSelect: (agentId: string) => void
  /** 创建新 Agent 的回调 */
  onCreate: () => void
  /** 关闭回调 */
  onClose: () => void
}

// ─── 组件 ─────────────────────────────────────────────────────────────────

/**
 * Agent 管理主菜单
 *
 * 显示所有 Agent 列表，支持选择和创建。
 */
export function AgentsMenu({ agents, onSelect, onCreate, onClose }: AgentsMenuProps) {
  const [selectedIndex, setSelectedIndex] = useState(0)

  // 键盘处理
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      onClose()
      return
    }

    if (key.upArrow) {
      setSelectedIndex(prev => Math.max(0, prev - 1))
      return
    }

    if (key.downArrow) {
      setSelectedIndex(prev => Math.min(agents.length - 1, prev + 1))
      return
    }

    if (key.return) {
      const agent = agents[selectedIndex]
      if (agent) {
        onSelect(agent.id)
      }
      return
    }

    // 创建新 Agent
    if (input === 'n' || input === 'N') {
      onCreate()
      return
    }
  })

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      {/* 标题 */}
      <Box marginBottom={1}>
        <Text color={TONE.brand} bold>Agent 管理</Text>
        <Text color={FG.faint}> (ESC 关闭)</Text>
      </Box>

      {/* Agent 列表 */}
      <Box flexDirection="column">
        {agents.length === 0 ? (
          <Text color={FG.faint}>没有 Agent</Text>
        ) : (
          agents.map((agent, i) => (
            <Box key={agent.id}>
              {/* 选中指示器 */}
              <Text color={i === selectedIndex ? TONE.accent : FG.faint}>
                {i === selectedIndex ? '▸ ' : '  '}
              </Text>

              {/* Agent 信息 */}
              <Box flexDirection="column">
                <Text>
                  <Text
                    color={i === selectedIndex ? TONE.accent : FG.body}
                    bold={i === selectedIndex}
                  >
                    {agent.name}
                  </Text>
                  {agent.isActive && (
                    <Text color={TONE.ok}> [活跃]</Text>
                  )}
                  {agent.model && (
                    <Text color={FG.faint}> ({agent.model})</Text>
                  )}
                </Text>
                <Box paddingLeft={4}>
                  <Text color={FG.sub}>{agent.description}</Text>
                </Box>
              </Box>
            </Box>
          ))
        )}
      </Box>

      {/* 底部提示 */}
      <Box marginTop={1}>
        <Text color={FG.faint} dimColor>
          ↑↓ 导航 · Enter 选择 · N 创建新 Agent
        </Text>
      </Box>
    </Box>
  )
}
