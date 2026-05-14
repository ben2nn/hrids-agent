// Spinner —— braille 圆点动画指示器
import React, { useState, useEffect } from 'react'
import { Text } from 'ink'

const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧']
const CIRCLE_FRAMES = ['◐', '◓', '◑', '◒']

interface SpinnerProps {
  /** 动画风格 */
  variant?: 'braille' | 'circle'
  /** 颜色 */
  color?: string
  /** 帧间隔 ms */
  interval?: number
}

export function Spinner({ variant = 'braille', color = 'cyan', interval = 120 }: SpinnerProps) {
  const frames = variant === 'circle' ? CIRCLE_FRAMES : BRAILLE_FRAMES
  const [idx, setIdx] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => {
      setIdx(prev => (prev + 1) % frames.length)
    }, interval)
    return () => clearInterval(timer)
  }, [interval, frames.length])

  return <Text color={color}>{frames[idx]}</Text>
}
