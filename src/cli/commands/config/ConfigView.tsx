import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { TONE, FG } from '../../ui/terminal/theme.js'
import type { CommandContext } from '../types.js'

// ─── 类型 ──────────────────────────────────────────────────────────────────

interface ConfigViewProps {
  /** 命令上下文 */
  ctx: CommandContext
  /** 关闭回调 */
  onClose: () => void
}

type Tab = 'overview' | 'models'

// ─── 组件 ─────────────────────────────────────────────────────────────────

export function ConfigView({ ctx, onClose }: ConfigViewProps) {
  const [activeTab, setActiveTab] = useState<Tab>('overview')

  // 键盘处理
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      onClose()
      return
    }

    // Tab 切换
    if (key.tab) {
      const tabs: Tab[] = ['overview', 'models']
      const currentIndex = tabs.indexOf(activeTab)
      const nextIndex = (currentIndex + 1) % tabs.length
      setActiveTab(tabs[nextIndex])
    }
  })

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      {/* 标题 */}
      <Box marginBottom={1}>
        <Text color={TONE.brand} bold>配置</Text>
        <Text color={FG.faint}> (Tab 切换标签，ESC 关闭)</Text>
      </Box>

      {/* 标签栏 */}
      <Box marginBottom={1}>
        {(['overview', 'models'] as Tab[]).map(tab => (
          <Box key={tab} marginRight={2}>
            <Text
              color={activeTab === tab ? TONE.brand : FG.faint}
              bold={activeTab === tab}
              underline={activeTab === tab}
            >
              {tab === 'overview' ? '概览' : '模型'}
            </Text>
          </Box>
        ))}
      </Box>

      {/* 内容 */}
      <Box flexDirection="column">
        {activeTab === 'overview' && (
          <OverviewTab ctx={ctx} />
        )}

        {activeTab === 'models' && (
          <ModelsTab ctx={ctx} />
        )}
      </Box>
    </Box>
  )
}

// ─── 概览标签（状态 + 使用量合并）─────────────────────────────────────────

function OverviewTab({ ctx }: { ctx: CommandContext }) {
  const summary = ctx.getCostSummary()
  const budget = ctx.getBudgetInfo()

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text color={TONE.brand} bold>会话状态</Text>
      </Box>

      <Box flexDirection="column" paddingLeft={2}>
        <Text>
          <Text color={FG.faint}>会话 ID: </Text>
          <Text color={TONE.accent}>{ctx.sessionId}</Text>
        </Text>
        <Text>
          <Text color={FG.faint}>历史长度: </Text>
          <Text color={FG.body}>{ctx.getHistoryLength()} 条事件</Text>
        </Text>
        <Text>
          <Text color={FG.faint}>预估 Tokens: </Text>
          <Text color={FG.body}>{ctx.getEstimatedTokens().toLocaleString()}</Text>
        </Text>
        <Text>
          <Text color={FG.faint}>当前模式: </Text>
          <Text color={TONE.accent}>{ctx.getMode()}</Text>
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text color={TONE.brand} bold>使用量</Text>
        <Box flexDirection="column" paddingLeft={2}>
          <Text>
            <Text color={FG.faint}>输入 Tokens: </Text>
            <Text color={FG.body}>{summary.inputTokens.toLocaleString()}</Text>
            <Text color={FG.faint}> · 输出: </Text>
            <Text color={FG.body}>{summary.outputTokens.toLocaleString()}</Text>
          </Text>
          <Text>
            <Text color={FG.faint}>已花费: </Text>
            <Text color={TONE.accent}>${summary.costUsd.toFixed(4)}</Text>
            {budget.limit !== undefined && (
              <>
                <Text color={FG.faint}> / </Text>
                <Text color={FG.body}>${budget.limit!.toFixed(2)}</Text>
              </>
            )}
          </Text>
        </Box>
      </Box>
    </Box>
  )
}

// ─── 模型标签 ──────────────────────────────────────────────────────────────

function ModelsTab({ ctx }: { ctx: CommandContext }) {
  const models = ctx.getAvailableModels()

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text color={TONE.brand} bold>模型配置</Text>
      </Box>

      <Box flexDirection="column" paddingLeft={2}>
        <Text>
          <Text color={FG.faint}>当前模型: </Text>
          <Text color={TONE.accent}>{ctx.getModel()}</Text>
        </Text>
      </Box>

      {models.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={TONE.brand} bold>可用模型</Text>
          <Box flexDirection="column" paddingLeft={2}>
            {models.map((m, i) => (
              <Text key={i}>
                <Text color={m.isDefault ? TONE.accent : FG.body}>
                  {m.model}
                </Text>
                <Text color={FG.faint}> ({m.provider})</Text>
                {m.isDefault && <Text color={TONE.ok}> [默认]</Text>}
              </Text>
            ))}
          </Box>
        </Box>
      )}
    </Box>
  )
}
