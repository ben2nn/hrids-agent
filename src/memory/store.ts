// 记忆存储 —— SQLite 元数据 + 可插拔向量后端
// 向量后端通过 VECTOR_STORE 环境变量切换：sqlite（默认）| pgvector | seekdb
import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'crypto'
import { existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { Memory, MemoryType, Triple, MemorySearchResult } from './types.js'
import { getEmbeddingProvider } from './embedding.js'
import { createVectorStore, type VectorStore } from './vectorStore.js'

const STORE_DIR = join(homedir(), '.hrids-agent', 'memory')
const DB_PATH = join(STORE_DIR, 'palace.db')

export class MemoryStore {
  private db: Database.Database
  private vec: VectorStore
  // embedding 维度，首次写入时确定，之后不可变
  private _dim: number | null = null

  constructor(dbPath = DB_PATH) {
    if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.vec = createVectorStore(this.db)
    this._initSchema()
    this._migrate()
    this._restoreDim()
  }

  // ── Schema ────────────────────────────────────────────────────

  private _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        rowid         INTEGER PRIMARY KEY AUTOINCREMENT,
        id            TEXT NOT NULL UNIQUE,
        content       TEXT NOT NULL,
        type          TEXT NOT NULL,
        wing          TEXT NOT NULL DEFAULT 'general',
        room          TEXT NOT NULL DEFAULT 'general',
        tags          TEXT NOT NULL DEFAULT '[]',
        importance    REAL NOT NULL DEFAULT 3,
        created_at    TEXT NOT NULL,
        source_session TEXT,
        superseded_by TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_mem_id   ON memories(id);
      CREATE INDEX IF NOT EXISTS idx_mem_wing ON memories(wing);
      CREATE INDEX IF NOT EXISTS idx_mem_room ON memories(room);
      CREATE INDEX IF NOT EXISTS idx_mem_type ON memories(type);

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

      CREATE INDEX IF NOT EXISTS idx_tri_subject   ON triples(subject);
      CREATE INDEX IF NOT EXISTS idx_tri_object    ON triples(object);
      CREATE INDEX IF NOT EXISTS idx_tri_predicate ON triples(predicate);

      CREATE TABLE IF NOT EXISTS identity (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)
  }

  /** 从 vec_config 恢复已保存的向量维度，并初始化向量后端 */
  private _restoreDim() {
    const saved = this.db.prepare("SELECT value FROM vec_config WHERE key='dim'").get() as { value: string } | undefined
    if (saved) {
      this._dim = parseInt(saved.value, 10)
      void this.vec.init(this._dim)
    }
  }

  /** 迁移旧数据库：补充新增列（幂等） */
  private _migrate() {
    try {
      this.db.exec(`ALTER TABLE memories ADD COLUMN superseded_by TEXT`)
    } catch { /* 列已存在，忽略 */ }
  }

  // ── 记忆写入 ──────────────────────────────────────────────────

  addMemory(mem: Omit<Memory, 'id' | 'createdAt' | 'embedding'>): Memory {
    const id = `mem_${randomUUID().replace(/-/g, '').slice(0, 16)}`
    const createdAt = new Date().toISOString()

    // 写入 memories 表，获取自增 rowid
    const result = this.db.prepare(`
      INSERT INTO memories (id, content, type, wing, room, tags, importance, created_at, source_session)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, mem.content, mem.type,
      mem.wing ?? 'general', mem.room ?? 'general',
      JSON.stringify(mem.tags ?? []),
      mem.importance ?? 3,
      createdAt,
      mem.sourceSession ?? null,
    )

    const rowid = Number(result.lastInsertRowid)

    // 异步生成 embedding 并写入向量后端
    void this._embedAndInsertVec(id, mem.content)
    return { ...mem, id, createdAt }
  }

  private async _embedAndInsertVec(id: string, content: string): Promise<void> {
    try {
      const provider = getEmbeddingProvider()
      const vec = await provider.embed(content)
      const dim = vec.length

      // 首次写入时确定维度，初始化向量后端
      if (this._dim === null) {
        this._dim = dim
        this.db.prepare("INSERT OR REPLACE INTO vec_config (key, value) VALUES ('dim', ?)").run(String(dim))
        await this.vec.init(dim)
      }

      if (dim !== this._dim) {
        console.error(`[memory] embedding 维度不匹配：期望 ${this._dim}，实际 ${dim}，跳过 id=${id}`)
        return
      }

      await this.vec.upsert(id, vec)
    } catch (err) {
      console.error(`[memory] embedding 失败 id=${id}:`, err)
    }
  }

  /**
   * 向量去重：查找与给定文本相似度超过阈值的记忆
   * 用于写入前判断是否已有重复内容
   */
  async findSimilar(content: string, threshold = 0.85, topK = 3): Promise<MemorySearchResult[]> {
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

  /**
   * 更新记忆：将旧记忆标记为 superseded，写入新内容
   * 返回新记忆，旧记忆保留但 superseded_by 指向新 id
   */
  updateMemory(
    oldId: string,
    patch: Partial<Pick<Memory, 'content' | 'type' | 'wing' | 'room' | 'importance' | 'tags'>>,
  ): Memory | null {
    const old = this.getMemory(oldId)
    if (!old) return null

    const newMem = this.addMemory({
      content: patch.content ?? old.content,
      type: patch.type ?? old.type,
      wing: patch.wing ?? old.wing,
      room: patch.room ?? old.room,
      importance: patch.importance ?? old.importance,
      tags: patch.tags ?? old.tags,
      sourceSession: old.sourceSession,
    })

    // 标记旧记忆为已失效
    this.db.prepare('UPDATE memories SET superseded_by = ? WHERE id = ?').run(newMem.id, oldId)
    // 同步删除旧向量（避免搜索时命中过时内容）
    void this.vec.delete(oldId)

    return newMem
  }

  deleteMemory(id: string): boolean {
    void this.vec.delete(id)
    const r = this.db.prepare('DELETE FROM memories WHERE id = ?').run(id)
    return r.changes > 0
  }

  getMemory(id: string): Memory | null {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? this._rowToMemory(row) : null
  }

  // ── 记忆检索 ──────────────────────────────────────────────────

  listMemories(opts: {
    wing?: string; room?: string; type?: MemoryType; limit?: number; includeSuperseded?: boolean
  } = {}): Memory[] {
    let sql = 'SELECT * FROM memories WHERE 1=1'
    const params: unknown[] = []
    if (!opts.includeSuperseded) { sql += ' AND superseded_by IS NULL' }
    if (opts.wing) { sql += ' AND wing = ?'; params.push(opts.wing) }
    if (opts.room) { sql += ' AND room = ?'; params.push(opts.room) }
    if (opts.type) { sql += ' AND type = ?'; params.push(opts.type) }
    sql += ' ORDER BY importance DESC, created_at DESC LIMIT ?'
    params.push(opts.limit ?? 50)
    return (this.db.prepare(sql).all(...params) as Record<string, unknown>[]).map(r => this._rowToMemory(r))
  }

  /**
   * L3 语义搜索 —— 使用 sqlite-vec 的 KNN MATCH 查询
   * 有向量索引时：O(log n) HNSW 近似最近邻
   * 无向量索引时（embedding 未就绪）：关键词匹配降级
   */
  async search(query: string, opts: {
    wing?: string; room?: string; topK?: number
  } = {}): Promise<MemorySearchResult[]> {
    const topK = opts.topK ?? 5

    // 尝试向量搜索
    if (this._dim !== null) {
      try {
        const provider = getEmbeddingProvider()
        const queryVec = await provider.embed(query)
        if (queryVec.length === this._dim) {
          const hits = await this.vec.search(queryVec, topK * 2)
          const results: MemorySearchResult[] = []
          for (const { id, score } of hits) {
            const mem = this.getMemory(id)
            if (!mem) continue
            if (opts.wing && mem.wing !== opts.wing) continue
            if (opts.room && mem.room !== opts.room) continue
            results.push({ memory: mem, score })
            if (results.length >= topK) break
          }
          if (results.length > 0) return results
        }
      } catch { /* 降级 */ }
    }

    // 降级：关键词匹配
    return this._keywordSearch(query, opts.wing, opts.room, topK)
  }

  /** 关键词匹配降级（无向量时使用） */
  private _keywordSearch(
    query: string, wing?: string, room?: string, topK = 5
  ): MemorySearchResult[] {
    const candidates = this.listMemories({ wing, room, limit: 200 })
    const queryWords = new Set(
      query.toLowerCase().split(/\s+/).filter(w => w.length > 1)
    )

    return candidates
      .map(mem => {
        const contentWords = new Set(
          mem.content.toLowerCase().split(/\s+/).filter(w => w.length > 1)
        )
        const intersection = [...queryWords].filter(w => contentWords.has(w)).length
        const score = intersection / Math.max(queryWords.size, 1) * 0.5
        return { memory: mem, score }
      })
      .filter(r => r.score > 0.05)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
  }

  /** L1 核心摘要：按时间衰减重要性排序，过滤已失效记忆 */
  getEssentialStory(wing?: string, maxItems = 15, maxChars = 3200): string {
    const mems = this.listMemories({ wing, limit: 100 }) // 已自动过滤 superseded

    if (mems.length === 0) return '## L1 — 暂无记忆。'

    // 时间衰减：90天半衰期，近期记忆权重更高
    const now = Date.now()
    const scored = mems.map(m => {
      const ageDays = (now - new Date(m.createdAt).getTime()) / 86_400_000
      const decayed = m.importance * Math.exp(-ageDays / 90)
      return { m, decayed }
    }).sort((a, b) => b.decayed - a.decayed).slice(0, maxItems)

    const byRoom = new Map<string, Memory[]>()
    for (const { m } of scored) {
      const list = byRoom.get(m.room) ?? []
      list.push(m)
      byRoom.set(m.room, list)
    }

    const lines = ['## L1 — 核心记忆']
    let total = 0
    for (const [room, items] of byRoom) {
      lines.push(`\n[${room}]`)
      for (const m of items) {
        const snippet = m.content.replace(/\n/g, ' ').slice(0, 200)
        const entry = `  - [${m.type}] ${snippet}`
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

  // ── 知识图谱 ──────────────────────────────────────────────────

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

  // ── 身份（L0）────────────────────────────────────────────────

  setIdentity(key: string, value: string) {
    this.db.prepare('INSERT OR REPLACE INTO identity (key, value) VALUES (?, ?)').run(key, value)
  }

  getIdentity(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM identity WHERE key=?').get(key) as { value: string } | undefined
    return row?.value ?? null
  }

  getIdentityText(): string {
    const rows = this.db.prepare('SELECT key, value FROM identity ORDER BY key').all() as { key: string; value: string }[]
    if (rows.length === 0) return '## L0 — 身份\n尚未配置身份信息。'
    const lines = ['## L0 — 身份']
    for (const { key, value } of rows) lines.push(`${key}: ${value}`)
    return lines.join('\n')
  }

  // ── 统计 ─────────────────────────────────────────────────────

  async stats() {
    const total = (this.db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number }).c
    const byType = this.db.prepare('SELECT type, COUNT(*) as c FROM memories GROUP BY type').all() as { type: string; c: number }[]
    const triples = (this.db.prepare('SELECT COUNT(*) as c FROM triples WHERE valid_to IS NULL').get() as { c: number }).c
    const wings = this.db.prepare('SELECT DISTINCT wing FROM memories').all() as { wing: string }[]

    let vecCount = 0
    if (this._dim !== null) {
      vecCount = await this.vec.count()
    }

    return {
      totalMemories: total,
      indexedVectors: vecCount,
      byType: Object.fromEntries(byType.map(r => [r.type, r.c])),
      activeTriples: triples,
      wings: wings.map(r => r.wing),
      embeddingDim: this._dim,
    }
  }

  close() { this.db.close() }

  // ── 私有转换 ─────────────────────────────────────────────────

  private _rowToMemory(row: Record<string, unknown>): Memory {
    return {
      id: row.id as string,
      content: row.content as string,
      type: row.type as MemoryType,
      wing: row.wing as string,
      room: row.room as string,
      tags: JSON.parse(row.tags as string ?? '[]'),
      importance: row.importance as number,
      createdAt: row.created_at as string,
      sourceSession: row.source_session as string | undefined,
      supersededBy: row.superseded_by as string | undefined,
    }
  }

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

// 全局单例
let _store: MemoryStore | null = null
export function getMemoryStore(): MemoryStore {
  if (!_store) _store = new MemoryStore()
  return _store
}
