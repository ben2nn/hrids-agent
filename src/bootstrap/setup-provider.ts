// Provider 初始化 —— 从 config.yaml 创建 LLM 提供商
import { createProvider, createProviderFromConfig, normalizeProvider } from '../providers/index.js'
import type { LLMProvider } from '../providers/index.js'
import type { FallbackStatusEvent } from '../providers/fallback-provider.js'
import type { AgentConfig } from '../core/config.js'

export interface ProviderOpts {
  /** CLI 传入的模型名（覆盖 config.model） */
  model?: string
  /** CLI 传入的 API Key（覆盖 config.apiKey） */
  apiKey?: string
  /** CLI 传入的 Base URL */
  baseUrl?: string
  /** CLI 传入的提供商名称 */
  provider?: string
  /** 完整 config（来自 loadConfig()） */
  config: AgentConfig
  /** FallbackProvider 状态回调 */
  onStatus?: (event: FallbackStatusEvent) => void
}

export function setupProvider(opts: ProviderOpts): LLMProvider {
  const { config, onStatus } = opts

  // CLI 参数显式指定了 model/provider/apiKey → 精确创建，跳过 fallback 链
  const hasCliOverride = opts.model || opts.provider || opts.apiKey
  if (hasCliOverride) {
    return createProvider({
      model: opts.model ?? config.model,
      apiKey: opts.apiKey ?? config.apiKey,
      baseUrl: opts.baseUrl ?? config.baseUrl,
      provider: opts.provider ? normalizeProvider(opts.provider) : config.provider,
      customProviders: config.customProviders,
    })
  }

  // 无 CLI 覆盖 → 走 config.yaml 的完整配置（含 llm.fallbacks）
  return createProviderFromConfig(config, onStatus)
}
