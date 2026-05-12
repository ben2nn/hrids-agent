import React, { useState, useEffect } from 'react'
import { Text, useInput } from 'ink'
import chalk from 'chalk'

interface Props {
  value: string
  onChange: (value: string) => void
  onSubmit?: (value: string) => void
  focus?: boolean
  prefix?: string
  prefixColor?: string
}

/**
 * 轻量 TextInput 替代品，绕过 ink-text-input 在 Windows 终端的光标漂移问题。
 * 使用 Ink 原生 useInput 处理键盘，chalk.inverse 渲染光标，不操作 stdin raw mode。
 * prefix 前缀（如 "› "）与输入内容在同一个 <Text> 中渲染，确保单行显示。
 */
export function SimpleTextInput({ value, onChange, onSubmit, focus = true, prefix, prefixColor }: Props) {
  const [cursorOffset, setCursorOffset] = useState(value.length)

  // value 从外部清空时（如提交后 setInput('')），重置光标到末尾
  useEffect(() => {
    if (cursorOffset > value.length) {
      setCursorOffset(value.length)
    }
  }, [value, cursorOffset])

  useInput((input, key) => {
    if (!focus) return

    if (key.return) {
      onSubmit?.(value)
      return
    }

    if (key.leftArrow) {
      setCursorOffset(prev => Math.max(0, prev - 1))
      return
    }
    if (key.rightArrow) {
      setCursorOffset(prev => Math.min(value.length, prev + 1))
      return
    }
    if ((key as { home?: boolean }).home) {
      setCursorOffset(0)
      return
    }
    if ((key as { end?: boolean }).end) {
      setCursorOffset(value.length)
      return
    }
    if (key.backspace || key.delete) {
      if (cursorOffset > 0) {
        const next = value.slice(0, cursorOffset - 1) + value.slice(cursorOffset)
        onChange(next)
        setCursorOffset(prev => prev - 1)
      }
      return
    }

    // 普通字符输入
    if (input) {
      const next = value.slice(0, cursorOffset) + input + value.slice(cursorOffset)
      onChange(next)
      setCursorOffset(prev => prev + input.length)
    }
  })

  // 前缀着色（用 ANSI 转义，嵌入同一个 <Text> 中避免 Ink 多行渲染）
  const prefixStr = prefix
    ? (prefixColor ? chalk.cyan(prefix) : prefix)
    : ''

  if (value.length === 0) {
    return <Text>{prefixStr}{focus ? chalk.inverse(' ') : ' '}</Text>
  }

  const before = value.slice(0, cursorOffset)
  const cursorChar = value[cursorOffset] ?? ' '
  const after = value.slice(cursorOffset + 1)

  return (
    <Text>
      {prefixStr}{before}{focus ? chalk.inverse(cursorChar) : cursorChar}{after}
    </Text>
  )
}
