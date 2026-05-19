// vectorStore.ts — 向量存储后端抽象层
// 支持：sqlite-vec（默认）| pgvector | seekdb
// 通过 VECTOR_STORE 环境变量切换，留空则使用 sqlite-vec

export interface VectorSearchResult {
  id: string       // memory id（字符串）
  score: number    // 相似度 0-1
}

/** 向量存储后端接口 */
export interface VectorStore {
  /** 初始化（建表/连接等），dim 为向量维度 */
  init(dim: number): Promise<void>
  /** 插入或更新一条向量，rowKey 为关联的 memory id */
  upsert(rowKey: string, vector: number[]): Promise<void>
  /** 删除一条向量 */
  delete(rowKey: string): Promise<void>
  /** KNN 搜索，返回最相似的 topK 条 */
  search(queryVec: number[], topK: number): Promise<VectorSearchResult[]>
  /** 已索引的向量数量 */
  count(): Promise<number>
  /** 关闭连接 */
  close(): Promise<void>
}

// ── sqlite-vec 后端（默认，无需额外服务）────────────────────────

import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { vectorToBuffer } from './embedding.js'

export class SqliteVecStore implements VectorStore {
  private db: Database.Database
  private dim: number | null = null
  // 实例级映射，避免多个 SqliteVecStore 实例（Gateway 多会话）共享全局 Map 导致 rowid 冲突
  private rowidToId = new Map<number, string>()
  private idToRowid = new Map<string, number>()

  constructor(db: Database.Database) {
    this.db = db
    sqliteVec.load(this.db)
  }

  async init(dim: number): Promise<void> {
    this.dim = dim
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vec_config (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories
      USING vec0(embedding float[${dim}])
    `)
    this.db.prepare("INSERT OR REPLACE INTO vec_config (key, value) VALUES ('dim', ?)").run(String(dim))
    // 重建 rowid 映射
    this._rebuildCache()
  }

  private _rebuildCache() {
    // 清空旧映射，防止维度迁移后新旧数据混合
    this.rowidToId.clear()
    this.idToRowid.clear()
    // 从 memories 表重建映射（vec0 rowid 与 memories rowid 对应）
    try {
      const rows = this.db.prepare('SELECT rowid, id FROM memories').all() as { rowid: number; id: string }[]
      for (const { rowid, id } of rows) {
        this.rowidToId.set(rowid, id)
        this.idToRowid.set(id, rowid)
      }
    } catch { /* memories 表可能还未创建 */ }
  }

  async upsert(memId: string, vector: number[]): Promise<void> {
    if (!this.dim) throw new Error('SqliteVecStore 未初始化')
    // 获取 memories 表中该 id 对应的 rowid
    const row = this.db.prepare('SELECT rowid FROM memories WHERE id = ?').get(memId) as { rowid: number } | undefined
    if (!row) return
    const rowid = row.rowid
    this.rowidToId.set(rowid, memId)
    this.idToRowid.set(memId, rowid)
    const blob = vectorToBuffer(vector)
    this.db.prepare('INSERT OR REPLACE INTO vec_memories (rowid, embedding) VALUES (?, ?)').run(BigInt(rowid), blob)
  }

  async delete(memId: string): Promise<void> {
    const rowid = this.idToRowid.get(memId)
    if (rowid === undefined) return
    try {
      this.db.prepare('DELETE FROM vec_memories WHERE rowid = ?').run(BigInt(rowid))
    } catch { /* vec0 表可能不存在 */ }
    this.rowidToId.delete(rowid)
    this.idToRowid.delete(memId)
  }

  async search(queryVec: number[], topK: number): Promise<VectorSearchResult[]> {
    if (!this.dim) return []
    const blob = vectorToBuffer(queryVec)
    const candidates = topK * 10
    const rows = this.db.prepare(`
      SELECT rowid, distance
      FROM vec_memories
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `).all(blob, candidates) as { rowid: number; distance: number }[]

    const results: VectorSearchResult[] = []
    for (const { rowid, distance } of rows) {
      const id = this.rowidToId.get(rowid)
      if (!id) continue
      // L2 距离转余弦相似度（归一化向量）
      const score = Math.max(0, 1 - (distance * distance) / 2)
      results.push({ id, score })
      if (results.length >= topK) break
    }
    return results
  }

  async count(): Promise<number> {
    try {
      return (this.db.prepare('SELECT COUNT(*) as c FROM vec_memories').get() as { c: number }).c
    } catch { return 0 }
  }

  async close(): Promise<void> { /* SQLite 由 MemoryStore 统一关闭 */ }
}

// ── PGVector 后端 ────────────────────────────────────────────────
// 依赖：pg（npm install pg @types/pg）
// 连接串：VECTOR_STORE_URL=postgresql://user:pass@host:5432/dbname

export class PgVectorStore implements VectorStore {
  private url: string
  private table: string
  private dim: number | null = null
  // 懒加载 pg，避免未安装时报错
  private pool: unknown = null

  constructor(url: string, table = 'memory_vectors') {
    this.url = url
    // 表名仅允许字母、数字、下划线，防止 SQL 注入
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
      throw new Error(`非法的表名: ${table}（仅允许字母、数字、下划线，且以字母或下划线开头）`)
    }
    this.table = table
  }

  private async _pool() {
    if (!this.pool) {
      const { Pool } = await import('pg' as never) as { Pool: new (opts: { connectionString: string }) => unknown }
      this.pool = new Pool({ connectionString: this.url })
    }
    return this.pool as { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }
  }

  async init(dim: number): Promise<void> {
    this.dim = dim
    const pool = await this._pool()
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector')
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        mem_id TEXT PRIMARY KEY,
        embedding vector(${dim})
      )
    `)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_${this.table}_vec ON ${this.table} USING ivfflat (embedding vector_cosine_ops)`)
  }

  async upsert(memId: string, vector: number[]): Promise<void> {
    const pool = await this._pool()
    await pool.query(
      `INSERT INTO ${this.table} (mem_id, embedding) VALUES ($1, $2)
       ON CONFLICT (mem_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
      [memId, `[${vector.join(',')}]`]
    )
  }

