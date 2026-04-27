// Anthropic 提供商 —— 支持 claude-* 系列模型
import Anthropic from '@anthropic-ai/sdk'
import { toAnthropicTool } from '../Tool.js'
import type { ToolDef } from '../Tool.js'
import type { ChatMessage, LLMProvider, ModelType, ProviderConfig, StreamChunk } from './types.js'
import { withRetry } from '../retry.js'
import { logger } from '../logger.js'

const log = logger.child({ component: 'anthropic-provider' })

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic'
  readonly model: string
  readonly modelType: ModelType
  private client: Anthropic

  constructor(config: ProviderConfig) {
    this.model = config.model
    this.modelType = config.modelType ?? 'llm'
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    })
  }

  async *stream(
    messages: ChatMessage[],
    tools: ToolDef[],
    systemPrompt: string,
    maxTokens: number,
  ): AsyncGenerator<StreamChunk> {
    const anthropicMessages = messages.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content as Anthropic.MessageParam['content'],
    }))

    // 用 withRetry 包装 stream 创建（网络错误/限流时自动退避重试）
    const stream = await withRetry(
      () => Promise.resolve(this.client.messages.stream({
        model: this.model,
        max_tokens: maxTokens,
        system: systemPrompt,
        tools: tools.map(toAnthropicTool) as Anthropic.Tool[],
        messages: anthropicMessages,
      })),
      { maxAttempts: 3 },
      `Anthropic stream [${this.model}]`,
    )

    try {
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield { type: 'text_delta', delta: event.delta.text }
        } else if (event.type === 'message_stop') {
          const final = await stream.finalMessage()
          for (const block of final.content) {
            if (block.type === 'tool_use') {
              yield { type: 'tool_call', toolCall: { id: block.id, name: block.name, input: block.input } }
            }
          }
          const u = final.usage
          const usageAny = u as unknown as Record<string, number>
          yield {
            type: 'usage',
            usage: {
              inputTokens: u.input_tokens,
              outputTokens: u.output_tokens,
              cacheReadTokens: usageAny['cache_read_input_tokens'] ?? 0,
              cacheWriteTokens: usageAny['cache_creation_input_tokens'] ?? 0,
            },
          }
          // 输出 stop_reason，供 QueryEngine 检测输出截断（max_tokens）
          if (final.stop_reason) {
            yield { type: 'stop_reason', stopReason: final.stop_reason }
          }
        }
      }
    } catch (err) {
      log.error('流式请求失败', { model: this.model, error: String(err) })
      throw err
    }

    yield { type: 'done' }
  }
}
