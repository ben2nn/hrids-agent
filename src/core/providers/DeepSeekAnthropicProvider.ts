// DeepSeek Anthropic 兼容提供商
//
// DS2API（DeepSeek → Anthropic 兼容层）的实际行为：
//   - 接受 Anthropic Messages API 格式（POST /v1/messages）
//   - baseUrl 直接指向根地址，不加 /v1（SDK 会自动拼接）
//   - 工具调用以 DSML 文本格式返回，而非原生 tool_use block
//   - 不支持 cache_control、beta 等 Anthropic 专有字段
//
// 因此本 provider：
//   1. 用原生 fetch 而非 Anthropic SDK，避免 SDK 注入不兼容的请求头/字段
//   2. 去掉 cache_control（DS2API 会报错）
//   3. 工具调用走 text_delta 累积，由 QueryEngine 的 DSML 解析逻辑兜底处理

import type { ToolDef } from '../Tool.js'
import type { ChatMessage, ContentPart, LLMProvider, ModelType, ProviderConfig, StreamChunk } from './types.js'
import { zodToJsonSchema } from '../schema.js'
import { withRetry } from '../retry.js'
import { logger } from '../logger.js'

const log = logger.child({ component: 'deepseek-anthropic-provider' })

// ── 消息格式转换 ──────────────────────────────────────────────

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string } }

function toAnthropicMessages(messages: ChatMessage[]): AnthropicMessage[] {
  const result: AnthropicMessage[] = []

  for (const msg of messages) {
    if (msg.role !== 'user' && msg.role !== 'assistant') continue

    if (typeof msg.content === 'string') {
      result.push({ role: msg.role, content: msg.content })
      continue
    }

    const blocks: AnthropicContentBlock[] = []
    for (const part of msg.content as ContentPart[]) {
      if (part.type === 'text') {
        blocks.push({ type: 'text', text: part.text })
      } else if (part.type === 'tool_use') {
        blocks.push({ type: 'tool_use', id: part.id, name: part.name, input: part.input })
      } else if (part.type === 'tool_result') {
        blocks.push({ type: 'tool_result', tool_use_id: part.tool_use_id, content: part.content, is_error: part.is_error })
      } else if (part.type === 'image' && part.source) {
        if (part.source.type === 'base64' && part.source.data) {
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: part.source.mediaType ?? 'image/jpeg', data: part.source.data },
          })
        } else if (part.source.type === 'url' && part.source.url) {
          blocks.push({ type: 'image', source: { type: 'url', url: part.source.url } })
        }
      }
    }

    if (blocks.length > 0) {
      result.push({ role: msg.role, content: blocks })
    }
  }

  return result
}

function toAnthropicTool(tool: ToolDef): object {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: zodToJsonSchema(tool.inputSchema),
  }
}

// ── Provider 实现 ─────────────────────────────────────────────

export class DeepSeekAnthropicProvider implements LLMProvider {
  readonly name = 'deepseek-anthropic'
  readonly model: string
  readonly modelType: ModelType
  readonly toolMode = 'dsml' as const
  private apiKey: string
  private baseUrl: string

  constructor(config: ProviderConfig) {
    this.model = config.model
    this.modelType = config.modelType ?? 'llm'
    this.apiKey = config.apiKey
    // DS2API 根地址，不加 /v1（fetch 时手动拼接 /v1/messages）
    this.baseUrl = (config.baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/, '')
  }

