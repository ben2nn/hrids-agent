import { describe, it, expect, vi, beforeEach } from 'vitest'

// mock 文件系统，避免读写真实的 ~/.hrids-agent/sessions/
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const store = new Map<string, string>()
  const dirs = new Set<string>()

  return {
    ...actual,
    existsSync: vi.fn((p: string) => store.has(p) || dirs.has(p)),
    mkdirSync: vi.fn((p: string) => dirs.add(p)),
    readFileSync: vi.fn((p: string) => {
      const content = store.get(p)
      if (!content) throw new Error(`ENOENT: ${p}`)
      return content
    }),
    writeFileSync: vi.fn((p: string, content: string) => store.set(p, content)),
    renameSync: vi.fn((src: string, dest: string) => {
      const content = store.get(src)
      if (content !== undefined) {
        store.set(dest, content)
        store.delete(src)
      }
    }),
    readdirSync: vi.fn(() => []),
    rmSync: vi.fn(),
  }
})

import {
  saveSessionMeta,
  loadSessionMeta,
  loadSessionEvents,
  listSessions,
  generateSessionId,
  extractSessionTitle,
} from '../../src/core/SessionStore.js'
import type { ConversationEvent } from '../../src/core/ConversationStore.js'

describe('SessionStore', () => {
  const events: ConversationEvent[] = [
    { type: 'user_message', content: '帮我写一个 hello world', timestamp: '2026-05-12T10:00:00Z' },
    { type: 'assistant_message', content: 'console.log("Hello World")', timestamp: '2026-05-12T10:00:01Z' },
  ]

  describe('generateSessionId', () => {
    it('生成唯一 ID', () => {
      const id1 = generateSessionId()
      const id2 = generateSessionId()
      expect(id1).not.toBe(id2)
    })

    it('ID 格式包含时间戳和随机串', () => {
      const id = generateSessionId()
      expect(id).toMatch(/^\d+-[a-z0-9]+$/)
    })
  })

  describe('extractSessionTitle', () => {
    it('从首条用户消息提取标题', () => {
      const { title, lastUserMessage } = extractSessionTitle(events)
      expect(title).toBe('帮我写一个 hello world')
      expect(lastUserMessage).toBe('帮我写一个 hello world')
    })

    it('无用户消息时返回 undefined', () => {
      const { title, lastUserMessage } = extractSessionTitle([
        { type: 'assistant_message', content: 'hi', timestamp: '2026-05-12T10:00:00Z' },
      ])
      expect(title).toBeUndefined()
      expect(lastUserMessage).toBeUndefined()
    })
  })

  describe('saveSessionMeta / loadSessionMeta', () => {
    it('保存后可以读取元数据', () => {
      saveSessionMeta('test-session-1', { model: 'claude-sonnet-4-5', eventCount: 2, title: '帮我写一个 hello world' })
      const meta = loadSessionMeta('test-session-1')
      expect(meta).not.toBeNull()
      expect(meta!.model).toBe('claude-sonnet-4-5')
      expect(meta!.messageCount).toBe(2)
      expect(meta!.title).toBe('帮我写一个 hello world')
    })

    it('不存在的会话元数据返回 null', () => {
      expect(loadSessionMeta('no-such-session')).toBeNull()
    })

    it('更新已有元数据保留 createdAt', () => {
      saveSessionMeta('test-session-update', { model: 'gpt-4o', eventCount: 1, title: '第一次' })
      const first = loadSessionMeta('test-session-update')!
      saveSessionMeta('test-session-update', { model: 'gpt-4o', eventCount: 3, title: '更新后' })
      const second = loadSessionMeta('test-session-update')!
      expect(second.createdAt).toBe(first.createdAt)
      expect(second.title).toBe('更新后')
      expect(second.messageCount).toBe(3)
    })
  })

  describe('listSessions', () => {
    it('无会话时返回空数组', () => {
      expect(listSessions()).toEqual([])
    })
  })
})
