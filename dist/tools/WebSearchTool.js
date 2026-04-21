// Web 搜索工具 —— 优先使用 Anthropic 原生 web_search 能力，降级到 DuckDuckGo
import { z } from 'zod';
import { HttpsProxyAgent } from 'https-proxy-agent';
const inputSchema = z.object({
    query: z.string().describe('搜索查询词'),
});
// 获取代理配置
function getProxyAgent() {
    const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
    if (proxyUrl) {
        return new HttpsProxyAgent(proxyUrl);
    }
    return undefined;
}
// 获取 fetch 配置（包含代理支持）
function getFetchOptions(options = {}) {
    const agent = getProxyAgent();
    return {
        ...options,
        // @ts-expect-error Node.js fetch 支持 agent 选项
        agent,
    };
}
// ── 降级方案：DuckDuckGo HTML 搜索（无需 API Key）────────────────────────────
async function searchViaDuckDuckGo(query) {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const fetchOptions = getFetchOptions({
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
        },
        signal: AbortSignal.timeout(20000),
        redirect: 'follow',
    });
    const res = await fetch(url, fetchOptions);
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
    const fetchOptions = getFetchOptions({
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
        signal: AbortSignal.timeout(30000),
    });
    const res = await fetch('https://api.anthropic.com/v1/messages', fetchOptions);
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
// 解析网络错误，提供更友好的错误信息
function parseNetworkError(err) {
    const errMsg = String(err);
    if (errMsg.includes('fetch failed') || errMsg.includes('ECONNREFUSED')) {
        const proxyHint = process.env.HTTPS_PROXY || process.env.HTTP_PROXY
            ? ''
            : '\n提示：可能需要配置代理。请设置环境变量 HTTPS_PROXY 或 HTTP_PROXY，例如：\n  HTTPS_PROXY=http://127.0.0.1:7890';
        return `网络连接失败，无法访问目标服务器。${proxyHint}`;
    }
    if (errMsg.includes('ETIMEDOUT') || errMsg.includes('Timeout')) {
        return '请求超时，请检查网络连接或稍后重试';
    }
    if (errMsg.includes('ENOTFOUND') || errMsg.includes('getaddrinfo')) {
        return 'DNS 解析失败，无法找到目标服务器';
    }
    if (errMsg.includes('certificate') || errMsg.includes('SSL') || errMsg.includes('TLS')) {
        return 'SSL/TLS 证书验证失败';
    }
    return errMsg;
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
            const errorMsg = parseNetworkError(err);
            // 主方案失败时尝试降级
            if (anthropicKey) {
                try {
                    const result = await searchViaDuckDuckGo(input.query);
                    return { type: 'success', output: `[Anthropic 搜索失败，已降级到 DuckDuckGo]\n\n${result}` };
                }
                catch (fallbackErr) {
                    const fallbackError = parseNetworkError(fallbackErr);
                    return { type: 'error', message: `搜索失败: ${errorMsg}；降级也失败: ${fallbackError}` };
                }
            }
            return { type: 'error', message: `搜索失败: ${errorMsg}` };
        }
    },
};
