// Web 搜索工具 —— 使用 Anthropic 原生 web_search 能力
import { z } from 'zod'
import type { ToolDef } from '../core/Tool.js'

const inputSchema = z.object({
  query: z.string().describe('搜索查询词'),
})

// Anthropic API 支持原生 web_search beta 工具
// 通过在 API 请求中声明 type: "web_search_20250305" 触发
// 这里我们用 fetch 直接调用，绕过 SDK 的类型限制
export const WebSearchTool: ToolDef<typeof inputSchema> = {
  name: 'web_search',
  description: '在互联网上搜索最新信息。适合查询实时数据、文档、新闻等。',
  inputSchema,
  readonly: true,

  describe(input) {
    return `搜索: ${input.query}`
  },

  async execute(input) {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
      return { type: 'error', message: '未设置 ANTHROPIC_API_KEY' }
    }

    try {
      // 使用 Anthropic beta web_search 工具
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
          messages: [{ role: 'user', content: `搜索并总结: ${input.query}` }],
        }),
        signal: AbortSignal.timeout(20000),
      })

      if (!res.ok) {
        return { type: 'error', message: `搜索 API 错误: ${res.status}` }
      }

      const data = await res.json() as {
        content: Array<{ type: string; text?: string }>
      }

      const text = data.content
        .filter(b => b.type === 'text' && b.text)
        .map(b => b.text)
        .join('\n')

      return { type: 'success', output: text || '未找到相关结果' }
    } catch (err) {
      return { type: 'error', message: `搜索失败: ${String(err)}` }
    }
  },
}
