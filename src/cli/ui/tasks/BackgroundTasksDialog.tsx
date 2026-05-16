import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { TONE, FG } from '../terminal/theme.js'
import { TaskProgress } from './TaskProgress.js'
import type { TaskStatus } from './TaskStatusIcon.js'

// ─── 类型 ──────────────────────────────────────────────────────────────────

interface Task {
  id: string
  name: string
  status: TaskStatus
  message?: string
  elapsed?: number
  progress?: number
}

interface BackgroundTasksDialogProps {
  /** 任务列表 */
  tasks: Task[]
  /** 关闭回调 */
  onClose: () => void
  /** 取消任务回调 */
  onCancelTask?: (taskId: string) => void
}

// ─── 组件 ─────────────────────────────────────────────────────────────────

/**
 * 后台任务对话框
 *
 * 显示所有后台任务的状态和进度。
 */
export function BackgroundTasksDialog({
  tasks,
  onClose,
  onCancelTask,
}: BackgroundTasksDialogProps) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [viewMode, setViewMode] = useState<'list' | 'detail'>('list')

  // 键盘处理
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      onClose()
      return
    }

    if (viewMode === 'list') {
      if (key.upArrow) {
        setSelectedIndex(prev => Math.max(0, prev - 1))
        return
      }

      if (key.downArrow) {
        setSelectedIndex(prev => Math.min(tasks.length - 1, prev + 1))
        return
      }

      if (key.return) {
        setViewMode('detail')
        return
      }

      // 取消任务
      if (input === 'x' || input === 'X') {
        const task = tasks[selectedIndex]
        if (task && onCancelTask) {
          onCancelTask(task.id)
        }
        return
      }
    }

    if (viewMode === 'detail') {
      if (key.escape || key.return) {
        setViewMode('list')
        return
      }
    }
  })

  const selectedTask = tasks[selectedIndex]

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      {/* 标题 */}
      <Box marginBottom={1}>
        <Text color={TONE.brand} bold>后台任务</Text>
        <Text color={FG.faint}> (ESC 关闭)</Text>
      </Box>

      {viewMode === 'list' ? (
        <>
          {/* 任务列表 */}
          <Box flexDirection="column">
            {tasks.length === 0 ? (
              <Text color={FG.faint}>没有后台任务</Text>
            ) : (
              tasks.map((task, i) => (
                <Box key={task.id}>
                  {/* 选中指示器 */}
                  <Text color={i === selectedIndex ? TONE.accent : FG.faint}>
                    {i === selectedIndex ? '▸ ' : '  '}
                  </Text>

                  {/* 任务信息 */}
                  <TaskProgress
                    name={task.name}
                    status={task.status}
                    message={task.message}
                    elapsed={task.elapsed}
                    progress={task.progress}
                  />
                </Box>
              ))
            )}
          </Box>

          {/* 底部提示 */}
          <Box marginTop={1}>
            <Text color={FG.faint} dimColor>
              ↑↓ 导航 · Enter 详情 · X 取消任务
            </Text>
          </Box>
        </>
      ) : (
        /* 任务详情 */
        selectedTask && (
          <Box flexDirection="column">
            <Box marginBottom={1}>
              <Text color={TONE.brand} bold>任务详情</Text>
            </Box>

            <Box flexDirection="column" paddingLeft={2}>
              <Text>
                <Text color={FG.faint}>ID: </Text>
                <Text color={FG.body}>{selectedTask.id}</Text>
              </Text>
              <Text>
                <Text color={FG.faint}>名称: </Text>
                <Text color={FG.body}>{selectedTask.name}</Text>
              </Text>
              <Text>
                <Text color={FG.faint}>状态: </Text>
                <Text color={FG.body}>{selectedTask.status}</Text>
              </Text>
              {selectedTask.message && (
                <Text>
                  <Text color={FG.faint}>消息: </Text>
                  <Text color={FG.body}>{selectedTask.message}</Text>
                </Text>
              )}
            </Box>

            <Box marginTop={1}>
              <Text color={FG.faint} dimColor>
                ESC 或 Enter 返回列表
              </Text>
            </Box>
          </Box>
        )
      )}
    </Box>
  )
}
