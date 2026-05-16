import React from 'react'
import { Box, Text } from 'ink'
import { TONE, FG } from './theme.js'

// ─── 类型 ──────────────────────────────────────────────────────────────────

interface StreamingMarkdownProps {
  content: string
  columns?: number
}

// ─── 内联格式化 ────────────────────────────────────────────────────────────

interface TextSegment {
  text: string
  bold?: boolean
  italic?: boolean
  code?: boolean
  link?: string
}

function parseInline(text: string): TextSegment[] {
  const segments: TextSegment[] = []
  let remaining = text

  while (remaining.length > 0) {
    // 行内代码 `code`
    const codeMatch = remaining.match(/^`([^`]+)`/)
    if (codeMatch) {
      segments.push({ text: codeMatch[1], code: true })
      remaining = remaining.slice(codeMatch[0].length)
      continue
    }

    // 粗体 **text**
    const boldMatch = remaining.match(/^\*\*([^*]+)\*\*/)
    if (boldMatch) {
      segments.push({ text: boldMatch[1], bold: true })
      remaining = remaining.slice(boldMatch[0].length)
      continue
    }

    // 斜体 *text*
    const italicMatch = remaining.match(/^\*([^*]+)\*/)
    if (italicMatch) {
      segments.push({ text: italicMatch[1], italic: true })
      remaining = remaining.slice(italicMatch[0].length)
      continue
    }

    // 链接 [text](url)
    const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/)
    if (linkMatch) {
      segments.push({ text: linkMatch[1], link: linkMatch[2] })
      remaining = remaining.slice(linkMatch[0].length)
      continue
    }

    // 普通文本（取到下一个特殊字符）
    const nextSpecial = remaining.search(/[`*\[]/)
    if (nextSpecial === -1) {
      segments.push({ text: remaining })
      break
    } else if (nextSpecial === 0) {
      // 特殊字符但不匹配任何格式，当作普通文本
      segments.push({ text: remaining[0] })
      remaining = remaining.slice(1)
    } else {
      segments.push({ text: remaining.slice(0, nextSpecial) })
      remaining = remaining.slice(nextSpecial)
    }
  }

  return segments
}

// ─── 行类型 ────────────────────────────────────────────────────────────────

type LineType = 'heading1' | 'heading2' | 'heading3' | 'bullet' | 'numbered' | 'code' | 'normal'

function getLineType(line: string): { type: LineType; content: string; indent: number } {
  const trimmed = line.trimStart()
  const indent = line.length - trimmed.length

  // 标题
  if (trimmed.startsWith('# ')) return { type: 'heading1', content: trimmed.slice(2), indent }
  if (trimmed.startsWith('## ')) return { type: 'heading2', content: trimmed.slice(3), indent }
  if (trimmed.startsWith('### ')) return { type: 'heading3', content: trimmed.slice(4), indent }

  // 无序列表
  if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
    return { type: 'bullet', content: trimmed.slice(2), indent }
  }

  // 有序列表
  const numberedMatch = trimmed.match(/^\d+\.\s/)
  if (numberedMatch) {
    return { type: 'numbered', content: trimmed.slice(numberedMatch[0].length), indent }
  }

  return { type: 'normal', content: trimmed, indent }
}

// ─── 渲染行 ────────────────────────────────────────────────────────────────

function renderLine(line: string, lineIndex: number, inCodeBlock: boolean): React.ReactNode {
  if (inCodeBlock) {
    return (
      <Text key={lineIndex} color={TONE.accent}>
        {line}
      </Text>
    )
  }

  const { type, content, indent } = getLineType(line)
  const indentStr = ' '.repeat(indent)

  switch (type) {
    case 'heading1':
      return (
        <Box key={lineIndex} marginTop={1}>
          <Text color={TONE.brand} bold>{'# '}{content}</Text>
        </Box>
      )
    case 'heading2':
      return (
        <Box key={lineIndex} marginTop={1}>
          <Text color={TONE.brand} bold>{'## '}{content}</Text>
        </Box>
      )
    case 'heading3':
      return (
        <Box key={lineIndex} marginTop={1}>
          <Text color={TONE.accent} bold>{'### '}{content}</Text>
        </Box>
      )
    case 'bullet':
      return (
        <Box key={lineIndex}>
          <Text>{indentStr}{'  • '}</Text>
          <InlineText text={content} />
        </Box>
      )
    case 'numbered':
      return (
        <Box key={lineIndex}>
          <Text>{indentStr}{'  '}</Text>
          <InlineText text={content} />
        </Box>
      )
    default:
      return (
        <Box key={lineIndex}>
          <InlineText text={content} />
        </Box>
      )
  }
}

// ─── 内联文本组件 ──────────────────────────────────────────────────────────

function InlineText({ text }: { text: string }) {
  const segments = parseInline(text)

  return (
    <Text>
      {segments.map((seg, i) => {
        if (seg.code) {
          return (
            <Text key={i} color={TONE.accent} backgroundColor={FG.faint}>
              {seg.text}
            </Text>
          )
        }
        if (seg.bold) {
          return <Text key={i} bold>{seg.text}</Text>
        }
        if (seg.italic) {
          return <Text key={i} italic>{seg.text}</Text>
        }
        if (seg.link) {
          return (
            <Text key={i} color={TONE.accent} underline>
              {seg.text}
            </Text>
          )
        }
        return <Text key={i}>{seg.text}</Text>
      })}
    </Text>
  )
}

// ─── 主组件 ────────────────────────────────────────────────────────────────

function StreamingMarkdownImpl({ content, columns }: StreamingMarkdownProps) {
  const lines = content.split('\n')
  let inCodeBlock = false
  const codeBlockLines: string[] = []
  const renderedLines: React.ReactNode[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // 代码块开始/结束
    if (line.trimStart().startsWith('```')) {
      if (inCodeBlock) {
        // 结束代码块
        inCodeBlock = false
        renderedLines.push(
          <Box key={`code-end-${i}`} flexDirection="column">
            {codeBlockLines.map((codeLine, j) => (
              <Text key={j} color={TONE.accent}>{codeLine}</Text>
            ))}
          </Box>
        )
        codeBlockLines.length = 0
      } else {
        // 开始代码块
        inCodeBlock = true
      }
      continue
    }

    if (inCodeBlock) {
      codeBlockLines.push(line)
    } else {
      renderedLines.push(renderLine(line, i, false))
    }
  }

  // 未闭合的代码块
  if (inCodeBlock && codeBlockLines.length > 0) {
    renderedLines.push(
      <Box key="code-unclosed" flexDirection="column">
        {codeBlockLines.map((codeLine, j) => (
          <Text key={j} color={TONE.accent}>{codeLine}</Text>
        ))}
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {renderedLines}
    </Box>
  )
}

export const StreamingMarkdown = React.memo(StreamingMarkdownImpl)