  async *stream(
    messages: ChatMessage[],
    tools: ToolDef[],
    systemPrompt: string[],
    maxTokens: number,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamChunk> {
    const anthropicMessages = toAnthropicMessages(messages)

    // system 合并为纯文本，不加 cache_control（DS2API 不支持）
    const systemText = systemPrompt.join('\n\n')

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: maxTokens,
      system: systemText,
      messages: anthropicMessages,
      stream: true,
    }

    if (tools.length > 0) {
      body.tools = tools.map(toAnthropicTool)
    }

    const url = `${this.baseUrl}/v1/messages`

    const res = await withRetry(
      () => fetch(url, {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
      }),
      { maxAttempts: 3 },
      `DeepSeek-Anthropic [${this.model}]`,
    )

    if (!res.ok) {
      const err = await res.text()
      log.error('API 请求失败', { model: this.model, status: res.status, body: err })
      throw new Error(`DeepSeek-Anthropic API 错误 ${res.status}: ${err}`)
    }

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buf = ''

    // 累积 tool_use block（原生 function calling 路径，DS2API 目前不走此路径）
    const pendingToolUse: Record<string, { id: string; name: string; inputJson: string }> = {}

    const READ_IDLE_TIMEOUT_MS = 300_000
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
        if (line.startsWith('event:')) continue
        if (!line.startsWith('data:')) continue

        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') continue

        try {
          const evt = JSON.parse(data) as Record<string, unknown>
          yield* this.handleSseEvent(evt, pendingToolUse)
        } catch {
          // 忽略解析失败的行
        }
      }
    }

    yield { type: 'done' }
  }

  private *handleSseEvent(
    evt: Record<string, unknown>,
    pendingToolUse: Record<string, { id: string; name: string; inputJson: string }>,
  ): Generator<StreamChunk> {
    const evtType = evt.type as string | undefined

    switch (evtType) {
      // ── 文本 delta ──────────────────────────────────────────
      case 'content_block_delta': {
        const delta = evt.delta as Record<string, unknown> | undefined
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          yield { type: 'text_delta', delta: delta.text }
        } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          // 原生 function calling：累积 tool input JSON
          const idx = String(evt.index ?? 0)
          if (pendingToolUse[idx]) {
            pendingToolUse[idx].inputJson += delta.partial_json
          }
        }
        break
      }

      // ── tool_use block 开始（原生 function calling）──────────
      case 'content_block_start': {
        const block = evt.content_block as Record<string, unknown> | undefined
        if (block?.type === 'tool_use') {
          const idx = String(evt.index ?? 0)
          pendingToolUse[idx] = {
            id: String(block.id ?? ''),
            name: String(block.name ?? ''),
            inputJson: '',
          }
        }
        break
      }

      // ── block 结束：输出完整的 tool_call ────────────────────
      case 'content_block_stop': {
        const idx = String(evt.index ?? 0)
        const tc = pendingToolUse[idx]
        if (tc) {
          delete pendingToolUse[idx]
          try {
            const input = JSON.parse(tc.inputJson || '{}') as unknown
            yield { type: 'tool_call', toolCall: { id: tc.id, name: tc.name, input } }
          } catch {
            log.warn('tool_use input JSON 解析失败', { name: tc.name, raw: tc.inputJson })
          }
        }
        break
      }

      // ── 用量统计 ─────────────────────────────────────────────
      case 'message_delta': {
        const usage = (evt.usage as Record<string, unknown> | undefined)
        if (usage) {
          yield {
            type: 'usage',
            usage: {
              inputTokens: Number(usage.input_tokens ?? 0),
              outputTokens: Number(usage.output_tokens ?? 0),
            },
          }
        }
        const delta = evt.delta as Record<string, unknown> | undefined
        if (delta?.stop_reason) {
          yield { type: 'stop_reason', stopReason: String(delta.stop_reason) }
        }
        break
      }

      case 'message_start': {
        const msg = evt.message as Record<string, unknown> | undefined
        const usage = msg?.usage as Record<string, unknown> | undefined
        if (usage) {
          yield {
            type: 'usage',
            usage: {
              inputTokens: Number(usage.input_tokens ?? 0),
              outputTokens: Number(usage.output_tokens ?? 0),
              cacheReadTokens: Number(usage.cache_read_input_tokens ?? 0),
              cacheWriteTokens: Number(usage.cache_creation_input_tokens ?? 0),
            },
          }
        }
        break
      }
    }
  }
}
