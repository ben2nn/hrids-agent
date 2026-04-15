import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'

// ============================================================
// 从 App.tsx 提取的纯函数（或在此处重新实现以便测试）
// ============================================================

type MsgRole = 'user' | 'assistant' | 'tool' | 'system' | 'error'

interface DisplayMsg {
  id?: string
  role: MsgRole
  text: string
  color?: string
}

const ROLE_COLOR: Record<MsgRole, string> = {
  user:      'green',
  assistant: 'white',
  tool:      'cyan',
  system:    'gray',
  error:     'red',
}

const ROLE_PREFIX: Record<MsgRole, string> = {
  user:      '你 › ',
  assistant: '✦ ',
  tool:      '',
  system:    '• ',
  error:     '✗ ',
}

const MAX_TOOL_LOG_LINES = 30
const MAX_OUTPUT_CHARS = 500

// updateMsg 纯函数版本
function updateMsg(
  msgs: DisplayMsg[],
  id: string,
  updater: (prev: DisplayMsg) => DisplayMsg,
  fallback?: DisplayMsg
): DisplayMsg[] {
  const idx = msgs.findIndex(m => m.id === id)
  if (idx !== -1) {
    return msgs.map((m, i) => i === idx ? updater(m) : m)
  }
  if (fallback) return [...msgs, fallback]
  return msgs
}

// 日志截断纯函数
function truncateLogs(logs: string[], maxLines: number): string[] {
  if (logs.length <= maxLines) return logs
  const omitted = logs.length - maxLines
  return [`  …（省略前 ${omitted} 行）`, ...logs.slice(-maxLines)]
}

// output 截断纯函数
function truncateOutput(output: string, maxChars: number): string {
  if (output.length <= maxChars) return output
  return output.slice(0, maxChars) + `\n…（共 ${output.length} 字符）`
}

// 模拟 tool_start → tool_log × N → tool_end 事件序列
interface ToolStartEvent { id: string; name: string; description: string }
interface ToolEndSuccessEvent { id: string; name: string; result: { type: 'success'; output: string } }
interface ToolEndErrorEvent { id: string; name: string; result: { type: 'error'; message: string } }

function simulateToolBlock(
  initialMsgs: DisplayMsg[],
  toolStart: ToolStartEvent,
  logs: string[],
  toolEnd: ToolEndSuccessEvent | ToolEndErrorEvent
): { msgs: DisplayMsg[]; toolProgress: string } {
  // tool_start
  let msgs: DisplayMsg[] = [...initialMsgs, { id: toolStart.id, role: 'tool', text: `⚙ ${toolStart.name}  ${toolStart.description}` }]

  // tool_log（过滤 stderr，记录到 currentLogs）
  const currentLogs: string[] = []
  for (const line of logs) {
    if (!line.trimStart().startsWith('[stderr]')) {
      currentLogs.push(`  ${line}`)
    }
  }

  // tool_end
  const kept = truncateLogs(currentLogs, MAX_TOOL_LOG_LINES)
  const logSuffix = kept.length > 0 ? '\n' + kept.join('\n') : ''

  if (toolEnd.result.type === 'error') {
    msgs = updateMsg(msgs, toolEnd.id, prev => ({
      ...prev,
      text: prev.text + logSuffix + `\n✗ ${toolEnd.name}: ${toolEnd.result.message}`,
      color: 'red',
    }), { role: 'error', text: `✗ ${toolEnd.name}: ${toolEnd.result.message}` })
  } else {
    const preview = truncateOutput(toolEnd.result.output, MAX_OUTPUT_CHARS)
    msgs = updateMsg(msgs, toolEnd.id, prev => ({
      ...prev,
      text: prev.text + logSuffix + `\n✓ ${toolEnd.name}${preview ? '\n' + preview : ''}`,
    }), { role: 'tool', text: `✓ ${toolEnd.name}${preview ? '\n' + preview : ''}` })
  }

  return { msgs, toolProgress: '' }
}

// ============================================================
// 属性测试
// ============================================================

describe('cli-display-format 属性测试', () => {
  // 属性测试将在后续子任务（8.2-8.10）中添加
  it('骨架测试 - 确认测试文件可运行', () => {
    expect(true).toBe(true)
  })

  it('骨架测试 - 确认 fast-check 可用', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        return typeof s === 'string'
      })
    )
  })

  it('骨架测试 - 确认辅助函数已定义', () => {
    // updateMsg
    const msgs: DisplayMsg[] = [{ id: 'x', role: 'tool', text: '初始' }]
    const updated = updateMsg(msgs, 'x', prev => ({ ...prev, text: '更新后' }))
    expect(updated[0].text).toBe('更新后')

    // truncateLogs
    const logs = Array.from({ length: 35 }, (_, i) => `行 ${i}`)
    const truncated = truncateLogs(logs, 30)
    expect(truncated.length).toBe(31) // 30 行 + 1 行省略提示
    expect(truncated[0]).toContain('省略前 5 行')

    // truncateOutput
    const longOutput = 'a'.repeat(600)
    const truncatedOut = truncateOutput(longOutput, 500)
    expect(truncatedOut.length).toBeLessThan(longOutput.length)
    expect(truncatedOut).toContain('共 600 字符')

    // simulateToolBlock
    const result = simulateToolBlock(
      [],
      { id: 'tool-1', name: 'testTool', description: '测试工具' },
      ['日志行 1', '日志行 2'],
      { id: 'tool-1', name: 'testTool', result: { type: 'success', output: '执行成功' } }
    )
    expect(result.msgs.length).toBe(1)
    expect(result.msgs[0].text).toContain('testTool')
    expect(result.msgs[0].text).toContain('✓')
    expect(result.toolProgress).toBe('')
  })

  it('骨架测试 - 确认常量定义正确', () => {
    expect(MAX_TOOL_LOG_LINES).toBe(30)
    expect(MAX_OUTPUT_CHARS).toBe(500)
    expect(ROLE_PREFIX['assistant']).toBe('✦ ')
    expect(ROLE_COLOR['error']).toBe('red')
    expect(ROLE_COLOR['system']).toBe('gray')
  })
})
