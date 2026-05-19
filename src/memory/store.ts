// 记忆存储 —— JSONL 桶文件 + SQLite 向量索引/知识图谱
// 每个智能体独立存储：~/.hrids/agents/{agent}/memory/
//   facts.jsonl / preferences.jsonl / decisions.jsonl — 记忆数据
//   index.db — 向量索引 + 知识图谱三元组
import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, copyFileSync, renameSync } from 'fs'
import { join } from 'path'
import { getConfigDir } from '../core/config.js'
import type { Memory, MemoryType, Triple, MemorySearchResult } from './types.js'
import { getEmbeddingProvider } from './embedding.js'
import { createVectorStore, type VectorStore } from './vector-store.js'

const AGENTS_DIR = join(getConfigDir(), 'agents')

function getAgentMemoryDir(agent: string): string {
  if (/[/\\]/.test(agent) || agent.includes('..')) {
    throw new Error(`Invalid agent name: ${agent}`)
  }
  return join(AGENTS_DIR, agent, 'memory')
}

type BucketName = 'facts' | 'preferences' | 'decisions'

function typeToBucket(type: MemoryType): BucketName {
  switch (type) {
    case 'fact': return 'facts'
    case 'preference': return 'preferences'
    case 'decision': return 'decisions'
    case 'milestone': return 'facts'
    case 'problem': return 'facts'
  }
}

const BUCKET_NAMES: BucketName[] = ['facts', 'preferences', 'decisions']

export class MemoryStore {
  private dir: string
  private db: Database.Database
  private vec: VectorStore
  private _dim: number | null = null

