// 提供商注册表 —— 从 builtin-providers/ 目录加载，支持用户扩展
// 每个平台一个 YAML 文件，模型参数完整维护
// 用户可在 ~/.hrids/providers/ 目录下创建同名文件覆盖配置

import { existsSync, readdirSync } from 'fs'
import { loadYamlFile } from '../YamlLoader.js'

// ── 模型级能力配置 ──────────────────────────────────────────────

/**
 * 模型功能类型
 * - text         文本对话/推理（LLM）
 * - vision       图文/视频理解（接受图片输入）
 * - tts          文字转语音（Text-to-Speech）
 * - stt          语音转文字（Speech-to-Text）
 * - voice-clone  声音克隆
 * - video-gen    视频生成
 * - image-gen    图片生成
 * - music        音乐生成
 * - embedding    文本向量化
 */
export type ModelCategory = 'text' | 'vision' | 'tts' | 'stt' | 'voice-clone' | 'video-gen' | 'image-gen' | 'music' | 'embedding'

/** 模型完整参数 */
export interface ModelProfile {
  /** 模型功能类型 */
  type: ModelCategory
  /** 上下文窗口大小（tokens） */
  contextWindow: number
  /** 最大输出 tokens */
  maxOutputTokens: number
  /** 支持图片输入 */
  supportsImage: boolean
  /** 支持视频输入 */
  supportsVideo: boolean
  /** 支持音频输入 */
  supportsAudio: boolean
  /** 支持原生联网搜索 */
  supportsWebSearch: boolean
  /** 支持扩展思考 / 推理 */
  supportsThinking: boolean
  /** 支持工具调用（function calling） */
  supportsToolUse: boolean
  /** 输入价格（USD / 1M tokens） */
  inputPrice: number
  /** 输出价格（USD / 1M tokens） */
  outputPrice: number
  /** 模型简介 */
  description: string
}

// ── 提供商定义 ──────────────────────────────────────────────────

/** 原生网络搜索配置方式 */
export type WebSearchMode =
  | { type: 'tool'; toolType: string }        // 通过工具类型，如 { type: 'web_search' }
  | { type: 'param'; key: string; value: unknown }  // 通过请求参数，如 { enable_search: true }
  | { type: 'custom' }                        // 自定义逻辑（在 Provider 中硬编码）

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
  /** provider 级默认：是否支持原生联网搜索 */
  nativeWebSearch?: boolean
  /** provider 级默认：原生网络搜索配置方式 */
  webSearchMode?: WebSearchMode
  /** 模型参数表（key = 模型名） */
  modelProfiles: Record<string, ModelProfile>
}

// ── YAML 配置结构 ──────────────────────────────────────────────

interface PlatformYaml {
  name: string
  transport: 'openai_chat' | 'anthropic_messages'
  apiKeyEnvVars: string[]
  defaultBaseUrl?: string
  baseUrlEnvVar?: string
  isAggregator?: boolean
  modelPrefixes?: string[]
  nativeWebSearch?: boolean
  webSearchMode?: WebSearchMode
  models?: Record<string, {
    type?: ModelCategory
    contextWindow?: number
    maxOutputTokens?: number
    supportsImage?: boolean
    supportsVideo?: boolean
    supportsAudio?: boolean
    supportsWebSearch?: boolean
    supportsThinking?: boolean
    supportsToolUse?: boolean
    inputPrice?: number
    outputPrice?: number
    description?: string
  }>
}

interface AliasesYaml {
  aliases?: Record<string, string>
}

// ── 目录发现 ──────────────────────────────────────────────────

/** builtin/ 目录路径（与 registry.ts 同级） */
function getBuiltinDir(): string {
  const candidates = [
    new URL('./builtin/', import.meta.url),
    new URL('../../builtin/', import.meta.url),
    new URL('../../../builtin/', import.meta.url),
  ]
  for (const u of candidates) {
    const p = u.pathname.replace(/^\/([A-Za-z]:)/, '$1')
    if (existsSync(p)) return p
  }
  return ''
}

