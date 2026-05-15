import React, { type ReactNode } from 'react'
import { Box } from 'ink'

// ─── 类型 ──────────────────────────────────────────────────────────────────

interface FullscreenLayoutProps {
  /** 可滚动内容（消息历史） */
  scrollable: ReactNode
  /** 底部固定内容（spinner、输入框） */
  bottom: ReactNode
  /** 状态栏 */
  statusBar?: ReactNode
  /** 覆盖层内容（权限对话框等，覆盖在滚动区域上方） */
  overlay?: ReactNode
  /** 模态内容（斜杠命令等，覆盖整个界面） */
  modal?: ReactNode
}

// ─── 组件 ─────────────────────────────────────────────────────────────────

/**
 * 全屏布局组件
 *
 * 布局结构：
 * ┌─────────────────────────────┐
 * │ scrollable (flexGrow)       │ ← 消息历史（可滚动）
 * ├─────────────────────────────┤
 * │ bottom                      │ ← 输入框、spinner
 * ├─────────────────────────────┤
 * │ statusBar                   │ ← 状态栏
 * └─────────────────────────────┘
 *
 * overlay 和 modal 会覆盖在上面
 */
export function FullscreenLayout({
  scrollable,
  bottom,
  statusBar,
  overlay,
  modal,
}: FullscreenLayoutProps) {
  // 模态优先级最高
  if (modal) {
    return (
      <Box flexDirection="column" width="100%" height="100%">
        {modal}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" width="100%" height="100%">
      {/* 可滚动区域 */}
      <Box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0}>
        {scrollable}
      </Box>

      {/* 覆盖层（如果有） */}
      {overlay && (
        <Box flexDirection="column">
          {overlay}
        </Box>
      )}

      {/* 底部固定区域 */}
      <Box flexDirection="column" flexShrink={0}>
        {bottom}
      </Box>

      {/* 状态栏 */}
      {statusBar && (
        <Box flexDirection="column" flexShrink={0}>
          {statusBar}
        </Box>
      )}
    </Box>
  )
}
