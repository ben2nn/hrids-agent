// 提供商工厂 —— 根据配置自动选择正确的提供商
import { AnthropicProvider } from './AnthropicProvider.js'
import { OpenAIProvider } from './OpenAIProvider.js'
import { FallbackProvider } from './FallbackProvider.js'
import type { LLMProvider, ProviderConfig } from './types.js'

export type { LLMProvider, ProviderConfig, StreamChunk, ChatMessage } from './types.js'
export { AnthropicProvider } from './AnthropicProvider.js'
export { OpenAIProvider } from './OpenAIProvider.js'
export { FallbackProvider } from './FallbackProvider.js'

// 已知的模型前缀 → 提供商映射
const ANTHROPIC_PREFIXES = ['claude-']
const OPENAI_PREFIXES = ['gpt-', 'o1', 'o3', 'o4']
const DEEPSEEK_PREFIXES = ['deepseek-']
const GROQ_PREFIXES = ['llama', 'mixtral', 'gemma', 'whisper']
// 阿里云百炼（DashScope）模型前缀
const ALIYUN_PREFIXES = ['qwen', 'qwq-', 'qvq-']
// 智谱 AI 模型前缀
const ZHIPU_PREFIXES = ['glm-', 'cogview-', 'cogvideo-', 'embedding-']

export interface ProviderOptions {
  model: string
  apiKey?: string
  baseUrl?: string
  // 显式指定提供商（覆盖自动检测）
  provider?: 'anthropic' | 'openai' | 'deepseek' | 'groq' | 'ollama' | 'aliyun' | 'zhipu' | 'nvidia' | 'custom'
}

export function createProvider(opts: ProviderOptions): LLMProvider {
  const { model, baseUrl } = opts

  // 显式指定提供商
  if (opts.provider) {
    return buildProvider(opts.provider, opts)
  }

  // 根据 baseUrl 自动判断（Ollama 通常是 localhost）
  if (baseUrl?.includes('localhost') || baseUrl?.includes('127.0.0.1')) {
    return new OpenAIProvider({ apiKey: opts.apiKey ?? 'ollama', baseUrl, model }, 'ollama')
  }

  // 根据模型名前缀自动判断
  if (ANTHROPIC_PREFIXES.some(p => model.startsWith(p))) {
    return new AnthropicProvider({ apiKey: requireKey(opts, 'ANTHROPIC_API_KEY'), baseUrl, model })
  }
  if (OPENAI_PREFIXES.some(p => model.startsWith(p))) {
    return new OpenAIProvider({ apiKey: requireKey(opts, 'OPENAI_API_KEY'), baseUrl, model }, 'openai')
  }
  if (DEEPSEEK_PREFIXES.some(p => model.startsWith(p))) {
    return new OpenAIProvider({
      apiKey: requireKey(opts, 'DEEPSEEK_API_KEY'),
      baseUrl: baseUrl ?? 'https://api.deepseek.com/v1',
      model,
    }, 'deepseek')
  }
  if (GROQ_PREFIXES.some(p => model.toLowerCase().startsWith(p))) {
    return new OpenAIProvider({
      apiKey: requireKey(opts, 'GROQ_API_KEY'),
      baseUrl: baseUrl ?? 'https://api.groq.com/openai/v1',
      model,
    }, 'groq')
  }
  if (ALIYUN_PREFIXES.some(p => model.startsWith(p))) {
    return new OpenAIProvider({
      apiKey: requireKey(opts, 'DASHSCOPE_API_KEY'),
      baseUrl: baseUrl ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model,
    }, 'aliyun')
  }
  if (ZHIPU_PREFIXES.some(p => model.startsWith(p))) {
    return new OpenAIProvider({
      apiKey: requireKey(opts, 'ZHIPU_API_KEY'),
      baseUrl: baseUrl ?? 'https://open.bigmodel.cn/api/paas/v4',
      model,
    }, 'zhipu')
  }

  // 默认尝试 Anthropic
  const key = opts.apiKey ?? process.env.ANTHROPIC_API_KEY
  if (key) return new AnthropicProvider({ apiKey: key, baseUrl, model })

  throw new Error(
    `无法自动识别模型 "${model}" 的提供商。\n` +
    `请通过 --provider 指定，或设置对应的环境变量。\n` +
    `支持的提供商: anthropic, openai, deepseek, groq, ollama, custom`
  )
}