/** 兼容旧的单文件路径 */
function getLegacyYamlPath(): string {
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

// ── 加载器 ──────────────────────────────────────────────────

/** 根据能力标志推断模型类型 */
function inferType(raw: { supportsImage?: boolean; supportsVideo?: boolean; supportsAudio?: boolean }): ModelCategory {
  if (raw.supportsAudio) return 'tts'
  if (raw.supportsVideo) return 'vision'
  if (raw.supportsImage) return 'vision'
  return 'text'
}

/** 将 YAML 中的模型定义转为 ModelProfile，填充默认值 */
function toModelProfile(raw: { type?: ModelCategory; contextWindow?: number; maxOutputTokens?: number; supportsImage?: boolean; supportsVideo?: boolean; supportsAudio?: boolean; supportsWebSearch?: boolean; supportsThinking?: boolean; supportsToolUse?: boolean; inputPrice?: number; outputPrice?: number; description?: string }): ModelProfile {
  return {
    type: raw.type ?? inferType(raw),
    contextWindow: raw.contextWindow ?? 32768,
    maxOutputTokens: raw.maxOutputTokens ?? 4096,
    supportsImage: raw.supportsImage ?? false,
    supportsVideo: raw.supportsVideo ?? false,
    supportsAudio: raw.supportsAudio ?? false,
    supportsWebSearch: raw.supportsWebSearch ?? false,
    supportsThinking: raw.supportsThinking ?? false,
    supportsToolUse: raw.supportsToolUse ?? true,
    inputPrice: raw.inputPrice ?? 0,
    outputPrice: raw.outputPrice ?? 0,
    description: raw.description ?? '',
  }
}

/** 从 builtin-providers/ 目录加载所有平台配置 */
function loadBuiltinProviders(): { providers: Map<string, ProviderDef>; aliases: Map<string, string> } {
  const providers = new Map<string, ProviderDef>()
  const aliases = new Map<string, string>()

  const dir = getBuiltinDir()
  if (!dir) {
    // 回退到旧的单文件模式
    return loadLegacySingleFile()
  }

  try {
    const files = readdirSync(dir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))

    for (const file of files) {
      const filePath = dir + file

      // 别名文件
      if (file === '_aliases.yaml' || file === '_aliases.yml') {
        try {
          const yaml = loadYamlFile<AliasesYaml>(filePath)
          for (const [alias, target] of Object.entries(yaml.aliases ?? {})) {
            aliases.set(alias, target)
          }
        } catch (err) {
          process.stderr.write(`[providers] 加载别名文件失败 ${file}: ${String(err)}\n`)
        }
        continue
      }

      // 平台配置文件
      const id = file.replace(/\.(yaml|yml)$/, '')
      try {
        const yaml = loadYamlFile<PlatformYaml>(filePath)

        const modelProfiles: Record<string, ModelProfile> = {}
        for (const [name, raw] of Object.entries(yaml.models ?? {})) {
          modelProfiles[name] = toModelProfile(raw as Parameters<typeof toModelProfile>[0])
        }

        providers.set(id, {
          id,
          name: yaml.name,
          transport: yaml.transport,
          apiKeyEnvVars: yaml.apiKeyEnvVars ?? [],
          defaultBaseUrl: yaml.defaultBaseUrl,
          baseUrlEnvVar: yaml.baseUrlEnvVar,
          isAggregator: yaml.isAggregator,
          modelPrefixes: yaml.modelPrefixes,
          nativeWebSearch: yaml.nativeWebSearch,
          webSearchMode: yaml.webSearchMode,
          modelProfiles,
        })
      } catch (err) {
        process.stderr.write(`[providers] 加载平台配置失败 ${file}: ${String(err)}\n`)
      }
    }
  } catch (err) {
    process.stderr.write(`[providers] 读取 builtin-providers/ 目录失败: ${String(err)}\n`)
  }

  return { providers, aliases }
}

