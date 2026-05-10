import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'
import { QueryEngine } from '../../src/core/QueryEngine.js'
import type { QueryEngineConfig, StreamEvent } from '../../src/core/QueryEngine.js'
import type { LLMProvider } from '../../src/core/providers/index.js'
import type { ToolDef } from '../../src/core/Tool.js'
import { PermissionManager } from '../../src/core/PermissionManager.js'

// mock 文件系统（PermissionManager 需要）
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => '{}'),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  }
})

// mock audit 日志
vi.mock('../../src/core/audit.js', () => ({ auditLog: vi.fn() }))

// 辅助：收集所有 StreamEvent
async function collectEvents(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  for await (const e of gen) events.push(e)
  return events
}

// 构造一个简单的 mock LLM provider（只返回文本，不调用工具）
function makeTextProvider(text: string): LLMProvider {
  return {
    model: 'mock-model',
    async *stream() {
      yield { type: 'text_delta', delta: text }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
    },
  } as unknown as LLMProvider
}

// 构造一个调用一次工具后返回文本的 provider
function makeToolProvider(toolName: string, toolInput: unknown, replyText: string): LLMProvider {
  let callCount = 0
  return {
    model: 'mock-model',
    async *stream() {
      callCount++
      if (callCount === 1) {
        // 第一轮：发起工具调用
        yield { type: 'tool_call', toolCall: { id: 'tc-1', name: toolName, input: toolInput } }
        yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } }
      } else {
        // 第二轮：返回文本
        yield { type: 'text_delta', delta: replyText }
        yield { type: 'usage', usage: { inputTokens: 15, outputTokens: 8 } }
      }
    },
  } as unknown as LLMProvider
}

function makeConfig(provider: LLMProvider, tools: ToolDef<never>[] = []): QueryEngineConfig {
  return {
    provider,
    systemPrompt: ['你是一个测试助手'],
    tools,
    permissions: new PermissionManager('ask', async () => true),
    maxTokens: 1024,
    maxTurns: 5,
  }
}

