import { z } from 'zod'
import type { ToolDef } from '../core/Tool.js'
import { loadConfig, getApiKey } from '../core/Config.js'
import { logger } from '../core/logger.js'
import { withRetry } from '../core/retry.js'

const log = logger.child({ component: 'vision-tool' })

const inputSchema = z.object({
  image_url: z.string().optional().describe('图片的 URL 地址'),
  image_path: z.string().optional().describe('本地图片文件的路径'),
  image_data: z.string().optional().describe('Base64 编码的图片数据（含 data:image/...;base64, 前缀）'),
  prompt: z.string().optional().describe('关于图片的具体问题，默认为"请详细描述这张图片的内容"'),
})

// 通用视觉 prompt（当 LLM 不需要视觉能力但用户发送图片时）
const DEFAULT_VISION_PROMPT = '请详细描述这张图片的内容。如果包含文字，请完整提取文字。如果包含图表、UI、代码等结构化内容，请详细说明其结构和含义。'

/**
 * VisionTool —— 视觉模型调用工具
 *
 * 使用场景：
 * - 当用户发送图片并询问图片相关内容时
 * - 当前 LLM（如纯文本模型）不支持视觉输入，需要委托视觉模型处理
 *
 * 工具接收图片（URL / 本地路径 / base64 数据），调用视觉模型分析，
 * 将分析结果返回给 LLM，供其继续回答用户问题。
 */
