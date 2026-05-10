import { useState, useEffect, useCallback, useRef } from 'react'
import yaml from 'js-yaml'
import { getConfigFile, saveConfigFile } from '../../../lib/gateway.js'

// ─── 内置 Provider 列表 ─────────────────────────────────────────────────────

const PROVIDER_LIST = [
  { id: 'aliyun', name: '阿里云百炼（DashScope）' },
  { id: 'anthropic', name: 'Anthropic' },
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'google', name: 'Google Gemini' },
  { id: 'groq', name: 'Groq' },
  { id: 'kimi', name: 'Kimi（Moonshot AI）' },
  { id: 'minimax', name: 'MiniMax' },
  { id: 'nvidia', name: 'NVIDIA NIM' },
  { id: 'ollama', name: 'Ollama（本地）' },
  { id: 'openai', name: 'OpenAI' },
  { id: 'openrouter', name: 'OpenRouter' },
  { id: 'xiaomi', name: 'Xiaomi MiMo' },
  { id: 'zhipu', name: '智谱 AI' },
]

// ─── 类型定义 ──────────────────────────────────────────────────────────────

interface FallbackEntry {
  provider: string
  apiKey: string
  models: string
  baseUrl?: string
  toolMode?: string
  _comment?: string
}

interface UserEntry {
  username: string
  password: string
  _comment?: string
}

interface CustomProviderEntry {
  name: string
  baseUrl: string
}

interface McpServerEntry {
  name: string
  command: string
  args: string
}

interface FormState {
  model: string
  llmFallbacks: FallbackEntry[]
  visionFallbacks: FallbackEntry[]
  multimodalFallbacks: FallbackEntry[]
  speechFallbacks: FallbackEntry[]
  embeddingFallbacks: FallbackEntry[]
  embeddingDimensions: string
  vectorBackend: string
  vectorUrl: string
  vectorTable: string
  agentPermissionMode: string
  agentMaxTokens: string
  agentMaxTurns: string
  agentMemoryCondense: boolean
  agentAutoDistillSkill: boolean
  agentAutoPruneSessions: boolean
  agentPruneKeepCount: string
  agentPruneMaxAgeDays: string
  gatewayPort: string
  gatewayHost: string
  gatewayToken: string
  gatewayUsers: UserEntry[]
  loggingLevel: string
  loggingTheme: string
  skillHubUrl: string
  skillHubApiBase: string
  customProviders: CustomProviderEntry[]
  mcpServers: McpServerEntry[]
  multiAgentMaxConcurrent: string
  multiAgentMaxTurns: string
  multiAgentTimeoutMs: string
  multiAgentAutoSelect: boolean
  multiAgentRecursive: boolean
  toolPermissionDenyList: string
  toolPermissionAllowMcp: boolean
}

const DEFAULT_FORM: FormState = {
  model: '',
  llmFallbacks: [],
  visionFallbacks: [],
  multimodalFallbacks: [],
  speechFallbacks: [],
  embeddingFallbacks: [],
  embeddingDimensions: '',
  vectorBackend: 'sqlite',
  vectorUrl: '',
  vectorTable: '',
  agentPermissionMode: 'ask',
  agentMaxTokens: '',
  agentMaxTurns: '',
  agentMemoryCondense: true,
  agentAutoDistillSkill: false,
  agentAutoPruneSessions: true,
  agentPruneKeepCount: '',
  agentPruneMaxAgeDays: '',
  gatewayPort: '',
  gatewayHost: '',
  gatewayToken: '',
  gatewayUsers: [],
  loggingLevel: 'info',
  loggingTheme: 'default',
  skillHubUrl: '',
  skillHubApiBase: '',
  customProviders: [],
  mcpServers: [],
  multiAgentMaxConcurrent: '',
  multiAgentMaxTurns: '',
  multiAgentTimeoutMs: '',
  multiAgentAutoSelect: true,
  multiAgentRecursive: false,
  toolPermissionDenyList: '',
  toolPermissionAllowMcp: false,
}

// ─── 解析 YAML → FormState ─────────────────────────────────────────────────

function parseFallbacks(arr: unknown): FallbackEntry[] {
  if (!Array.isArray(arr)) return []
  return arr
    .filter((item: unknown) => item && typeof item === 'object' && !(item as Record<string, unknown>)._example)
    .map((item: unknown) => {
      const obj = item as Record<string, unknown>
      const models = Array.isArray(obj.models) ? (obj.models as string[]).join(', ') : String(obj.models ?? '')
      return {
        provider: String(obj.provider ?? ''),
        apiKey: String(obj.apiKey ?? ''),
        models,
        baseUrl: obj.baseUrl ? String(obj.baseUrl) : undefined,
        toolMode: obj.toolMode ? String(obj.toolMode) : undefined,
        _comment: obj._comment ? String(obj._comment) : undefined,
      }
    })
}

function parseUsers(arr: unknown): UserEntry[] {
  if (!Array.isArray(arr)) return []
  return arr
    .filter((item: unknown) => item && typeof item === 'object' && !(item as Record<string, unknown>)._example)
    .map((item: unknown) => {
      const obj = item as Record<string, unknown>
      return {
        username: String(obj.username ?? ''),
        password: String(obj.password ?? ''),
        _comment: obj._comment ? String(obj._comment) : undefined,
      }
    })
}

function parseCustomProviders(arr: unknown): CustomProviderEntry[] {
  if (!Array.isArray(arr)) return []
  return arr
    .filter((item: unknown) => item && typeof item === 'object')
    .map((item: unknown) => {
      const obj = item as Record<string, unknown>
      return {
        name: String(obj.name ?? ''),
        baseUrl: String(obj.baseUrl ?? ''),
      }
    })
}

