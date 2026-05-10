// 记忆堆栈 —— 核心摘要 + 按需检索 + 深度搜索
import { getMemoryStore, getMemoryStoreForSession } from './store.js'
import type { MemoryStore } from './store.js'
import type { MemorySearchResult, WakeUpResult } from './types.js'

export class MemoryStack {
  private store: MemoryStore

  constructor(store?: MemoryStore) {
    this.store = store ?? getMemoryStore()
  }

  // ── 核心摘要 ─────────────────────────────────────────────

  getEssentialStory(agent?: string): string {
    return this.store.getEssentialStory(agent)
  }

  // ── 按需检索 ─────────────────────────────────────────────

  recall(opts: { agent?: string; limit?: number } = {}): string {
    const mems = this.store.listMemories({ agent: opts.agent, limit: opts.limit ?? 10 })
    if (mems.length === 0) return '未找到记忆。'

    const lines = [`按需记忆（${mems.length} 条）`]
    for (const m of mems) {
      const snippet = m.content.replace(/\n/g, ' ').slice(0, 300)
      lines.push(`  [${m.type}] ${snippet}`)
    }
    return lines.join('\n')
  }

  // ── 深度搜索 ─────────────────────────────────────────────

  async search(query: string, opts: { topK?: number } = {}): Promise<MemorySearchResult[]> {
    return this.store.search(query, opts)
  }

  async searchText(query: string, opts: { topK?: number } = {}): Promise<string> {
    const results = await this.search(query, opts)
    if (results.length === 0) return `未找到与"${query}"相关的记忆`

    const lines = [`搜索结果："${query}"`]
    for (const { memory: m, score } of results) {
      const snippet = m.content.replace(/\n/g, ' ').slice(0, 300)
      lines.push(`  (相似度 ${score.toFixed(3)}) ${snippet}`)
    }
    return lines.join('\n')
  }

  // ── 唤醒 ─────────────────────────────────────────────────

  wakeUp(): WakeUpResult {
    const summary = this.getEssentialStory()
    return {
      summary,
      totalTokens: Math.ceil(summary.length / 4),
    }
  }

  buildMemoryContext(): string {
    const { summary, totalTokens } = this.wakeUp()
    return `${summary}\n\n<!-- 记忆上下文约 ${totalTokens} tokens -->`
  }

  // ── 知识图谱 ─────────────────────────────────────────────

  addFact(subject: string, predicate: string, object: string, opts?: { validFrom?: string; confidence?: number }) {
    return this.store.addTriple(subject, predicate, object, opts)
  }

  invalidateFact(subject: string, predicate: string, object: string, endedAt?: string) {
    this.store.invalidateTriple(subject, predicate, object, endedAt)
  }

  queryEntity(name: string, opts?: { asOf?: string; direction?: 'outgoing' | 'incoming' | 'both' }) {
    return this.store.queryEntity(name, opts)
  }

  // ── 统计 ─────────────────────────────────────────────────

  async status() {
    return this.store.stats()
  }
}

// 全局单例（CLI 模式）
let _stack: MemoryStack | null = null
export function getMemoryStack(): MemoryStack {
  if (!_stack) _stack = new MemoryStack()
  return _stack
}

// 会话级实例注册表（Gateway 多会话模式）
const _sessionStacks = new Map<string, MemoryStack>()

export function getMemoryStackForSession(sessionId: string): MemoryStack {
  let stack = _sessionStacks.get(sessionId)
  if (!stack) {
    const store = getMemoryStoreForSession(sessionId)
    stack = new MemoryStack(store)
    _sessionStacks.set(sessionId, stack)
  }
  return stack
}

export function destroyMemoryStackForSession(sessionId: string): void {
  _sessionStacks.delete(sessionId)
}
