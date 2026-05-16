import React from 'react'
import { Box, Text, useInput } from 'ink'
import { TONE, FG } from '../terminal/theme.js'

// ─── 类型 ──────────────────────────────────────────────────────────────────

interface Agent {
  id: string
  name: string
  description: string
  model?: string
  systemPrompt?: string
  isActive?: boolean
}

interface AgentDetailProps {
  /** Agent 信息 */
  agent: Agent
  /** 编辑回调 */
  onEdit: () => void
  /** 返回回调 */
  onBack: () => void
}

// ─── 组件 ─────────────────────────────────────────────────────────────────

/**
 * Agent 详情组件
 *
 * 显示单个 Agent 的详细信息。
 */
export function AgentDetail({ agent, onEdit, onBack }: AgentDetailProps) {
  // 键盘处理
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      onBack()
      return
    }

    if (input === 'e' || input === 'E') {
      onEdit()
      return
    }

    if (key.return) {
      onBack()
      return
    }
  })

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      {/* 标题 */}
      <Box marginBottom={1}>
        <Text color={TONE.brand} bold>Agent 详情</Text>
        <Text color={FG.faint}> (ESC 返回)</Text>
      </Box>

      {/* Agent 信息 */}
      <Box flexDirection="column" paddingLeft={1}>
        <Text>
          <Text color={FG.faint}>名称: </Text>
          <Text color={FG.body}>{agent.name}</Text>
        </Text>
        <Text>
          <Text color={FG.faint}>ID: </Text>
          <Text color={FG.body}>{agent.id}</Text>
        </Text>
        <Text>
          <Text color={FG.faint}>描述: </Text>
          <Text color={FG.body}>{agent.description}</Text>
        </Text>
        {agent.model && (
          <Text>
            <Text color={FG.faint}>模型: </Text>
            <Text color={FG.body}>{agent.model}</Text>
          </Text>
        )}
        <Text>
          <Text color={FG.faint}>状态: </Text>
          <Text color={agent.isActive ? TONE.ok : FG.body}>
            {agent.isActive ? '活跃' : '未激活'}
          </Text>
        </Text>
      </Box>

      {/* 系统提示 */}
      {agent.systemPrompt && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={TONE.brand} bold>系统提示</Text>
          <Box
            flexDirection="column"
            paddingLeft={2}
            marginTop={1}
          >
            {agent.systemPrompt.split('\n').slice(0, 10).map((line, i) => (
              <Text key={i} color={FG.sub}>{line}</Text>
            ))}
            {agent.systemPrompt.split('\n').length > 10 && (
              <Text color={FG.faint}>...</Text>
            )}
          </Box>
        </Box>
      )}

      {/* 底部提示 */}
      <Box marginTop={1}>
        <Text color={FG.faint} dimColor>
          E 编辑 · ESC 返回
        </Text>
      </Box>
    </Box>
  )
}
