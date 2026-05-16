import React, { useState, useEffect, useRef } from 'react'
import { Box, Text, useInput } from 'ink'
import { TONE, FG, STRIPE_BORDER } from './theme.js'
import type { SessionMeta } from '../../core/SessionStore.js'

// ─── 类型 ──────────────────────────────────────────────────────────────────

interface SessionListProps {
  /** 会话列表 */
  sessions: SessionMeta[]
  /** 每页显示数量 */
  pageSize?: number
  /** 选择回调 */
  onSelect: (sessionId: string) => void
  /** 取消回调 */
  onCancel: () => void
}

// ─── 组件 ─────────────────────────────────────────────────────────────────

/**
 * 会话列表组件
 *
 * 支持上下导航、翻页、选择会话
 */
export function SessionList({
  sessions,
  pageSize = 5,
  onSelect,
  onCancel,
}: SessionListProps) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [pageOffset, setPageOffset] = useState(0)
  const inputReadyRef = useRef(false)

  // 延迟接受输入，避免处理提交 "sessions" 时缓冲的 Enter 按键
  useEffect(() => {
    const timer = setTimeout(() => { inputReadyRef.current = true }, 50)
    return () => clearTimeout(timer)
  }, [])

  // 计算总页数
  const totalPages = Math.ceil(sessions.length / pageSize)
  const currentPage = Math.floor(pageOffset / pageSize)

  // 获取当前页的会话
  const pageSessions = sessions.slice(pageOffset, pageOffset + pageSize)

  // 键盘事件处理
  useInput((input, key) => {
    if (!inputReadyRef.current) return
    if (key.upArrow) {
      setSelectedIndex(prev => {
        if (prev === 0) {
          // 如果已经在第一项，尝试翻到上一页
          if (pageOffset > 0) {
            setPageOffset(pageOffset - pageSize)
            return pageSize - 1
          }
          return 0
        }
        return prev - 1
      })
    } else if (key.downArrow) {
      setSelectedIndex(prev => {
        if (prev === pageSessions.length - 1) {
          // 如果已经在最后一项，尝试翻到下一页
          if (pageOffset + pageSize < sessions.length) {
            setPageOffset(pageOffset + pageSize)
            return 0
          }
          return prev
        }
        return prev + 1
      })
    } else if (key.pageUp) {
      // 上一页
      setPageOffset(prev => Math.max(0, prev - pageSize))
      setSelectedIndex(0)
    } else if (key.pageDown) {
      // 下一页
      setPageOffset(prev => {
        const nextOffset = prev + pageSize
        return nextOffset < sessions.length ? nextOffset : prev
      })
      setSelectedIndex(0)
    } else if (key.return) {
      // 选择当前会话
      const session = pageSessions[selectedIndex]
      if (session) {
        onSelect(session.id)
      }
    } else if (key.escape) {
      onCancel()
    }
  })

  // 格式化日期
  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)
    const diffDays = Math.floor(diffMs / 86400000)

    if (diffMins < 1) return '刚刚'
    if (diffMins < 60) return `${diffMins} 分钟前`
    if (diffHours < 24) return `${diffHours} 小时前`
    if (diffDays < 7) return `${diffDays} 天前`
    return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
  }

  // 截断文本
  const truncate = (text: string, maxLen: number) => {
    if (text.length <= maxLen) return text
    return text.slice(0, maxLen - 3) + '...'
  }

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={TONE.accent} paddingX={1}>
      {/* 标题 */}
      <Box justifyContent="space-between">
        <Text color={TONE.accent} bold>📋 会话列表</Text>
        <Text color={FG.faint}>
          {sessions.length} 个会话 · {currentPage + 1}/{totalPages} 页
        </Text>
      </Box>

      {/* 分隔线 */}
      <Text color={FG.faint}>{'─'.repeat(50)}</Text>

      {/* 会话列表 */}
      <Box flexDirection="column">
        {pageSessions.map((session, index) => {
          const isSelected = index === selectedIndex
          const marker = isSelected ? '▸ ' : '  '
          const titleColor = isSelected ? TONE.ok : FG.body
          const metaColor = isSelected ? FG.body : FG.sub

          return (
            <Box key={session.id}>
              <Text color={isSelected ? TONE.ok : FG.faint}>{marker}</Text>
              <Box flexDirection="column" flexGrow={1}>
                <Text color={titleColor} bold>
                  {truncate(session.title || '新对话', 36)}
                  <Text color={metaColor}> {formatDate(session.updatedAt)}</Text>
                </Text>
                <Text color={metaColor}>
                  {session.messageCount}条 · {session.model || '未知'}
                </Text>
              </Box>
            </Box>
          )
        })}
      </Box>

      {/* 分隔线 */}
      <Text color={FG.faint}>{'─'.repeat(50)}</Text>

      {/* 操作提示 */}
      <Text color={FG.faint} dimColor>
        ↑↓ 导航 · PgUp/PgDn 翻页 · Enter 选择 · Esc 取消
      </Text>
    </Box>
  )
}
