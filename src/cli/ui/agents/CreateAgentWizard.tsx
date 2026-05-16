import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { TONE, FG } from '../terminal/theme.js'

// ─── 类型 ──────────────────────────────────────────────────────────────────

interface AgentConfig {
  name: string
  description: string
  model?: string
  systemPrompt?: string
}

interface CreateAgentWizardProps {
  /** 创建回调 */
  onCreate: (config: AgentConfig) => void
  /** 取消回调 */
  onCancel: () => void
}

type Step = 'name' | 'description' | 'model' | 'systemPrompt' | 'confirm'

// ─── 组件 ─────────────────────────────────────────────────────────────────

/**
 * 创建 Agent 向导
 *
 * 分步引导用户创建新 Agent。
 */
export function CreateAgentWizard({ onCreate, onCancel }: CreateAgentWizardProps) {
  const [step, setStep] = useState<Step>('name')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [model, setModel] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')

  // 键盘处理
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      onCancel()
      return
    }

    // 下一步
    if (key.return) {
      switch (step) {
        case 'name':
          if (name.trim()) setStep('description')
          break
        case 'description':
          if (description.trim()) setStep('model')
          break
        case 'model':
          setStep('systemPrompt')
          break
        case 'systemPrompt':
          setStep('confirm')
          break
        case 'confirm':
          onCreate({ name, description, model: model || undefined, systemPrompt: systemPrompt || undefined })
          break
      }
      return
    }

    // 退格键
    if (key.backspace || key.delete) {
      switch (step) {
        case 'name': setName(prev => prev.slice(0, -1)); break
        case 'description': setDescription(prev => prev.slice(0, -1)); break
        case 'model': setModel(prev => prev.slice(0, -1)); break
        case 'systemPrompt': setSystemPrompt(prev => prev.slice(0, -1)); break
      }
      return
    }

    // 普通字符
    if (input && !key.ctrl && !key.meta) {
      switch (step) {
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
        <Text color={TONE.brand} bold>创建 Agent</Text>
        <Text color={FG.faint}> (向导模式)</Text>
      </Box>

      {/* 步骤指示器 */}
      <Box marginBottom={1}>
        {(['name', 'description', 'model', 'systemPrompt', 'confirm'] as Step[]).map((s, i) => (
          <Text key={s} color={s === step ? TONE.accent : FG.faint}>
            {i > 0 && ' → '}
            {i + 1}
          </Text>
        ))}
      </Box>

      {/* 步骤内容 */}
      <Box flexDirection="column">
        {step === 'name' && (
          <StepInput
            label="名称"
            value={name}
            placeholder="输入 Agent 名称"
            required
          />
        )}

        {step === 'description' && (
          <StepInput
            label="描述"
            value={description}
            placeholder="输入 Agent 描述"
            required
          />
        )}

        {step === 'model' && (
          <StepInput
            label="模型"
            value={model}
            placeholder="可选：指定模型（如 gpt-4）"
          />
        )}

        {step === 'systemPrompt' && (
          <StepInput
            label="系统提示"
            value={systemPrompt}
            placeholder="可选：输入系统提示"
          />
        )}

        {step === 'confirm' && (
          <Box flexDirection="column">
            <Box marginBottom={1}>
              <Text color={TONE.brand} bold>确认创建</Text>
            </Box>
            <Box flexDirection="column" paddingLeft={2}>
              <Text>
                <Text color={FG.faint}>名称: </Text>
                <Text color={FG.body}>{name}</Text>
              </Text>
              <Text>
                <Text color={FG.faint}>描述: </Text>
                <Text color={FG.body}>{description}</Text>
              </Text>
              {model && (
                <Text>
                  <Text color={FG.faint}>模型: </Text>
                  <Text color={FG.body}>{model}</Text>
                </Text>
              )}
              {systemPrompt && (
                <Text>
                  <Text color={FG.faint}>系统提示: </Text>
                  <Text color={FG.body}>{systemPrompt.slice(0, 50)}...</Text>
                </Text>
              )}
            </Box>
          </Box>
        )}
      </Box>

      {/* 底部提示 */}
      <Box marginTop={1}>
        <Text color={FG.faint} dimColor>
          {step === 'confirm'
            ? 'Enter 确认 · ESC 取消'
            : 'Enter 下一步 · ESC 取消'
          }
        </Text>
      </Box>
    </Box>
  )
}

// ─── 步骤输入组件 ──────────────────────────────────────────────────────────

interface StepInputProps {
  label: string
  value: string
  placeholder?: string
  required?: boolean
}

function StepInput({ label, value, placeholder, required }: StepInputProps) {
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text color={TONE.accent} bold>{label}</Text>
        {required && <Text color={TONE.err}> *</Text>}
      </Box>
      <Box>
        <Text color={value ? FG.body : FG.faint}>
          {value || placeholder || ''}
        </Text>
        <Text color={FG.faint}>▏</Text>
      </Box>
    </Box>
  )
}
