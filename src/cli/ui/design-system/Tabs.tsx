import React from 'react'
import { Box, Text, useInput } from 'ink'
import { TONE, FG } from '../theme.js'

// ─── 类型 ──────────────────────────────────────────────────────────────────

interface Tab {
  id: string
  label: string
}

interface TabsProps {
  /** 标签列表 */
  tabs: Tab[]
  /** 当前激活的标签 ID */
  activeTab: string
  /** 标签切换回调 */
  onChange: (tabId: string) => void
}

// ─── 组件 ─────────────────────────────────────────────────────────────────

/**
 * Tab 导航组件
 *
 * 支持键盘导航和 Tab 切换。
 */
export function Tabs({ tabs, activeTab, onChange }: TabsProps) {
  // 键盘处理
  useInput((input, key) => {
    if (key.tab) {
      const currentIndex = tabs.findIndex(t => t.id === activeTab)
      const nextIndex = (currentIndex + 1) % tabs.length
      onChange(tabs[nextIndex].id)
      return
    }

    // Shift+Tab 反向切换
    if (key.shift && key.tab) {
      const currentIndex = tabs.findIndex(t => t.id === activeTab)
      const prevIndex = (currentIndex - 1 + tabs.length) % tabs.length
      onChange(tabs[prevIndex].id)
      return
    }
  })

  return (
    <Box>
      {tabs.map((tab, i) => (
        <Box key={tab.id} marginRight={2}>
          <Text
            color={tab.id === activeTab ? TONE.brand : FG.faint}
            bold={tab.id === activeTab}
            underline={tab.id === activeTab}
          >
            {tab.label}
          </Text>
        </Box>
      ))}
    </Box>
  )
}
