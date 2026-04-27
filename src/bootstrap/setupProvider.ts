// Provider 初始化 —— 从 CLI 参数和环境变量创建 LLM 提供商
import { createProvider, createProviderFromEnv } from '../core/providers/index.js'
import type { LLMProvider } from '../core/providers/index.js'

export interface ProviderOpts {
  model: string
  apiKey?: string
  baseUrl?: string
  provider?: string
}

export function setupProvider(opts: ProviderOpts): LLMProvider {
  const hasFallback = !!process.env.LLM_FALLBACK_1
  if (hasFallback) {
    return createProviderFromEnv()
  }
  return createProvider({
    model: opts.model,
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl || undefined,
    provider: opts.provider as 'anthropic' | 'openai' | 'deepseek' | 'groq' | 'ollama' | 'aliyun' | 'zhipu' | 'nvidia' | 'custom' | undefined,
  })
}
