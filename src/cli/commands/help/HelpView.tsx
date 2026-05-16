import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { TONE, FG } from '../../ui/terminal/theme.js'
import type { Command } from '../types.js'
import { isCommandVisible, getCommandName } from '../types.js'

// ─── 类型 ──────────────────────────────────────────────────────────────────

interface HelpViewProps {
  /** 所有可用命令 */
  commands: Command[]
  /** 关闭回调 */
  onClose: () => void
}

type Tab = 'general' | 'commands' | 'custom'

// ─── 组件 ─────────────────────────────────────────────────────────────────

export function HelpView({ commands, onClose }: HelpViewProps) {
  const [activeTab, setActiveTab] = useState<Tab>('commands')

  // 键盘处理
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      onClose()
      return
    }

    // Tab 切换
    if (key.tab) {
      const tabs: Tab[] = ['general', 'commands', 'custom']
      const currentIndex = tabs.indexOf(activeTab)
      const nextIndex = (currentIndex + 1) % tabs.length
      setActiveTab(tabs[nextIndex])
    }
  })

  // 按分类分组命令
  const visibleCommands = commands.filter(isCommandVisible)
  const grouped = {
    builtin: visibleCommands.filter(c => !c.category || c.category === 'builtin'),
    session: visibleCommands.filter(c => c.category === 'session'),
    config: visibleCommands.filter(c => c.category === 'config'),
    tools: visibleCommands.filter(c => c.category === 'tools'),
    custom: visibleCommands.filter(c => c.category === 'custom'),
  }

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      {/* 标题 */}
      <Box marginBottom={1}>
        <Text color={TONE.brand} bold>帮助</Text>
        <Text color={FG.faint}> (Tab 切换标签，ESC 关闭)</Text>
      </Box>

      {/* 标签栏 */}
      <Box marginBottom={1}>
        {(['general', 'commands', 'custom'] as Tab[]).map(tab => (
          <Box key={tab} marginRight={2}>
            <Text
              color={activeTab === tab ? TONE.brand : FG.faint}
              bold={activeTab === tab}
              underline={activeTab === tab}
            >
              {tab === 'general' ? '通用' : tab === 'commands' ? '命令' : '自定义'}
            </Text>
          </Box>
        ))}
      </Box>

      {/* 内容 */}
      <Box flexDirection="column">
        {activeTab === 'general' && (
          <GeneralHelp />
        )}

        {activeTab === 'commands' && (
          <CommandsHelp grouped={grouped} />
        )}

        {activeTab === 'custom' && (
          <CustomHelp />
        )}
      </Box>
    </Box>
  )
}

// ─── 通用帮助 ──────────────────────────────────────────────────────────────

function GeneralHelp() {
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text color={TONE.brand} bold>快捷键</Text>
      </Box>
      <Box flexDirection="column" paddingLeft={2}>
        <HelpItem shortcut="Ctrl+C" description="中断当前任务 / 退出" />
        <HelpItem shortcut="Ctrl+L" description="清屏" />
        <HelpItem shortcut="PageUp/Down" description="滚动消息历史" />
        <HelpItem shortcut="↑/↓" description="浏览输入历史" />
        <HelpItem shortcut="Tab" description="自动补全" />
        <HelpItem shortcut="ESC" description="关闭对话框" />
      </Box>

      <Box marginTop={1} marginBottom={1}>
        <Text color={TONE.brand} bold>输入格式</Text>
      </Box>
      <Box flexDirection="column" paddingLeft={2}>
        <Text color={FG.body}>• 普通文本 — 发送给 AI 助手</Text>
        <Text color={FG.body}>• /命令 — 执行斜杠命令</Text>
        <Text color={FG.body}>• @文件 — 引用文件</Text>
      </Box>
    </Box>
  )
}

// ─── 命令帮助 ──────────────────────────────────────────────────────────────

interface CommandsHelpProps {
  grouped: {
    builtin: Command[]
    session: Command[]
    config: Command[]
    tools: Command[]
    custom: Command[]
  }
}

function CommandsHelp({ grouped }: CommandsHelpProps) {
  const renderGroup = (title: string, commands: Command[]) => {
    if (commands.length === 0) return null

    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text color={TONE.accent} bold>{title}</Text>
        <Box flexDirection="column" paddingLeft={2}>
          {commands.map(cmd => (
            <Box key={cmd.name}>
              <Text color={TONE.brand}>
                /{getCommandName(cmd)}
                {cmd.argumentHint ? ` ${cmd.argumentHint}` : ''}
              </Text>
              <Text color={FG.sub}> — {cmd.description}</Text>
            </Box>
          ))}
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {renderGroup('内置命令', grouped.builtin)}
      {renderGroup('会话命令', grouped.session)}
      {renderGroup('配置命令', grouped.config)}
      {renderGroup('工具命令', grouped.tools)}
      {renderGroup('自定义命令', grouped.custom)}
    </Box>
  )
}

// ─── 自定义帮助 ────────────────────────────────────────────────────────────

function CustomHelp() {
  return (
    <Box flexDirection="column">
      <Text color={FG.sub}>
        自定义命令可以通过配置文件添加。
      </Text>
      <Box marginTop={1}>
        <Text color={FG.body}>
          详见文档：docs/custom-commands.md
        </Text>
      </Box>
    </Box>
  )
}

// ─── 帮助项 ────────────────────────────────────────────────────────────────

function HelpItem({ shortcut, description }: { shortcut: string; description: string }) {
  return (
    <Box>
      <Text color={TONE.accent} bold>{shortcut.padEnd(16)}</Text>
      <Text color={FG.body}>{description}</Text>
    </Box>
  )
}
