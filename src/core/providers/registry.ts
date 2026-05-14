// 提供商注册表 —— 从 YAML 文件加载，支持用户扩展
// 内置配置：providers/builtin.yaml
// 用户扩展：~/.hrids/providers/*.yaml（同名覆盖，新名追加）

import { existsSync } from 'fs'
import { loadYamlFile } from '../YamlLoader.js'

// ── 提供商定义 ────────────────────────────────────────────────

/** 原生网络搜索配置方式 */
export type WebSearchMode =
  | { type: 'tool'; toolType: string }        // 通过工具类型，如 { type: 'web_search' }
  | { type: 'param'; key: string; value: unknown }  // 通过请求参数，如 { enable_search: true }
  | { type: 'custom' }                        // 自定义逻辑（在 Provider 中硬编码）

/** 多模态能力配置 */
export interface MultimodalCapabilities {
  /** 图片理解（支持的 MIME 类型列表，true 表示支持所有图片类型） */
  image?: boolean | string[]
  /** 视频理解（支持的 MIME 类型列表，true 表示支持所有视频类型） */
  video?: boolean | string[]
  /** 音频理解（支持的 MIME 类型列表，true 表示支持所有音频类型） */
  audio?: boolean | string[]
}

export interface ProviderDef {
  /** 规范 ID，如 'aliyun'、'anthropic' */
  id: string
  /** 显示名称 */
  name: string
  /** 传输协议：openai_chat | anthropic_messages */
  transport: 'openai_chat' | 'anthropic_messages'
  /** 按优先级排列的 API Key 环境变量名 */
  apiKeyEnvVars: string[]
  /** 默认 Base URL（可被用户覆盖） */
  defaultBaseUrl?: string
  /** 允许用户通过此环境变量覆盖 Base URL */
  baseUrlEnvVar?: string
  /** 是否为聚合器（如 OpenRouter，支持多模型路由） */
  isAggregator?: boolean
  /** 模型名前缀列表，用于自动识别提供商 */
  modelPrefixes?: string[]
  /** 是否支持原生联网搜索 */
  nativeWebSearch?: boolean
  /** 原生网络搜索配置方式（未设置则使用默认工具方式） */
  webSearchMode?: WebSearchMode
  /** 多模态能力配置 */
  capabilities?: MultimodalCapabilities
}

// ── YAML 配置结构 ──────────────────────────────────────────────

interface BuiltinProviderYaml {
  name: string
  transport: 'openai_chat' | 'anthropic_messages'
  apiKeyEnvVars: string[]
  defaultBaseUrl?: string
  baseUrlEnvVar?: string
  isAggregator?: boolean
  modelPrefixes?: string[]
  nativeWebSearch?: boolean
  webSearchMode?: WebSearchMode
  capabilities?: MultimodalCapabilities
}

interface BuiltinProvidersYaml {
  providers: Record<string, BuiltinProviderYaml>
  aliases?: Record<string, string>
}

// ── 内置提供商注册表（从 YAML 加载） ──────────────────────────

/** 内置提供商配置文件路径 */
function getBuiltinYamlPath(): string {
  // 尝试多个可能的路径（兼容 dist/ 运行和 bin/ 运行）
  const candidates = [
    new URL('../../builtin-providers.yaml', import.meta.url),
    new URL('../../../builtin-providers.yaml', import.meta.url),
    new URL('../../../../builtin-providers.yaml', import.meta.url),
  ]
  for (const u of candidates) {
    const p = u.pathname.replace(/^\/([A-Za-z]:)/, '$1')
    if (existsSync(p)) return p
  }
  return ''
}

