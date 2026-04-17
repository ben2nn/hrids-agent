// Web 搜索工具 —— 优先使用 Anthropic 原生 web_search 能力，降级到 DuckDuckGo
import { z } from 'zod';
const inputSchema = z.object({
    query: z.string().describe('搜索查询词'),
});
// ── 降级方案：DuckDuckGo HTML 搜索（无需 API Key）────────────────────────────
async function searchViaDuckDuckGo(query) {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; hrids-agent/0.1)',
            'Accept': 'text/html',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
        signal: AbortSignal.timeout(15000),
        redirect: 'follow',
    });
    if (!res.ok) {
        throw new Error(`DuckDuckGo 返回 HTTP ${res.status}`);
    }
    const html = await res.text();
    // 提取搜索结果：标题 + 摘要 + URL
    const results = [];
    // 匹配 DuckDuckGo HTML 结果块
    const resultPattern = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetPattern = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
    const titles = [];
    let m;
    while ((m = resultPattern.exec(html)) !== null && titles.length < 8) {
        const href = m[1];
        const title = m[2].replace(/<[^>]+>/g, '').trim();
        if (href && title && !href.startsWith('//duckduckgo')) {
            titles.push({ url: href, title });
        }
    }
    const snippets = [];
    while ((m = snippetPattern.exec(html)) !== null && snippets.length < 8) {
        const snippet = m[1].replace(/<[^>]+>/g, '').trim();
        if (snippet)
            snippets.push(snippet);
    }
    for (let i = 0; i < Math.min(titles.length, 5); i++) {
        const { url, title } = titles[i];
        const snippet = snippets[i] ?? '';
        results.push(`**${title}**\n${snippet}\n${url}`);
    }
    if (results.length === 0) {
        return '未找到相关搜索结果（DuckDuckGo 降级模式）';
    }
    return `搜索结果（来源：DuckDuckGo）：\n\n${results.join('\n\n---\n\n')}`;
}
// ── 主方案：Anthropic 原生 web_search beta ────────────────────────────────────
async function searchViaAnthropic(query, apiKey) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'web-search-2025-03-05',
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            model: 'claude-haiku-4-5',
            max_tokens: 1024,
            tools: [{ type: 'web_search_20250305', name: 'web_search' }],
            messages: [{ role: 'user', content: `搜索并总结: ${query}` }],
        }),
        signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
        throw new Error(`Anthropic API 错误: ${res.status}`);
    }
    const data = await res.json();
    const text = data.content
        .filter(b => b.type === 'text' && b.text)
        .map(b => b.text)
        .join('\n');
    return text || '未找到相关结果';
}
export const WebSearchTool = {
    name: 'web_search',
    description: '在互联网上搜索最新信息。适合查询实时数据、文档、新闻等。有 ANTHROPIC_API_KEY 时使用 Anthropic 原生搜索，否则自动降级到 DuckDuckGo。',
    inputSchema,
    readonly: true,
    describe(input) {
        return `搜索: ${input.query}`;
    },
    async execute(input) {
        const anthropicKey = process.env.ANTHROPIC_API_KEY;
        try {
            if (anthropicKey) {
                // 优先使用 Anthropic 原生 web_search
                const result = await searchViaAnthropic(input.query, anthropicKey);
                return { type: 'success', output: result };
            }
            else {
                // 降级到 DuckDuckGo（无需 API Key）
                const result = await searchViaDuckDuckGo(input.query);
                return { type: 'success', output: result };
            }
        }
        catch (err) {
            // 主方案失败时尝试降级
            if (anthropicKey) {
                try {
                    const result = await searchViaDuckDuckGo(input.query);
                    return { type: 'success', output: `[Anthropic 搜索失败，已降级到 DuckDuckGo]\n\n${result}` };
                }
                catch (fallbackErr) {
                    return { type: 'error', message: `搜索失败: ${String(err)}；降级也失败: ${String(fallbackErr)}` };
                }
            }
            return { type: 'error', message: `搜索失败: ${String(err)}` };
        }
    },
};
