// 提供商工厂 —— 根据注册表和 config.json 自动选择正确的提供商
import { AnthropicProvider } from './AnthropicProvider.js'
import { OpenAIProvider } from './OpenAIProvider.js'
import { DeepSeekAnthropicProvider } from './DeepSeekAnthropicProvider.js'
import { FallbackProvider } from './FallbackProvider.js'
import type { LLMProvider, ModelType, ProviderConfig } from './types.js'
import {
  getBuiltinProvider,
  getCustomProvider,
  inferProviderByModel,
  normalizeProvider,
  type CustomProviderConfig,
  type ProviderDef,
} from './registry.js'
import type { ModelFallbackGroup, ModelTypeConfig } from '../Config.js'

export type { LLMProvider, ModelType, ProviderConfig, StreamChunk, ChatMessage, EmbeddingProvider, SpeechProvider } from './types.js'
export { AnthropicProvider } from './AnthropicProvider.js'
export { OpenAIProvider } from './OpenAIProvider.js'
export { DeepSeekAnthropicProvider } from './DeepSeekAnthropicProvider.js'
export { FallbackProvider } from './FallbackProvider.js'
export { BUILTIN_PROVIDERS, PROVIDER_ALIASES, normalizeProvider, getBuiltinProvider, getCustomProvider, inferProviderByModel } from './registry.js'
export type { ProviderDef, CustomProviderConfig } from './registry.js'

// ── ProviderOptions ───────────────────────────────────────────

export interface ProviderOptions {
  model: string
  apiKey?: string
  baseUrl?: string
  modelType?: ModelType
  /** 显式指定提供商（支持内置 ID、别名、自定义提供商名称） */
  provider?: string
  /** 用户自定义提供商列表（来自 config.json 的 customProviders） */
  customProviders?: CustomProviderConfig[]
  /**
   * 工具调用模式（默认 "native"）：
   *   - "native"：原生 function calling
   *   - "dsml"：强制走 DSML 文本解析（DS2API 等兼容层）
   */
  toolMode?: 'native' | 'dsml'
}

// ── 单一提供商创建 ────────────────────────────────────────────

export function createProvider(opts: ProviderOptions): LLMProvider {
  const { model, baseUrl, customProviders = [] } = opts

  // 1. 显式指定提供商
  if (opts.provider) {
    const def = resolveProviderDef(opts.provider, customProviders)
    if (!def) {
      throw new Error(
        `未知提供商: "${opts.provider}"。\n` +
        `内置提供商: ${BUILTIN_PROVIDER_IDS.join(', ')}\n` +
        `如需自定义提供商，请在 config.json 的 customProviders 中添加。`
      )
    }
    return buildFromDef(def, opts)
  }

  // 2. 根据 baseUrl 自动判断（localhost → Ollama）
  if (baseUrl?.includes('localhost') || baseUrl?.includes('127.0.0.1')) {
    return new OpenAIProvider(
      { apiKey: opts.apiKey ?? 'ollama', baseUrl, model, modelType: opts.modelType },
      'ollama',
    )
  }

  // 3. 根据模型名前缀自动推断提供商
  const inferred = inferProviderByModel(model)
  if (inferred) return buildFromDef(inferred, opts)

  // 4. 兜底：有 apiKey 则尝试 Anthropic
  if (opts.apiKey) {
    return new AnthropicProvider({ apiKey: opts.apiKey, baseUrl, model, modelType: opts.modelType })
  }

  throw new Error(
    `无法自动识别模型 "${model}" 的提供商。\n` +
    `请在 config.json 中设置 provider 字段，或在 llm.fallbacks 中指定 provider。\n` +
    `内置提供商: ${BUILTIN_PROVIDER_IDS.join(', ')}`
  )
}

// ── 内部：从 ProviderDef 构建 LLMProvider ─────────────────────

function buildFromDef(def: ProviderDef, opts: ProviderOptions): LLMProvider {
  const { model, modelType, toolMode = 'native' } = opts
  const baseUrl = opts.baseUrl ?? def.defaultBaseUrl
  const apiKey = opts.apiKey

  const config: ProviderConfig = { apiKey: apiKey ?? '', baseUrl, model, modelType }

  if (def.transport === 'anthropic_messages') {
    if (!apiKey) throw new Error(`缺少 ${def.name} 的 API Key，请在 llm.fallbacks 中为 ${def.id} 配置 apiKey`)
    // dsml 模式或 deepseekCompat：使用 DeepSeekAnthropicProvider
    // 去掉 cache_control 等不兼容字段，工具调用走 DSML 文本解析
    if (toolMode === 'dsml' || def.deepseekCompat) {
      return new DeepSeekAnthropicProvider(config)
    }
    return new AnthropicProvider(config)
  }

  if (def.id !== 'ollama' && !apiKey) {
    throw new Error(`缺少 ${def.name} 的 API Key，请在 llm.fallbacks 中为 ${def.id} 配置 apiKey`)
  }
  // dsml 模式下禁用 OpenAI function calling，让模型输出 DSML 文本
  return new OpenAIProvider({ ...config, apiKey: apiKey ?? 'ollama' }, def.id, toolMode === 'dsml')
}

