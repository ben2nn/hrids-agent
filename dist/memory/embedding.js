// Embedding 提供商 —— 生成语义向量，替代 TF-IDF
// 支持 OpenAI API / Ollama 本地模型 / 降级 TF-IDF
// 支持多模型 Fallback：EMBEDDING_FALLBACK_N 配置，重试三次后切换下一个模型
// 向量维度：OpenAI text-embedding-3-small = 1536，Ollama nomic-embed-text = 768
// 每个模型在切换前的最大重试次数（与 FallbackProvider 保持一致）
const MAX_RETRIES_PER_MODEL = 3;
// ── TF-IDF 降级实现（无需 API）────────────────────────────────
function tokenize(text) {
    return text.toLowerCase()
        .replace(/[^\w\u4e00-\u9fff\s]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length > 1);
}
/** 将 TF 词频 Map 转为固定维度的稀疏向量（哈希技巧，维度 = 2048） */
function tfidfToVector(text, dim = 2048) {
    const tokens = tokenize(text);
    const vec = new Array(dim).fill(0);
    const freq = new Map();
    for (const t of tokens)
        freq.set(t, (freq.get(t) ?? 0) + 1);
    const total = tokens.length || 1;
    for (const [t, c] of freq) {
        // FNV-1a 哈希映射到维度
        let h = 2166136261;
        for (let i = 0; i < t.length; i++) {
            h ^= t.charCodeAt(i);
            h = (h * 16777619) >>> 0;
        }
        vec[h % dim] += c / total;
    }
    return vec;
}
// ── 向量工具 ─────────────────────────────────────────────────
export function cosineSimilarity(a, b) {
    if (a.length !== b.length)
        return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
}
/** Float32 数组 → Buffer（存 SQLite BLOB） */
export function vectorToBuffer(vec) {
    const buf = Buffer.allocUnsafe(vec.length * 4);
    for (let i = 0; i < vec.length; i++)
        buf.writeFloatLE(vec[i], i * 4);
    return buf;
}
/** Buffer → Float32 数组 */
export function bufferToVector(buf) {
    const len = buf.length / 4;
    const vec = new Array(len);
    for (let i = 0; i < len; i++)
        vec[i] = buf.readFloatLE(i * 4);
    return vec;
}
// ── 单一 EmbeddingProvider ────────────────────────────────────
export class EmbeddingProvider {
    config;
    // 简单的内存缓存，避免对相同文本重复调用 API
    cache = new Map();
    constructor(config) {
        this.config = config;
    }
    get name() {
        return `${this.config.provider}/${this.config.model ?? 'default'}`;
    }
    get dimensions() {
        if (this.config.provider === 'tfidf')
            return 2048;
        if (this.config.dimensions)
            return this.config.dimensions;
        if (this.config.provider === 'ollama')
            return 768;
        return 1536; // OpenAI text-embedding-3-small 默认
    }
    async embed(text) {
        const cacheKey = `${this.config.provider}:${text.slice(0, 200)}`;
        if (this.cache.has(cacheKey))
            return this.cache.get(cacheKey);
        let vec;
        switch (this.config.provider) {
            case 'openai':
                vec = await this._embedOpenAI(text);
                break;
            case 'ollama':
                vec = await this._embedOllama(text);
                break;
            default:
                vec = tfidfToVector(text);
        }
        // 最多缓存 1000 条
        if (this.cache.size >= 1000) {
            const firstKey = this.cache.keys().next().value;
            if (firstKey)
                this.cache.delete(firstKey);
        }
        this.cache.set(cacheKey, vec);
        return vec;
    }
    /** 批量 embed，OpenAI 支持批量请求，减少 API 调用次数 */
    async embedBatch(texts) {
        if (this.config.provider === 'tfidf') {
            return texts.map(t => tfidfToVector(t));
        }
        if (this.config.provider === 'openai') {
            return this._embedOpenAIBatch(texts);
        }
        // Ollama 不支持批量，串行调用
        const results = [];
        for (const t of texts)
            results.push(await this._embedOllama(t));
        return results;
    }
    // ── OpenAI Embeddings API ─────────────────────────────────
    async _embedOpenAI(text) {
        const [result] = await this._embedOpenAIBatch([text]);
        return result;
    }
    async _embedOpenAIBatch(texts) {
        const baseUrl = this.config.baseUrl ?? 'https://api.openai.com/v1';
        const model = this.config.model ?? 'text-embedding-3-small';
        const body = { model, input: texts };
        if (this.config.dimensions)
            body.dimensions = this.config.dimensions;
        const res = await fetch(`${baseUrl}/embeddings`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.config.apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const err = await res.text();
            throw new Error(`OpenAI Embeddings API 错误 ${res.status}: ${err}`);
        }
        const data = await res.json();
        // 按 index 排序，确保顺序正确
        return data.data
            .sort((a, b) => a.index - b.index)
            .map(d => d.embedding);
    }
    // ── Ollama Embeddings API ─────────────────────────────────
    async _embedOllama(text) {
        const baseUrl = this.config.baseUrl ?? 'http://localhost:11434';
        const model = this.config.model ?? 'nomic-embed-text';
        const res = await fetch(`${baseUrl}/api/embeddings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, prompt: text }),
        });
        if (!res.ok) {
            const err = await res.text();
            throw new Error(`Ollama Embeddings API 错误 ${res.status}: ${err}`);
        }
        const data = await res.json();
        return data.embedding;
    }
    /** 测试连通性，返回 true 表示可用 */
    async ping() {
        try {
            await this.embed('test');
            return true;
        }
        catch {
            return false;
        }
    }
}
// ── EmbeddingFallbackProvider —— 多模型故障转移 ───────────────
/**
 * 对当前模型重试 MAX_RETRIES_PER_MODEL 次，全部失败后切换下一个模型。
 * 与 FallbackProvider（LLM）的策略保持一致。
 */
export class EmbeddingFallbackProvider {
    providers;
    currentIdx = 0;
    constructor(providers) {
        if (providers.length === 0)
            throw new Error('EmbeddingFallbackProvider 至少需要一个提供商');
        this.providers = providers;
    }
    get name() { return `fallback(${this.providers[this.currentIdx].name})`; }
    get dimensions() { return this.providers[this.currentIdx].dimensions; }
    async _callWithFallback(fn, context) {
        let modelSwitches = 0;
        for (let idx = this.currentIdx; idx < this.providers.length; idx++) {
            const provider = this.providers[idx];
            let lastErr;
            for (let attempt = 1; attempt <= MAX_RETRIES_PER_MODEL; attempt++) {
                try {
                    const result = await fn(provider);
                    this.currentIdx = idx; // 记住成功的位置
                    return result;
                }
                catch (err) {
                    lastErr = err;
                    if (attempt < MAX_RETRIES_PER_MODEL) {
                        process.stderr.write(`[embedding] ${provider.name} 第 ${attempt} 次失败，将重试（${attempt}/${MAX_RETRIES_PER_MODEL}）: ${String(err)}\n`);
                        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
                    }
                }
            }
            // 当前模型三次全部失败，切换下一个
            modelSwitches++;
            if (idx + 1 < this.providers.length) {
                process.stderr.write(`[embedding] ${provider.name} 重试 ${MAX_RETRIES_PER_MODEL} 次均失败，` +
                    `切换到 ${this.providers[idx + 1].name}: ${String(lastErr)}\n`);
            }
            else {
                throw new Error(`[embedding] 所有向量模型均失败（每个模型重试 ${MAX_RETRIES_PER_MODEL} 次，共切换 ${modelSwitches} 次）。` +
                    `最后错误: ${String(lastErr)}`);
            }
        }
        throw new Error(`[embedding] ${context} 失败：无可用模型`);
    }
    async embed(text) {
        return this._callWithFallback(p => p.embed(text), 'embed');
    }
    async embedBatch(texts) {
        return this._callWithFallback(p => p.embedBatch(texts), 'embedBatch');
    }
    async ping() {
        try {
            await this.embed('test');
            return true;
        }
        catch {
            return false;
        }
    }
}
let _provider = null;
/**
 * 从环境变量创建 EmbeddingProvider（支持多模型 Fallback）
 *
 * 优先级：
 * 1. EMBEDDING_FALLBACK_N 多模型配置（N = 1, 2, 3...）
 * 2. EMBEDDING_MODEL 单一模型
 * 3. 降级 TF-IDF（无需 API）
 *
 * EMBEDDING_FALLBACK_N 格式（与 LLM_FALLBACK_N 相同）：
 *   EMBEDDING_FALLBACK_1=provider:aliyun,models:text-embedding-v3,text-embedding-v2
 *   EMBEDDING_FALLBACK_2=provider:openai,models:text-embedding-3-small
 */
function createEmbeddingProviderFromEnv() {
    // 1. 尝试读取 EMBEDDING_FALLBACK_N 多模型配置
    const fallbackProviders = [];
    for (let i = 1; i <= 20; i++) {
        const raw = process.env[`EMBEDDING_FALLBACK_${i}`];
        if (!raw)
            break;
        const entries = parseEmbeddingLine(raw);
        for (const cfg of entries) {
            fallbackProviders.push(new EmbeddingProvider(cfg));
        }
    }
    if (fallbackProviders.length > 0) {
        if (!process.env.AGENT_SERVER_MODE) {
            const chain = fallbackProviders.map(p => p.name).join(' → ');
            process.stderr.write(`[embedding] fallback 链: ${chain}\n`);
        }
        return fallbackProviders.length === 1
            ? fallbackProviders[0]
            : new EmbeddingFallbackProvider(fallbackProviders);
    }
    // 2. 单一 EMBEDDING_MODEL
    const model = process.env.EMBEDDING_MODEL;
    if (model) {
        const baseUrl = process.env.EMBEDDING_BASE_URL;
        const provider = baseUrl && !baseUrl.includes('openai.com') && !baseUrl.includes('dashscope')
            ? 'ollama'
            : 'openai';
        return new EmbeddingProvider({
            provider,
            model,
            apiKey: process.env.OPENAI_API_KEY ?? process.env.DASHSCOPE_API_KEY,
            baseUrl,
            dimensions: process.env.EMBEDDING_DIMENSIONS
                ? parseInt(process.env.EMBEDDING_DIMENSIONS, 10)
                : undefined,
        });
    }
    // 3. 降级 TF-IDF
    return new EmbeddingProvider({ provider: 'tfidf' });
}
/**
 * 解析一行 EMBEDDING_FALLBACK_N 配置，返回多个 EmbeddingConfig
 * 格式：provider:aliyun,models:text-embedding-v3,text-embedding-v2[,apiKey:xxx][,baseUrl:xxx]
 */
function parseEmbeddingLine(raw) {
    const modelsMatch = raw.match(/(?:^|,)models:(.+)$/);
    if (modelsMatch) {
        const beforeModels = raw.slice(0, raw.indexOf('models:'));
        const kv = parseKV(beforeModels);
        const afterModels = modelsMatch[1];
        const modelTokens = [];
        const extraKV = {};
        for (const token of afterModels.split(',')) {
            const t = token.trim();
            if (!t)
                continue;
            if (t.includes(':')) {
                const idx = t.indexOf(':');
                extraKV[t.slice(0, idx)] = t.slice(idx + 1);
            }
            else {
                modelTokens.push(t);
            }
        }
        const merged = { ...kv, ...extraKV };
        const platformProvider = merged.provider ?? 'openai';
        const apiKey = merged.apiKey ?? resolveApiKey(platformProvider);
        const baseUrl = merged.baseUrl ?? resolveBaseUrl(platformProvider);
        const dimensions = merged.dimensions ? parseInt(merged.dimensions, 10) : undefined;
        return modelTokens.map(model => ({
            provider: platformProvider === 'ollama' ? 'ollama' : 'openai',
            model,
            apiKey,
            baseUrl,
            dimensions,
        }));
    }
    // 旧格式：model:xxx,provider:yyy,...
    const kv = parseKV(raw);
    if (!kv.model)
        throw new Error(`EMBEDDING_FALLBACK 配置行缺少 model 字段: ${raw}`);
    const platformProvider = kv.provider ?? 'openai';
    return [{
            provider: platformProvider === 'ollama' ? 'ollama' : 'openai',
            model: kv.model,
            apiKey: kv.apiKey ?? resolveApiKey(platformProvider),
            baseUrl: kv.baseUrl ?? resolveBaseUrl(platformProvider),
            dimensions: kv.dimensions ? parseInt(kv.dimensions, 10) : undefined,
        }];
}
/** 根据平台名自动解析 API Key */
function resolveApiKey(platform) {
    switch (platform) {
        case 'openai': return process.env.OPENAI_API_KEY;
        case 'aliyun': return process.env.DASHSCOPE_API_KEY;
        case 'zhipu': return process.env.ZHIPU_API_KEY;
        case 'deepseek': return process.env.DEEPSEEK_API_KEY;
        case 'ollama': return undefined;
        default: return process.env.OPENAI_API_KEY ?? process.env.DASHSCOPE_API_KEY;
    }
}
/** 根据平台名自动解析 Base URL */
function resolveBaseUrl(platform) {
    switch (platform) {
        case 'aliyun': return 'https://dashscope.aliyuncs.com/compatible-mode/v1';
        case 'zhipu': return 'https://open.bigmodel.cn/api/paas/v4';
        case 'deepseek': return 'https://api.deepseek.com/v1';
        case 'ollama': return process.env.EMBEDDING_BASE_URL ?? 'http://localhost:11434';
        default: return process.env.EMBEDDING_BASE_URL;
    }
}
function parseKV(str) {
    const result = {};
    for (const token of str.split(',')) {
        const t = token.trim();
        if (!t || !t.includes(':'))
            continue;
        const idx = t.indexOf(':');
        result[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
    }
    return result;
}
export function getEmbeddingProvider() {
    if (!_provider) {
        _provider = createEmbeddingProviderFromEnv();
    }
    return _provider;
}
/** 重置单例（用于配置变更后重新初始化） */
export function resetEmbeddingProvider(config) {
    _provider = config ? new EmbeddingProvider(config) : createEmbeddingProviderFromEnv();
}
