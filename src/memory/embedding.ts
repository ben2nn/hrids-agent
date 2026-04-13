// Embedding 提供商 —— 生成语义向量，替代 TF-IDF
// 支持 OpenAI API / Ollama 本地模型 / 降级 TF-IDF
// 向量维度：OpenAI text-embedding-3-small = 1536，Ollama nomic-embed-text = 768

export interface EmbeddingConfig {
  provider: 'openai' | 'ollama' | 'tfidf'
  model?: string       // 默认 openai: text-embedding-3-small, ollama: nomic-embed-text
  apiKey?: string
  baseUrl?: string     // Ollama: http://localhost:11434
  dimensions?: number  // OpenAI 支持降维（如 512），减少存储
}

// ── TF-IDF 降级实现（无需 API）────────────────────────────────

function tokenize(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^\w\u4e00-\u9fff\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1)
}

/** 将 TF 词频 Map 转为固定维度的稀疏向量（哈希技巧，维度 = 2048） */
function tfidfToVector(text: string, dim = 2048): number[] {
  const tokens = tokenize(text)
  const vec = new Array<number>(dim).fill(0)
  const freq = new Map<string, number>()
  for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1)
  const total = tokens.length || 1
  for (const [t, c] of freq) {
    // FNV-1a 哈希映射到维度
    let h = 2166136261
    for (let i = 0; i < t.length; i++) {
      h ^= t.charCodeAt(i)
      h = (h * 16777619) >>> 0
    }
    vec[h % dim] += c / total
  }
  return vec
}

// ── 向量工具 ─────────────────────────────────────────────────

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

/** Float32 数组 → Buffer（存 SQLite BLOB） */
export function vectorToBuffer(vec: number[]): Buffer {
  const buf = Buffer.allocUnsafe(vec.length * 4)
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4)
  return buf
}

/** Buffer → Float32 数组 */
export function bufferToVector(buf: Buffer): number[] {
  const len = buf.length / 4
  const vec = new Array<number>(len)
  for (let i = 0; i < len; i++) vec[i] = buf.readFloatLE(i * 4)
  return vec
}

// ── EmbeddingProvider ─────────────────────────────────────────

export class EmbeddingProvider {
  private config: EmbeddingConfig
  // 简单的内存缓存，避免对相同文本重复调用 API
  private cache = new Map<string, number[]>()

  constructor(config: EmbeddingConfig) {
    this.config = config
  }

  get dimensions(): number {
    if (this.config.provider === 'tfidf') return 2048
    if (this.config.dimensions) return this.config.dimensions
    if (this.config.provider === 'ollama') return 768
    return 1536  // OpenAI text-embedding-3-small 默认
  }

  async embed(text: string): Promise<number[]> {
    const cacheKey = `${this.config.provider}:${text.slice(0, 200)}`
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey)!

    let vec: number[]
    switch (this.config.provider) {
      case 'openai':
        vec = await this._embedOpenAI(text)
        break
      case 'ollama':
        vec = await this._embedOllama(text)
        break
      default:
        vec = tfidfToVector(text)
    }

    // 最多缓存 1000 条
    if (this.cache.size >= 1000) {
      const firstKey = this.cache.keys().next().value
      if (firstKey) this.cache.delete(firstKey)
    }
    this.cache.set(cacheKey, vec)
    return vec
  }

  /** 批量 embed，OpenAI 支持批量请求，减少 API 调用次数 */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (this.config.provider === 'tfidf') {
      return texts.map(t => tfidfToVector(t))
    }
    if (this.config.provider === 'openai') {
      return this._embedOpenAIBatch(texts)
    }
    // Ollama 不支持批量，串行调用
    const results: number[][] = []
    for (const t of texts) results.push(await this._embedOllama(t))
    return results
  }

  // ── OpenAI Embeddings API ─────────────────────────────────

  private async _embedOpenAI(text: string): Promise<number[]> {
    const [result] = await this._embedOpenAIBatch([text])
    return result
  }

  private async _embedOpenAIBatch(texts: string[]): Promise<number[][]> {
    const baseUrl = this.config.baseUrl ?? 'https://api.openai.com/v1'
    const model = this.config.model ?? 'text-embedding-3-small'

    const body: Record<string, unknown> = { model, input: texts }
    if (this.config.dimensions) body.dimensions = this.config.dimensions

    const res = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`OpenAI Embeddings API 错误 ${res.status}: ${err}`)
    }

    const data = await res.json() as {
      data: Array<{ embedding: number[]; index: number }>
    }

    // 按 index 排序，确保顺序正确
    return data.data
      .sort((a, b) => a.index - b.index)
      .map(d => d.embedding)
  }

  // ── Ollama Embeddings API ─────────────────────────────────

  private async _embedOllama(text: string): Promise<number[]> {
    const baseUrl = this.config.baseUrl ?? 'http://localhost:11434'
    const model = this.config.model ?? 'nomic-embed-text'

    const res = await fetch(`${baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: text }),
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Ollama Embeddings API 错误 ${res.status}: ${err}`)
    }

    const data = await res.json() as { embedding: number[] }
    return data.embedding
  }

  /** 测试连通性，返回 true 表示可用 */
  async ping(): Promise<boolean> {
    try {
      await this.embed('test')
      return true
    } catch {
      return false
    }
  }
}

// ── 全局单例 ─────────────────────────────────────────────────

let _provider: EmbeddingProvider | null = null

export function getEmbeddingProvider(): EmbeddingProvider {
  if (!_provider) {
    const model = process.env.EMBEDDING_MODEL
    // 有模型名则使用向量 API，否则降级 TF-IDF
    if (model) {
      const baseUrl = process.env.EMBEDDING_BASE_URL
      // 有 baseUrl 且不含 openai.com 则视为 Ollama，否则视为 OpenAI 兼容接口
      const provider: EmbeddingConfig['provider'] =
        baseUrl && !baseUrl.includes('openai.com') && !baseUrl.includes('dashscope')
          ? 'ollama'
          : 'openai'
      _provider = new EmbeddingProvider({
        provider,
        model,
        apiKey: process.env.OPENAI_API_KEY ?? process.env.DASHSCOPE_API_KEY,
        baseUrl,
        dimensions: process.env.EMBEDDING_DIMENSIONS
          ? parseInt(process.env.EMBEDDING_DIMENSIONS, 10)
          : undefined,
      })
    } else {
      _provider = new EmbeddingProvider({ provider: 'tfidf' })
    }
  }
  return _provider
}

/** 重置单例（用于配置变更后重新初始化） */
export function resetEmbeddingProvider(config: EmbeddingConfig) {
  _provider = new EmbeddingProvider(config)
}