export const VisionTool: ToolDef<typeof inputSchema> = {
  name: 'vision',
  description:
    '使用视觉模型分析图片内容。当你收到用户发送的图片但无法直接查看时，使用此工具获取图片的文字描述。' +
    '传入图片的 URL、本地文件路径或对话中的 base64 数据。' +
    '如果用户对图片有具体问题，通过 prompt 参数传递。',
  inputSchema,
  readonly: true,
  capabilities: { parallelSafe: true },

  describe(input) {
    const label = input.image_path ?? input.image_url ?? `base64(${(input.image_data?.length ?? 0)} 字符)`
    return `视觉分析: ${label}`
  },

  async execute(input) {
    // ── 收集图片源，统一为 data: URL 字符串 ─────────────────────
    const imageUrls: string[] = []

    if (input.image_url) {
      // 直接是 HTTP URL 或 data: URL，原样传入
      imageUrls.push(input.image_url)
    }
    if (input.image_path) {
      // 本地文件路径：读取为 base64 data URL
      try {
        const { readFileSync, existsSync } = await import('fs')
        const { extname } = await import('path')
        if (!existsSync(input.image_path)) {
          return { type: 'error', message: `文件不存在: ${input.image_path}` }
        }
        const buf = readFileSync(input.image_path)
        const ext = extname(input.image_path).toLowerCase()
        const mimeMap: Record<string, string> = {
          '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
          '.png': 'image/png', '.gif': 'image/gif',
          '.webp': 'image/webp', '.bmp': 'image/bmp',
        }
        const mime = mimeMap[ext] ?? 'image/jpeg'
        imageUrls.push(`data:${mime};base64,${buf.toString('base64')}`)
      } catch (err) {
        return { type: 'error', message: `读取图片文件失败: ${String(err)}` }
      }
    }
    if (input.image_data) {
      // 确保有 data: 前缀
      const dataUrl = input.image_data.startsWith('data:')
        ? input.image_data
        : `data:image/jpeg;base64,${input.image_data}`
      imageUrls.push(dataUrl)
    }

    if (imageUrls.length === 0) {
      return { type: 'error', message: '未提供任何图片。请指定 image_url、image_path 或 image_data。' }
    }

    // ── 解析视觉模型配置 ────────────────────────────────────────
    const config = loadConfig()
    const visionCfg = config.vision

    let model: string
    let baseUrl: string
    let apiKey: string | undefined

    if (visionCfg?.fallbacks && visionCfg.fallbacks.length > 0) {
      // 使用 fallback 链中的第一个可用模型
      const first = visionCfg.fallbacks[0]
      model = first.models[0]
      apiKey = first.apiKey
      baseUrl = first.baseUrl ?? resolveDefaultBaseUrl(first.provider)
      if (!apiKey) {
        apiKey = getApiKey(first.provider)
      }
    } else if (visionCfg?.model) {
      model = visionCfg.model
      apiKey = getApiKey(model) ?? config.apiKey
      baseUrl = config.baseUrl ?? 'https://api.openai.com/v1'
    } else {
      // 没有配置 vision 模型 → 尝试复用 llm 配置
      if (config.llm?.fallbacks && config.llm.fallbacks.length > 0) {
        const first = config.llm.fallbacks[0]
        model = first.models[0]
        apiKey = first.apiKey ?? config.apiKey
        baseUrl = first.baseUrl ?? resolveDefaultBaseUrl(first.provider)
      } else {
        model = config.model ?? ''
        apiKey = config.apiKey
        baseUrl = config.baseUrl ?? 'https://api.openai.com/v1'
      }
    }

    if (!apiKey) {
      return {
        type: 'error',
        message:
          '未配置视觉模型的 API Key。请在 config.json 的 vision 字段中配置视觉模型，' +
          '或设置对应的环境变量（如 OPENAI_API_KEY）。\n' +
          `当前解析到的模型: ${model}\n` +
          `配置文件位置: ~/.hrids-agent/config.json`,
      }
    }

    const prompt = input.prompt ?? DEFAULT_VISION_PROMPT

    log.info('调用视觉模型', { model, baseUrl, imageCount: imageUrls.length, promptLen: prompt.length })

    // ── 构建 OpenAI Vision API 请求 ──────────────────────────────
    const content: Array<Record<string, unknown>> = [
      { type: 'text', text: prompt },
    ]
    for (const url of imageUrls) {
      content.push({
        type: 'image_url',
        image_url: { url, detail: 'auto' },
      })
    }

    const body = {
      model,
      messages: [{ role: 'user', content }],
      max_tokens: 2000,
    }

    log.debug('视觉模型请求', {
      model,
      baseUrl,
      imageCount: imageUrls.length,
      bodyBytes: JSON.stringify(body).length,
    })

    try {
      const res = await withRetry(
        () =>
          fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(120_000),
          }),
        { maxAttempts: 2 },
        `vision API [${model}]`,
      )

      if (!res.ok) {
        const errText = await res.text().catch(() => '')
        log.error('视觉模型 API 请求失败', { status: res.status, error: errText })
        return {
          type: 'error',
          message: `视觉模型 API 错误 ${res.status}: ${res.statusText}${errText ? ` — ${errText.slice(0, 300)}` : ''}`,
        }
      }

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>
      }
      const text = data.choices?.[0]?.message?.content

      if (!text) {
        return { type: 'error', message: '视觉模型返回了空内容' }
      }

      return { type: 'success', output: text }
    } catch (err) {
      const msg = String(err)
      if (msg.includes('timeout') || msg.includes('TimeoutError') || msg.includes('AbortError')) {
        return { type: 'error', message: '视觉模型请求超时（120s）' }
      }
      return { type: 'error', message: `视觉模型请求失败: ${msg}` }
    }
  },
}

/** 根据 provider ID 解析默认 baseUrl */
function resolveDefaultBaseUrl(provider: string): string {
  const defaults: Record<string, string> = {
    openai: 'https://api.openai.com/v1',
    deepseek: 'https://api.deepseek.com/v1',
    aliyun: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    zhipu: 'https://open.bigmodel.cn/api/paas/v4',
    groq: 'https://api.groq.com/openai/v1',
    kimi: 'https://api.kimi.com/coding/v1',
    openrouter: 'https://openrouter.ai/api/v1',
    google: 'https://generativelanguage.googleapis.com/v1beta/openai',
  }
  return defaults[provider.toLowerCase()] ?? 'https://api.openai.com/v1'
}