/** 解析提供商定义（内置 → 自定义） */
function resolveProviderDef(name: string, customs: CustomProviderConfig[]): ProviderDef | undefined {
  return getBuiltinProvider(name) ?? getCustomProvider(name, customs)
}

const BUILTIN_PROVIDER_IDS = ['anthropic', 'openai', 'deepseek', 'deepseek-anthropic', 'groq', 'aliyun', 'zhipu', 'nvidia', 'ollama', 'openrouter', 'kimi', 'minimax', 'google']

// ── 多模型 Fallback 工厂 ──────────────────────────────────────

export function createFallbackProvider(configs: ProviderOptions[]): LLMProvider {
  if (configs.length === 0) throw new Error('至少需要一个提供商配置')
  if (configs.length === 1) return createProvider(configs[0])
  return new FallbackProvider(configs.map(c => createProvider(c)))
}

export function createGroupedFallbackProvider(groups: Array<{ platformName: string; configs: ProviderOptions[] }>): LLMProvider {
  if (groups.length === 0) throw new Error('至少需要一个平台配置')

  const allProviders: LLMProvider[] = []
  const providerGroups: import('./FallbackProvider.js').ProviderGroup[] = []

  for (const g of groups) {
    const providers = g.configs.map(c => createProvider(c))
    allProviders.push(...providers)
    providerGroups.push({ platformName: g.platformName, providers })
  }

  if (allProviders.length === 1) return allProviders[0]
  return new FallbackProvider(allProviders, providerGroups)
}

// ── 从 config 创建指定类型的 Provider ────────────────────────

interface TypedProviderContext {
  typeConfig?: ModelTypeConfig
  customProviders?: CustomProviderConfig[]
  modelType: ModelType
}

/**
 * 从 ModelTypeConfig（config.json 中的 llm / vision / multimodal / speech）
 * 创建对应的 LLMProvider，支持多平台 Fallback。
 * API Key 直接从各 fallback 条目的 apiKey 字段读取。
 */
export function createTypedProvider(ctx: TypedProviderContext): LLMProvider | null {
  const { typeConfig, customProviders = [], modelType } = ctx
  if (!typeConfig) return null

  // 有 fallbacks 配置 → 构建分组 Fallback
  if (typeConfig.fallbacks && typeConfig.fallbacks.length > 0) {
    const groups = typeConfig.fallbacks.map(g => ({
      platformName: g.provider,
      configs: g.models.map(model => ({
        model,
        provider: normalizeProvider(g.provider),
        apiKey: g.apiKey,
        baseUrl: g.baseUrl,
        modelType,
        customProviders,
        toolMode: g.toolMode,
      } satisfies ProviderOptions)),
    }))

    if (!process.env.AGENT_SERVER_MODE) {
      const chain = groups.map((g, i) =>
        `[平台${i + 1}:${g.platformName}] ${g.configs.map(c => c.model).join(' → ')}`
      ).join(' || ')
      process.stderr.write(`[providers] ${modelType} fallback 链: ${chain}\n`)
    }

    return createGroupedFallbackProvider(groups)
  }

  // 只有单一 model
  if (typeConfig.model) {
    return createProvider({ model: typeConfig.model, modelType, customProviders })
  }

  return null
}

// ── 便捷工厂（供 setupProvider / gateway 使用）────────────────

/**
 * 从完整 config 创建 LLM 提供商。
 * 优先级：config.llm.fallbacks > config.llm.model > config.model
 */
export function createProviderFromConfig(config: {
  model: string
  provider?: string
  apiKey?: string
  baseUrl?: string
  llm?: ModelTypeConfig
  customProviders?: CustomProviderConfig[]
}): LLMProvider {
  const { customProviders = [] } = config

  // 1. llm 字段（含 fallbacks）
  const fromLlm = createTypedProvider({ typeConfig: config.llm, customProviders, modelType: 'llm' })
  if (fromLlm) return fromLlm

  // 2. 顶层 model + provider
  return createProvider({
    model: config.model,
    provider: config.provider,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    modelType: 'llm',
    customProviders,
  })
}

export function createVisionProviderFromConfig(config: {
  vision?: ModelTypeConfig
  customProviders?: CustomProviderConfig[]
}): LLMProvider | null {
  return createTypedProvider({
    typeConfig: config.vision,
    customProviders: config.customProviders,
    modelType: 'vision',
  })
}

export function createMultimodalProviderFromConfig(config: {
  multimodal?: ModelTypeConfig
  customProviders?: CustomProviderConfig[]
}): LLMProvider | null {
  return createTypedProvider({
    typeConfig: config.multimodal,
    customProviders: config.customProviders,
    modelType: 'multimodal',
  })
}

export function createSpeechProviderFromConfig(config: {
  speech?: ModelTypeConfig
  customProviders?: CustomProviderConfig[]
}): LLMProvider | null {
  return createTypedProvider({
    typeConfig: config.speech,
    customProviders: config.customProviders,
    modelType: 'speech',
  })
}