  constructor(agent = 'main') {
    this.dir = getAgentMemoryDir(agent)
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })

    // 确保 JSONL 桶文件存在
    for (const bucket of BUCKET_NAMES) {
      const p = this._bucketPath(bucket)
      if (!existsSync(p)) writeFileSync(p, '', 'utf-8')
    }

    // SQLite 仅用于向量索引 + 知识图谱
    const dbPath = join(this.dir, 'index.db')
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')

    // 为向量后端保留最小 memories 表（仅 rowid + id 映射，不存内容）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        id    TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS vec_config (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS triples (
        id           TEXT PRIMARY KEY,
        subject      TEXT NOT NULL,
        predicate    TEXT NOT NULL,
        object       TEXT NOT NULL,
        valid_from   TEXT,
        valid_to     TEXT,
        confidence   REAL NOT NULL DEFAULT 1.0,
        source_mem   TEXT,
        created_at   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tri_subject ON triples(subject);
      CREATE INDEX IF NOT EXISTS idx_tri_object  ON triples(object);
    `)

    this.vec = createVectorStore(this.db)
    this._initPromise = this._restoreDim()
  }

  private _initPromise: Promise<void>
  /** 等待向量索引初始化完成（构造后首次向量操作前应 await） */
  async ready(): Promise<void> { await this._initPromise }

  private async _restoreDim(): Promise<void> {
    const saved = this.db.prepare("SELECT value FROM vec_config WHERE key='dim'").get() as { value: string } | undefined
    if (saved) {
      this._dim = parseInt(saved.value, 10)
      await this.vec.init(this._dim)
    }
  }

  private _bucketPath(bucket: BucketName): string {
    return join(this.dir, `${bucket}.jsonl`)
  }

  // ── JSONL 操作 ──────────────────────────────────────────────

  private _loadBucket(bucket: BucketName): Memory[] {
    const content = readFileSync(this._bucketPath(bucket), 'utf-8')
    if (!content.trim()) return []
    const results: Memory[] = []
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try {
        results.push(JSON.parse(line) as Memory)
      } catch {
        process.stderr.write(`[memory] 损坏的 JSONL 行 (${bucket}): ${line.slice(0, 100)}\n`)
      }
    }
    return results
  }

  private _saveBucket(bucket: BucketName, memories: Memory[]) {
    const lines = memories.map(m => JSON.stringify(m))
    const target = this._bucketPath(bucket)
    const tmp = target + '.tmp'
    writeFileSync(tmp, lines.join('\n') + (lines.length > 0 ? '\n' : ''), 'utf-8')
    renameSync(tmp, target)
  }

  private _appendBucket(bucket: BucketName, mem: Memory) {
    appendFileSync(this._bucketPath(bucket), JSON.stringify(mem) + '\n', 'utf-8')
  }

  /** 在桶文件内定位记忆并替换 */
  private _updateInBucket(bucket: BucketName, id: string, updater: (m: Memory) => Memory): boolean {
    const mems = this._loadBucket(bucket)
    const idx = mems.findIndex(m => m.id === id)
    if (idx === -1) return false
    mems[idx] = updater(mems[idx])
    this._saveBucket(bucket, mems)
    return true
  }

  /** 在所有桶中查找记忆 */
  private _findInAllBuckets(id: string): Memory | null {
    for (const bucket of BUCKET_NAMES) {
      const mems = this._loadBucket(bucket)
      const found = mems.find(m => m.id === id)
      if (found) return found
    }
    return null
  }

  // ── 记忆写入 ──────────────────────────────────────────────

  addMemory(mem: Omit<Memory, 'id' | 'createdAt' | 'updatedAt'>): Memory {
    const id = `mem_${randomUUID().replace(/-/g, '').slice(0, 16)}`
    const now = new Date().toISOString()
    const full: Memory = { ...mem, id, createdAt: now, updatedAt: now }
    const bucket = typeToBucket(mem.type)

    // 写入 JSONL 桶
    this._appendBucket(bucket, full)

    // 向量映射（最小 rowid）
    this.db.prepare('INSERT INTO memories (id) VALUES (?)').run(id)

    // 异步生成向量（附带错误日志，避免静默丢失）
    this._embedAndInsertVec(id, full.content).catch(err => {
      process.stderr.write(`[memory] 向量嵌入失败 (${id}): ${err}\n`)
    })

    return full
  }

  private async _embedAndInsertVec(id: string, content: string): Promise<void> {
    await this.ready()
    try {
      const provider = getEmbeddingProvider()
      const vec = await provider.embed(content)
      const dim = vec.length

      if (this._dim === null) {
        this._dim = dim
        this.db.prepare("INSERT OR REPLACE INTO vec_config (key, value) VALUES ('dim', ?)").run(String(dim))
        await this.vec.init(dim)
      }

      if (dim !== this._dim) {
        const { auditLog } = await import('../shared/audit.js')
        auditLog({ action: 'memory_dim_migration', resource: id, result: 'allowed', details: { from: this._dim, to: dim } })
        // 删除旧维度的向量表，用新维度重建
        this._dim = dim
        try { this.db.exec('DROP TABLE IF EXISTS vec_memories') } catch { /* 首次无表 */ }
        await this.vec.init(dim)
      }

      await this.vec.upsert(id, vec)
    } catch (err) {
      try {
        const { auditLog } = await import('../shared/audit.js')
        auditLog({ action: 'memory_embed_error', resource: id, result: 'error', details: { error: String(err) } })
      } catch { /* 忽略 */ }
    }
  }

  // ── 向量去重 ──────────────────────────────────────────────

  async findSimilar(content: string, threshold = 0.85, topK = 3): Promise<MemorySearchResult[]> {
    await this.ready()
    if (this._dim === null) return []
    try {
      const provider = getEmbeddingProvider()
      const vec = await provider.embed(content)
      if (vec.length !== this._dim) return []
      const hits = await this.vec.search(vec, topK)
      return hits
        .filter(h => h.score >= threshold)
        .map(h => ({ memory: this.getMemory(h.id)!, score: h.score }))
        .filter(r => r.memory != null)
    } catch {
      return []
    }
  }

  // ── 更新/删除 ──────────────────────────────────────────────

  updateMemory(oldId: string, patch: Partial<Pick<Memory, 'content' | 'type' | 'importance'>>): Memory | null {
    const old = this.getMemory(oldId)
    if (!old) return null

    const newMem = this.addMemory({
      content: patch.content ?? old.content,
      type: patch.type ?? old.type,
      agent: old.agent,
      importance: patch.importance ?? old.importance,
      sourceSession: old.sourceSession,
    })

    // 标记旧记忆为已失效（在对应桶中更新）
    const oldBucket = typeToBucket(old.type)
    this._updateInBucket(oldBucket, oldId, m => ({ ...m, supersededBy: newMem.id, updatedAt: new Date().toISOString() }))

    // 同步删除旧向量
    this.vec.delete(oldId).catch(err => {
      process.stderr.write(`[memory] 向量删除失败 (${oldId}): ${err}\n`)
    })

    return newMem
  }

  deleteMemory(id: string): boolean {
    this.vec.delete(id).catch(err => {
      process.stderr.write(`[memory] 向量删除失败 (${id}): ${err}\n`)
    })
    // 清理 memories 表的 rowid 映射，防止孤立行泄漏
    try { this.db.prepare('DELETE FROM memories WHERE id = ?').run(id) } catch { /* 表可能不存在 */ }
    for (const bucket of BUCKET_NAMES) {
      const mems = this._loadBucket(bucket)
      const idx = mems.findIndex(m => m.id === id)
      if (idx !== -1) {
        mems.splice(idx, 1)
        this._saveBucket(bucket, mems)
        return true
      }
    }
    return false
  }

  getMemory(id: string): Memory | null {
    return this._findInAllBuckets(id)
  }

  // ── 记忆检索 ──────────────────────────────────────────────

  /** 获取所有活跃记忆（未被取代） */
  getActiveMemories(agent?: string): Memory[] {
    const all: Memory[] = []
    for (const bucket of BUCKET_NAMES) {
      all.push(...this._loadBucket(bucket).filter(m => !m.supersededBy))
    }
    if (agent) return all.filter(m => m.agent === agent)
    return all
  }

  listMemories(opts: { agent?: string; type?: MemoryType; limit?: number } = {}): Memory[] {
    let mems = this.getActiveMemories(opts.agent)
    if (opts.type) mems = mems.filter(m => m.type === opts.type)
    mems.sort((a, b) => b.importance - a.importance || b.createdAt.localeCompare(a.createdAt))
    return mems.slice(0, opts.limit ?? 50)
  }

  async search(query: string, opts: { topK?: number } = {}): Promise<MemorySearchResult[]> {
    await this.ready()
    const topK = opts.topK ?? 5

    if (this._dim !== null) {
      try {
        const provider = getEmbeddingProvider()
        const queryVec = await provider.embed(query)
        if (queryVec.length === this._dim) {
          const hits = await this.vec.search(queryVec, topK * 2)
          const results: MemorySearchResult[] = []
          for (const { id, score } of hits) {
            const mem = this.getMemory(id)
            if (!mem || mem.supersededBy) continue
            results.push({ memory: mem, score })
            if (results.length >= topK) break
          }
          if (results.length > 0) return results
        }
      } catch { /* 降级 */ }
    }

    return this._keywordSearch(query, topK)
  }

  private _keywordSearch(query: string, topK = 5): MemorySearchResult[] {
    const candidates = this.getActiveMemories()
    const queryLower = query.toLowerCase()
    // 提取查询词：空格分词 + 中文字符 bigram
    const queryWords = new Set<string>()
    for (const w of queryLower.split(/\s+/).filter(w => w.length > 1)) {
      queryWords.add(w)
    }
    // 中文字符 bigram（连续两个中文字符作为一个词）
    const cjkBigrams = queryLower.match(/[一-鿿]{2,}/g) ?? []
    for (const bg of cjkBigrams) {
      for (let i = 0; i < bg.length - 1; i++) {
        queryWords.add(bg.slice(i, i + 2))
      }
    }

    return candidates
      .map(mem => {
        const contentLower = mem.content.toLowerCase()
        const contentWords = new Set(contentLower.split(/\s+/).filter(w => w.length > 1))
        // 也为内容提取中文 bigram
        const contentCjk = contentLower.match(/[一-鿿]{2,}/g) ?? []
        for (const bg of contentCjk) {
          for (let i = 0; i < bg.length - 1; i++) {
            contentWords.add(bg.slice(i, i + 2))
          }
        }
        const intersection = [...queryWords].filter(w => contentWords.has(w)).length
        const score = intersection / Math.max(queryWords.size, 1) * 0.5
        return { memory: mem, score }
      })
      .filter(r => r.score > 0.05)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
  }

  // ── 核心摘要 ──────────────────────────────────────────────

  getEssentialStory(agent?: string, maxItems = 15, maxChars = 3200): string {
    const mems = this.getActiveMemories(agent)
    if (mems.length === 0) return '暂无记忆。'

    const now = Date.now()
    const scored = mems.map(m => {
      const ageDays = (now - new Date(m.updatedAt || m.createdAt).getTime()) / 86_400_000
      const decayed = m.importance * Math.exp(-ageDays / 90)
      return { m, decayed }
    }).sort((a, b) => b.decayed - a.decayed).slice(0, maxItems)

    const byType = new Map<string, Memory[]>()
    for (const { m } of scored) {
      const list = byType.get(m.type) ?? []
      list.push(m)
      byType.set(m.type, list)
    }

    const lines = ['## 核心记忆']
    let total = 0
    for (const [type, items] of byType) {
      lines.push(`\n[${type}]`)
      for (const m of items) {
        const snippet = m.content.replace(/\n/g, ' ').slice(0, 200)
        const entry = `  - ${snippet}`
        if (total + entry.length > maxChars) {
          lines.push('  ... (更多记忆可通过搜索获取)')
          return lines.join('\n')
        }
        lines.push(entry)
        total += entry.length
      }
    }
    return lines.join('\n')
  }

  // ── 知识图谱 ──────────────────────────────────────────────

  addTriple(
    subject: string, predicate: string, object: string,
    opts: { validFrom?: string; confidence?: number; sourceMemId?: string } = {}
  ): Triple {
    const subId = subject.toLowerCase().replace(/\s+/g, '_')
    const objId = object.toLowerCase().replace(/\s+/g, '_')
    const pred = predicate.toLowerCase().replace(/\s+/g, '_')

    const existing = this.db.prepare(
      'SELECT id FROM triples WHERE subject=? AND predicate=? AND object=? AND valid_to IS NULL'
    ).get(subId, pred, objId) as { id: string } | undefined
    if (existing) return this.getTriple(existing.id)!

    const id = `t_${createHash('sha256').update(`${subId}${pred}${objId}${Date.now()}`).digest('hex').slice(0, 12)}`
    const createdAt = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO triples (id, subject, predicate, object, valid_from, valid_to, confidence, source_mem, created_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)
    `).run(id, subId, pred, objId, opts.validFrom ?? null, opts.confidence ?? 1.0, opts.sourceMemId ?? null, createdAt)

    return { id, subject: subId, predicate: pred, object: objId, validFrom: opts.validFrom, confidence: opts.confidence ?? 1.0, sourceMemoryId: opts.sourceMemId, createdAt }
  }

  invalidateTriple(subject: string, predicate: string, object: string, endedAt?: string) {
    const subId = subject.toLowerCase().replace(/\s+/g, '_')
    const objId = object.toLowerCase().replace(/\s+/g, '_')
    const pred = predicate.toLowerCase().replace(/\s+/g, '_')
    const ended = endedAt ?? new Date().toISOString().slice(0, 10)
    this.db.prepare(
      'UPDATE triples SET valid_to=? WHERE subject=? AND predicate=? AND object=? AND valid_to IS NULL'
    ).run(ended, subId, pred, objId)
  }

  queryEntity(name: string, opts: { asOf?: string; direction?: 'outgoing' | 'incoming' | 'both' } = {}): Triple[] {
    const eid = name.toLowerCase().replace(/\s+/g, '_')
    const dir = opts.direction ?? 'outgoing'
    const results: Triple[] = []
    const timeFilter = opts.asOf
      ? 'AND (valid_from IS NULL OR valid_from <= ?) AND (valid_to IS NULL OR valid_to >= ?)'
      : 'AND valid_to IS NULL'
    const timeParams = opts.asOf ? [opts.asOf, opts.asOf] : []

    if (dir === 'outgoing' || dir === 'both') {
      const rows = this.db.prepare(
        `SELECT * FROM triples WHERE subject=? ${timeFilter} ORDER BY created_at DESC`
      ).all(eid, ...timeParams) as Record<string, unknown>[]
      results.push(...rows.map(r => this._rowToTriple(r)))
    }
    if (dir === 'incoming' || dir === 'both') {
      const rows = this.db.prepare(
        `SELECT * FROM triples WHERE object=? ${timeFilter} ORDER BY created_at DESC`
      ).all(eid, ...timeParams) as Record<string, unknown>[]
      results.push(...rows.map(r => this._rowToTriple(r)))
    }
    return results
  }

  getTriple(id: string): Triple | null {
    const row = this.db.prepare('SELECT * FROM triples WHERE id=?').get(id) as Record<string, unknown> | undefined
    return row ? this._rowToTriple(row) : null
  }

  // ── 统计 ──────────────────────────────────────────────────

  async stats() {
    let total = 0
    const byType: Record<string, number> = {}
    for (const bucket of BUCKET_NAMES) {
      const mems = this._loadBucket(bucket)
      total += mems.length
      for (const m of mems) {
        byType[m.type] = (byType[m.type] ?? 0) + 1
      }
    }

    let vecCount = 0
    if (this._dim !== null) {
      vecCount = await this.vec.count()
    }

    const triples = (this.db.prepare('SELECT COUNT(*) as c FROM triples WHERE valid_to IS NULL').get() as { c: number }).c

    return {
      totalMemories: total,
      indexedVectors: vecCount,
      byType,
      activeTriples: triples,
      embeddingDim: this._dim,
    }
  }

  close() { this.db.close() }

  // ── 私有辅助 ──────────────────────────────────────────────

  private _rowToTriple(row: Record<string, unknown>): Triple {
    return {
      id: row.id as string,
      subject: row.subject as string,
      predicate: row.predicate as string,
      object: row.object as string,
      validFrom: row.valid_from as string | undefined,
      validTo: row.valid_to as string | undefined,
      confidence: row.confidence as number,
      sourceMemoryId: row.source_mem as string | undefined,
      createdAt: row.created_at as string,
    }
  }
}

