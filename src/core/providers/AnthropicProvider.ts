// Anthropic 提供商 —— 支持 claude-* 系列模型
import Anthropic from '@anthropic-ai/sdk'
import { toAnthropicTool } from '../Tool.js'
import type { ToolDef } from '../Tool.js'
import type { ChatMessage, LLMProvider, ModelType, ProviderConfig, StreamChunk } from './types.js'

import { logger } from '../logger.js'
import { STATIC_SECTION_COUNT } from '../coordinator/coordinatorPrompt.js'

const log = logger.child({ component: 'anthropic-provider' })

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic'
  readonly model: string
  readonly modelType: ModelType

  private client: Anthropic
  private nativeWebSearch: boolean

  constructor(config: ProviderConfig) {
    this.model = config.model
    this.modelType = config.modelType ?? 'llm'
    this.nativeWebSearch = config.nativeWebSearch ?? false
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    })
  }

  async *stream(
    messages: ChatMessage[],
    tools: ToolDef[],
    systemPrompt: string[],
    maxTokens: number,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamChunk> {
    const anthropicMessages = messages.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content as Anthropic.MessageParam['content'],
    }))

    // 将 string[] 转为 Anthropic system blocks，精确控制缓存边界：
    //
    // 数组结构（由 getCoordinatorSystemPrompt + buildSystemContext 保证）：
    //   [0..STATIC_SECTION_COUNT-1] 静态层 —— 内容固定，打 cache_control
    //   [STATIC_SECTION_COUNT..]    动态层 —— 工具速查、扩展层、记忆、环境，不缓存
    //
    // STATIC_SECTION_COUNT 从 coordinatorPrompt.ts 导入，与 STATIC_SECTIONS.length 自动同步。
    const systemBlocks: Anthropic.TextBlockParam[] = systemPrompt.map((text, i) => {
      const isStatic = i < STATIC_SECTION_COUNT
      return isStatic
        ? { type: 'text', text, cache_control: { type: 'ephemeral' } as Anthropic.CacheControlEphemeral }
        : { type: 'text', text }
    })

    // 构建工具列表
    const anthropicTools: Anthropic.Tool[] = tools.length > 0
      ? tools.map(toAnthropicTool) as Anthropic.Tool[]
      : []
    // 原生联网搜索：Claude 内部搜索并返回结果
    if (this.nativeWebSearch) {
      anthropicTools.push({ type: 'web_search_20250305', name: 'web_search' } as unknown as Anthropic.Tool)
    }

    // 重试由外层 FallbackProvider 统一处理
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: maxTokens,
      system: systemBlocks,
      tools: anthropicTools.length > 0 ? anthropicTools : undefined,
      messages: anthropicMessages,
    }, { signal })

    try {
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield { type: 'text_delta', delta: event.delta.text }
        } else if (event.type === 'content_block_delta' && event.delta.type === 'thinking_delta') {
          yield { type: 'thinking_delta', delta: event.delta.thinking }
        } else if (event.type === 'message_stop') {
          const final = await stream.finalMessage()
          for (const block of final.content) {
            // 跳过原生 web_search 工具调用，它由 Anthropic API 内部处理
            if (block.type === 'tool_use' && !(this.nativeWebSearch && block.name === 'web_search')) {
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
