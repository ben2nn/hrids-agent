import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CommandRegistry, createBuiltinCommands } from '../../src/core/CommandRegistry.js'
import type { CommandContext, SlashCommand } from '../../src/core/CommandRegistry.js'

function makeMockContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    clearHistory: vi.fn(),
    compactHistory: vi.fn(),
    generateCompactSummary: vi.fn(async () => 'mock summary'),
    getHistoryLength: vi.fn(() => 10),
    getEstimatedTokens: vi.fn(() => 1000),
    getCostSummary: vi.fn(() => '费用摘要'),
    getBudgetInfo: vi.fn(() => ({ spent: 0.5, limit: 10 })),
    setModel: vi.fn(),
    getModel: vi.fn(() => 'test-model'),
    setMode: vi.fn(),
    getMode: vi.fn(() => 'ask'),
    sessionId: 'test-session',
    listSessions: vi.fn(() => []),
    listArchives: vi.fn(() => []),
    newSession: vi.fn(),
    switchSession: vi.fn(() => true),
    ...overrides,
  }
}

describe('CommandRegistry - parse', () => {
  let registry: CommandRegistry

  beforeEach(() => {
    registry = new CommandRegistry()
  })

  it('解析 /command 格式', () => {
    const result = registry.parse('/help')
    expect(result).toEqual({ name: 'help', args: '' })
  })

  it('解析 /command args 格式', () => {
    const result = registry.parse('/model gpt-4o')
    expect(result).toEqual({ name: 'model', args: 'gpt-4o' })
  })

  it('解析 /command 多参数', () => {
    const result = registry.parse('/compact 自定义摘要指令')
    expect(result).toEqual({ name: 'compact', args: '自定义摘要指令' })
  })

  it('不以 / 开头返回 null', () => {
    expect(registry.parse('hello')).toBeNull()
    expect(registry.parse('help')).toBeNull()
  })

  it('命令名转小写', () => {
    const result = registry.parse('/HELP')
    expect(result?.name).toBe('help')
  })

  it('空输入返回 null', () => {
    expect(registry.parse('')).toBeNull()
  })
})

describe('CommandRegistry - register/find', () => {
  let registry: CommandRegistry

  beforeEach(() => {
    registry = new CommandRegistry()
  })

  it('注册并查找命令', () => {
    const cmd: SlashCommand = {
      name: 'test',
      description: 'test command',
      execute: vi.fn(async () => ({ type: 'message' as const, text: 'ok' })),
    }
    registry.register(cmd)
    expect(registry.find('test')).toBe(cmd)
  })

  it('查找不存在的命令返回 undefined', () => {
    expect(registry.find('nonexistent')).toBeUndefined()
  })

  it('getAll 返回所有注册的命令', () => {
    registry.register({ name: 'a', description: '', execute: vi.fn(async () => ({ type: 'message' as const, text: '' })) })
    registry.register({ name: 'b', description: '', execute: vi.fn(async () => ({ type: 'message' as const, text: '' })) })
    expect(registry.getAll()).toHaveLength(2)
  })
})

describe('createBuiltinCommands', () => {
  it('返回内置命令列表', () => {
    const commands = createBuiltinCommands('test-key', 'test-model')
    const names = commands.map(c => c.name)
    expect(names).toContain('clear')
    expect(names).toContain('compact')
    expect(names).toContain('cost')
    expect(names).toContain('model')
    expect(names).toContain('session')
    expect(names).toContain('help')
    expect(names).toContain('plan')
    expect(names).toContain('commit')
    expect(names).toContain('review')
    expect(names).toContain('exit')
    expect(names).toContain('history')
    expect(names).toContain('new-session')
    expect(names).toContain('sessions')
    expect(names).toContain('resume')
  })

  it('clear 命令清空历史', async () => {
    const commands = createBuiltinCommands('', '')
    const clear = commands.find(c => c.name === 'clear')!
    const ctx = makeMockContext()
    const result = await clear.execute('', ctx)
    expect(ctx.clearHistory).toHaveBeenCalled()
    expect(result.type).toBe('message')
  })

  it('compact 命令压缩历史', async () => {
    const commands = createBuiltinCommands('', '')
    const compact = commands.find(c => c.name === 'compact')!
    const ctx = makeMockContext()
    const result = await compact.execute('', ctx)
    expect(ctx.generateCompactSummary).toHaveBeenCalled()
    expect(ctx.compactHistory).toHaveBeenCalledWith('mock summary')
    expect(result.type).toBe('message')
  })

  it('compact 空历史返回提示', async () => {
    const commands = createBuiltinCommands('', '')
    const compact = commands.find(c => c.name === 'compact')!
    const ctx = makeMockContext({ getHistoryLength: () => 0 })
    const result = await compact.execute('', ctx)
    expect(result.type).toBe('message')
    expect((result as { type: 'message'; text: string }).text).toContain('没有')
  })

  it('model 命令无参数显示当前模型', async () => {
    const commands = createBuiltinCommands('', '')
    const model = commands.find(c => c.name === 'model')!
    const ctx = makeMockContext()
    const result = await model.execute('', ctx)
    expect(result.type).toBe('message')
    expect((result as { type: 'message'; text: string }).text).toContain('test-model')
  })

  it('model 命令有参数切换模型', async () => {
    const commands = createBuiltinCommands('', '')
    const model = commands.find(c => c.name === 'model')!
    const ctx = makeMockContext()
    const result = await model.execute('gpt-4o', ctx)
    expect(ctx.setModel).toHaveBeenCalledWith('gpt-4o')
  })

  it('plan 命令切换模式', async () => {
    const commands = createBuiltinCommands('', '')
    const plan = commands.find(c => c.name === 'plan')!
    const ctx = makeMockContext()
    await plan.execute('', ctx)
    expect(ctx.setMode).toHaveBeenCalledWith('plan')
  })

  it('plan 命令再次执行退出计划模式', async () => {
    const commands = createBuiltinCommands('', '')
    const plan = commands.find(c => c.name === 'plan')!
    const ctx = makeMockContext({ getMode: () => 'plan' })
    await plan.execute('', ctx)
    expect(ctx.setMode).toHaveBeenCalledWith('ask')
  })

  it('exit 命令返回 exit 类型', async () => {
    const commands = createBuiltinCommands('', '')
    const exit = commands.find(c => c.name === 'exit')!
    const result = await exit.execute('', makeMockContext())
    expect(result.type).toBe('exit')
  })

  it('session 命令显示会话 ID', async () => {
    const commands = createBuiltinCommands('', '')
    const session = commands.find(c => c.name === 'session')!
    const result = await session.execute('', makeMockContext())
    expect((result as { type: 'message'; text: string }).text).toContain('test-session')
  })

  it('help 命令返回 noop', async () => {
    const commands = createBuiltinCommands('', '')
    const help = commands.find(c => c.name === 'help')!
    const result = await help.execute('', makeMockContext())
    expect(result.type).toBe('noop')
  })

  it('commit 命令返回 inject', async () => {
    const commands = createBuiltinCommands('', '')
    const commit = commands.find(c => c.name === 'commit')!
    const result = await commit.execute('', makeMockContext())
    expect(result.type).toBe('inject')
    expect((result as { type: 'inject'; prompt: string }).prompt).toContain('git diff')
  })

  it('review 命令返回 inject', async () => {
    const commands = createBuiltinCommands('', '')
    const review = commands.find(c => c.name === 'review')!
    const result = await review.execute('', makeMockContext())
    expect(result.type).toBe('inject')
  })
})