// ── 单例管理 ──────────────────────────────────────────────────

let _store: MemoryStore | null = null
export function getMemoryStore(): MemoryStore {
  if (!_store) _store = new MemoryStore('main')
  return _store
}

const _sessionStores = new Map<string, MemoryStore>()

export function getMemoryStoreForSession(sessionId: string): MemoryStore {
  let store = _sessionStores.get(sessionId)
  if (!store) {
    store = new MemoryStore('main')
    _sessionStores.set(sessionId, store)
  }
  return store
}

export function destroyMemoryStoreForSession(sessionId: string): void {
  const store = _sessionStores.get(sessionId)
  if (store) {
    try { store.close() } catch { /* 忽略 */ }
    _sessionStores.delete(sessionId)
  }
}

// ── 旧数据库迁移 ──────────────────────────────────────────────

export function migrateOldMemoryStore(): boolean {
  const oldDbPath = join(getConfigDir(), 'memory', 'palace.db')
  const newDir = getAgentMemoryDir('main')

  if (!existsSync(oldDbPath)) return false
  if (existsSync(join(newDir, 'index.db'))) return false

  if (!existsSync(newDir)) mkdirSync(newDir, { recursive: true })

  try {
    // 读取旧数据库中的记忆，转换为新格式并写入 JSONL
    const oldDb = new Database(oldDbPath, { readonly: true })
    const rows = oldDb.prepare('SELECT * FROM memories WHERE superseded_by IS NULL').all() as Record<string, unknown>[]

    const bucketMap: Record<string, Memory[]> = { facts: [], preferences: [], decisions: [] }

    for (const row of rows) {
      const type = row.type as string
      let bucket: BucketName
      if (type === 'preference') bucket = 'preferences'
      else if (type === 'decision') bucket = 'decisions'
      else bucket = 'facts'

      const mem: Memory = {
        id: row.id as string,
        content: row.content as string,
        type: type as MemoryType,
        agent: 'main',
        importance: row.importance as number,
        createdAt: row.created_at as string,
        updatedAt: row.created_at as string,
        sourceSession: row.source_session as string | undefined,
      }
      bucketMap[bucket].push(mem)
    }

    for (const [bucket, mems] of Object.entries(bucketMap)) {
      if (mems.length > 0) {
        const lines = mems.map(m => JSON.stringify(m))
        writeFileSync(join(newDir, `${bucket}.jsonl`), lines.join('\n') + '\n', 'utf-8')
      }
    }

    oldDb.close()

    // 复制旧数据库为 index.db（保留向量和三元组）
    copyFileSync(oldDbPath, join(newDir, 'index.db'))

    console.log('[memory] 已从旧格式迁移记忆数据到 JSONL + index.db')
    return true
  } catch (err) {
    console.error('[memory] 迁移失败:', err)
    return false
  }
}