/** 兼容旧的单文件 builtin-providers.yaml */
function loadLegacySingleFile(): { providers: Map<string, ProviderDef>; aliases: Map<string, string> } {
  const providers = new Map<string, ProviderDef>()
  const aliases = new Map<string, string>()

  const yamlPath = getLegacyYamlPath()
  if (!yamlPath) {
    process.stderr.write('[providers] 未找到 builtin-providers/ 目录或 builtin-providers.yaml\n')
    return { providers, aliases }
  }

  try {
    interface LegacyProviderYaml {
      name: string
      transport: 'openai_chat' | 'anthropic_messages'
      apiKeyEnvVars: string[]
      defaultBaseUrl?: string
      baseUrlEnvVar?: string
      isAggregator?: boolean
      modelPrefixes?: string[]
      nativeWebSearch?: boolean
      webSearchMode?: WebSearchMode
      capabilities?: { image?: boolean; video?: boolean; audio?: boolean }
    }
    interface LegacyYaml {
      providers: Record<string, LegacyProviderYaml>
      aliases?: Record<string, string>
    }

    const yaml = loadYamlFile<LegacyYaml>(yamlPath)

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
        modelProfiles: {},  // 旧格式无模型详情
      })
    }

    for (const [alias, target] of Object.entries(yaml.aliases ?? {})) {
      aliases.set(alias, target)
    }
  } catch (err) {
    process.stderr.write(`[providers] 加载 builtin-providers.yaml 失败: ${String(err)}\n`)
  }

  return { providers, aliases }
}

// ── 初始化（模块加载时执行） ──────────────────────────────────

const { providers: _builtinProviders, aliases: _builtinAliases } = loadBuiltinProviders()

/** 导出为数组 */
export const BUILTIN_PROVIDERS: ProviderDef[] = Array.from(_builtinProviders.values())

/** 导出别名表 */
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
  /** 原生网络搜索配置方式 */
  webSearchMode?: WebSearchMode
  /** 模型名前缀列表，用于自动识别提供商 */
  modelPrefixes?: string[]
  /** 模型参数表（key = 模型名），格式与 builtin-providers YAML 一致 */
  models?: Record<string, {
    type?: ModelCategory
    contextWindow?: number
    maxOutputTokens?: number
    supportsImage?: boolean
    supportsVideo?: boolean
    supportsAudio?: boolean
    supportsWebSearch?: boolean
    supportsThinking?: boolean
    supportsToolUse?: boolean
    inputPrice?: number
    outputPrice?: number
    description?: string
  }>
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

  const modelProfiles: Record<string, ModelProfile> = {}
  for (const [modelName, raw] of Object.entries(entry.models ?? {})) {
    modelProfiles[modelName] = toModelProfile(raw)
  }

  return {
    id: toSlug(entry.name),
    name: entry.name,
    transport: entry.transport ?? 'openai_chat',
    apiKeyEnvVars: entry.apiKeyEnvVar ? [entry.apiKeyEnvVar] : [],
    defaultBaseUrl: entry.baseUrl,
    nativeWebSearch: entry.nativeWebSearch,
    webSearchMode: entry.webSearchMode,
    modelPrefixes: entry.modelPrefixes,
    modelProfiles,
  }
}

/** 根据模型名前缀自动推断提供商（内置 + 自定义） */
export function inferProviderByModel(model: string, customs?: CustomProviderConfig[]): ProviderDef | undefined {
  for (const def of _builtinProviders.values()) {
    if (def.modelPrefixes?.some(p => model.startsWith(p))) {
      return def
    }
  }
  if (customs) {
    for (const c of customs) {
      if (c.modelPrefixes?.some(p => model.startsWith(p))) {
        return getCustomProvider(c.name, customs)
      }
    }
  }
  return undefined
}

// ── 模型参数解析 ──────────────────────────────────────────────

/**
 * 获取某个模型的最终能力配置。
 * 优先级：provider 级默认 < modelProfiles 中的模型级配置
 */
export function resolveModelProfile(
  providerDef: ProviderDef,
  modelName: string,
): ModelProfile {
  const profile = providerDef.modelProfiles[modelName]
  if (profile) return profile

  // 未在 modelProfiles 中定义的模型，返回基于 provider 默认值的兜底
  return {
    type: 'text',
    contextWindow: 32768,
    maxOutputTokens: 4096,
    supportsImage: false,
    supportsVideo: false,
    supportsAudio: false,
    supportsWebSearch: providerDef.nativeWebSearch ?? false,
    supportsThinking: false,
    supportsToolUse: true,
    inputPrice: 0,
    outputPrice: 0,
    description: '',
  }
}

/** 获取提供商下所有模型名 */
export function listProviderModels(providerId: string): string[] {
  const def = _builtinProviders.get(providerId)
  return def ? Object.keys(def.modelProfiles) : []
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