/** 从 YAML 文件加载内置提供商 */
function loadBuiltinProviders(): { providers: Map<string, ProviderDef>; aliases: Map<string, string> } {
  const providers = new Map<string, ProviderDef>()
  const aliases = new Map<string, string>()

  const yamlPath = getBuiltinYamlPath()
  if (!yamlPath) {
    process.stderr.write('[providers] 未找到 builtin.yaml，使用空注册表\n')
    return { providers, aliases }
  }

  try {
    const yaml = loadYamlFile<BuiltinProvidersYaml>(yamlPath)

    // 加载提供商
    for (const [id, def] of Object.entries(yaml.providers ?? {})) {
      providers.set(id, {
        id,
        name: def.name,
        transport: def.transport,
        apiKeyEnvVars: def.apiKeyEnvVars ?? [],
        defaultBaseUrl: def.defaultBaseUrl,
        baseUrlEnvVar: def.baseUrlEnvVar,
        isAggregator: def.isAggregator,
        modelPrefixes: def.modelPrefixes,
        nativeWebSearch: def.nativeWebSearch,
        webSearchMode: def.webSearchMode,
        capabilities: def.capabilities,
      })
    }

    // 加载别名
    for (const [alias, target] of Object.entries(yaml.aliases ?? {})) {
      aliases.set(alias, target)
    }
  } catch (err) {
    process.stderr.write(`[providers] 加载 builtin.yaml 失败: ${String(err)}\n`)
  }

  return { providers, aliases }
}

// ── 初始化（模块加载时执行） ──────────────────────────────────

const { providers: _builtinProviders, aliases: _builtinAliases } = loadBuiltinProviders()

/** 导出为数组（兼容旧代码） */
export const BUILTIN_PROVIDERS: ProviderDef[] = Array.from(_builtinProviders.values())

/** 导出别名表（兼容旧代码） */
export const PROVIDER_ALIASES: Record<string, string> = Object.fromEntries(_builtinAliases)

// ── 用户自定义提供商 ──────────────────────────────────────────
// 对应 config.yaml 中的 customProviders 字段

export interface CustomProviderConfig {
  /** 显示名称，同时作为 ID 使用（slug 化后） */
  name: string
  /** Base URL */
  baseUrl: string
  /** 传输协议：openai_chat（默认）| anthropic_messages */
  transport?: 'openai_chat' | 'anthropic_messages'
  /** API Key 环境变量名（可选，不填则不需要 key） */
  apiKeyEnvVar?: string
  /** 直接内联 API Key（不推荐，建议用 apiKeyEnvVar） */
  apiKey?: string
  /** 是否支持原生联网搜索（web_search 工具参数） */
  nativeWebSearch?: boolean
}

// ── 查找函数 ──────────────────────────────────────────────────

/** 规范化提供商名称（别名解析 + 小写） */
export function normalizeProvider(name: string): string {
  const key = name.trim().toLowerCase()
  return _builtinAliases.get(key) ?? key
}

/** 从内置注册表查找提供商定义 */
export function getBuiltinProvider(name: string): ProviderDef | undefined {
  const canonical = normalizeProvider(name)
  return _builtinProviders.get(canonical)
}

/** 从用户自定义列表查找提供商定义 */
export function getCustomProvider(name: string, customs: CustomProviderConfig[]): ProviderDef | undefined {
  const key = name.trim().toLowerCase()
  const entry = customs.find(c =>
    c.name.toLowerCase() === key ||
    toSlug(c.name) === key
  )
  if (!entry) return undefined

  return {
    id: toSlug(entry.name),
    name: entry.name,
    transport: entry.transport ?? 'openai_chat',
    apiKeyEnvVars: entry.apiKeyEnvVar ? [entry.apiKeyEnvVar] : [],
    defaultBaseUrl: entry.baseUrl,
    nativeWebSearch: entry.nativeWebSearch,
  }
}

/** 根据模型名前缀自动推断提供商 */
export function inferProviderByModel(model: string): ProviderDef | undefined {
  for (const def of _builtinProviders.values()) {
    if (def.modelPrefixes?.some(p => model.startsWith(p))) {
      return def
    }
  }
  return undefined
}

/** 将显示名称转为 slug（用于自定义提供商 ID） */
function toSlug(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
}

/** 重新加载内置提供商配置（供测试或热更新使用） */
export function _reloadBuiltinProviders(): void {
  const { providers, aliases } = loadBuiltinProviders()
  _builtinProviders.clear()
  for (const [k, v] of providers) _builtinProviders.set(k, v)
  _builtinAliases.clear()
  for (const [k, v] of aliases) _builtinAliases.set(k, v)
}
