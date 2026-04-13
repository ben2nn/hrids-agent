// 提供商抽象层 —— 统一不同 LLM 服务的接口

import type { ToolDef } from '../Tool.js'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentPart[]
  tool_call_id?: string   // tool 角色时使用
  tool_calls?: ToolCall[] // assistant 角色时使用
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

export interface ToolCall {
  id: string
  name: string
  input: unknown
}

export interface StreamChunk {
  type: 'text_delta' | 'tool_call' | 'usage' | 'done'
  delta?: string
  toolCall?: ToolCall
  usage?: { inputTokens: number; outputTokens: number }
}

export interface ProviderConfig {
  apiKey: string
  baseUrl?: string   // 自定义端点（Ollama、本地代理等）
  model: string
}

// 所有提供商必须实现的接口
export interface LLMProvider {
  readonly name: string
  readonly model: string
  stream(
    messages: ChatMessage[],
    tools: ToolDef[],
    systemPrompt: string,
    maxTokens: number,
  ): AsyncGenerator<StreamChunk>
}
