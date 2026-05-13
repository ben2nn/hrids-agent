// OpenAI 兼容提供商 —— 支持 OpenAI、DeepSeek、Groq、Ollama、本地模型等
// 任何实现了 OpenAI Chat Completions API 的服务都可以使用
import type { ToolDef } from '../Tool.js'
import type { ChatMessage, LLMProvider, ModelType, ProviderConfig, StreamChunk } from './types.js'

import { logger } from '../logger.js'
import { zodToJsonSchema } from '../schema.js'

const log = logger.child({ component: 'openai-provider' })


interface OAIMessage {
  role: string
  content: string | null
  reasoning_content?: string
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

interface OAITool {
  type: 'function'
  function: { name: string; description: string; parameters: object }
}

// 将通用 ToolDef 转换为 OpenAI function calling 格式
function toOAITool(tool: ToolDef): OAITool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: zodToJsonSchema(tool.inputSchema),
    },
  }
}

// 将通用消息转换为 OpenAI 格式
function toOAIMessages(messages: ChatMessage[], systemPrompt: string[]): OAIMessage[] {
  // OpenAI 不支持 system 数组，合并为单个 system 消息
  const systemContent = systemPrompt.join('\n\n')

  const result: OAIMessage[] = [{ role: 'system', content: systemContent }]

  for (const msg of messages) {
    if (msg.role === 'user' || msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        result.push({ role: msg.role, content: msg.content })
      } else {
        // 处理包含工具调用的 assistant 消息
        const textParts = (msg.content as Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>)
          .filter(b => b.type === 'text')
          .map(b => b.text ?? '')
          .join('')

        const toolCalls = (msg.content as Array<{ type: string; id?: string; name?: string; input?: unknown }>)
          .filter(b => b.type === 'tool_use')
          .map(b => ({
            id: b.id ?? '',
            type: 'function' as const,
            function: { name: b.name ?? '', arguments: JSON.stringify(b.input) },
          }))

        if (msg.role === 'assistant') {
          // 提取 thinking 块作为 reasoning_content（DeepSeek 等 OpenAI 兼容 API 要求）
          const thinkingParts = (msg.content as Array<{ type: string; thinking?: string }>)
            .filter(b => b.type === 'thinking')
            .map(b => b.thinking ?? '')
            .join('')

          result.push({
            role: 'assistant',
            content: textParts || null,
            ...(thinkingParts ? { reasoning_content: thinkingParts } : {}),
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          })
        } else {
          // user 消息：处理 text、tool_result、图片内容块
          const blocks = msg.content as Array<{ type: string; tool_use_id?: string; content?: string; source?: { type: string; mediaType?: string; data?: string; url?: string } }>

          const imageBlocks = blocks.filter(b => b.type === 'image')
          const toolResults = blocks.filter(b => b.type === 'tool_result')
          const textParts = blocks.filter(b => b.type === 'text').map(b => (b as { text?: string }).text ?? '').join('')

          // tool_result → 转为 role: "tool" 消息（OpenAI 格式要求独立消息）
          // 同时保留 user 消息中的 text 内容（如有）
          if (toolResults.length > 0) {
            if (textParts) {
              result.push({ role: 'user', content: textParts })
            }
            for (const tr of toolResults) {
              result.push({
                role: 'tool',
                content: tr.content ?? '',
                tool_call_id: tr.tool_use_id ?? '',
              })
            }
          } else if (imageBlocks.length > 0) {
            // 包含图片：构建多模态内容数组（OpenAI vision 格式）
            const multiContent: Array<unknown> = []
            for (const b of blocks) {
              if (b.type === 'text') {
                multiContent.push({ type: 'text', text: (b as { type: 'text'; text?: string }).text ?? '' })
              } else if (b.type === 'image' && b.source) {
                if (b.source.type === 'base64' && b.source.data) {
                  multiContent.push({
                    type: 'image_url',
                    image_url: { url: `data:${b.source.mediaType ?? 'image/jpeg'};base64,${b.source.data}` },
                  })
                } else if (b.source.type === 'url' && b.source.url) {
                  multiContent.push({ type: 'image_url', image_url: { url: b.source.url } })
                }
              }
            }
            if (multiContent.length > 0) {
              result.push({ role: 'user', content: multiContent as unknown as string })
            }
          } else if (textParts) {
            // 纯 text 块（无图片、无 tool_result）
            result.push({ role: 'user', content: textParts })
          }
        }
      }
    }
  }
  return result
}

