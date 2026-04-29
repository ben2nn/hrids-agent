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
  }
})

import {
  saveSession,
  loadSession,
  loadSessionMeta,
  listSessions,
  generateSessionId,
} from '../../src/core/SessionStore.js'
import type { Message } from '../../src/core/QueryEngine.js'

describe('SessionStore', () => {
  const messages: Message[] = [
    { role: 'user', content: '帮我写一个 hello world' },
    { role: 'assistant', content: 'console.log("Hello World")' },
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

  describe('saveSession / loadSession', () => {
    it('保存后可以读取消息', () => {
      saveSession('test-session-1', messages, 'claude-sonnet-4-5')
      const loaded = loadSession('test-session-1')
      expect(loaded).not.toBeNull()
      expect(loaded).toHaveLength(2)
      expect(loaded![0].role).toBe('user')
      expect(loaded![0].content).toBe('帮我写一个 hello world')
    })

    it('不存在的会话返回 null', () => {
      const result = loadSession('nonexistent-session')
      expect(result).toBeNull()
    })
  })

  describe('loadSessionMeta', () => {
    it('保存后可以读取元数据', () => {
      saveSession('test-session-2', messages, 'gpt-4o')
      const meta = loadSessionMeta('test-session-2')
      expect(meta).not.toBeNull()
      expect(meta!.model).toBe('gpt-4o')
      expect(meta!.messageCount).toBe(2)
      expect(meta!.title).toBe('帮我写一个 hello world')
    })

    it('不存在的会话元数据返回 null', () => {
      expect(loadSessionMeta('no-such-session')).toBeNull()
    })
  })

  describe('listSessions', () => {
    it('无会话时返回空数组', () => {
      expect(listSessions()).toEqual([])
    })
  })
})
