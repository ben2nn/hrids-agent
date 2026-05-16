import React, { useState } from 'react'
import { Box, Text } from 'ink'
import { TONE, FG } from './theme.js'

// ─── 类型 ──────────────────────────────────────────────────────────────────

interface DiffLine {
  type: 'add' | 'remove' | 'context' | 'header'
  content: string
  oldLine?: number
  newLine?: number
}

interface DiffViewProps {
  filePath: string
  diff: string
  maxLines?: number  // 最大显示行数，超过则截断
}

// ─── 解析 diff ─────────────────────────────────────────────────────────────

function parseDiff(diffText: string): DiffLine[] {
  const lines: DiffLine[] = []
  const rawLines = diffText.split('\n')

  for (const line of rawLines) {
    if (line.startsWith('@@')) {
      lines.push({ type: 'header', content: line })
    } else if (line.startsWith('+')) {
      lines.push({ type: 'add', content: line.slice(1) })
    } else if (line.startsWith('-')) {
      lines.push({ type: 'remove', content: line.slice(1) })
    } else if (line.startsWith(' ')) {
      lines.push({ type: 'context', content: line.slice(1) })
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file" 等
      lines.push({ type: 'context', content: line })
    } else {
      lines.push({ type: 'context', content: line })
    }
  }

  return lines
}

// ─── 行颜色 ────────────────────────────────────────────────────────────────

const LINE_COLOR: Record<DiffLine['type'], string> = {
  add:     'green',
  remove:  'red',
  context: FG.body,
  header:  TONE.accent,
}

const LINE_PREFIX: Record<DiffLine['type'], string> = {
  add:     '+',
  remove:  '-',
  context: ' ',
  header:  '',
}

// ─── 组件 ─────────────────────────────────────────────────────────────────

function DiffViewImpl({ filePath, diff, maxLines = 30 }: DiffViewProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const lines = parseDiff(diff)
  const totalLines = lines.length
  const shouldTruncate = totalLines > maxLines && !isExpanded
  const displayLines = shouldTruncate ? lines.slice(0, maxLines) : lines

  return (
    <Box flexDirection="column">
      {/* 文件路径 */}
      <Box>
        <Text color={TONE.brand} bold>diff </Text>
        <Text color={FG.body}>{filePath}</Text>
      </Box>

      {/* Diff 内容 */}
      <Box flexDirection="column" paddingLeft={1}>
        {displayLines.map((line, i) => (
          <Box key={i}>
            {line.type !== 'header' && (
              <Text color={FG.faint} dimColor>
                {String(line.oldLine ?? '').padStart(4)}{' '}
              </Text>
            )}
            <Text color={LINE_COLOR[line.type]}>
              {LINE_PREFIX[line.type]}{line.content}
            </Text>
          </Box>
        ))}
      </Box>

      {/* 截断提示 */}
      {shouldTruncate && (
        <Box paddingLeft={1}>
          <Text
            color={TONE.accent}
            dimColor
          >
            ... 已截断 {totalLines - maxLines} 行 (点击展开查看全部)
          </Text>
        </Box>
      )}

      {/* 展开/折叠按钮 */}
      {totalLines > maxLines && (
        <Box paddingLeft={1}>
          <Text color={FG.faint} dimColor>
            {isExpanded ? '[-] 折叠' : `[+] 展开全部 ${totalLines} 行`}
          </Text>
        </Box>
      )}
    </Box>
  )
}

export const DiffView = React.memo(DiffViewImpl)
