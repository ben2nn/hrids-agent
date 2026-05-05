import { useEffect, useState } from 'react'
import { getAvailableModels, getAgentConfig, updateAgentConfig } from '../../lib/gateway.js'
import type { ModelEntry } from '../../lib/gateway.js'

// ─── 骨架屏 ────────────────────────────────────────────────────────────────

function SkeletonRow() {
  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border)] animate-pulse">
      <div className="w-8 h-8 rounded-lg bg-[var(--bg-tertiary)] shrink-0" />
      <div className="flex-1 space-y-1.5">
        <div className="h-3.5 w-40 bg-[var(--bg-tertiary)] rounded" />
        <div className="h-3 w-20 bg-[var(--bg-tertiary)] rounded" />
      </div>
    </div>
  )
}

// ─── 提供商图标 ────────────────────────────────────────────────────────────

function ProviderBadge({ provider }: { provider: string }) {
  const map: Record<string, { label: string; color: string }> = {
    aliyun:    { label: '阿里云', color: 'bg-orange-500/20 text-orange-400 border-orange-500/30' },
    openai:    { label: 'OpenAI', color: 'bg-green-500/20 text-green-400 border-green-500/30' },
    anthropic: { label: 'Anthropic', color: 'bg-purple-500/20 text-purple-400 border-purple-500/30' },
    deepseek:  { label: 'DeepSeek', color: 'bg-blue-500/20 text-blue-400 border-blue-500/30' },
    groq:      { label: 'Groq', color: 'bg-red-500/20 text-red-400 border-red-500/30' },
    ollama:    { label: 'Ollama', color: 'bg-gray-500/20 text-gray-400 border-gray-500/30' },
    default:   { label: '默认', color: 'bg-[var(--bg-tertiary)] text-[var(--text-muted)] border-[var(--border)]' },
  }
  const cfg = map[provider.toLowerCase()] ?? { label: provider, color: 'bg-[var(--bg-tertiary)] text-[var(--text-muted)] border-[var(--border)]' }
  return (
    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${cfg.color}`}>
      {cfg.label}
    </span>
  )
}

// ─── ModelPage ─────────────────────────────────────────────────────────────

export function ModelPage() {
  const [models, setModels] = useState<ModelEntry[]>([])
  const [defaultModel, setDefaultModel] = useState('')
  const [selectedModel, setSelectedModel] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      setError(null)
      try {
        const [modelsRes, configRes] = await Promise.all([
          getAvailableModels(),
          getAgentConfig(),
        ])
        if (!cancelled) {
          setModels(modelsRes.models)
          setDefaultModel(modelsRes.defaultModel)
          setSelectedModel(configRes.model)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : '加载失败，请稍后重试')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [])

  async function handleSave() {
    if (!selectedModel || saving) return
    setSaving(true)
    setSaved(false)
    try {
      await updateAgentConfig({ model: selectedModel })
      setDefaultModel(selectedModel)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const isDirty = selectedModel !== defaultModel

  return (
    <div className="flex-1 overflow-y-auto p-4">
      {/* 页面标题 */}
      <div className="mb-5">
        <h2 className="text-base font-semibold text-[var(--text-primary)]">⚡ Auto — 模型配置</h2>
        <p className="text-xs text-[var(--text-secondary)] mt-0.5">
          选择默认使用的大语言模型，新建会话时若未指定则使用此配置
        </p>
      </div>

      {/* 加载中 */}
      {loading && (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 4 }).map((_, i) => <SkeletonRow key={i} />)}
        </div>
      )}

      {/* 错误 */}
      {!loading && error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">
          <span className="font-medium">加载失败：</span>{error}
        </div>
      )}

      {/* 模型列表 */}
      {!loading && !error && (
        <>
          <div className="flex flex-col gap-2 mb-5">
            {models.map((m) => {
              const isSelected = m.model === selectedModel
              return (
                <button
                  key={`${m.provider}-${m.model}`}
                  type="button"
                  onClick={() => setSelectedModel(m.model)}
                  className={[
                    'flex items-center gap-3 px-4 py-3 rounded-xl border text-left transition-all duration-150 w-full',
                    isSelected
                      ? 'border-[var(--accent-border)] bg-[var(--accent-subtle)]'
                      : 'border-[var(--border)] bg-[var(--bg-secondary)] hover:border-[var(--border-focus)] hover:bg-[var(--bg-tertiary)]',
                  ].join(' ')}
                >
                  {/* 选中指示 */}
                  <div className={[
                    'w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 transition-all',
                    isSelected
                      ? 'border-[var(--accent)] bg-[var(--accent)]'
                      : 'border-[var(--border)]',
                  ].join(' ')}>
                    {isSelected && (
                      <div className="w-1.5 h-1.5 rounded-full bg-white" />
                    )}
                  </div>

                  {/* 模型信息 */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`text-sm font-medium font-mono truncate ${isSelected ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}>
                        {m.model}
                      </span>
                      {m.isDefault && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--accent-subtle)] text-[var(--accent)] border border-[var(--accent-border)] font-semibold shrink-0">
                          当前默认
                        </span>
                      )}
                    </div>
                    <div className="mt-1">
                      <ProviderBadge provider={m.provider} />
                    </div>
                  </div>
                </button>
              )
            })}

            {/* 自定义模型输入 */}
            <div className="mt-1">
              <label className="text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wide block mb-1.5">
                或手动输入模型名
              </label>
              <input
                type="text"
                value={models.some(m => m.model === selectedModel) ? '' : selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                placeholder="例如：gpt-4o、claude-3-5-sonnet-20241022"
                className="w-full px-3.5 py-2.5 rounded-xl text-sm bg-[var(--bg-tertiary)] border border-[var(--border)] text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--accent-subtle)] transition-all font-mono"
              />
            </div>
          </div>

          {/* 当前选中 + 保存按钮 */}
          <div className="flex items-center justify-between gap-3 pt-3 border-t border-[var(--border-subtle)]">
            <div className="min-w-0">
              <span className="text-[11px] text-[var(--text-muted)]">当前选中：</span>
              <span className="text-xs font-mono text-[var(--text-primary)] ml-1 truncate">
                {selectedModel || '—'}
              </span>
            </div>
            <button
              type="button"
              onClick={handleSave}
              disabled={!isDirty || saving || !selectedModel}
              className={[
                'px-4 py-2 rounded-xl text-sm font-semibold transition-all shrink-0',
                saved
                  ? 'bg-green-600 text-white'
                  : isDirty && selectedModel
                    ? 'bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white shadow-sm'
                    : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)] cursor-not-allowed',
              ].join(' ')}
            >
              {saving ? (
                <span className="flex items-center gap-2">
                  <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                  </svg>
                  保存中...
                </span>
              ) : saved ? '✓ 已保存' : '设为默认'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