function buildProvider(provider: string, opts: ProviderOptions): LLMProvider {
  const { model, baseUrl } = opts
  switch (provider) {
    case 'anthropic':
      return new AnthropicProvider({ apiKey: requireKey(opts, 'ANTHROPIC_API_KEY'), baseUrl, model })
    case 'openai':
      return new OpenAIProvider({ apiKey: requireKey(opts, 'OPENAI_API_KEY'), baseUrl, model }, 'openai')
    case 'deepseek':
      return new OpenAIProvider({
        apiKey: requireKey(opts, 'DEEPSEEK_API_KEY'),
        baseUrl: baseUrl ?? 'https://api.deepseek.com/v1',
        model,
      }, 'deepseek')
    case 'groq':
      return new OpenAIProvider({
        apiKey: requireKey(opts, 'GROQ_API_KEY'),
        baseUrl: baseUrl ?? 'https://api.groq.com/openai/v1',
        model,
      }, 'groq')
    case 'aliyun':
      return new OpenAIProvider({
        apiKey: requireKey(opts, 'DASHSCOPE_API_KEY'),
        baseUrl: baseUrl ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model,
      }, 'aliyun')
    case 'zhipu':
      return new OpenAIProvider({
        apiKey: requireKey(opts, 'ZHIPU_API_KEY'),
        baseUrl: baseUrl ?? 'https://open.bigmodel.cn/api/paas/v4',
        model,
      }, 'zhipu')
    case 'nvidia':
      return new OpenAIProvider({
        apiKey: requireKey(opts, 'NVIDIA_API_KEY'),
        baseUrl: baseUrl ?? 'https://integrate.api.nvidia.com/v1',
        model,
      }, 'nvidia')
    case 'ollama':
      return new OpenAIProvider({
        apiKey: 'ollama',
        baseUrl: baseUrl ?? 'http://localhost:11434/v1',
        model,
      }, 'ollama')
    case 'custom':
      return new OpenAIProvider({
        apiKey: requireKey(opts, 'CUSTOM_API_KEY'),
        baseUrl: baseUrl ?? (() => { throw new Error('custom 提供商需要 --base-url') })(),
        model,
      }, 'custom')
    default:
      throw new Error(`未知提供商: ${provider}，支持的提供商: anthropic, openai, deepseek, groq, ollama, aliyun, zhipu, nvidia, custom`)
  }
}

function requireKey(opts: ProviderOptions, envVar: string): string {
  const key = opts.apiKey ?? process.env[envVar]
  if (!key) throw new Error(`缺少 API Key，请设置环境变量 ${envVar} 或使用 --api-key 参数`)
  return key
}

/**
 * 创建多 LLM 故障转移提供商（带平台分组）
 * 同平台内按模型顺序切换，平台全挂再跨平台
 */
export function createFallbackProvider(configs: ProviderOptions[]): LLMProvider {
  if (configs.length === 0) throw new Error('至少需要一个提供商配置')
  if (configs.length === 1) return createProvider(configs[0])
  return new FallbackProvider(configs.map(c => createProvider(c)))
}

/**
 * 创建带平台分组的故障转移提供商
 * groups 内同平台模型先切换，平台全挂再跨平台
 */
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

/**
 * 从环境变量读取多 LLM 配置并创建 FallbackProvider（带平台分组）
 *
 * 环境变量格式（按优先级排列）：
 *   LLM_FALLBACK_1=provider:aliyun,models:qwen3.5-flash,qwen3.5-plus
 *   LLM_FALLBACK_2=provider:deepseek,models:deepseek-chat,deepseek-reasoner
 *
 * 同一 LLM_FALLBACK_N 行内的模型属于同一平台，优先在平台内切换，
 * 平台内全部失败后才跨到下一个 LLM_FALLBACK_N+1 平台。
 */
