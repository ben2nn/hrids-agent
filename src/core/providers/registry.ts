// 提供商注册表 —— 集中管理所有提供商的元数据
// 参考 hermes-agent 的 providers.py 设计，将提供商定义与工厂逻辑分离

// ── 提供商定义 ────────────────────────────────────────────────

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
  /** 是否支持原生联网搜索（web_search 工具参数） */
  nativeWebSearch?: boolean
}

// ── 内置提供商注册表 ──────────────────────────────────────────

export const BUILTIN_PROVIDERS: ProviderDef[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    transport: 'anthropic_messages',
    apiKeyEnvVars: ['ANTHROPIC_API_KEY', 'ANTHROPIC_TOKEN'],
    baseUrlEnvVar: 'ANTHROPIC_BASE_URL',
    modelPrefixes: ['claude-'],
    nativeWebSearch: true,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    transport: 'openai_chat',
    apiKeyEnvVars: ['OPENAI_API_KEY'],
    defaultBaseUrl: 'https://api.openai.com/v1',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    modelPrefixes: ['gpt-', 'o1', 'o3', 'o4'],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    transport: 'openai_chat',
    apiKeyEnvVars: ['DEEPSEEK_API_KEY'],
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    baseUrlEnvVar: 'DEEPSEEK_BASE_URL',
    modelPrefixes: ['deepseek-'],
  },
  {
    id: 'groq',
    name: 'Groq',
    transport: 'openai_chat',
    apiKeyEnvVars: ['GROQ_API_KEY'],
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    baseUrlEnvVar: 'GROQ_BASE_URL',
    modelPrefixes: ['llama', 'mixtral', 'gemma', 'whisper'],
  },
  {
    id: 'aliyun',
    name: '阿里云百炼（DashScope）',
    transport: 'openai_chat',
    apiKeyEnvVars: ['DASHSCOPE_API_KEY'],
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    baseUrlEnvVar: 'DASHSCOPE_BASE_URL',
    modelPrefixes: ['qwen', 'qwq-', 'qvq-', 'tongyi-', 'MiniMax-'],
  },
  {
    id: 'xiaomi',
    name: 'Xiaomi MiMo',
    transport: 'openai_chat',
    apiKeyEnvVars: ['XIAOMI_API_KEY', 'MIMO_API_KEY'],
    defaultBaseUrl: 'https://api.xiaomimimo.com/v1',
    baseUrlEnvVar: 'XIAOMI_BASE_URL',
    modelPrefixes: ['mimo-'],
    nativeWebSearch: true,
  },
  {
    id: 'zhipu',
    name: '智谱 AI',
    transport: 'openai_chat',
    apiKeyEnvVars: ['ZHIPU_API_KEY'],
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    baseUrlEnvVar: 'ZHIPU_BASE_URL',
    modelPrefixes: ['glm-', 'cogview-', 'cogvideo-', 'embedding-'],
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    transport: 'openai_chat',
    apiKeyEnvVars: ['NVIDIA_API_KEY'],
    defaultBaseUrl: 'https://integrate.api.nvidia.com/v1',
    baseUrlEnvVar: 'NVIDIA_BASE_URL',
  },
  {
    id: 'ollama',
    name: 'Ollama（本地）',
    transport: 'openai_chat',
    apiKeyEnvVars: [],
    defaultBaseUrl: 'http://localhost:11434/v1',
    baseUrlEnvVar: 'OLLAMA_BASE_URL',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    transport: 'openai_chat',
    apiKeyEnvVars: ['OPENROUTER_API_KEY', 'OPENAI_API_KEY'],
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    baseUrlEnvVar: 'OPENROUTER_BASE_URL',
    isAggregator: true,
  },
  {
    id: 'kimi',
    name: 'Kimi（Moonshot AI）',
    transport: 'openai_chat',
    apiKeyEnvVars: ['KIMI_API_KEY'],
    defaultBaseUrl: 'https://api.kimi.com/coding/v1',
    baseUrlEnvVar: 'KIMI_BASE_URL',
    modelPrefixes: ['kimi-', 'moonshot-'],
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    transport: 'openai_chat',
    apiKeyEnvVars: ['MINIMAX_API_KEY'],
    defaultBaseUrl: 'https://api.minimax.io/v1',
    baseUrlEnvVar: 'MINIMAX_BASE_URL',
  },
  {
    id: 'google',
    name: 'Google Gemini',
    transport: 'openai_chat',
    apiKeyEnvVars: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    baseUrlEnvVar: 'GEMINI_BASE_URL',
    modelPrefixes: ['gemini-'],
  },
]

// ── 别名映射 ──────────────────────────────────────────────────
// 将用户友好的名称 / 历史名称映射到规范 ID

export const PROVIDER_ALIASES: Record<string, string> = {
  // anthropic
  'claude': 'anthropic',
  // openai
  'gpt': 'openai',
  // deepseek
  'deep-seek': 'deepseek',
  // groq
  'groq-cloud': 'groq',
  // aliyun
  'dashscope': 'aliyun',
  'qwen': 'aliyun',
  'alibaba': 'aliyun',
  'alibaba-cloud': 'aliyun',
  // zhipu
  'glm': 'zhipu',
  'zhipuai': 'zhipu',
  'bigmodel': 'zhipu',
  // nvidia
  'nim': 'nvidia',
  'nvidia-nim': 'nvidia',
  // ollama
  'local': 'ollama',
  'lmstudio': 'ollama',
  // openrouter
  'or': 'openrouter',
  // kimi
  'moonshot': 'kimi',
  'kimi-coding': 'kimi',
  // google
  'gemini': 'google',
  'google-ai': 'google',
}

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
  return PROVIDER_ALIASES[key] ?? key
}

/** 从内置注册表查找提供商定义 */
export function getBuiltinProvider(name: string): ProviderDef | undefined {
  const canonical = normalizeProvider(name)
  return BUILTIN_PROVIDERS.find(p => p.id === canonical)
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
  for (const def of BUILTIN_PROVIDERS) {
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
