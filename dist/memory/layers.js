// 4 层记忆堆栈 —— 借鉴 mempalace 的 layers.py
// L0: 身份 (~100 tokens) | L1: 核心摘要 (~500-800) | L2: 按需 | L3: 深度搜索
import { getMemoryStore } from './store.js';
export class MemoryStack {
    store = getMemoryStore();
    // ── L0：身份层 ───────────────────────────────────────────────
    /** 读取身份定义文本（~100 tokens） */
    getIdentity() {
        return this.store.getIdentityText();
    }
    setIdentity(key, value) {
        this.store.setIdentity(key, value);
    }
    // ── L1：核心摘要层 ───────────────────────────────────────────
    /** 生成核心记忆摘要（~500-800 tokens），按重要性排序 */
    getEssentialStory(wing) {
        return this.store.getEssentialStory(wing);
    }
    // ── L2：按需检索层 ───────────────────────────────────────────
    /** 按 wing/room 过滤检索（~200-500 tokens） */
    recall(opts = {}) {
        const mems = this.store.listMemories({ ...opts, limit: opts.limit ?? 10 });
        if (mems.length === 0) {
            const label = [opts.wing, opts.room].filter(Boolean).join('/');
            return `## L2 — 未找到记忆${label ? `（${label}）` : ''}`;
        }
        const lines = [`## L2 — 按需记忆（${mems.length} 条）`];
        for (const m of mems) {
            const snippet = m.content.replace(/\n/g, ' ').slice(0, 300);
            lines.push(`  [${m.room}/${m.type}] ${snippet}`);
        }
        return lines.join('\n');
    }
    // ── L3：深度搜索层 ───────────────────────────────────────────
    /** TF-IDF / 语义向量搜索 */
    async search(query, opts = {}) {
        return this.store.search(query, opts);
    }
    /** 格式化搜索结果为文本 */
    async searchText(query, opts = {}) {
        const results = await this.search(query, opts);
        if (results.length === 0)
            return `## L3 — 未找到与"${query}"相关的记忆`;
        const lines = [`## L3 — 搜索结果："${query}"`];
        for (const { memory: m, score } of results) {
            const snippet = m.content.replace(/\n/g, ' ').slice(0, 300);
            lines.push(`  [${m.wing}/${m.room}] (相似度 ${score.toFixed(3)})`);
            lines.push(`    ${snippet}`);
        }
        return lines.join('\n');
    }
    // ── 唤醒（L0 + L1）──────────────────────────────────────────
    /** 生成唤醒文本，注入 system prompt（~600-900 tokens） */
    wakeUp(wing) {
        const l0 = this.getIdentity();
        const l1 = this.getEssentialStory(wing);
        const combined = `${l0}\n\n${l1}`;
        return {
            l0Identity: l0,
            l1Essential: l1,
            totalTokens: Math.ceil(combined.length / 4),
        };
    }
    /** 生成完整的记忆上下文字符串，用于注入 system prompt */
    buildMemoryContext(wing) {
        const { l0Identity, l1Essential, totalTokens } = this.wakeUp(wing);
        return `${l0Identity}\n\n${l1Essential}\n\n<!-- 记忆上下文约 ${totalTokens} tokens -->`;
    }
    // ── 知识图谱 ─────────────────────────────────────────────────
    addFact(subject, predicate, object, opts) {
        return this.store.addTriple(subject, predicate, object, opts);
    }
    invalidateFact(subject, predicate, object, endedAt) {
        this.store.invalidateTriple(subject, predicate, object, endedAt);
    }
    queryEntity(name, opts) {
        return this.store.queryEntity(name, opts);
    }
    // ── 统计 ─────────────────────────────────────────────────────
    async status() {
        return this.store.stats();
    }
}
// 全局单例
let _stack = null;
export function getMemoryStack() {
    if (!_stack)
        _stack = new MemoryStack();
    return _stack;
}
