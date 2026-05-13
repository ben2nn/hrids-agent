/**
 * Web 搜索工具 —— Mojeek + 可配置 SearXNG
 *
 * 搜索引擎：
 * - Mojeek（默认，免费、无反爬限制、无需 API Key）
 * - SearXNG（可配置自托管实例，如 xng.hrids.com）
 *
 * 配置方式（config.yaml）：
 * ```yaml
 * webSearch:
 *   engine: searxng        # mojeek（默认）| searxng
 *   endpoint: https://xng.hrids.com  # SearXNG 实例地址
 * ```
 *
 * 设计参考 DeepSeek-Reasonix web.ts
 */

import { z } from 'zod'
import type { ToolDef } from '../core/Tool.js'
import { NetworkPolicyDecider } from '../core/NetworkPolicy.js'
import { loadConfig } from '../core/Config.js'

// ── 类型定义 ──────────────────────────────────────────────────

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

const inputSchema = z.object({
  query: z.string().describe('搜索查询词'),
  topK: z.number().optional().describe('返回结果数量（1..10），默认 5'),
})

// ── 常量 ──────────────────────────────────────────────────────

const DEFAULT_TOPK = 5
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const MOJEEK_ENDPOINT = 'https://www.mojeek.com/search'

// ── Mojeek ────────────────────────────────────────────────────

/** 解析 Mojeek HTML 搜索结果（title-anchor + snippet-paragraph 位置配对） */
export function parseMojeekResults(html: string): SearchResult[] {
  const titles: string[] = []
  const titleAnchorRe = /<a\b[^>]*\bclass="title"[^>]*>[\s\S]*?<\/a>/g
  let m: RegExpExecArray | null
  while ((m = titleAnchorRe.exec(html)) !== null) {
    titles.push(m[0])
  }

  const snippets: string[] = []
  const snippetRe = /<p\b[^>]*\bclass="s"[^>]*>([\s\S]*?)<\/p>/g
  while ((m = snippetRe.exec(html)) !== null) {
    snippets.push(m[1] ?? '')
  }

  const hrefRe = /href="([^"]+)"/
  const innerRe = /<a\b[^>]*>([\s\S]*?)<\/a>/
  const results: SearchResult[] = []
  for (let i = 0; i < titles.length; i++) {
    const anchor = titles[i]!
    const hrefMatch = anchor.match(hrefRe)
    const innerMatch = anchor.match(innerRe)
    if (!hrefMatch?.[1]) continue
    results.push({
      title: decodeHtmlEntities(stripHtml(innerMatch?.[1] ?? '')).trim(),
      url: hrefMatch[1],
      snippet: decodeHtmlEntities(stripHtml(snippets[i] ?? ''))
        .replace(/\s+/g, ' ')
        .trim(),
    })
  }
  return results
}

async function searchMojeek(query: string, topK: number): Promise<SearchResult[]> {
  const resp = await fetch(`${MOJEEK_ENDPOINT}?q=${encodeURIComponent(query)}`, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(20000),
    redirect: 'follow',
  })
  if (!resp.ok) {
    if (resp.status === 429) throw new Error('Mojeek 请求频率限制（429），请稍后重试')
    if (resp.status === 403) throw new Error('Mojeek 拒绝访问（403），可能触发了反爬机制')
    throw new Error(`Mojeek 返回 HTTP ${resp.status}`)
  }
  const html = await resp.text()
  const results = parseMojeekResults(html).slice(0, topK)
  if (results.length === 0) {
    if (/no results found|did not match any documents/i.test(html)) return []
    if (/captcha|verify you are human|access denied|forbidden/i.test(html)) {
      throw new Error('Mojeek 触发了人机验证，搜索被阻止')
    }
    throw new Error(`Mojeek 返回了无法解析的结果（${html.length} 字符）`)
  }
  return results
}

// ── SearXNG ───────────────────────────────────────────────────

