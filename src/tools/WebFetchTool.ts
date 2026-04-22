import { z } from 'zod'
import type { ToolDef } from '../core/Tool.js'

const inputSchema = z.object({
  url: z.string().describe('要获取的 URL'),
  maxLength: z.number().optional().describe('最大返回字符数，默认 20000'),
  raw: z.boolean().optional().describe('返回原始 HTML 而非提取的文本，默认 false'),
})

// 代理由 proxySetup.ts 在启动时注入为全局 dispatcher，fetch 无需手动传 dispatcher

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

  // 5. 合并多余空白行，保留段落结构
  text = text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .join('\n')

  return text
}

export const WebFetchTool: ToolDef<typeof inputSchema> = {
  name: 'web_fetch',
  description: '获取网页内容，自动提取正文文本（去除 HTML 标签和脚本）',
  inputSchema,
  readonly: true,

  describe(input) {
    return `获取网页: ${input.url}`
  },

  async execute(input) {
    try {
      const res = await fetch(input.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; hrids-agent/0.1; +https://github.com/hrids)',
          'Accept': 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
        signal: AbortSignal.timeout(20000),
        redirect: 'follow',
      })

      if (!res.ok) {
        return { type: 'error', message: `HTTP ${res.status}: ${res.statusText} — ${input.url}` }
      }

      const contentType = res.headers.get('content-type') ?? ''
      const rawText = await res.text()

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
      const output = plain.length > maxLen
        ? `${plain.slice(0, maxLen)}\n\n[内容已截断，共 ${plain.length} 字符，使用 maxLength 参数获取更多]`
        : plain

      return { type: 'success', output: output || '（页面内容为空）' }
    } catch (err) {
      const msg = String(err)
      if (msg.includes('timeout') || msg.includes('TimeoutError')) {
        return { type: 'error', message: `请求超时（20s）: ${input.url}` }
      }
      return { type: 'error', message: `请求失败: ${msg}` }
    }
  },
}
