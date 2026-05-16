import React from 'react'
import { Box, Text } from 'ink'

interface Props {
  version: string
  model: string
  providerName: string
  projectPath: string
  cols?: number
}

const LOGO = [
  '  /\\_/\\',
  ' ( o.o )',
  '  > ^ <',
]

const TIPS = [
  '输入消息开始对话，或使用 /help 查看命令',
  '使用 /init 创建 CLAUDE.md 配置文件',
  'Ctrl+C 中断当前任务，再次 Ctrl+C 退出',
]

const WHATS_NEW = [
  '多平台 Fallback 自动切换，保障稳定性',
  '技能系统 + MCP 协议扩展能力',
  '自动记忆提取与上下文压缩',
]

/** 计算字符串的终端显示宽度（中文/全角字符算 2 列） */
function strWidth(s: string): number {
  let w = 0
  for (const ch of s) {
    const code = ch.codePointAt(0)!
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3000 && code <= 0x30ff) ||
      (code >= 0xff00 && code <= 0xffef) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0x2e80 && code <= 0x2eff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x20000 && code <= 0x2a6df)
    ) {
      w += 2
    } else {
      w += 1
    }
  }
  return w
}

/** 用空格把字符串填充到指定显示宽度 */
function pad(s: string, width: number): string {
  const diff = width - strWidth(s)
  return diff > 0 ? s + ' '.repeat(diff) : s
}

/** 截断到指定显示宽度，超出部分加省略号 */
function trunc(s: string, width: number): string {
  if (strWidth(s) <= width) return pad(s, width)
  let w = 0
  let out = ''
  for (const ch of s) {
    const cw = strWidth(ch)
    if (w + cw > width - 1) break
    out += ch
    w += cw
  }
  return out + '…' + ' '.repeat(Math.max(0, width - strWidth(out) - 1))
}

/** 居中填充 */
function center(s: string, width: number): string {
  const sw = strWidth(s)
  if (sw >= width) return trunc(s, width)
  const left = Math.floor((width - sw) / 2)
  const right = width - sw - left
  return ' '.repeat(left) + s + ' '.repeat(right)
}

// ANSI 颜色码
const C_CYAN = '\x1b[36m'
const C_WHITE = '\x1b[37m'
const C_GRAY = '\x1b[90m'
const C_BOLD = '\x1b[1m'
const C_RESET = '\x1b[0m'

// 左右两列等宽，根据终端宽度自适应
const DEFAULT_COL_W = 40

export function SplashScreen({ version, model, providerName, projectPath, cols }: Props) {
  const title = ` HRIDS Agent v${version} `
  const totalWidth = cols ? Math.min(cols - 2, DEFAULT_COL_W * 2 + 6) : DEFAULT_COL_W * 2 + 6
  const COL_W = Math.max(20, Math.floor((totalWidth - 6) / 2))

  // 顶部边框
  const topFill = totalWidth - 5 - strWidth(title)
  const topBorder = '╭───' + title + '─'.repeat(Math.max(0, topFill)) + '╮'

  // 底部边框（┴ 要对齐内容行中间的 │，位置在 COL_W + 2 处）
  const botBorder = '╰' + '─'.repeat(COL_W + 2) + '┴' + '─'.repeat(COL_W + 1) + '╯'

  // 左侧各行
  const leftLines: { text: string; ansi?: string }[] = [
    { text: '' },
    { text: 'Welcome back!', ansi: C_BOLD },
    { text: '' },
    ...LOGO.map(t => ({ text: t, ansi: C_CYAN })),
    { text: '' },
    { text: `${providerName} · ${model}`, ansi: C_WHITE },
    { text: projectPath, ansi: C_GRAY },
  ]

  // 右侧各行
  const rightLines: { text: string; ansi?: string }[] = [
    { text: 'Tips for getting started', ansi: C_BOLD },
    { text: TIPS[0] },
    { text: '─'.repeat(30) },
    { text: "What's new", ansi: C_BOLD },
    ...WHATS_NEW.map(t => ({ text: t })),
  ]

  const rows: string[] = []
  rows.push(topBorder)

  const maxRows = Math.max(leftLines.length, rightLines.length)
  for (let i = 0; i < maxRows; i++) {
    const l = i < leftLines.length ? leftLines[i] : { text: '' }
    const r = i < rightLines.length ? rightLines[i] : { text: '' }

    const leftContent = center(l.text, COL_W)
    const rightContent = trunc(r.text, COL_W)

    const leftStr = l.ansi
      ? `${l.ansi}${leftContent}${C_RESET}`
      : leftContent
    const rightStr = r.ansi
      ? `${r.ansi}${rightContent}${C_RESET}`
      : rightContent

    rows.push(`│ ${leftStr} │ ${rightStr}│`)
  }

  rows.push(botBorder)

  return (
    <Box flexDirection="column">
      {rows.map((row, i) => (
        <Text key={i}>{row}</Text>
      ))}
    </Box>
  )
}
