import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { TONE, FG } from './theme.js'

// ─── 类型 ──────────────────────────────────────────────────────────────────

interface Session {
  id: string
  createdAt: string
  messageCount?: number
  lastMessage?: string
}

interface ResumeSessionProps {
  /** 可恢复的会话列表 */
  sessions: Session[]
  /** 选择会话的回调 */
  onSelect: (sessionId: string) => void
  /** 取消回调 */
  onCancel: () => void
}

// ─── 工具函数 ──────────────────────────────────────────────────────────────

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMins / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffMins < 1) return '刚刚'
  if (diffMins < 60) return `${diffMins} 分钟前`
  if (diffHours < 24) return `${diffHours} 小时前`
  if (diffDays < 7) return `${diffDays} 天前`
  return date.toLocaleDateString()
}

// ─── 组件 ─────────────────────────────────────────────────────────────────

/**
 * 会话恢复列表组件
 *
 * 显示可恢复的历史会话列表，支持键盘导航和选择。
 */
export function ResumeSession({ sessions, onSelect, onCancel }: ResumeSessionProps) {
  const [selectedIndex, setSelectedIndex] = useState(0)

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
      setSelectedIndex(prev => Math.min(sessions.length - 1, prev + 1))
      return
    }

    if (key.return) {
      const session = sessions[selectedIndex]
      if (session) {
        onSelect(session.id)
      }
      return
    }
  })

  if (sessions.length === 0) {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text color={FG.faint}>没有可恢复的会话</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      {/* 标题 */}
      <Box marginBottom={1}>
        <Text color={TONE.brand} bold>恢复会话</Text>
        <Text color={FG.faint}> (↑↓ 导航，Enter 选择，ESC 取消)</Text>
      </Box>

      {/* 会话列表 */}
      <Box flexDirection="column">
        {sessions.map((session, i) => (
          <Box key={session.id}>
            {/* 选中指示器 */}
            <Text color={i === selectedIndex ? TONE.accent : FG.faint}>
              {i === selectedIndex ? '▸ ' : '  '}
            </Text>

            {/* 会话信息 */}
            <Box flexDirection="column">
              <Text>
                <Text color={i === selectedIndex ? TONE.accent : FG.body} bold>
                  {session.id.slice(0, 12)}
                </Text>
                <Text color={FG.faint}> · {formatRelativeTime(session.createdAt)}</Text>
                {session.messageCount !== undefined && (
                  <Text color={FG.faint}> · {session.messageCount} 消息</Text>
                )}
              </Text>

              {/* 最后一条消息预览 */}
              {session.lastMessage && (
                <Box paddingLeft={4}>
                  <Text color={FG.sub} dimColor>
                    {session.lastMessage.length > 60
                      ? session.lastMessage.slice(0, 60) + '...'
                      : session.lastMessage
                    }
                  </Text>
                </Box>
              )}
            </Box>
          </Box>
        ))}
      </Box>

      {/* 底部提示 */}
      <Box marginTop={1}>
        <Text color={FG.faint} dimColor>
          共 {sessions.length} 个会话
        </Text>
      </Box>
    </Box>
  )
}
