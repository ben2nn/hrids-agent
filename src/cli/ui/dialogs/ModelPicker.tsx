import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { TONE, FG } from '../terminal/theme.js'

// ─── 类型 ──────────────────────────────────────────────────────────────────

interface Model {
  provider: string
  model: string
  isDefault?: boolean
}

interface ModelPickerProps {
  /** 可用模型列表 */
  models: Model[]
  /** 当前选中的模型 */
  currentModel: string
  /** 选择模型的回调 */
  onSelect: (model: string) => void
  /** 取消回调 */
  onCancel: () => void
}

// ─── 组件 ─────────────────────────────────────────────────────────────────

/**
 * 模型选择器组件
 *
 * 显示可用模型列表，支持键盘导航和选择。
 */
export function ModelPicker({ models, currentModel, onSelect, onCancel }: ModelPickerProps) {
  // 找到当前模型的索引
  const initialIndex = models.findIndex(m => m.model === currentModel)
  const [selectedIndex, setSelectedIndex] = useState(initialIndex >= 0 ? initialIndex : 0)

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
      setSelectedIndex(prev => Math.min(models.length - 1, prev + 1))
      return
    }

    if (key.return) {
      const model = models[selectedIndex]
      if (model) {
        onSelect(model.model)
      }
      return
    }
  })

  if (models.length === 0) {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text color={FG.faint}>没有可用的模型</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      {/* 标题 */}
      <Box marginBottom={1}>
        <Text color={TONE.brand} bold>选择模型</Text>
        <Text color={FG.faint}> (↑↓ 导航，Enter 选择，ESC 取消)</Text>
      </Box>

      {/* 模型列表 */}
      <Box flexDirection="column">
        {models.map((model, i) => (
          <Box key={`${model.provider}-${model.model}`}>
            {/* 选中指示器 */}
            <Text color={i === selectedIndex ? TONE.accent : FG.faint}>
              {i === selectedIndex ? '▸ ' : '  '}
            </Text>

            {/* 模型信息 */}
            <Text>
              <Text
                color={i === selectedIndex ? TONE.accent : FG.body}
                bold={i === selectedIndex}
              >
                {model.model}
              </Text>
              <Text color={FG.faint}> ({model.provider})</Text>
              {model.isDefault && (
                <Text color={TONE.ok}> [默认]</Text>
              )}
              {model.model === currentModel && (
                <Text color={TONE.accent}> [当前]</Text>
              )}
            </Text>
          </Box>
        ))}
      </Box>

      {/* 底部提示 */}
      <Box marginTop={1}>
        <Text color={FG.faint} dimColor>
          共 {models.length} 个模型
        </Text>
      </Box>
    </Box>
  )
}