describe('QueryEngine', () => {
  describe('基础文本响应', () => {
    it('发送消息后收到 text_delta 和 done 事件', async () => {
      const engine = new QueryEngine(makeConfig(makeTextProvider('你好！')))
      const events = await collectEvents(engine.send('hi'))

      const textEvents = events.filter(e => e.type === 'text_delta')
      expect(textEvents.length).toBeGreaterThan(0)
      expect((textEvents[0] as { type: 'text_delta'; delta: string }).delta).toBe('你好！')

      const doneEvent = events.find(e => e.type === 'done')
      expect(doneEvent).toBeDefined()
    })

    it('收到 usage 事件并记录成本', async () => {
      const engine = new QueryEngine(makeConfig(makeTextProvider('ok')))
      const events = await collectEvents(engine.send('test'))

      const usageEvent = events.find(e => e.type === 'usage')
      expect(usageEvent).toBeDefined()
    })
  })

  describe('历史管理', () => {
    it('发送消息后历史中包含用户和助手消息', async () => {
      const engine = new QueryEngine(makeConfig(makeTextProvider('回复内容')))
      await collectEvents(engine.send('用户消息'))

      const history = engine.getHistory()
      expect(history.some(m => m.role === 'user')).toBe(true)
      expect(history.some(m => m.role === 'assistant')).toBe(true)
    })

    it('clearHistory 清空历史', async () => {
      const engine = new QueryEngine(makeConfig(makeTextProvider('ok')))
      await collectEvents(engine.send('test'))
      engine.clearHistory()
      expect(engine.getHistory()).toHaveLength(0)
    })

    it('setHistory 替换历史', () => {
      const engine = new QueryEngine(makeConfig(makeTextProvider('ok')))
      const newHistory = [{ role: 'user' as const, content: '新历史' }]
      engine.setHistory(newHistory)
      expect(engine.getHistory()).toHaveLength(1)
      expect(engine.getHistory()[0].content).toBe('新历史')
    })

    it('compactHistory 压缩为摘要消息', () => {
      const engine = new QueryEngine(makeConfig(makeTextProvider('ok')))
      engine.compactHistory('这是摘要内容')
      const history = engine.getHistory()
      expect(history).toHaveLength(2)
      expect(typeof history[0].content === 'string' && history[0].content).toContain('这是摘要内容')
    })
  })

  describe('并发保护', () => {
    it('运行中再次 send 返回错误', async () => {
      // 创建一个可控的 provider：用 deferred promise 控制何时结束
      let finishStream!: () => void
      const streamFinished = new Promise<void>(resolve => { finishStream = resolve })

      const provider = {
        model: 'mock',
        async *stream() {
          yield { type: 'text_delta', delta: 'start' }
          await streamFinished
          yield { type: 'text_delta', delta: 'end' }
        },
      } as unknown as LLMProvider

      const engine = new QueryEngine(makeConfig(provider))
      const gen1 = engine.send('task1')

      // 触发第一个 send 进入 running 状态（yield 'start' 后暂停在 await streamFinished）
      await gen1.next()
      expect(engine.isRunning()).toBe(true)

      // 立即发第二个，应返回错误
      const events = await collectEvents(engine.send('task2'))
      const errorEvent = events.find(e => e.type === 'error')
      expect(errorEvent).toBeDefined()

      // 清理：让第一个生成器正常结束
      finishStream()
    })
  })

  describe('abort', () => {
    it('abort 后 isRunning 变为 false', async () => {
      // provider 在 abort 信号触发后立即结束
      const provider = {
        model: 'mock',
        async *stream(_hist: unknown, _tools: unknown, _sys: unknown, _max: unknown, _signal: unknown) {
          // 每 10ms 检查一次，模拟可中断的流式请求
          for (let i = 0; i < 100; i++) {
            await new Promise(r => setTimeout(r, 10))
            yield { type: 'text_delta', delta: '.' }
          }
        },
      } as unknown as LLMProvider

      const engine = new QueryEngine(makeConfig(provider))
      const gen = engine.send('task')

      // 启动执行
      gen.next()

      // 稍等一下确保已经开始运行
      await new Promise(r => setTimeout(r, 50))
      expect(engine.isRunning()).toBe(true)

      // 中止
      engine.abort()

      // 等待 generator 结束（有超时保护）
      await Promise.race([
        (async () => { for await (const _ of gen) { /* drain */ } })(),
        new Promise(r => setTimeout(r, 2000)),
      ])

      expect(engine.isRunning()).toBe(false)
    }, 5000)
  })

  describe('工具调用', () => {
    it('工具调用成功时收到 tool_start 和 tool_end 事件', async () => {
      const mockTool: ToolDef<never> = {
        name: 'echo_tool',
        description: '回显工具',
        inputSchema: z.object({ text: z.string() }) as never,
        readonly: true,
        async execute(input: { text: string }) {
          return { type: 'success', output: `echo: ${input.text}` }
        },
      }

      const provider = makeToolProvider('echo_tool', { text: 'hello' }, '工具调用完成')
      const engine = new QueryEngine(makeConfig(provider, [mockTool as never]))
      const events = await collectEvents(engine.send('调用工具'))

      expect(events.some(e => e.type === 'tool_start')).toBe(true)
      expect(events.some(e => e.type === 'tool_end')).toBe(true)
    })

    it('工具不存在时 tool_end 包含错误', async () => {
      const provider = makeToolProvider('nonexistent_tool', {}, '完成')
      const engine = new QueryEngine(makeConfig(provider, []))
      const events = await collectEvents(engine.send('调用不存在的工具'))

      const toolEnd = events.find(e => e.type === 'tool_end') as { type: 'tool_end'; result: { type: string } } | undefined
      expect(toolEnd?.result.type).toBe('error')
    })

    it('readonly 模式下写工具被拒绝', async () => {
      const writeTool: ToolDef<never> = {
        name: 'write_tool',
        description: '写工具',
        inputSchema: z.object({}) as never,
        readonly: false,
        async execute() {
          return { type: 'success', output: 'written' }
        },
      }

      const provider = makeToolProvider('write_tool', {}, '完成')
      const permissions = new PermissionManager('plan', async () => false)
      const engine = new QueryEngine({
        ...makeConfig(provider, [writeTool as never]),
        permissions,
      })
      const events = await collectEvents(engine.send('写文件'))

      expect(events.some(e => e.type === 'permission_denied')).toBe(true)
    })
  })

  describe('成本预算', () => {
    it('超出预算时触发 budget_exceeded 事件', async () => {
      // provider 每次都消耗大量 token
      const expensiveProvider = {
        model: 'claude-sonnet-4-5',
        async *stream() {
          yield { type: 'text_delta', delta: 'ok' }
          // 模拟消耗 100 万 token，成本约 $18
          yield { type: 'usage', usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } }
        },
      } as unknown as LLMProvider

      const engine = new QueryEngine({
        ...makeConfig(expensiveProvider),
        maxBudgetUsd: 0.001, // 极低预算
      })
      const events = await collectEvents(engine.send('test'))

      expect(events.some(e => e.type === 'budget_exceeded')).toBe(true)
    })
  })

  describe('getEstimatedTokens', () => {
    it('空历史时 token 估算为 0', () => {
      const engine = new QueryEngine(makeConfig(makeTextProvider('ok')))
      expect(engine.getEstimatedTokens()).toBe(0)
    })

    it('有历史时 token 估算大于 0', async () => {
      const engine = new QueryEngine(makeConfig(makeTextProvider('这是一段较长的回复内容')))
      await collectEvents(engine.send('这是一条用户消息'))
      expect(engine.getEstimatedTokens()).toBeGreaterThan(0)
    })
  })
})
