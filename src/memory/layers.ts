// 4 层记忆堆栈 —— 借鉴 mempalace 的 layers.py
// L0: 身份 (~100 tokens) | L1: 核心摘要 (~500-800) | L2: 按需 | L3: 深度搜索
import { getMemoryStore, getMemoryStoreForSession } from './store.js'
import type { MemoryStore } from './store.js'
import type { MemorySearchResult, WakeUpResult } from './types.js'

export class MemoryStack {
  private store: MemoryStore

  constructor(store?: MemoryStore) {
    this.store = store ?? getMemoryStore()
  }

  // ── L0：身份层 ───────────────────────────────────────────────

  /** 读取身份定义文本（~100 tokens） */
  getIdentity(): string {
    return this.store.getIdentityText()
  }

  setIdentity(key: string, value: string) {
    this.store.setIdentity(key, value)
  }

  // ── L1：核心摘要层 ───────────────────────────────────────────

  /** 生成核心记忆摘要（~500-800 tokens），按重要性排序 */
  getEssentialStory(wing?: string): string {
    return this.store.getEssentialStory(wing)
  }

  // ── L2：按需检索层 ───────────────────────────────────────────

  /** 按 wing/room 过滤检索（~200-500 tokens） */
  recall(opts: { wing?: string; room?: string; limit?: number } = {}): string {
    const mems = this.store.listMemories({ ...opts, limit: opts.limit ?? 10 })
    if (mems.length === 0) {
      const label = [opts.wing, opts.room].filter(Boolean).join('/')
      return `## L2 — 未找到记忆${label ? `（${label}）` : ''}`
    }

    const lines = [`## L2 — 按需记忆（${mems.length} 条）`]
    for (const m of mems) {
      const snippet = m.content.replace(/\n/g, ' ').slice(0, 300)
      lines.push(`  [${m.room}/${m.type}] ${snippet}`)
    }
    return lines.join('\n')
  }

  // ── L3：深度搜索层 ───────────────────────────────────────────

  /** TF-IDF / 语义向量搜索 */
  async search(query: string, opts: { wing?: string; room?: string; topK?: number } = {}): Promise<MemorySearchResult[]> {
    return this.store.search(query, opts)
  }

  /** 格式化搜索结果为文本 */
  async searchText(query: string, opts: { wing?: string; room?: string; topK?: number } = {}): Promise<string> {
    const results = await this.search(query, opts)
    if (results.length === 0) return `## L3 — 未找到与"${query}"相关的记忆`

    const lines = [`## L3 — 搜索结果："${query}"`]
    for (const { memory: m, score } of results) {
      const snippet = m.content.replace(/\n/g, ' ').slice(0, 300)
      lines.push(`  [${m.wing}/${m.room}] (相似度 ${score.toFixed(3)})`)
      lines.push(`    ${snippet}`)
    }
    return lines.join('\n')
  }

  // ── 唤醒（L0 + L1）──────────────────────────────────────────

  /** 生成唤醒文本，注入 system prompt（~600-900 tokens） */
  wakeUp(wing?: string): WakeUpResult {
    const l0 = this.getIdentity()
    const l1 = this.getEssentialStory(wing)
    const combined = `${l0}\n\n${l1}`
    return {
      l0Identity: l0,
      l1Essential: l1,
      totalTokens: Math.ceil(combined.length / 4),
    }
  }

  /** 生成完整的记忆上下文字符串，用于注入 system prompt */
  buildMemoryContext(wing?: string): string {
    const { l0Identity, l1Essential, totalTokens } = this.wakeUp(wing)
    return `${l0Identity}\n\n${l1Essential}\n\n<!-- 记忆上下文约 ${totalTokens} tokens -->`
  }

  // ── 知识图谱 ─────────────────────────────────────────────────

  addFact(subject: string, predicate: string, object: string, opts?: { validFrom?: string; confidence?: number }) {
    return this.store.addTriple(subject, predicate, object, opts)
  }

  invalidateFact(subject: string, predicate: string, object: string, endedAt?: string) {
    this.store.invalidateTriple(subject, predicate, object, endedAt)
  }

  queryEntity(name: string, opts?: { asOf?: string; direction?: 'outgoing' | 'incoming' | 'both' }) {
    return this.store.queryEntity(name, opts)
  }

  // ── 统计 ─────────────────────────────────────────────────────

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

/** Gateway 模式：获取或创建指定会话的 MemoryStack */
export function getMemoryStackForSession(sessionId: string): MemoryStack {
  let stack = _sessionStacks.get(sessionId)
  if (!stack) {
    const store = getMemoryStoreForSession(sessionId)
    stack = new MemoryStack(store)
    _sessionStacks.set(sessionId, stack)
  }
  return stack
}

/** Gateway 模式：销毁会话的 MemoryStack */
export function destroyMemoryStackForSession(sessionId: string): void {
  _sessionStacks.delete(sessionId)
}