  async delete(memId: string): Promise<void> {
    const pool = await this._pool()
    await pool.query(`DELETE FROM ${this.table} WHERE mem_id = $1`, [memId])
  }

  async search(queryVec: number[], topK: number): Promise<VectorSearchResult[]> {
    const pool = await this._pool()
    const { rows } = await pool.query(
      `SELECT mem_id, 1 - (embedding <=> $1) AS score
       FROM ${this.table}
       ORDER BY embedding <=> $1
       LIMIT $2`,
      [`[${queryVec.join(',')}]`, topK]
    )
    return (rows as { mem_id: string; score: number }[]).map(r => ({ id: r.mem_id, score: r.score }))
  }

  async count(): Promise<number> {
    const pool = await this._pool()
    const { rows } = await pool.query(`SELECT COUNT(*) as c FROM ${this.table}`)
    return parseInt((rows[0] as { c: string }).c, 10)
  }

  async close(): Promise<void> {
    if (this.pool) await (this.pool as { end: () => Promise<void> }).end()
  }
}

// ── SeekDB 后端 ──────────────────────────────────────────────────
// SeekDB 提供兼容 OpenSearch/Elasticsearch 的向量搜索 HTTP API
// 连接串：VECTOR_STORE_URL=http://host:9200
// 索引名：VECTOR_STORE_TABLE（默认 memory_vectors）

export class SeekDbStore implements VectorStore {
  private baseUrl: string
  private index: string
  private dim: number | null = null

  constructor(baseUrl: string, index = 'memory_vectors') {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.index = index
  }

  private async _req(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok && res.status !== 404) {
      throw new Error(`SeekDB ${method} ${path} → ${res.status}: ${await res.text()}`)
    }
    return res.status === 404 ? null : res.json()
  }

  async init(dim: number): Promise<void> {
    this.dim = dim
    await this._req('PUT', `/${this.index}`, {
      mappings: {
        properties: {
          mem_id: { type: 'keyword' },
          embedding: { type: 'knn_vector', dimension: dim },
        },
      },
      settings: { 'index.knn': true },
    })
  }

  async upsert(memId: string, vector: number[]): Promise<void> {
    await this._req('PUT', `/${this.index}/_doc/${encodeURIComponent(memId)}`, {
      mem_id: memId,
      embedding: vector,
    })
  }

  async delete(memId: string): Promise<void> {
    await this._req('DELETE', `/${this.index}/_doc/${encodeURIComponent(memId)}`)
  }

  async search(queryVec: number[], topK: number): Promise<VectorSearchResult[]> {
    const res = await this._req('POST', `/${this.index}/_search`, {
      size: topK,
      query: {
        knn: { embedding: { vector: queryVec, k: topK } },
      },
    }) as { hits?: { hits?: Array<{ _id: string; _score: number }> } } | null

    return (res?.hits?.hits ?? []).map(h => ({ id: h._id, score: h._score }))
  }

  async count(): Promise<number> {
    const res = await this._req('GET', `/${this.index}/_count`) as { count?: number } | null
    return res?.count ?? 0
  }

  async close(): Promise<void> { /* HTTP 无需关闭 */ }
}

// ── 工厂函数：根据 config.yaml 创建对应后端 ──────────────────────────

import { createRequire } from 'module'
const _require = createRequire(import.meta.url)

export function createVectorStore(db: Database.Database): VectorStore {
  const { loadConfig } = _require('../core/config.js') as { loadConfig: () => import('../core/config.js').AgentConfig }
  const cfg = loadConfig().vectorStore ?? {}
  const backend = (cfg.backend ?? 'sqlite').toLowerCase()
  const url = cfg.url ?? ''
  const table = cfg.table ?? 'memory_vectors'

  switch (backend) {
    case 'pgvector':
    case 'pg':
      if (!url) throw new Error('vectorStore.backend=pgvector 需要配置 vectorStore.url')
      return new PgVectorStore(url, table)
    case 'seekdb':
      if (!url) throw new Error('vectorStore.backend=seekdb 需要配置 vectorStore.url')
      return new SeekDbStore(url, table)
    default:
      return new SqliteVecStore(db)
  }
}