export class OpenAIProvider implements LLMProvider {
  readonly name: string
  readonly model: string
  readonly modelType: ModelType
  private config: ProviderConfig

  constructor(config: ProviderConfig, providerName = 'openai') {
    this.config = config
    this.model = config.model
    this.modelType = config.modelType ?? 'llm'
    this.name = providerName
  }

  async *stream(
    messages: ChatMessage[],
    tools: ToolDef[],
    systemPrompt: string[],
    maxTokens: number,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamChunk> {
    const baseUrl = this.config.baseUrl ?? 'https://api.openai.com/v1'
    const oaiMessages = toOAIMessages(messages, systemPrompt)
    const oaiTools = tools.length > 0 ? tools.map(toOAITool) : undefined

    const body: Record<string, unknown> = {
      model: this.model,
      messages: oaiMessages,
      max_tokens: maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    }
    if (oaiTools) body.tools = oaiTools

    // ── 请求体诊断日志（脱敏：base64 图片只打长度）──────────────────────────
    const debugMessages = oaiMessages.map(m => {
      if (typeof m.content === 'string') {
        return { role: m.role, contentLen: m.content.length, contentPreview: m.content.slice(0, 100) }
      }
      if (Array.isArray(m.content)) {
        return {
          role: m.role,
          parts: (m.content as Array<Record<string, unknown>>).map(p => {
            if (p.type === 'image_url') {
              const url = (p.image_url as Record<string, unknown>)?.url as string ?? ''
              return { type: 'image_url', urlLen: url.length, isDataUrl: url.startsWith('data:') }
            }
            if (p.type === 'text') return { type: 'text', len: (p.text as string)?.length, preview: (p.text as string)?.slice(0, 80) }
            return { type: p.type }
          }),
        }
      }
      return { role: m.role, content: m.content }
    })
    const bodyBytes = JSON.stringify(body).length
    log.debug('[请求诊断] 发送请求体', {
      provider: this.name,
      model: this.model,
      bodyBytes,
      messageCount: oaiMessages.length,
      toolCount: oaiTools?.length ?? 0,
      messages: debugMessages,
    })

    // 仅在非 server 模式下输出调试信息，避免污染 JSON 通信通道
    if (!process.env.AGENT_SERVER_MODE) {
      //process.stderr.write(`[DEBUG] provider=${this.name} model=${this.model}\n`)
      //process.stderr.write(`[DEBUG] baseUrl=${baseUrl}\n`)
      //process.stderr.write(`[DEBUG] apiKey=${keyPreview}\n`)
    }

    // 重试由外层 FallbackProvider 统一处理
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(600000),
    })

    if (!res.ok) {
      const err = await res.text()
      log.error('API 请求失败', { provider: this.name, model: this.model, status: res.status, body: err.slice(0, 500) })
      // 截断响应体，避免泄露敏感信息（如 prompt 片段、token 等）
      throw new Error(`${this.name} API 错误 ${res.status}: ${err.slice(0, 200)}`)
    }

    if (!res.body) throw new Error(`${this.name} API 返回空响应体`)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''

    // 累积工具调用（流式工具调用是分片的）
    const pendingToolCalls: Record<number, { id: string; name: string; args: string }> = {}

    // 响应统计
    let totalTextLen = 0
    let totalToolCalls = 0
    let finalUsage: { inputTokens: number; outputTokens: number } | null = null
    let finishReasonFinal = ''
    const reqStartAt = Date.now()