/** 解析 SearXNG HTML 搜索结果 */
export function parseSearxngHtmlResults(html: string): SearchResult[] {
  const results: SearchResult[] = []

  // 方式 1: <article class="result"> 或 <div class="result">（默认主题）
  const articleRe = /<(?:article|div)\b[^>]*\bclass="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/(?:article|div)>/gi
  let m: RegExpExecArray | null
  while ((m = articleRe.exec(html)) !== null) {
    const block = m[1]
    const linkMatch = block.match(/<h[34]\s*>\s*<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/<a\b[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
    if (!linkMatch) continue
    const url = linkMatch[1]
    const title = stripHtml(linkMatch[2]).trim()
    if (!title || !url) continue

    let snippet = ''
    const pMatch = block.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)
    if (pMatch) snippet = stripHtml(pMatch[1]).trim()
    if (!snippet) {
      const csMatch = block.match(/<(?:div|span)\b[^>]*class="[^"]*(?:content|snippet)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span)>/i)
      if (csMatch) snippet = stripHtml(csMatch[1]).trim()
    }

    results.push({ title, url, snippet })
  }
  if (results.length > 0) return results

  // 方式 2: 降级 — <h3><a href> 配对
  const h3Re = /<h3\b[^>]*>\s*<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  while ((m = h3Re.exec(html)) !== null) {
    const url = m[1]
    const title = stripHtml(m[2]).trim()
    if (!title || !url || url.startsWith('#')) continue
    // 尝试在 h3 后找 <p> 作为 snippet
    const afterH3 = html.slice(m.index + m[0].length)
    const pMatch = afterH3.match(/^\s*<p\b[^>]*>([\s\S]*?)<\/p>/i)
    const snippet = pMatch ? stripHtml(pMatch[1]).trim() : ''
    results.push({ title, url, snippet })
  }
  return results
}

