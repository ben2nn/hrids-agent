// PromptInput —— 自定义多行文本编辑器
import React, { useState, useCallback, useEffect } from 'react'
import { Box, Text } from 'ink'
import { useKeystroke } from '../terminal/KeystrokeContext.js'
import { FG } from '../terminal/theme.js'

interface PromptInputProps {
  onSubmit: (text: string) => void
  onChange?: (text: string) => void
  disabled?: boolean
  placeholder?: string
  /** 受控模式：外部设置输入框值（如文件选择后插入路径） */
  value?: string
}

export function PromptInput({ onSubmit, onChange, disabled, placeholder, value }: PromptInputProps) {
  const [text, setText] = useState('')
  const [cursorPos, setCursorPos] = useState(0)
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)

  const updateText = useCallback((newText: string) => {
    setText(newText)
    onChange?.(newText)
  }, [onChange])

  // 受控模式：外部 value 变化时同步到内部状态
  useEffect(() => {
    if (value !== undefined) {
      setText(value)
      setCursorPos(value.length)
    }
  }, [value])

  useKeystroke((key) => {
    if (disabled) return
    if (key.name === 'enter' && !key.shift) {
      if (text.trim()) {
        onSubmit(text.trim())
        setHistory(prev => [...prev, text.trim()].slice(-100))
        updateText('')
        setCursorPos(0)
        setHistoryIndex(-1)
      }
      return
    }
    if (key.name === 'backspace' && cursorPos > 0) {
      updateText(text.slice(0, cursorPos - 1) + text.slice(cursorPos))
      setCursorPos(cursorPos - 1)
      return
    }
    if (key.name === 'delete' && cursorPos < text.length) {
      updateText(text.slice(0, cursorPos) + text.slice(cursorPos + 1))
      return
    }
    if (key.name === 'left') { setCursorPos(Math.max(0, cursorPos - 1)); return }
    if (key.name === 'right') { setCursorPos(Math.min(text.length, cursorPos + 1)); return }
    if (key.name === 'home') { setCursorPos(0); return }
    if (key.name === 'end') { setCursorPos(text.length); return }
    if (key.name === 'up' && history.length > 0) {
      const idx = historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1)
      setHistoryIndex(idx); updateText(history[idx]); setCursorPos(history[idx].length); return
    }
    if (key.name === 'down' && historyIndex !== -1) {
      const idx = historyIndex + 1
      if (idx >= history.length) { setHistoryIndex(-1); updateText(''); setCursorPos(0) }
      else { setHistoryIndex(idx); updateText(history[idx]); setCursorPos(history[idx].length) }
      return
    }
    if (key.ctrl && key.name === 'u') { updateText(''); setCursorPos(0); return }
    if (key.paste && key.pasteContent) {
      const newText = text.slice(0, cursorPos) + key.pasteContent + text.slice(cursorPos)
      updateText(newText); setCursorPos(cursorPos + key.pasteContent.length); return
    }
    if (key.sequence && !key.ctrl && !key.alt && !key.meta && key.sequence.length === 1) {
      updateText(text.slice(0, cursorPos) + key.sequence + text.slice(cursorPos))
      setCursorPos(cursorPos + 1)
    }
  }, !disabled)

  const beforeCursor = text.slice(0, cursorPos)
  const atCursor = text[cursorPos] || ' '
  const afterCursor = text.slice(cursorPos + 1)

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan" bold>{'> '}</Text>
        <Text>{beforeCursor}</Text>
        <Text inverse>{atCursor}</Text>
        <Text>{afterCursor}</Text>
        {!text && placeholder && <Text dimColor>{placeholder}</Text>}
      </Box>
      {!text && (
        <Text color={FG.faint} dimColor>{'  '}↑ 历史</Text>
      )}
    </Box>
  )
}
