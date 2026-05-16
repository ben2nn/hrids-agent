import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { TONE, FG } from '../terminal/theme.js'

// ─── 类型 ──────────────────────────────────────────────────────────────────

interface AgentData {
  name: string
  description: string
  model?: string
  systemPrompt?: string
}

interface AgentEditorProps {
  /** 初始数据 */
  initialData?: AgentData
  /** 保存回调 */
  onSave: (data: AgentData) => void
  /** 取消回调 */
  onCancel: () => void
}

// ─── 组件 ─────────────────────────────────────────────────────────────────

/**
 * Agent 配置编辑器
 *
 * 支持编辑 Agent 的基本属性。
 */
export function AgentEditor({ initialData, onSave, onCancel }: AgentEditorProps) {
  const [name, setName] = useState(initialData?.name ?? '')
  const [description, setDescription] = useState(initialData?.description ?? '')
  const [model, setModel] = useState(initialData?.model ?? '')
  const [systemPrompt, setSystemPrompt] = useState(initialData?.systemPrompt ?? '')
  const [activeField, setActiveField] = useState<'name' | 'description' | 'model' | 'systemPrompt'>('name')

  // 键盘处理
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      onCancel()
      return
    }

    // Tab 切换字段
    if (key.tab) {
      const fields = ['name', 'description', 'model', 'systemPrompt'] as const
      const currentIndex = fields.indexOf(activeField)
      const nextIndex = (currentIndex + 1) % fields.length
      setActiveField(fields[nextIndex])
      return
    }

    // 保存
    if (key.ctrl && input === 's') {
      onSave({ name, description, model: model || undefined, systemPrompt: systemPrompt || undefined })
      return
    }

    // 退格键
    if (key.backspace || key.delete) {
      switch (activeField) {
        case 'name': setName(prev => prev.slice(0, -1)); break
        case 'description': setDescription(prev => prev.slice(0, -1)); break
        case 'model': setModel(prev => prev.slice(0, -1)); break
        case 'systemPrompt': setSystemPrompt(prev => prev.slice(0, -1)); break
      }
      return
    }

    // 普通字符
    if (input && !key.ctrl && !key.meta) {
      switch (activeField) {
        case 'name': setName(prev => prev + input); break
        case 'description': setDescription(prev => prev + input); break
        case 'model': setModel(prev => prev + input); break
        case 'systemPrompt': setSystemPrompt(prev => prev + input); break
      }
    }
  })

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      {/* 标题 */}
      <Box marginBottom={1}>
        <Text color={TONE.brand} bold>
          {initialData ? '编辑 Agent' : '创建 Agent'}
        </Text>
        <Text color={FG.faint}> (Tab 切换字段，Ctrl+S 保存)</Text>
      </Box>

      {/* 字段 */}
      <Box flexDirection="column">
        <FieldInput
          label="名称"
          value={name}
          isActive={activeField === 'name'}
          placeholder="Agent 名称"
        />
        <FieldInput
          label="描述"
          value={description}
          isActive={activeField === 'description'}
          placeholder="Agent 描述"
        />
        <FieldInput
          label="模型"
          value={model}
          isActive={activeField === 'model'}
          placeholder="可选：指定模型"
        />
        <FieldInput
          label="系统提示"
          value={systemPrompt}
          isActive={activeField === 'systemPrompt'}
          placeholder="可选：系统提示"
        />
      </Box>

      {/* 底部提示 */}
      <Box marginTop={1}>
        <Text color={FG.faint} dimColor>
          Tab 切换 · Ctrl+S 保存 · ESC 取消
        </Text>
      </Box>
    </Box>
  )
}

// ─── 字段输入组件 ──────────────────────────────────────────────────────────

interface FieldInputProps {
  label: string
  value: string
  isActive: boolean
  placeholder?: string
}

function FieldInput({ label, value, isActive, placeholder }: FieldInputProps) {
  return (
    <Box marginBottom={1}>
      <Box width={12}>
        <Text color={isActive ? TONE.accent : FG.faint}>{label}:</Text>
      </Box>
      <Text color={value ? FG.body : FG.faint}>
        {value || placeholder || ''}
      </Text>
      {isActive && <Text color={FG.faint}>▏</Text>}
    </Box>
  )
}
