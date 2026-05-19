import { describe, it, expect, vi, beforeEach } from 'vitest'

// mock 文件系统
const { mockStore } = vi.hoisted(() => ({
  mockStore: new Map<string, string>(),
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn((p: string) => mockStore.has(p)),
    readFileSync: vi.fn((p: string) => mockStore.get(p) ?? '[]'),
    writeFileSync: vi.fn((p: string, content: string) => mockStore.set(p, content)),
    renameSync: vi.fn((src: string, dest: string) => {
      const content = mockStore.get(src)
      if (content !== undefined) {
        mockStore.set(dest, content)
        mockStore.delete(src)
      }
    }),
    mkdirSync: vi.fn(),
  }
})

vi.mock('../../src/core/Config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/Config.js')>()
  return {
    ...actual,
    getConfigDir: () => '/tmp/hrids-test',
    loadConfig: () => ({ timeZone: 'Asia/Shanghai' }),
  }
})

beforeEach(() => {
  mockStore.clear()
})

import { ScheduleCronTool, parseCronNextRun } from '../../src/tools/ScheduleCronTool.js'

describe('ScheduleCronTool', () => {
  it('create 创建定时任务', async () => {
    const result = await ScheduleCronTool.execute({
      action: 'create',
      expression: '0 9 * * *',
      description: '每天早上检查邮件',
      task: '每天早上检查邮件',
    })
    expect(result.type).toBe('success')
    expect((result as { type: 'success'; output: string }).output).toContain('创建')
  })

  it('list 列出所有任务', async () => {
    // 先创建一个
    await ScheduleCronTool.execute({
      action: 'create',
      expression: '*/30 * * * *',
      description: '每30分钟同步数据',
      task: '每30分钟同步数据',
    })

    const result = await ScheduleCronTool.execute({ action: 'list' })
    expect(result.type).toBe('success')
    expect((result as { type: 'success'; output: string }).output).toContain('每30分钟同步数据')
  })

  it('list 无任务时返回提示', async () => {
    const result = await ScheduleCronTool.execute({ action: 'list' })
    expect(result.type).toBe('success')
    // 空列表应有提示
    const output = (result as { type: 'success'; output: string }).output
    expect(output.length).toBeGreaterThan(0)
  })

  it('delete 删除指定任务', async () => {
    // 先创建
    await ScheduleCronTool.execute({
      action: 'create',
      expression: '0 18 * * *',
      description: '下班提醒',
      task: '下班提醒',
    })

    // 获取 ID
    const listResult = await ScheduleCronTool.execute({ action: 'list' })
    const output = (listResult as { type: 'success'; output: string }).output

    // 从输出中提取 ID（格式通常是 ID: xxx 或 [id]）
    const idMatch = output.match(/[a-f0-9-]{8,}/)
    if (idMatch) {
      const deleteResult = await ScheduleCronTool.execute({
        action: 'delete',
        id: idMatch[0],
      })
      expect(deleteResult.type).toBe('success')
    }
  })

  it('delete 不存在的任务返回错误', async () => {
    const result = await ScheduleCronTool.execute({
      action: 'delete',
      id: 'nonexistent-id-12345',
    })
    expect(result.type).toBe('error')
  })

  it('readonly 为 false', () => {
    expect(ScheduleCronTool.readonly).toBe(false)
  })

  it('按配置时区计算下一次执行时间', () => {
    const from = Date.parse('2026-05-19T00:00:00.000Z') // Asia/Shanghai 08:00
    const next = parseCronNextRun('0 9 * * *', from)

    expect(new Date(next!).toISOString()).toBe('2026-05-19T01:00:00.000Z')
  })
})