function parseMcpServers(arr: unknown): McpServerEntry[] {
  if (!Array.isArray(arr)) return []
  return arr
    .filter((item: unknown) => item && typeof item === 'object')
    .map((item: unknown) => {
      const obj = item as Record<string, unknown>
      const args = Array.isArray(obj.args) ? (obj.args as string[]).join(' ') : String(obj.args ?? '')
      return {
        name: String(obj.name ?? ''),
        command: String(obj.command ?? ''),
        args,
      }
    })
}

function yamlToForm(parsed: Record<string, unknown>): FormState {
  const llm = (parsed.llm ?? {}) as Record<string, unknown>
  const vision = (parsed.vision ?? {}) as Record<string, unknown>
  const multimodal = (parsed.multimodal ?? {}) as Record<string, unknown>
  const speech = (parsed.speech ?? {}) as Record<string, unknown>
  const embedding = (parsed.embedding ?? {}) as Record<string, unknown>
  const vectorStore = (parsed.vectorStore ?? {}) as Record<string, unknown>
  const agent = (parsed.agent ?? {}) as Record<string, unknown>
  const gateway = (parsed.gateway ?? {}) as Record<string, unknown>
  const logging = (parsed.logging ?? {}) as Record<string, unknown>
  const skillHub = (parsed.skillHub ?? {}) as Record<string, unknown>
  const multiAgent = (parsed.multiAgent ?? {}) as Record<string, unknown>
  const toolPerm = (parsed.toolPermissions ?? {}) as Record<string, unknown>

  return {
    model: String(parsed.model ?? ''),
    llmFallbacks: parseFallbacks(llm.fallbacks),
    visionFallbacks: parseFallbacks(vision.fallbacks),
    multimodalFallbacks: parseFallbacks(multimodal.fallbacks),
    speechFallbacks: parseFallbacks(speech.fallbacks),
    embeddingFallbacks: parseFallbacks(embedding.fallbacks),
    embeddingDimensions: embedding.dimensions != null ? String(embedding.dimensions) : '',
    vectorBackend: String(vectorStore.backend ?? 'sqlite'),
    vectorUrl: String(vectorStore.url ?? ''),
    vectorTable: String(vectorStore.table ?? ''),
    agentPermissionMode: String(agent.permissionMode ?? 'ask'),
    agentMaxTokens: agent.maxTokens != null ? String(agent.maxTokens) : '',
    agentMaxTurns: agent.maxTurns != null ? String(agent.maxTurns) : '',
    agentMemoryCondense: Boolean(agent.memoryCondense ?? true),
    agentAutoDistillSkill: Boolean(agent.autoDistillSkill ?? false),
    agentAutoPruneSessions: Boolean(agent.autoPruneSessions ?? true),
    agentPruneKeepCount: agent.pruneKeepCount != null ? String(agent.pruneKeepCount) : '',
    agentPruneMaxAgeDays: agent.pruneMaxAgeDays != null ? String(agent.pruneMaxAgeDays) : '',
    gatewayPort: gateway.port != null ? String(gateway.port) : '',
    gatewayHost: String(gateway.host ?? ''),
    gatewayToken: String(gateway.token ?? ''),
    gatewayUsers: parseUsers(gateway.users),
    loggingLevel: String(logging.level ?? 'info'),
    loggingTheme: String(logging.theme ?? 'default'),
    skillHubUrl: String(skillHub.url ?? ''),
    skillHubApiBase: String(skillHub.apiBase ?? ''),
    customProviders: parseCustomProviders(parsed.customProviders),
    mcpServers: parseMcpServers(parsed.mcpServers),
    multiAgentMaxConcurrent: multiAgent.globalMaxConcurrent != null ? String(multiAgent.globalMaxConcurrent) : '',
    multiAgentMaxTurns: multiAgent.defaultMaxTurns != null ? String(multiAgent.defaultMaxTurns) : '',
    multiAgentTimeoutMs: multiAgent.defaultTimeoutMs != null ? String(multiAgent.defaultTimeoutMs) : '',
    multiAgentAutoSelect: Boolean(multiAgent.autoSelectProfiles ?? true),
    multiAgentRecursive: Boolean(multiAgent.allowRecursiveAgent ?? false),
    toolPermissionDenyList: Array.isArray(toolPerm.defaultDenyList) ? (toolPerm.defaultDenyList as string[]).join(', ') : '',
    toolPermissionAllowMcp: Boolean(toolPerm.allowMcpTools ?? false),
  }
}

// ─── FormState → 配置对象 ──────────────────────────────────────────────────

function fallbacksToObj(list: FallbackEntry[]) {
  return list.map(f => {
    const models = f.models.split(',').map(s => s.trim()).filter(Boolean)
    const obj: Record<string, unknown> = { provider: f.provider, apiKey: f.apiKey, models }
    if (f.baseUrl) obj.baseUrl = f.baseUrl
    if (f.toolMode) obj.toolMode = f.toolMode
    if (f._comment) obj._comment = f._comment
    return obj
  })
}

function usersToObj(list: UserEntry[]) {
  return list.map(u => {
    const obj: Record<string, unknown> = { username: u.username, password: u.password }
    if (u._comment) obj._comment = u._comment
    return obj
  })
}