    // 单次 read() 超时保护：防止服务端保持连接但不发数据导致永久阻塞
    // 使用请求级超时（600s）的一半作为单次读取超时，避免与工具层超时冲突
    const READ_IDLE_TIMEOUT_MS = 300_000 // 5 分钟无数据则超时
    const readWithTimeout = (ms: number) => {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), ms)
      return Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          ctrl.signal.addEventListener('abort', () => reject(new Error(`流式读取超时（${ms / 1000}s 无数据）`)))
        }),
      ]).finally(() => clearTimeout(timer))
    }

    while (true) {
      const { done, value } = await readWithTimeout(READ_IDLE_TIMEOUT_MS)
      if (done) break
      buf += decoder.decode(value, { stream: true })

      const lines = buf.split('\n')
      buf = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') {
          // 输出所有累积的工具调用
          for (const tc of Object.values(pendingToolCalls)) {
            totalToolCalls++
            try {
              yield {
                type: 'tool_call',
                toolCall: { id: tc.id, name: tc.name, input: JSON.parse(tc.args || '{}') },
              }
            } catch (parseErr) {
              log.warn('工具调用参数 JSON 解析失败，跳过该调用', {
                toolName: tc.name, toolId: tc.id,
                argsPreview: tc.args.slice(0, 200),
                error: String(parseErr),
              })
            }
          }
          log.debug('[响应诊断] 流式响应完成', {
            provider: this.name,
            model: this.model,
            elapsedMs: Date.now() - reqStartAt,
            textLen: totalTextLen,
            toolCalls: totalToolCalls,
            finishReason: finishReasonFinal,
            inputTokens: finalUsage?.inputTokens ?? null,
            outputTokens: finalUsage?.outputTokens ?? null,
          })
          yield { type: 'done' }
          return
        }

        try {
          const chunk = JSON.parse(data) as {
            choices?: Array<{
              delta?: {
                content?: string
                tool_calls?: Array<{
                  index: number
                  id?: string
                  function?: { name?: string; arguments?: string }
                }>
              }
              finish_reason?: string
            }>
            usage?: { prompt_tokens: number; completion_tokens: number }
          }

          const delta = chunk.choices?.[0]?.delta
          if (delta?.content) {
            totalTextLen += delta.content.length
            yield { type: 'text_delta', delta: delta.content }
          }

          // 累积工具调用片段
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (!pendingToolCalls[tc.index]) {
                pendingToolCalls[tc.index] = { id: tc.id ?? '', name: tc.function?.name ?? '', args: '' }
              }
              if (tc.id) pendingToolCalls[tc.index].id = tc.id
              if (tc.function?.name) pendingToolCalls[tc.index].name = tc.function.name
              if (tc.function?.arguments) pendingToolCalls[tc.index].args += tc.function.arguments
            }
          }

          // 用量统计（通常在最后一个 chunk）
          if (chunk.usage) {
            finalUsage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens }
            yield {
              type: 'usage',
              usage: {
                inputTokens: chunk.usage.prompt_tokens,
                outputTokens: chunk.usage.completion_tokens,
              },
            }
          }

          // 输出 stop_reason，供 QueryEngine 检测输出截断（length = max_tokens）
          const finishReason = chunk.choices?.[0]?.finish_reason
          if (finishReason) {
            finishReasonFinal = finishReason
            // OpenAI 用 'length' 表示 max_tokens，统一映射为 'max_tokens'
            yield { type: 'stop_reason', stopReason: finishReason === 'length' ? 'max_tokens' : finishReason }
          }
        } catch (parseErr) {
          log.debug('SSE chunk JSON 解析失败', { data: data.slice(0, 200), error: String(parseErr) })
        }
      }
    }

    log.debug('[响应诊断] 流式响应完成（非DONE结束）', {
      provider: this.name,
      model: this.model,
      elapsedMs: Date.now() - reqStartAt,
      textLen: totalTextLen,
      toolCalls: totalToolCalls,
      inputTokens: finalUsage?.inputTokens ?? null,
      outputTokens: finalUsage?.outputTokens ?? null,
    })
    yield { type: 'done' }
  }
}
