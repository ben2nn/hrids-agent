// OpenAI 兼容提供商 —— 支持 OpenAI、DeepSeek、Groq、Ollama、本地模型等
// 任何实现了 OpenAI Chat Completions API 的服务都可以使用
import { z } from 'zod'
import type { ToolDef } from '../Tool.js'
import type { ChatMessage, LLMProvider, ModelType, ProviderConfig, StreamChunk } from './types.js'
import { withRetry } from '../retry.js'
import { logger } from '../logger.js'
import { zodToJsonSchema } from '../schema.js'

const log = logger.child({ component: 'openai-provider' })

interface OAIMessage {
  role: string
  content: string | null
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
function toOAIMessages(messages: ChatMessage[], systemPrompt: string): OAIMessage[] {
  const result: OAIMessage[] = [{ role: 'system', content: systemPrompt }]

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
          result.push({
            role: 'assistant',
            content: textParts || null,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          })
        } else {
          // user 消息：处理 tool_result 和图片内容块
          const blocks = msg.content as Array<{ type: string; tool_use_id?: string; content?: string; source?: { type: string; mediaType?: string; data?: string; url?: string } }>

          // 检查是否有图片块
          const imageBlocks = blocks.filter(b => b.type === 'image')
          const toolResults = blocks.filter(b => b.type === 'tool_result')

          if (imageBlocks.length > 0) {
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
          } else if (toolResults.length > 0) {
            for (const tr of toolResults) {
              result.push({
                role: 'tool',
                content: tr.content ?? '',
                tool_call_id: tr.tool_use_id ?? '',
              })
            }
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
    systemPrompt: string,
    maxTokens: number,
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

    const keyPreview = this.config.apiKey
      ? `${this.config.apiKey.slice(0, 8)}...（共${this.config.apiKey.length}位）`
      : '（空）'
    // 仅在非 server 模式下输出调试信息，避免污染 JSON 通信通道
    if (!process.env.AGENT_SERVER_MODE) {
      //process.stderr.write(`[DEBUG] provider=${this.name} model=${this.model}\n`)
      //process.stderr.write(`[DEBUG] baseUrl=${baseUrl}\n`)
      //process.stderr.write(`[DEBUG] apiKey=${keyPreview}\n`)
    }

    // 带重试的 fetch（网络错误/429/5xx 自动退避重试）
    const res = await withRetry(
      () => fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(600000),
      }),
      { maxAttempts: 3 },
      `${this.name} API [${this.model}]`,
    )

    if (!res.ok) {
      const err = await res.text()
      log.error('API 请求失败', { provider: this.name, model: this.model, status: res.status })
      throw new Error(`${this.name} API 错误 ${res.status}: ${err}`)
    }

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buf = ''

    // 累积工具调用（流式工具调用是分片的）
    const pendingToolCalls: Record<number, { id: string; name: string; args: string }> = {}

    // 单次 read() 超时保护：防止服务端保持连接但不发数据导致永久阻塞
    // 使用请求级超时（600s）的一半作为单次读取超时，避免与工具层超时冲突
    const READ_IDLE_TIMEOUT_MS = 300_000 // 5 分钟无数据则超时
    const readWithTimeout = (ms: number) => Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`流式读取超时（${ms / 1000}s 无数据）`)), ms)
      ),
    ])

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
            try {
              yield {
                type: 'tool_call',
                toolCall: { id: tc.id, name: tc.name, input: JSON.parse(tc.args || '{}') },
              }
            } catch { /* JSON 解析失败忽略 */ }
          }
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
            // OpenAI 用 'length' 表示 max_tokens，统一映射为 'max_tokens'
            yield { type: 'stop_reason', stopReason: finishReason === 'length' ? 'max_tokens' : finishReason }
          }
        } catch { /* 忽略解析错误 */ }
      }
    }

    yield { type: 'done' }
  }
}
