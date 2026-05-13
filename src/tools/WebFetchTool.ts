import { z } from 'zod'
import type { ToolDef } from '../core/Tool.js'
import { NetworkPolicyDecider } from '../core/NetworkPolicy.js'
import { loadConfig } from '../core/Config.js'
import { ExternalContentIsolator } from '../core/ExternalContentIsolator.js'

const inputSchema = z.object({
  url: z.string().describe('要获取的 URL'),
  maxLength: z.number().optional().describe('最大返回字符数，默认 20000'),
  raw: z.boolean().optional().describe('返回原始 HTML 而非提取的文本，默认 false'),
})

// 代理由 proxySetup.ts 在启动时注入为全局 dispatcher，fetch 无需手动传 dispatcher

const isolator = new ExternalContentIsolator()

// 从 HTML 中提取可读文本，比简单 regex 更干净
function extractTextFromHtml(html: string): string {
  // 1. 移除 script / style / noscript 块（含内容）
  let text = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')

  // 2. 将块级标签替换为换行
  text = text.replace(/<\/?(p|div|h[1-6]|li|tr|br|hr|blockquote|pre|article|section|header|footer|nav|main)[^>]*>/gi, '\n')

  // 3. 移除所有剩余标签
  text = text.replace(/<[^>]+>/g, '')

  // 4. 解码常见 HTML 实体
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
    // 移除控制字符（保留换行和制表符），防止 HTML 实体解码注入控制字符
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')

  // 5. 合并多余空白行，保留段落结构
  text = text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .join('\n')

  return text
}

/** 从 config.yaml 构建 NetworkPolicyDecider（带缓存） */
let _decider: NetworkPolicyDecider | null = null
function getDecider(): NetworkPolicyDecider {
  if (!_decider) {
    const config = loadConfig()
    const policyConfig = config.networkPolicy
    if (policyConfig?.enabled === false) {
      // 策略禁用：允许所有
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

/** 重置缓存（供测试或配置热更新使用） */
export function resetNetworkPolicyCache(): void {
  _decider = null
}

export const WebFetchTool: ToolDef<typeof inputSchema> = {
  name: 'web_fetch',
  description: `获取指定 URL 的网页内容，自动提取正文。
适用场景：读取已知 URL 的文章/文档/数据
不适用场景：搜索未知信息 → 用 web_search | 本地文件 → 用 file_read`,
  inputSchema,
  readonly: true,
  capabilities: { requiresNetwork: true, parallelSafe: true, maxExecutionTimeMs: 20_000 },

  describe(input) {
    return `获取网页: ${input.url}`
  },

  async execute(input) {
    // URL scheme 校验：仅允许 http/https
    const url = new URL(input.url)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { type: 'error', message: `不支持的 URL 协议: ${url.protocol}（仅允许 http/https）` }
    }

    // SSRF 防护：阻止访问环回地址、链路本地地址和云元数据地址
    const hostname = url.hostname
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname.startsWith('169.254.') ||
      hostname.startsWith('10.') ||
      hostname.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
      hostname === 'metadata.google.internal' ||
      hostname === 'instance-data'
    ) {
      return { type: 'error', message: `安全策略禁止访问内网/元数据地址: ${hostname}` }
    }

    // 网络策略检查
    const decider = getDecider()
    const { decision, reason } = decider.decide(input.url)
    if (decision === 'deny') {
      return { type: 'error', message: `网络策略拒绝访问: ${reason}` }
    }

    try {
      // redirect:manual 防止 SSRF 重定向绕过域名检查
      const res = await fetch(input.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; hrids-agent/0.1; +https://github.com/hrids)',
          'Accept': 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
        signal: AbortSignal.timeout(20000),
        redirect: 'manual',
      })

      // 处理重定向：检查目标是否安全
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location')
        if (location) {
          try {
            const redirectUrl = new URL(location, input.url)
            const redirectHostname = redirectUrl.hostname
            if (
              redirectHostname === 'localhost' || redirectHostname === '127.0.0.1' || redirectHostname === '::1' ||
              redirectHostname.startsWith('169.254.') || redirectHostname.startsWith('10.') ||
              redirectHostname.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(redirectHostname)
            ) {
              return { type: 'error', message: `重定向目标为内网地址，已阻止: ${redirectHostname}` }
            }
          } catch { /* 忽略无效重定向 URL */ }
        }
      }

      if (!res.ok) {
        return { type: 'error', message: `HTTP ${res.status}: ${res.statusText} — ${input.url}` }
      }

      const contentType = res.headers.get('content-type') ?? ''
      // 响应体大小限制（10MB），防止 OOM
      const MAX_RESPONSE_BYTES = 10 * 1024 * 1024
      const contentLength = res.headers.get('content-length')
      if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_BYTES) {
        return { type: 'error', message: `响应体过大（${(parseInt(contentLength, 10) / 1024 / 1024).toFixed(1)}MB > 10MB 限制）: ${input.url}` }
      }
      const rawText = await res.text()
      if (rawText.length > MAX_RESPONSE_BYTES) {
        return { type: 'error', message: `响应体过大（${(rawText.length / 1024 / 1024).toFixed(1)}MB > 10MB 限制）: ${input.url}` }
      }

      let plain: string
      if (input.raw) {
        plain = rawText
      } else if (contentType.includes('html')) {
        plain = extractTextFromHtml(rawText)
      } else if (contentType.includes('json')) {
        // JSON 格式化输出
        try {
          plain = JSON.stringify(JSON.parse(rawText), null, 2)
        } catch {
          plain = rawText
        }
      } else {
        plain = rawText
      }

      const maxLen = input.maxLength ?? 20000
      const truncated = plain.length > maxLen
        ? `${plain.slice(0, maxLen)}\n\n[内容已截断，共 ${plain.length} 字符，使用 maxLength 参数获取更多]`
        : plain

      // 隔离外部内容，防止提示注入攻击
      const safe = isolator.isolate(truncated || '（页面内容为空）', `web:${input.url}`)

      return { type: 'success', output: safe }
    } catch (err) {
      const msg = String(err)
      if (msg.includes('timeout') || msg.includes('TimeoutError')) {
        return { type: 'error', message: `请求超时（20s）: ${input.url}` }
      }
      return { type: 'error', message: `请求失败: ${msg}` }
    }
  },
}
