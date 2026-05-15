import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { TONE, FG } from '../../ui/theme.js'
import type { CommandContext } from '../types.js'

// ─── 类型 ──────────────────────────────────────────────────────────────────

interface ConfigViewProps {
  /** 命令上下文 */
  ctx: CommandContext
  /** 关闭回调 */
  onClose: () => void
}

type Tab = 'config' | 'status' | 'usage'

// ─── 组件 ─────────────────────────────────────────────────────────────────

export function ConfigView({ ctx, onClose }: ConfigViewProps) {
  const [activeTab, setActiveTab] = useState<Tab>('status')

  // 键盘处理
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      onClose()
      return
    }

    // Tab 切换
    if (key.tab) {
      const tabs: Tab[] = ['config', 'status', 'usage']
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
        {(['config', 'status', 'usage'] as Tab[]).map(tab => (
          <Box key={tab} marginRight={2}>
            <Text
              color={activeTab === tab ? TONE.brand : FG.faint}
              bold={activeTab === tab}
              underline={activeTab === tab}
            >
              {tab === 'config' ? '配置' : tab === 'status' ? '状态' : '使用量'}
            </Text>
          </Box>
        ))}
      </Box>

      {/* 内容 */}
      <Box flexDirection="column">
        {activeTab === 'config' && (
          <ConfigTab ctx={ctx} />
        )}

        {activeTab === 'status' && (
          <StatusTab ctx={ctx} />
        )}

        {activeTab === 'usage' && (
          <UsageTab ctx={ctx} />
        )}
      </Box>
    </Box>
  )
}

// ─── 配置标签 ──────────────────────────────────────────────────────────────

function ConfigTab({ ctx }: { ctx: CommandContext }) {
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
        <Text>
          <Text color={FG.faint}>当前模式: </Text>
          <Text color={TONE.accent}>{ctx.getMode()}</Text>
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

// ─── 状态标签 ──────────────────────────────────────────────────────────────

function StatusTab({ ctx }: { ctx: CommandContext }) {
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
      </Box>

      {/* 预算信息 */}
      <Box flexDirection="column" marginTop={1}>
        <Text color={TONE.brand} bold>预算</Text>
        <Box flexDirection="column" paddingLeft={2}>
          <Text>
            <Text color={FG.faint}>已花费: </Text>
            <Text color={TONE.accent}>${ctx.getBudgetInfo().spent.toFixed(4)}</Text>
          </Text>
          {ctx.getBudgetInfo().limit !== undefined && (
            <Text>
              <Text color={FG.faint}>限额: </Text>
              <Text color={FG.body}>${ctx.getBudgetInfo().limit!.toFixed(2)}</Text>
            </Text>
          )}
        </Box>
      </Box>
    </Box>
  )
}

// ─── 使用量标签 ────────────────────────────────────────────────────────────

function UsageTab({ ctx }: { ctx: CommandContext }) {
  const summary = ctx.getCostSummary()

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text color={TONE.brand} bold>使用量统计</Text>
      </Box>

      <Box flexDirection="column" paddingLeft={2}>
        <Text>
          <Text color={FG.faint}>输入 Tokens: </Text>
          <Text color={FG.body}>{summary.inputTokens.toLocaleString()}</Text>
        </Text>
        <Text>
          <Text color={FG.faint}>输出 Tokens: </Text>
          <Text color={FG.body}>{summary.outputTokens.toLocaleString()}</Text>
        </Text>
        <Text>
          <Text color={FG.faint}>总花费: </Text>
          <Text color={TONE.accent}>${summary.costUsd.toFixed(4)}</Text>
        </Text>
      </Box>
    </Box>
  )
}
