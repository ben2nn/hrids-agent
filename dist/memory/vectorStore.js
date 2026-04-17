// vectorStore.ts — 向量存储后端抽象层
// 支持：sqlite-vec（默认）| pgvector | seekdb
// 通过 VECTOR_STORE 环境变量切换，留空则使用 sqlite-vec
import * as sqliteVec from 'sqlite-vec';
import { vectorToBuffer } from './embedding.js';
// rowid（整数）↔ memory id（字符串）双向映射
const rowidToId = new Map();
const idToRowid = new Map();
export class SqliteVecStore {
    db;
    dim = null;
    nextRowid = 1;
    constructor(db) {
        this.db = db;
        sqliteVec.load(this.db);
    }
    async init(dim) {
        this.dim = dim;
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS vec_config (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories
      USING vec0(embedding float[${dim}])
    `);
        this.db.prepare("INSERT OR REPLACE INTO vec_config (key, value) VALUES ('dim', ?)").run(String(dim));
        // 重建 rowid 映射
        this._rebuildCache();
    }
    _rebuildCache() {
        // 从 memories 表重建映射（vec0 rowid 与 memories rowid 对应）
        try {
            const rows = this.db.prepare('SELECT rowid, id FROM memories').all();
            for (const { rowid, id } of rows) {
                rowidToId.set(rowid, id);
                idToRowid.set(id, rowid);
            }
            if (rows.length > 0) {
                this.nextRowid = Math.max(...rows.map(r => r.rowid)) + 1;
            }
        }
        catch { /* memories 表可能还未创建 */ }
    }
    async upsert(memId, vector) {
        if (!this.dim)
            throw new Error('SqliteVecStore 未初始化');
        // 获取 memories 表中该 id 对应的 rowid
        const row = this.db.prepare('SELECT rowid FROM memories WHERE id = ?').get(memId);
        if (!row)
            return;
        const rowid = row.rowid;
        rowidToId.set(rowid, memId);
        idToRowid.set(memId, rowid);
        const blob = vectorToBuffer(vector);
        this.db.prepare('INSERT OR REPLACE INTO vec_memories (rowid, embedding) VALUES (?, ?)').run(BigInt(rowid), blob);
    }
    async delete(memId) {
        const rowid = idToRowid.get(memId);
        if (rowid === undefined)
            return;
        try {
            this.db.prepare('DELETE FROM vec_memories WHERE rowid = ?').run(BigInt(rowid));
        }
        catch { /* vec0 表可能不存在 */ }
        rowidToId.delete(rowid);
        idToRowid.delete(memId);
    }
    async search(queryVec, topK) {
        if (!this.dim)
            return [];
        const blob = vectorToBuffer(queryVec);
        const candidates = topK * 10;
        const rows = this.db.prepare(`
      SELECT rowid, distance
      FROM vec_memories
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `).all(blob, candidates);
        const results = [];
        for (const { rowid, distance } of rows) {
            const id = rowidToId.get(rowid);
            if (!id)
                continue;
            // L2 距离转余弦相似度（归一化向量）
            const score = Math.max(0, 1 - (distance * distance) / 2);
            results.push({ id, score });
            if (results.length >= topK)
                break;
        }
        return results;
    }
    async count() {
        try {
            return this.db.prepare('SELECT COUNT(*) as c FROM vec_memories').get().c;
        }
        catch {
            return 0;
        }
    }
    async close() { }
}
// ── PGVector 后端 ────────────────────────────────────────────────
// 依赖：pg（npm install pg @types/pg）
// 连接串：VECTOR_STORE_URL=postgresql://user:pass@host:5432/dbname
export class PgVectorStore {
    url;
    table;
    dim = null;
    // 懒加载 pg，避免未安装时报错
    pool = null;
    constructor(url, table = 'memory_vectors') {
        this.url = url;
        this.table = table;
    }
    async _pool() {
        if (!this.pool) {
            const { Pool } = await import('pg');
            this.pool = new Pool({ connectionString: this.url });
        }
        return this.pool;
    }
    async init(dim) {
        this.dim = dim;
        const pool = await this._pool();
        await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
        await pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        mem_id TEXT PRIMARY KEY,
        embedding vector(${dim})
      )
    `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_${this.table}_vec ON ${this.table} USING ivfflat (embedding vector_cosine_ops)`);
    }
    async upsert(memId, vector) {
        const pool = await this._pool();
        await pool.query(`INSERT INTO ${this.table} (mem_id, embedding) VALUES ($1, $2)
       ON CONFLICT (mem_id) DO UPDATE SET embedding = EXCLUDED.embedding`, [memId, `[${vector.join(',')}]`]);
    }
    async delete(memId) {
        const pool = await this._pool();
        await pool.query(`DELETE FROM ${this.table} WHERE mem_id = $1`, [memId]);
    }
    async search(queryVec, topK) {
        const pool = await this._pool();
        const { rows } = await pool.query(`SELECT mem_id, 1 - (embedding <=> $1) AS score
       FROM ${this.table}
       ORDER BY embedding <=> $1
       LIMIT $2`, [`[${queryVec.join(',')}]`, topK]);
        return rows.map(r => ({ id: r.mem_id, score: r.score }));
    }
    async count() {
        const pool = await this._pool();
        const { rows } = await pool.query(`SELECT COUNT(*) as c FROM ${this.table}`);
        return parseInt(rows[0].c, 10);
    }
    async close() {
        if (this.pool)
            await this.pool.end();
    }
}
// ── SeekDB 后端 ──────────────────────────────────────────────────
// SeekDB 提供兼容 OpenSearch/Elasticsearch 的向量搜索 HTTP API
// 连接串：VECTOR_STORE_URL=http://host:9200
// 索引名：VECTOR_STORE_TABLE（默认 memory_vectors）
export class SeekDbStore {
    baseUrl;
    index;
    dim = null;
    constructor(baseUrl, index = 'memory_vectors') {
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this.index = index;
    }
    async _req(method, path, body) {
        const res = await fetch(`${this.baseUrl}${path}`, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
        });
        if (!res.ok && res.status !== 404) {
            throw new Error(`SeekDB ${method} ${path} → ${res.status}: ${await res.text()}`);
        }
        return res.status === 404 ? null : res.json();
    }
    async init(dim) {
        this.dim = dim;
        await this._req('PUT', `/${this.index}`, {
            mappings: {
                properties: {
                    mem_id: { type: 'keyword' },
                    embedding: { type: 'knn_vector', dimension: dim },
                },
            },
            settings: { 'index.knn': true },
        });
    }
    async upsert(memId, vector) {
        await this._req('PUT', `/${this.index}/_doc/${encodeURIComponent(memId)}`, {
            mem_id: memId,
            embedding: vector,
        });
    }
    async delete(memId) {
        await this._req('DELETE', `/${this.index}/_doc/${encodeURIComponent(memId)}`);
    }
    async search(queryVec, topK) {
        const res = await this._req('POST', `/${this.index}/_search`, {
            size: topK,
            query: {
                knn: { embedding: { vector: queryVec, k: topK } },
            },
        });
        return (res?.hits?.hits ?? []).map(h => ({ id: h._id, score: h._score }));
    }
    async count() {
        const res = await this._req('GET', `/${this.index}/_count`);
        return res?.count ?? 0;
    }
    async close() { }
}
// ── 工厂函数：根据环境变量创建对应后端 ──────────────────────────
export function createVectorStore(db) {
    const backend = (process.env.VECTOR_STORE ?? 'sqlite').toLowerCase();
    const url = process.env.VECTOR_STORE_URL ?? '';
    const table = process.env.VECTOR_STORE_TABLE ?? 'memory_vectors';
    switch (backend) {
        case 'pgvector':
        case 'pg':
            if (!url)
                throw new Error('VECTOR_STORE=pgvector 需要配置 VECTOR_STORE_URL');
            return new PgVectorStore(url, table);
        case 'seekdb':
            if (!url)
                throw new Error('VECTOR_STORE=seekdb 需要配置 VECTOR_STORE_URL');
            return new SeekDbStore(url, table);
        default:
            return new SqliteVecStore(db);
    }
}
