// 提供商抽象层 —— 统一不同 LLM 服务的接口

import type { ToolDef } from '../Tool.js'

// ── 模型类型 ──────────────────────────────────────────────────
/**
 * 模型功能类型，用于区分不同用途的模型：
 * - llm        大语言模型（纯文本对话、推理、代码生成）
 * - vision     视觉模型（图像理解、图文对话）
 * - multimodal 全模态大模型（文本 + 图像 + 音频输入/输出）
 * - speech     语音模型（TTS 文字转语音 / STT 语音转文字）
 * - embedding  向量模型（文本语义向量化，用于检索/记忆）
 */
export type ModelType = 'llm' | 'vision' | 'multimodal' | 'speech' | 'embedding'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentPart[]
  tool_call_id?: string   // tool 角色时使用
  tool_calls?: ToolCall[] // assistant 角色时使用
  requestId?: string      // 关联到请求 ID，用于前端消息分组
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | { type: 'image'; source: ImageSource }

export interface ImageSource {
  type: 'base64' | 'url'
  mediaType?: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
  data?: string   // base64 编码的图像数据
  url?: string    // 图像 URL
}

export interface ToolCall {
  id: string
  name: string
  input: unknown
}

export interface StreamChunk {
  type: 'text_delta' | 'tool_call' | 'usage' | 'stop_reason' | 'done'
  delta?: string
  toolCall?: ToolCall
  stopReason?: string  // 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence'
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
}

export interface ProviderConfig {
  apiKey: string
  baseUrl?: string   // 自定义端点（Ollama、本地代理等）
  model: string
  modelType?: ModelType
}

// 所有提供商必须实现的接口
export interface LLMProvider {
  readonly name: string
  readonly model: string
  readonly modelType: ModelType
  /**
   * 工具调用模式（默认 "native"）：
   *   - "native"：原生 function calling（OpenAI tool_calls / Anthropic tool_use）
   *   - "dsml"：不传 tools，模型输出 DSML 文本，由 QueryEngine 解析
   */
  readonly toolMode?: 'native' | 'dsml'
  stream(
    messages: ChatMessage[],
    tools: ToolDef[],
    systemPrompt: string[],
    maxTokens: number,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamChunk>
}

// ── 向量模型接口 ──────────────────────────────────────────────
export interface EmbeddingProvider {
  readonly name: string
  readonly model: string
  readonly modelType: 'embedding'
  readonly dimensions: number
  embed(text: string): Promise<number[]>
  embedBatch(texts: string[]): Promise<number[][]>
  ping(): Promise<boolean>
}

// ── 语音模型接口 ──────────────────────────────────────────────
export interface SpeechProvider {
  readonly name: string
  readonly model: string
  readonly modelType: 'speech'
  /** 文字转语音（TTS），返回音频 Buffer */
  textToSpeech?(text: string, options?: TtsOptions): Promise<Buffer>
  /** 语音转文字（STT），传入音频 Buffer，返回文本 */
  speechToText?(audio: Buffer, options?: SttOptions): Promise<string>
}

export interface TtsOptions {
  voice?: string       // 音色/发音人
  speed?: number       // 语速（0.5 ~ 2.0）
  format?: 'mp3' | 'wav' | 'pcm' | 'opus'
}

export interface SttOptions {
  language?: string    // 语言代码，如 'zh' | 'en'
  format?: 'mp3' | 'wav' | 'pcm' | 'opus' | 'webm'
}
