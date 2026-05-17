// Anthropic 提供商 —— 支持 claude-* 系列模型
import Anthropic from '@anthropic-ai/sdk'
import { toAnthropicTool } from '../Tool.js'
import type { ToolDef } from '../Tool.js'
import type { ChatMessage, LLMProvider, ModelType, ProviderConfig, StreamChunk } from './types.js'

import { logger } from '../logger.js'
import { STATIC_SECTION_COUNT } from '../coordinator/coordinatorPrompt.js'

const log = logger.child({ component: 'anthropic-provider' })

/**
 * 将内部 ChatMessage[]（OpenAI 风格）转换为 Anthropic API 格式。
 *
 * 内部格式：
 * - 工具调用：assistant 消息的 tool_calls 数组
 * - 工具结果：独立的 role: 'tool' 消息
 *
 * Anthropic 格式：
 * - 工具调用：assistant 消息中的 tool_use content blocks
 * - 工具结果：user 消息中的 tool_result content blocks
 */
function toAnthropicMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = []

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]

    if (msg.role === 'user' || msg.role === 'system') {
      result.push({
        role: 'user',
        content: msg.content as Anthropic.MessageParam['content'],
      })
    } else if (msg.role === 'assistant') {
      // 构建 assistant 消息的 content blocks
      const contentBlocks: Anthropic.ContentBlockParam[] = []

      // thinking 必须在 text 之前（Anthropic API 要求）
      const msgAny = msg as unknown as { thinking?: string; thinkingSignature?: string }
      if (msgAny.thinking) {
        contentBlocks.push({ type: 'thinking', thinking: msgAny.thinking, signature: msgAny.thinkingSignature ?? '' } as Anthropic.ContentBlockParam)
      }

      // 处理文本内容
      if (typeof msg.content === 'string') {
        if (msg.content) {
          contentBlocks.push({ type: 'text', text: msg.content })
        }
      } else if (Array.isArray(msg.content)) {
        // 已经是 content blocks 数组
        for (const block of msg.content) {
          if (block.type === 'text' && (block as { text?: string }).text) {
            contentBlocks.push({ type: 'text', text: (block as { text: string }).text })
          } else if (block.type === 'thinking' && (block as { thinking?: string }).thinking) {
            const tb = block as { thinking: string; signature?: string }
            contentBlocks.push({ type: 'thinking', thinking: tb.thinking, signature: tb.signature ?? '' } as Anthropic.ContentBlockParam)
          }
        }
      }

      // 将 tool_calls 转换为 tool_use content blocks
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          contentBlocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.input,
          })
        }
      }

      // 如果没有任何内容，添加空文本块
      if (contentBlocks.length === 0) {
        contentBlocks.push({ type: 'text', text: '' })
      }

      result.push({
        role: 'assistant',
        content: contentBlocks,
      })
    } else if (msg.role === 'tool') {
      // 将 tool 结果转换为 user 消息中的 tool_result content block
      // 收集连续的 tool 消息
      const toolResults: Anthropic.ToolResultBlockParam[] = [{
        type: 'tool_result',
        tool_use_id: msg.tool_call_id ?? '',
        content: typeof msg.content === 'string' ? msg.content : '',
        is_error: (msg as { is_error?: boolean }).is_error,
      }]

      // 继续收集后续的 tool 消息
      while (i + 1 < messages.length && messages[i + 1].role === 'tool') {
        i++
        const nextTool = messages[i]
        toolResults.push({
          type: 'tool_result',
          tool_use_id: nextTool.tool_call_id ?? '',
          content: typeof nextTool.content === 'string' ? nextTool.content : '',
          is_error: (nextTool as { is_error?: boolean }).is_error,
        })
      }

      result.push({
        role: 'user',
        content: toolResults,
      })
    }
  }

  return result
}

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic'
  readonly model: string
  readonly modelType: ModelType

  private client: Anthropic
  private nativeWebSearch: boolean
  private webSearchMode: import('./types.js').WebSearchMode | undefined

  constructor(config: ProviderConfig) {
    this.model = config.model
    this.modelType = config.modelType ?? 'llm'
    this.nativeWebSearch = config.nativeWebSearch ?? false
    this.webSearchMode = config.webSearchMode
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
    let thinkingSignature: string | undefined
    const anthropicMessages = toAnthropicMessages(messages)

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
    if (this.nativeWebSearch && !tools.some(t => t.name === 'web_search')) {
      const toolType = this.webSearchMode?.type === 'tool'
        ? this.webSearchMode.toolType
        : 'web_search_20250305'
      anthropicTools.push({ type: toolType, name: 'web_search' } as unknown as Anthropic.Tool)
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
          let thinkingSignature: string | undefined
          for (const block of final.content) {
            // 跳过原生 web_search 工具调用，它由 Anthropic API 内部处理
            if (block.type === 'tool_use' && !(this.nativeWebSearch && block.name === 'web_search')) {
              yield { type: 'tool_call', toolCall: { id: block.id, name: block.name, input: block.input } }
            }
            if (block.type === 'thinking' && (block as { signature?: string }).signature) {
              thinkingSignature = (block as { signature: string }).signature
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

    yield { type: 'done', thinkingSignature }
  }
}