export function createProviderFromEnv(): LLMProvider {
  const groups: Array<{ platformName: string; configs: ProviderOptions[] }> = []

  // 读取 LLM_FALLBACK_1 ~ LLM_FALLBACK_20
  for (let i = 1; i <= 20; i++) {
    const raw = process.env[`LLM_FALLBACK_${i}`]
    if (!raw) break

    const entries = parseProviderLine(raw)
    if (entries.length === 0) {
      throw new Error(`LLM_FALLBACK_${i} 解析失败，请检查格式`)
    }

    // 平台名取 provider 字段，或第一个模型名
    const platformName = entries[0].provider ?? entries[0].model
    groups.push({ platformName, configs: entries })
  }

  if (groups.length > 0) {
    const allModels = groups.flatMap(g => g.configs)
    if (!process.env.AGENT_SERVER_MODE) {
      const chain = groups.map((g, gi) =>
        `[平台${gi + 1}:${g.platformName}] ${g.configs.map(c => c.model).join(' → ')}`
      ).join(' || ')
      process.stderr.write(`[providers] fallback 链: ${chain}\n`)
    }
    return createGroupedFallbackProvider(groups)
  }

  // 没有 LLM_FALLBACK_* 配置，使用单一 DEFAULT_MODEL
  const model = process.env.DEFAULT_MODEL
  if (!model) throw new Error('请设置 DEFAULT_MODEL 或 LLM_FALLBACK_1 环境变量')
  return createProvider({ model })
}

/**
 * 解析一行 LLM_FALLBACK_N 配置，返回一组 ProviderOptions
 *
 * 支持两种格式：
 * - 新格式: provider:aliyun,models:qwen3-235b,qwen3-8b,apiKey:xxx
 * - 旧格式: model:qwen3-235b,provider:aliyun,apiKey:xxx
 */
function parseProviderLine(raw: string): ProviderOptions[] {
  // 先找 models: 关键字的位置
  const modelsMatch = raw.match(/(?:^|,)models:(.+)$/)

  if (modelsMatch) {
    // 新格式：models: 后面全部都是模型名（直到遇到下一个 key:value 则停止）
    // 先提取 models 之前的 key:value 对
    const beforeModels = raw.slice(0, raw.indexOf('models:'))
    const kvPairs = parseKV(beforeModels)

    // models: 后面的内容，按逗号分割，但要排除 key:value 形式（含冒号的视为 kv）
    const afterModels = modelsMatch[1]
    const modelTokens: string[] = []
    const extraKV: Record<string, string> = {}

    for (const token of afterModels.split(',')) {
      const t = token.trim()
      if (!t) continue
      if (t.includes(':')) {
        // 是 key:value，加入 extraKV
        const idx = t.indexOf(':')
        extraKV[t.slice(0, idx)] = t.slice(idx + 1)
      } else {
        modelTokens.push(t)
      }
    }

    const merged = { ...kvPairs, ...extraKV }
    const provider = merged.provider as ProviderOptions['provider']
    const apiKey = merged.apiKey
    const baseUrl = merged.baseUrl

    return modelTokens.map(model => ({ model, provider, apiKey, baseUrl }))
  }

  // 旧格式：model:xxx,provider:yyy,...
  const kv = parseKV(raw)
  if (!kv.model) throw new Error(`配置行缺少 model 字段: ${raw}`)
  return [{
    model: kv.model,
    provider: kv.provider as ProviderOptions['provider'],
    apiKey: kv.apiKey,
    baseUrl: kv.baseUrl,
  }]
}

/** 解析 "key:val,key2:val2" 形式的字符串为对象（遇到 models: 停止） */
function parseKV(str: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const token of str.split(',')) {
    const t = token.trim()
    if (!t || !t.includes(':')) continue
    const idx = t.indexOf(':')
    result[t.slice(0, idx).trim()] = t.slice(idx + 1).trim()
  }
  return result
}