/** 校验 SearXNG endpoint */
function normalizeSearxngEndpoint(raw: string): string {
  let url: URL
  try {
    url = new URL(raw.includes('://') ? raw : `http://${raw}`)
  } catch {
    throw new Error(`无效的 SearXNG 地址: ${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`SearXNG 地址必须是 http/https 协议，当前: ${url.protocol}`)
  }
  return url.origin
}

async function searchSearxng(query: string, topK: number, endpoint: string): Promise<SearchResult[]> {
  const baseUrl = normalizeSearxngEndpoint(endpoint)
  const url = `${baseUrl}/search?format=html&q=${encodeURIComponent(query)}`
  let resp: Response
  try {
    resp = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
      signal: AbortSignal.timeout(20000),
    })
  } catch (err) {
    if (err instanceof TypeError && (err as Error).message.includes('fetch')) {
      throw new Error(`无法连接 SearXNG 实例: ${endpoint}`)
    }
    throw err
  }
  if (!resp.ok) {
    if (resp.status === 429) throw new Error('SearXNG 请求频率限制（429）')
    if (resp.status === 403) throw new Error('SearXNG 拒绝访问（403）')
    throw new Error(`SearXNG 返回 HTTP ${resp.status}`)
  }
  const html = await resp.text()
  const results = parseSearxngHtmlResults(html).slice(0, topK)
  if (results.length === 0) {
    if (/no results found|did not match any documents/i.test(html)) return []
    throw new Error(`SearXNG 返回了无法解析的结果（${html.length} 字符）`)
  }
  return results
}

// ── 搜索分发 ──────────────────────────────────────────────────

async function webSearch(query: string, topK: number): Promise<{ results: SearchResult[]; engine: string }> {
  const config = loadConfig()
  const engine = config.webSearch?.engine ?? 'mojeek'
  const endpoint = config.webSearch?.endpoint ?? 'http://localhost:8080'

  // SearXNG 优先，失败自动降级 Mojeek
  if (engine === 'searxng') {
    try {
      const results = await searchSearxng(query, topK, endpoint)
      return { results, engine: `SearXNG (${endpoint})` }
    } catch (searxErr) {
      process.stderr.write(`[web_search] SearXNG 失败，降级到 Mojeek: ${searxErr}\n`)
      const results = await searchMojeek(query, topK)
      return { results, engine: 'Mojeek (SearXNG 降级)' }
    }
  }

  const results = await searchMojeek(query, topK)
  return { results, engine: 'Mojeek' }
}

// ── 结果格式化 ────────────────────────────────────────────────

export function formatSearchResults(query: string, results: SearchResult[]): string {
  const lines: string[] = [`query: ${query}`, `\nresults (${results.length}):`]
  results.forEach((r, i) => {
    lines.push(`\n${i + 1}. ${r.title}`)
    lines.push(`   ${r.url}`)
    if (r.snippet) lines.push(`   ${r.snippet}`)
  })
  return lines.join('\n')
}

// ── HTML 工具函数 ─────────────────────────────────────────────

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, '')
}

function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#\d+|#x[0-9a-fA-F]+|\w+);/g, (raw, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) {
      const code = Number.parseInt(name.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : raw
    }
    if (name.startsWith('#')) {
      const code = Number.parseInt(name.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : raw
    }
    const entities: Record<string, string> = {
      amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    }
    return entities[name.toLowerCase()] ?? raw
  })
}

// ── 错误解析 ──────────────────────────────────────────────────

function parseNetworkError(err: unknown): string {
  const errMsg = String(err)
  if (errMsg.includes('fetch failed') || errMsg.includes('ECONNREFUSED')) {
    const proxyHint = process.env.HTTPS_PROXY || process.env.HTTP_PROXY
      ? ''
      : '\n提示：可能需要配置代理。请设置环境变量 HTTPS_PROXY 或 HTTP_PROXY'
    return `网络连接失败。${proxyHint}`
  }
  if (errMsg.includes('ETIMEDOUT') || errMsg.includes('Timeout') || errMsg.includes('timeout')) {
    return '请求超时，请检查网络连接或稍后重试'
  }
  if (errMsg.includes('ENOTFOUND') || errMsg.includes('getaddrinfo')) {
    return 'DNS 解析失败，无法找到目标服务器'
  }
  if (errMsg.includes('certificate') || errMsg.includes('SSL') || errMsg.includes('TLS')) {
    return 'SSL/TLS 证书验证失败'
  }
  return errMsg
}

// ── 网络策略检查 ──────────────────────────────────────────────

let _decider: NetworkPolicyDecider | null = null
function getDecider(): NetworkPolicyDecider {
  if (!_decider) {
    const config = loadConfig()
    const policyConfig = config.networkPolicy
    if (policyConfig?.enabled === false) {
      _decider = new NetworkPolicyDecider({ defaultAction: 'allow' })
    } else {
      _decider = new NetworkPolicyDecider({
        allowedDomains: policyConfig?.allowedDomains,
        blockedDomains: policyConfig?.blockedDomains,
        defaultAction: policyConfig?.defaultAction ?? 'allow',
      })
    }
  }
  return _decider
}

export function resetNetworkPolicyCache(): void {
  _decider = null
}

function checkNetworkPolicy(): string | null {
  const decider = getDecider()
  const config = loadConfig()
  const endpoints = ['https://www.mojeek.com']
  if (config.webSearch?.engine === 'searxng' && config.webSearch?.endpoint) {
    endpoints.push(config.webSearch.endpoint)
  }
  for (const endpoint of endpoints) {
    const { decision, reason } = decider.decide(endpoint)
    if (decision === 'deny') {
      return `网络策略拒绝搜索端点: ${reason}`
    }
  }
  return null
}

// ── 工具定义 ──────────────────────────────────────────────────

export const WebSearchTool: ToolDef<typeof inputSchema> = {
  name: 'web_search',
  description: `在互联网上搜索最新信息。内部自动降级：SearXNG → Mojeek。
适用场景：查询实时数据（天气、股价、新闻）、搜索技术文档、查找 API 用法
不适用场景：查询已有知识能回答的问题 → 直接回答 | 已知具体 URL → 用 web_fetch | 问候/闲聊`,
  inputSchema,
  readonly: true,
  capabilities: { requiresNetwork: true, parallelSafe: true, maxExecutionTimeMs: 30_000 },

  describe(input) {
    return `搜索: ${input.query}`
  },

  async execute(input) {
    const policyError = checkNetworkPolicy()
    if (policyError) {
      return { type: 'error', message: policyError }
    }

    const topK = Math.max(1, Math.min(10, input.topK ?? DEFAULT_TOPK))

    try {
      const { results, engine } = await webSearch(input.query, topK)
      return { type: 'success', output: `[${engine}]\n\n${formatSearchResults(input.query, results)}` }
    } catch (err) {
      return {
        type: 'error',
        message: `搜索失败: ${parseNetworkError(err)}\n提示：如果已知具体 URL，可尝试使用 web_fetch 获取网页内容`,
      }
    }
  },
}