function formToObj(form: FormState, original: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...original }

  result.model = form.model

  const llmOrig = (original.llm ?? {}) as Record<string, unknown>
  result.llm = { ...llmOrig, fallbacks: fallbacksToObj(form.llmFallbacks) }

  const visionOrig = (original.vision ?? {}) as Record<string, unknown>
  result.vision = { ...visionOrig, fallbacks: fallbacksToObj(form.visionFallbacks) }

  const mmOrig = (original.multimodal ?? {}) as Record<string, unknown>
  result.multimodal = { ...mmOrig, fallbacks: fallbacksToObj(form.multimodalFallbacks) }

  const spOrig = (original.speech ?? {}) as Record<string, unknown>
  result.speech = { ...spOrig, fallbacks: fallbacksToObj(form.speechFallbacks) }

  const embOrig = (original.embedding ?? {}) as Record<string, unknown>
  const embResult: Record<string, unknown> = { ...embOrig, fallbacks: fallbacksToObj(form.embeddingFallbacks) }
  if (form.embeddingDimensions !== '') embResult.dimensions = Number(form.embeddingDimensions)
  result.embedding = embResult

  const vsOrig = (original.vectorStore ?? {}) as Record<string, unknown>
  const vsResult: Record<string, unknown> = { ...vsOrig, backend: form.vectorBackend }
  if (form.vectorUrl) vsResult.url = form.vectorUrl
  if (form.vectorTable) vsResult.table = form.vectorTable
  result.vectorStore = vsResult

  const agOrig = (original.agent ?? {}) as Record<string, unknown>
  result.agent = {
    ...agOrig,
    permissionMode: form.agentPermissionMode,
    maxTokens: form.agentMaxTokens !== '' ? Number(form.agentMaxTokens) : undefined,
    maxTurns: form.agentMaxTurns !== '' ? Number(form.agentMaxTurns) : undefined,
    memoryCondense: form.agentMemoryCondense,
    autoDistillSkill: form.agentAutoDistillSkill,
    autoPruneSessions: form.agentAutoPruneSessions,
    pruneKeepCount: form.agentPruneKeepCount !== '' ? Number(form.agentPruneKeepCount) : undefined,
    pruneMaxAgeDays: form.agentPruneMaxAgeDays !== '' ? Number(form.agentPruneMaxAgeDays) : undefined,
  }

  const gwOrig = (original.gateway ?? {}) as Record<string, unknown>
  result.gateway = {
    ...gwOrig,
    port: form.gatewayPort !== '' ? Number(form.gatewayPort) : undefined,
    host: form.gatewayHost,
    token: form.gatewayToken,
    users: usersToObj(form.gatewayUsers),
  }

  const logOrig = (original.logging ?? {}) as Record<string, unknown>
  result.logging = { ...logOrig, level: form.loggingLevel, theme: form.loggingTheme }

  const shOrig = (original.skillHub ?? {}) as Record<string, unknown>
  result.skillHub = { ...shOrig, url: form.skillHubUrl, apiBase: form.skillHubApiBase }

  // customProviders
  result.customProviders = form.customProviders.map(cp => ({ name: cp.name, baseUrl: cp.baseUrl }))

  // mcpServers
  result.mcpServers = form.mcpServers.map(s => {
    const obj: Record<string, unknown> = { name: s.name, command: s.command }
    if (s.args) obj.args = s.args.split(/\s+/).filter(Boolean)
    return obj
  })

  // multiAgent
  const maOrig = (original.multiAgent ?? {}) as Record<string, unknown>
  result.multiAgent = {
    ...maOrig,
    globalMaxConcurrent: form.multiAgentMaxConcurrent !== '' ? Number(form.multiAgentMaxConcurrent) : undefined,
    defaultMaxTurns: form.multiAgentMaxTurns !== '' ? Number(form.multiAgentMaxTurns) : undefined,
    defaultTimeoutMs: form.multiAgentTimeoutMs !== '' ? Number(form.multiAgentTimeoutMs) : undefined,
    autoSelectProfiles: form.multiAgentAutoSelect,
    allowRecursiveAgent: form.multiAgentRecursive,
  }

  // toolPermissions
  const tpOrig = (original.toolPermissions ?? {}) as Record<string, unknown>
  const denyList = form.toolPermissionDenyList.split(',').map(s => s.trim()).filter(Boolean)
  result.toolPermissions = {
    ...tpOrig,
    defaultDenyList: denyList,
    allowMcpTools: form.toolPermissionAllowMcp,
  }

  return result
}

// ─── 子组件：折叠分组卡片 ──────────────────────────────────────────────────

function SectionCard({
  title,
  icon,
  children,
  defaultOpen = true,
}: {
  title: string
  icon: React.ReactNode
  children: React.ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left cursor-pointer bg-transparent border-0 hover:bg-[var(--bg-tertiary)] transition-colors"
      >
        <div className="flex items-center gap-2.5">
          <span className="w-6 h-6 rounded-md bg-[var(--accent-subtle)] flex items-center justify-center text-[var(--accent)] shrink-0">
            {icon}
          </span>
          <span className="text-sm font-semibold text-[var(--text-primary)]">{title}</span>
        </div>
        <svg
          width="14" height="14" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
          className={`text-[var(--text-muted)] transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div className="px-4 pb-4 pt-1 space-y-3 border-t border-[var(--border)]">
          {children}
        </div>
      )}
    </div>
  )
}

// ─── 子组件：表单行 ────────────────────────────────────────────────────────

function FormRow({ label, desc, children }: { label: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div className="min-w-0 pt-0.5">
        <p className="text-xs font-medium text-[var(--text-primary)]">{label}</p>
        {desc && <p className="text-[10px] text-[var(--text-muted)] mt-0.5">{desc}</p>}
      </div>
      <div className="shrink-0 min-w-[180px] max-w-[280px] w-full">{children}</div>
    </div>
  )
}

// ─── 子组件：通用输入框样式 ────────────────────────────────────────────────

const inputCls = 'w-full px-2.5 py-1.5 rounded-lg text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-focus)] transition-colors placeholder:text-[var(--text-muted)]'
const selectCls = 'w-full px-2.5 py-1.5 rounded-lg text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-focus)] transition-colors cursor-pointer'

// ─── 子组件：Provider 下拉选择（combobox） ─────────────────────────────────

function ProviderSelect({
  value,
  onChange,
  customProviders,
}: {
  value: string
  onChange: (v: string) => void
  customProviders?: CustomProviderEntry[]
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState(value)
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // 同步外部 value 到 query
  useEffect(() => {
    if (!open) setQuery(value)
  }, [value, open])

  // 点击外部关闭
  useEffect(() => {
    if (!open) return
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // 合并内置 + 自定义 provider
  const allProviders = [
    ...PROVIDER_LIST,
    ...(customProviders ?? []).map(cp => ({ id: cp.name.toLowerCase().replace(/\s+/g, '-'), name: cp.name })),
  ]

  const filtered = query.trim()
    ? allProviders.filter(p =>
        p.id.includes(query.toLowerCase()) ||
        p.name.toLowerCase().includes(query.toLowerCase())
      )
    : allProviders

  function handleSelect(id: string) {
    onChange(id)
    setQuery(id)
    setOpen(false)
  }

  function handleInputChange(v: string) {
    setQuery(v)
    setOpen(true)
  }

  function handleBlur() {
    // 延迟关闭，让 click 事件先触发
    setTimeout(() => {
      setOpen(false)
      // 如果输入不在列表中，直接作为自定义值
      if (query.trim() && !allProviders.some(p => p.id === query.trim().toLowerCase())) {
        onChange(query.trim())
      }
    }, 150)
  }

  return (
    <div ref={ref} className="relative">
      <input
        ref={inputRef}
        className={inputCls}
        placeholder="输入或搜索 provider"
        value={open ? query : value}
        onChange={e => handleInputChange(e.target.value)}
        onFocus={() => { setOpen(true); setQuery(value) }}
        onBlur={handleBlur}
      />
      {open && filtered.length > 0 && (
        <div className="absolute top-full left-0 right-0 mt-1 max-h-48 overflow-y-auto bg-[var(--bg-elevated)] border border-[var(--border)] rounded-lg shadow-[var(--shadow-lg)] z-50">
          {filtered.map(p => (
            <button
              key={p.id}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); handleSelect(p.id) }}
              className={[
                'w-full px-2.5 py-2 text-left text-xs transition-colors border-0 cursor-pointer',
                value === p.id
                  ? 'bg-[var(--accent-subtle)] text-[var(--text-primary)]'
                  : 'bg-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]',
              ].join(' ')}
            >
              <span className="font-mono">{p.id}</span>
              <span className="text-[var(--text-muted)] ml-1.5">{p.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── 子组件：Fallback 列表编辑器 ──────────────────────────────────────────

function FallbackList({
  label,
  list,
  onChange,
  customProviders,
}: {
  label: string
  list: FallbackEntry[]
  onChange: (list: FallbackEntry[]) => void
  customProviders?: CustomProviderEntry[]
}) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)
  const add = () => onChange([...list, { provider: '', apiKey: '', models: '' }])
  const remove = (i: number) => onChange(list.filter((_, idx) => idx !== i))
  const update = (i: number, field: keyof FallbackEntry, value: string) => {
    const next = list.map((item, idx) => idx === i ? { ...item, [field]: value || undefined } : item)
    onChange(next)
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-[var(--text-secondary)]">{label}</span>
        <button
          type="button"
          onClick={add}
          className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium bg-[var(--accent-subtle)] text-[var(--accent)] hover:bg-[var(--accent-border)] transition-colors border-0 cursor-pointer"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          添加
        </button>
      </div>
      {list.length === 0 && (
        <p className="text-[10px] text-[var(--text-muted)] italic py-1">暂无条目，点击"添加"新增</p>
      )}
      {list.map((item, i) => (
        <div key={i} className="rounded-lg border border-[var(--border)] bg-[var(--bg-tertiary)] p-2.5 space-y-2">
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <ProviderSelect
                value={item.provider}
                onChange={v => update(i, 'provider', v)}
                customProviders={customProviders}
              />
            </div>
            <button
              type="button"
              onClick={() => remove(i)}
              className="shrink-0 w-6 h-6 flex items-center justify-center rounded-md text-[var(--text-muted)] hover:text-[var(--error)] hover:bg-[var(--error-subtle)] transition-colors border-0 bg-transparent cursor-pointer"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          <input
            className={inputCls}
            placeholder="apiKey（如 sk-xxxxxxxx）"
            value={item.apiKey}
            onChange={e => update(i, 'apiKey', e.target.value)}
          />
          <input
            className={inputCls}
            placeholder="models（逗号分隔，如 gpt-4o, gpt-4o-mini）"
            value={item.models}
            onChange={e => update(i, 'models', e.target.value)}
          />
          {/* 展开高级选项 */}
          <button
            type="button"
            onClick={() => setExpandedIdx(expandedIdx === i ? null : i)}
            className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] bg-transparent border-0 cursor-pointer px-0"
          >
            {expandedIdx === i ? '收起选项 ▲' : '高级选项 ▼'}
          </button>
          {expandedIdx === i && (
            <div className="space-y-2 pt-1">
              <input
                className={inputCls}
                placeholder="baseUrl（可选，覆盖默认地址）"
                value={item.baseUrl ?? ''}
                onChange={e => update(i, 'baseUrl', e.target.value)}
              />
              <select
                className={selectCls}
                value={item.toolMode ?? ''}
                onChange={e => update(i, 'toolMode', e.target.value)}
              >
                <option value="">toolMode（默认 native）</option>
                <option value="native">native（原生 function calling）</option>
                <option value="dsml">dsml（文本解析模式）</option>
              </select>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ─── 子组件：用户列表编辑器 ────────────────────────────────────────────────

function UserList({
  list,
  onChange,
}: {
  list: UserEntry[]
  onChange: (list: UserEntry[]) => void
}) {
  const add = () => onChange([...list, { username: '', password: '' }])
  const remove = (i: number) => onChange(list.filter((_, idx) => idx !== i))
  const update = (i: number, field: keyof UserEntry, value: string) => {
    const next = list.map((item, idx) => idx === i ? { ...item, [field]: value } : item)
    onChange(next)
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-[var(--text-secondary)]">用户列表</span>
        <button
          type="button"
          onClick={add}
          className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium bg-[var(--accent-subtle)] text-[var(--accent)] hover:bg-[var(--accent-border)] transition-colors border-0 cursor-pointer"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          添加用户
        </button>
      </div>
      {list.length === 0 && (
        <p className="text-[10px] text-[var(--text-muted)] italic py-1">暂无用户，点击"添加用户"新增</p>
      )}
      {list.map((item, i) => (
        <div key={i} className="rounded-lg border border-[var(--border)] bg-[var(--bg-tertiary)] p-2.5 space-y-2">
          <div className="flex items-center gap-2">
            <input
              className={inputCls + ' flex-1'}
              placeholder="用户名"
              value={item.username}
              onChange={e => update(i, 'username', e.target.value)}
            />
            <button
              type="button"
              onClick={() => remove(i)}
              className="shrink-0 w-6 h-6 flex items-center justify-center rounded-md text-[var(--text-muted)] hover:text-[var(--error)] hover:bg-[var(--error-subtle)] transition-colors border-0 bg-transparent cursor-pointer"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          <input
            className={inputCls}
            type="password"
            placeholder="密码"
            value={item.password}
            onChange={e => update(i, 'password', e.target.value)}
          />
        </div>
      ))}
    </div>
  )
}

// ─── 子组件：自定义提供商列表编辑器 ────────────────────────────────────────

function CustomProviderList({
  list,
  onChange,
}: {
  list: CustomProviderEntry[]
  onChange: (list: CustomProviderEntry[]) => void
}) {
  const add = () => onChange([...list, { name: '', baseUrl: '' }])
  const remove = (i: number) => onChange(list.filter((_, idx) => idx !== i))
  const update = (i: number, field: keyof CustomProviderEntry, value: string) => {
    const next = list.map((item, idx) => idx === i ? { ...item, [field]: value } : item)
    onChange(next)
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-[var(--text-secondary)]">自定义提供商</span>
        <button
          type="button"
          onClick={add}
          className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium bg-[var(--accent-subtle)] text-[var(--accent)] hover:bg-[var(--accent-border)] transition-colors border-0 cursor-pointer"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          添加
        </button>
      </div>
      {list.length === 0 && (
        <p className="text-[10px] text-[var(--text-muted)] italic py-1">暂无自定义提供商</p>
      )}
      {list.map((item, i) => (
        <div key={i} className="rounded-lg border border-[var(--border)] bg-[var(--bg-tertiary)] p-2.5 space-y-2">
          <div className="flex items-center gap-2">
            <input
              className={inputCls + ' flex-1'}
              placeholder="名称（如 MyLLM）"
              value={item.name}
              onChange={e => update(i, 'name', e.target.value)}
            />
            <button
              type="button"
              onClick={() => remove(i)}
              className="shrink-0 w-6 h-6 flex items-center justify-center rounded-md text-[var(--text-muted)] hover:text-[var(--error)] hover:bg-[var(--error-subtle)] transition-colors border-0 bg-transparent cursor-pointer"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          <input
            className={inputCls}
            placeholder="baseUrl（如 https://my-llm.example.com/v1）"
            value={item.baseUrl}
            onChange={e => update(i, 'baseUrl', e.target.value)}
          />
        </div>
      ))}
    </div>
  )
}

// ─── 子组件：MCP 服务器列表编辑器 ──────────────────────────────────────────

function McpServerList({
  list,
  onChange,
}: {
  list: McpServerEntry[]
  onChange: (list: McpServerEntry[]) => void
}) {
  const add = () => onChange([...list, { name: '', command: '', args: '' }])
  const remove = (i: number) => onChange(list.filter((_, idx) => idx !== i))
  const update = (i: number, field: keyof McpServerEntry, value: string) => {
    const next = list.map((item, idx) => idx === i ? { ...item, [field]: value } : item)
    onChange(next)
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-[var(--text-secondary)]">MCP 服务器</span>
        <button
          type="button"
          onClick={add}
          className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium bg-[var(--accent-subtle)] text-[var(--accent)] hover:bg-[var(--accent-border)] transition-colors border-0 cursor-pointer"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          添加
        </button>
      </div>
      {list.length === 0 && (
        <p className="text-[10px] text-[var(--text-muted)] italic py-1">暂无 MCP 服务器</p>
      )}
      {list.map((item, i) => (
        <div key={i} className="rounded-lg border border-[var(--border)] bg-[var(--bg-tertiary)] p-2.5 space-y-2">
          <div className="flex items-center gap-2">
            <input
              className={inputCls + ' flex-1'}
              placeholder="名称（如 filesystem）"
              value={item.name}
              onChange={e => update(i, 'name', e.target.value)}
            />
            <button
              type="button"
              onClick={() => remove(i)}
              className="shrink-0 w-6 h-6 flex items-center justify-center rounded-md text-[var(--text-muted)] hover:text-[var(--error)] hover:bg-[var(--error-subtle)] transition-colors border-0 bg-transparent cursor-pointer"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          <input
            className={inputCls}
            placeholder="command（如 npx）"
            value={item.command}
            onChange={e => update(i, 'command', e.target.value)}
          />
          <input
            className={inputCls}
            placeholder="args（空格分隔，如 -y @modelcontextprotocol/server-filesystem /tmp）"
            value={item.args}
            onChange={e => update(i, 'args', e.target.value)}
          />
        </div>
      ))}
    </div>
  )
}

// ─── 子组件：开关 ──────────────────────────────────────────────────────────

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="relative inline-flex items-center cursor-pointer">
      <input
        type="checkbox"
        className="sr-only"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
      />
      <div className={[
        'w-9 h-5 rounded-full transition-colors duration-200',
        checked ? 'bg-[var(--accent)]' : 'bg-[var(--bg-elevated)]',
      ].join(' ')} style={{ border: '1px solid var(--border)' }}>
        <div className={[
          'absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200',
          checked ? 'translate-x-4' : 'translate-x-0.5',
        ].join(' ')} />
      </div>
    </label>
  )
}

// ─── 主组件 ────────────────────────────────────────────────────────────────

export function ConfigPanel() {
  const [tab, setTab] = useState<'form' | 'yaml'>('form')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle')

  // 原始 YAML 字符串（YAML 视图用）
  const [yamlText, setYamlText] = useState('')
  const [yamlError, setYamlError] = useState<string | null>(null)

  // 解析后的原始对象（保留未知字段）
  const [originalParsed, setOriginalParsed] = useState<Record<string, unknown>>({})

  // 表单状态
  const [form, setForm] = useState<FormState>(DEFAULT_FORM)

  // ── 加载 ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    getConfigFile()
      .then((res) => {
        if (cancelled) return
        const text = res.content
        try {
          const parsed = yaml.load(text) as Record<string, unknown>
          setOriginalParsed(parsed)
          setForm(yamlToForm(parsed))
          setYamlText(yaml.dump(parsed, { indent: 2, lineWidth: 120, noRefs: true }))
        } catch {
          setError('配置文件 YAML 解析失败，请检查格式')
          setYamlText(text)
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  // ── 表单 → YAML 同步 ──────────────────────────────────────────────────────
  const updateForm = useCallback((patch: Partial<FormState>) => {
    setForm(prev => {
      const next = { ...prev, ...patch }
      const obj = formToObj(next, originalParsed)
      setYamlText(yaml.dump(obj, { indent: 2, lineWidth: 120, noRefs: true }))
      setYamlError(null)
      return next
    })
  }, [originalParsed])

  // ── YAML → 表单同步 ───────────────────────────────────────────────────────
  const handleYamlChange = (text: string) => {
    setYamlText(text)
    try {
      const parsed = yaml.load(text) as Record<string, unknown>
      setOriginalParsed(parsed)
      setForm(yamlToForm(parsed))
      setYamlError(null)
    } catch {
      setYamlError('YAML 格式错误，修复后将自动同步到表单')
    }
  }

  // ── 保存 ──────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    setSaveStatus('saving')
    try {
      await saveConfigFile(yamlText)
      setSaveStatus('saved')
      setTimeout(() => setSaveStatus('idle'), 2000)
    } catch (e) {
      setError(String(e))
      setSaveStatus('idle')
    }
  }

  // ── 渲染 ──────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 gap-3 text-[var(--text-muted)]">
        <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        </svg>
        <span className="text-xs">加载配置中…</span>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        {/* Tab 切换 */}
        <div className="flex gap-1 p-1 bg-[var(--bg-tertiary)] rounded-lg border border-[var(--border)]">
          {(['form', 'yaml'] as const).map(t => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={[
                'px-3 py-1.5 rounded-md text-xs font-medium transition-all duration-150 border-0 cursor-pointer',
                tab === t
                  ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm border border-[var(--border)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] bg-transparent',
              ].join(' ')}
            >
              {t === 'form' ? '表单' : 'YAML'}
            </button>
          ))}
        </div>

        {/* 保存按钮 */}
        <button
          type="button"
          onClick={handleSave}
          disabled={saveStatus === 'saving'}
          className={[
            'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all border-0 cursor-pointer',
            saveStatus === 'saved'
              ? 'bg-[var(--accent-subtle)] text-[var(--accent)]'
              : 'bg-[var(--accent)] text-white hover:opacity-90',
            saveStatus === 'saving' ? 'opacity-60 cursor-not-allowed' : '',
          ].join(' ')}
        >
          {saveStatus === 'saving' && (
            <svg className="animate-spin" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
          )}
          {saveStatus === 'saved' && (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
          {saveStatus === 'saving' ? '保存中…' : saveStatus === 'saved' ? '已保存' : '保存'}
        </button>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="px-3 py-2.5 rounded-lg border border-[var(--error)] bg-[var(--error-subtle)] text-xs text-[var(--error)]">
          {error}
        </div>
      )}

      {/* ── 表单视图 ── */}
      {tab === 'form' && (
        <div className="space-y-3">

          {/* 模型配置 */}
          <SectionCard title="模型配置" icon={
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="12" r="3" /><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" />
            </svg>
          }>
            <FormRow label="默认模型" desc="全局默认使用的模型名称">
              <input
                className={inputCls}
                placeholder="如 qwen3.5-35b-a3b"
                value={form.model}
                onChange={e => updateForm({ model: e.target.value })}
              />
            </FormRow>
            <FallbackList
              label="LLM Fallbacks（大语言模型）"
              list={form.llmFallbacks}
              onChange={llmFallbacks => updateForm({ llmFallbacks })}
              customProviders={form.customProviders}
            />
            <FallbackList
              label="Vision Fallbacks（视觉模型）"
              list={form.visionFallbacks}
              onChange={visionFallbacks => updateForm({ visionFallbacks })}
              customProviders={form.customProviders}
            />
            <FallbackList
              label="Multimodal Fallbacks（全模态模型）"
              list={form.multimodalFallbacks}
              onChange={multimodalFallbacks => updateForm({ multimodalFallbacks })}
              customProviders={form.customProviders}
            />
            <FallbackList
              label="Speech Fallbacks（语音模型）"
              list={form.speechFallbacks}
              onChange={speechFallbacks => updateForm({ speechFallbacks })}
              customProviders={form.customProviders}
            />
            <FallbackList
              label="Embedding Fallbacks（向量模型）"
              list={form.embeddingFallbacks}
              onChange={embeddingFallbacks => updateForm({ embeddingFallbacks })}
              customProviders={form.customProviders}
            />
            <FormRow label="Embedding 维度" desc="向量维度，留空使用模型默认值">
              <input
                className={inputCls}
                type="number"
                placeholder="如 512"
                value={form.embeddingDimensions}
                onChange={e => updateForm({ embeddingDimensions: e.target.value })}
              />
            </FormRow>
          </SectionCard>

          {/* 自定义提供商 */}
          <SectionCard title="自定义提供商" defaultOpen={false} icon={
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
            </svg>
          }>
            <CustomProviderList
              list={form.customProviders}
              onChange={customProviders => updateForm({ customProviders })}
            />
          </SectionCard>

          {/* 向量配置 */}
          <SectionCard title="向量配置" icon={
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" /><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
            </svg>
          }>
            <FormRow label="存储后端" desc="向量数据库类型">
              <select
                className={selectCls}
                value={form.vectorBackend}
                onChange={e => updateForm({ vectorBackend: e.target.value })}
              >
                <option value="sqlite">sqlite（内置，默认）</option>
                <option value="pgvector">pgvector</option>
                <option value="seekdb">seekdb</option>
              </select>
            </FormRow>
            {(form.vectorBackend === 'pgvector' || form.vectorBackend === 'seekdb') && (
              <FormRow label="连接 URL" desc="数据库连接字符串">
                <input
                  className={inputCls}
                  placeholder="如 postgresql://user:pass@host/db"
                  value={form.vectorUrl}
                  onChange={e => updateForm({ vectorUrl: e.target.value })}
                />
              </FormRow>
            )}
            <FormRow label="表名" desc="向量存储使用的表名（可选）">
              <input
                className={inputCls}
                placeholder="留空使用默认表名"
                value={form.vectorTable}
                onChange={e => updateForm({ vectorTable: e.target.value })}
              />
            </FormRow>
          </SectionCard>

          {/* 智能体配置 */}
          <SectionCard title="智能体配置" icon={
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 2a10 10 0 1 0 10 10" /><path d="M12 8v4l3 3" />
            </svg>
          }>
            <FormRow label="权限模式" desc="工具调用时的权限确认方式">
              <select
                className={selectCls}
                value={form.agentPermissionMode}
                onChange={e => updateForm({ agentPermissionMode: e.target.value })}
              >
                <option value="ask">ask（每次询问）</option>
                <option value="craft">craft（自动执行）</option>
                <option value="plan">plan（计划模式）</option>
              </select>
            </FormRow>
            <FormRow label="最大 Token 数" desc="单次对话最大 token 限制">
              <input
                className={inputCls}
                type="number"
                placeholder="如 8096"
                value={form.agentMaxTokens}
                onChange={e => updateForm({ agentMaxTokens: e.target.value })}
              />
            </FormRow>
            <FormRow label="最大轮次" desc="单次任务最大对话轮数">
              <input
                className={inputCls}
                type="number"
                placeholder="如 50"
                value={form.agentMaxTurns}
                onChange={e => updateForm({ agentMaxTurns: e.target.value })}
              />
            </FormRow>
            <FormRow label="记忆压缩" desc="自动压缩长对话上下文">
              <Toggle checked={form.agentMemoryCondense} onChange={v => updateForm({ agentMemoryCondense: v })} />
            </FormRow>
            <FormRow label="自动提炼技能" desc="从对话中自动提炼技能片段">
              <Toggle checked={form.agentAutoDistillSkill} onChange={v => updateForm({ agentAutoDistillSkill: v })} />
            </FormRow>
            <FormRow label="自动清理会话" desc="定期清理过期历史会话">
              <Toggle checked={form.agentAutoPruneSessions} onChange={v => updateForm({ agentAutoPruneSessions: v })} />
            </FormRow>
            {form.agentAutoPruneSessions && (
              <>
                <FormRow label="保留会话数" desc="清理时保留的最近会话数量">
                  <input
                    className={inputCls}
                    type="number"
                    placeholder="如 50"
                    value={form.agentPruneKeepCount}
                    onChange={e => updateForm({ agentPruneKeepCount: e.target.value })}
                  />
                </FormRow>
                <FormRow label="最大保留天数" desc="超过此天数的会话将被清理">
                  <input
                    className={inputCls}
                    type="number"
                    placeholder="如 90"
                    value={form.agentPruneMaxAgeDays}
                    onChange={e => updateForm({ agentPruneMaxAgeDays: e.target.value })}
                  />
                </FormRow>
              </>
            )}
          </SectionCard>

          {/* 多智能体配置 */}
          <SectionCard title="多智能体配置" defaultOpen={false} icon={
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          }>
            <FormRow label="最大并发数" desc="子智能体最大并发数量">
              <input
                className={inputCls}
                type="number"
                placeholder="如 10"
                value={form.multiAgentMaxConcurrent}
                onChange={e => updateForm({ multiAgentMaxConcurrent: e.target.value })}
              />
            </FormRow>
            <FormRow label="默认最大轮次" desc="子智能体默认最大对话轮数">
              <input
                className={inputCls}
                type="number"
                placeholder="如 30"
                value={form.multiAgentMaxTurns}
                onChange={e => updateForm({ multiAgentMaxTurns: e.target.value })}
              />
            </FormRow>
            <FormRow label="默认超时（ms）" desc="子智能体默认超时时间">
              <input
                className={inputCls}
                type="number"
                placeholder="如 300000"
                value={form.multiAgentTimeoutMs}
                onChange={e => updateForm({ multiAgentTimeoutMs: e.target.value })}
              />
            </FormRow>
            <FormRow label="自动选择角色" desc="根据任务自动匹配最合适的 profile">
              <Toggle checked={form.multiAgentAutoSelect} onChange={v => updateForm({ multiAgentAutoSelect: v })} />
            </FormRow>
            <FormRow label="允许递归派生" desc="子智能体是否可以再派生子智能体">
              <Toggle checked={form.multiAgentRecursive} onChange={v => updateForm({ multiAgentRecursive: v })} />
            </FormRow>
          </SectionCard>

          {/* 工具权限 */}
          <SectionCard title="工具权限" defaultOpen={false} icon={
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          }>
            <FormRow label="默认禁止工具" desc="子智能体默认禁止使用的工具（逗号分隔）">
              <input
                className={inputCls}
                placeholder="如 todo_write, todo_update"
                value={form.toolPermissionDenyList}
                onChange={e => updateForm({ toolPermissionDenyList: e.target.value })}
              />
            </FormRow>
            <FormRow label="允许 MCP 工具" desc="子智能体是否可以使用 MCP 工具">
              <Toggle checked={form.toolPermissionAllowMcp} onChange={v => updateForm({ toolPermissionAllowMcp: v })} />
            </FormRow>
          </SectionCard>

          {/* MCP 服务器 */}
          <SectionCard title="MCP 服务器" defaultOpen={false} icon={
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <rect x="2" y="2" width="20" height="8" rx="2" ry="2" /><rect x="2" y="14" width="20" height="8" rx="2" ry="2" /><line x1="6" y1="6" x2="6.01" y2="6" /><line x1="6" y1="18" x2="6.01" y2="18" />
            </svg>
          }>
            <McpServerList
              list={form.mcpServers}
              onChange={mcpServers => updateForm({ mcpServers })}
            />
          </SectionCard>

          {/* 网关配置 */}
          <SectionCard title="网关配置" icon={
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" />
            </svg>
          }>
            <FormRow label="端口" desc="HTTP/WebSocket 监听端口">
              <input
                className={inputCls}
                type="number"
                placeholder="如 3282"
                value={form.gatewayPort}
                onChange={e => updateForm({ gatewayPort: e.target.value })}
              />
            </FormRow>
            <FormRow label="主机" desc="监听地址">
              <input
                className={inputCls}
                placeholder="如 127.0.0.1"
                value={form.gatewayHost}
                onChange={e => updateForm({ gatewayHost: e.target.value })}
              />
            </FormRow>
            <FormRow label="Token" desc="API 访问令牌（留空不启用）">
              <input
                className={inputCls}
                type="password"
                placeholder="留空不启用 token 验证"
                value={form.gatewayToken}
                onChange={e => updateForm({ gatewayToken: e.target.value })}
              />
            </FormRow>
            <UserList
              list={form.gatewayUsers}
              onChange={gatewayUsers => updateForm({ gatewayUsers })}
            />
          </SectionCard>

          {/* 日志配置 */}
          <SectionCard title="日志配置" icon={
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /><polyline points="10 9 9 9 8 9" />
            </svg>
          }>
            <FormRow label="日志级别" desc="控制台输出的最低日志级别">
              <select
                className={selectCls}
                value={form.loggingLevel}
                onChange={e => updateForm({ loggingLevel: e.target.value })}
              >
                <option value="debug">debug</option>
                <option value="info">info</option>
                <option value="warn">warn</option>
                <option value="error">error</option>
              </select>
            </FormRow>
            <FormRow label="日志主题" desc="日志输出样式">
              <select
                className={selectCls}
                value={form.loggingTheme}
                onChange={e => updateForm({ loggingTheme: e.target.value })}
              >
                <option value="default">default</option>
                <option value="minimal">minimal</option>
              </select>
            </FormRow>
          </SectionCard>

          {/* 技能配置 */}
          <SectionCard title="技能配置" icon={
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
          }>
            <FormRow label="SkillHub URL" desc="AI Skills 社区地址">
              <input
                className={inputCls}
                placeholder="如 https://skillhub.cn"
                value={form.skillHubUrl}
                onChange={e => updateForm({ skillHubUrl: e.target.value })}
              />
            </FormRow>
            <FormRow label="API Base" desc="SkillHub API 接口地址">
              <input
                className={inputCls}
                placeholder="如 https://api.skillhub.cn"
                value={form.skillHubApiBase}
                onChange={e => updateForm({ skillHubApiBase: e.target.value })}
              />
            </FormRow>
          </SectionCard>

        </div>
      )}

      {/* ── YAML 视图 ── */}
      {tab === 'yaml' && (
        <div className="space-y-2">
          {yamlError && (
            <div className="px-3 py-2 rounded-lg border border-[var(--error)] bg-[var(--error-subtle)] text-[10px] text-[var(--error)]">
              {yamlError}
            </div>
          )}
          <textarea
            className={[
              'w-full h-[60vh] px-3 py-2.5 rounded-xl text-xs font-mono resize-none',
              'bg-[var(--bg-secondary)] border border-[var(--border)]',
              'text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-focus)] transition-colors',
            ].join(' ')}
            value={yamlText}
            onChange={e => handleYamlChange(e.target.value)}
            spellCheck={false}
          />
        </div>
      )}
    </div>
  )
}
