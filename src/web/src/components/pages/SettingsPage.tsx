import { useState, useEffect, useCallback } from 'react'
import { useThemeStore } from '../../store/themeStore.js'
import { getLogs, getUsageStats, getConfigFile, saveConfigFile } from '../../lib/gateway.js'
import type { LogEntry, UsageDayStats } from '../../lib/gateway.js'

// ─── Tab 定义 ──────────────────────────────────────────────────────────────

type SettingsSection = 'general' | 'config' | 'logs' | 'usage'

const TABS: Array<{ id: SettingsSection; label: string; icon: React.ReactNode }> = [
  {
    id: 'general',
    label: '通用',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    ),
  },
  {
    id: 'config',
    label: '配置文件',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
      </svg>
    ),
  },
  {
    id: 'logs',
    label: '日志',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
        <line x1="8" y1="21" x2="16" y2="21" />
        <line x1="12" y1="17" x2="12" y2="21" />
      </svg>
    ),
  },
  {
    id: 'usage',
    label: '用量',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="20" x2="18" y2="10" />
        <line x1="12" y1="20" x2="12" y2="4" />
        <line x1="6" y1="20" x2="6" y2="14" />
      </svg>
    ),
  },
]

// ─── 通用设置面板 ──────────────────────────────────────────────────────────

function GeneralPanel() {
  const { theme, toggle } = useThemeStore()

  return (
    <div className="space-y-2">
      {/* 主题 */}
      <SettingRow
        label="界面主题"
        desc="切换日间 / 夜间模式"
      >
        <div className="flex gap-1.5 p-1 bg-[var(--bg-tertiary)] rounded-lg border border-[var(--border)]">
          {(['light', 'dark'] as const).map(t => (
            <button
              key={t}
              type="button"
              onClick={() => { if (theme !== t) toggle() }}
              className={[
                'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all duration-150 border-0 cursor-pointer',
                theme === t
                  ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm border border-[var(--border)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
              ].join(' ')}
            >
              {t === 'light' ? (
                <>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="5" />
                    <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
                    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                    <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
                    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                  </svg>
                  日间
                </>
              ) : (
                <>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                  </svg>
                  夜间
                </>
              )}
            </button>
          ))}
        </div>
      </SettingRow>

      {/* 语言 */}
      <SettingRow label="界面语言" desc="选择显示语言">
        <select
          className="px-3 py-1.5 rounded-lg text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] text-[var(--text-primary)] cursor-pointer focus:outline-none focus:border-[var(--border-focus)] transition-colors"
          defaultValue="zh-CN"
        >
          <option value="zh-CN">简体中文</option>
          <option value="en-US">English</option>
        </select>
      </SettingRow>
    </div>
  )
}

// ─── 通用行组件 ────────────────────────────────────────────────────────────

function SettingRow({ label, desc, children }: { label: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3.5 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border)] hover:border-[var(--border-focus)] transition-colors group">
      <div className="min-w-0">
        <p className="text-sm font-medium text-[var(--text-primary)]">{label}</p>
        {desc && <p className="text-xs text-[var(--text-muted)] mt-0.5">{desc}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

// ─── 配置面板 ──────────────────────────────────────────────────────────────

function ConfigPanel() {
  const [content, setContent] = useState('')
  const [path, setPath] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    setLoading(true)
    getConfigFile()
      .then(data => { setContent(data.content); setPath(data.path) })
      .catch(err => setError(String(err)))
      .finally(() => setLoading(false))
  }, [])

  const handleSave = async () => {
    setError('')
    setSaving(true)
    try {
      JSON.parse(content)
      await saveConfigFile(content)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      setError(String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-3 h-full">
      {/* 头部信息栏 */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border)]">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-7 h-7 rounded-lg bg-[var(--accent-subtle)] flex items-center justify-center shrink-0">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--accent)]">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
          </div>
          <div className="min-w-0">
            <p className="text-xs font-semibold text-[var(--text-primary)]">config.json</p>
            {path && <p className="text-[10px] text-[var(--text-muted)] font-mono truncate mt-0.5">{path}</p>}
          </div>
        </div>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || loading}
          className={[
            'flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all duration-150 border-0 cursor-pointer shrink-0',
            saved
              ? 'bg-[var(--success-subtle)] text-[var(--success)] border border-[var(--success)]/30'
              : 'bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white disabled:opacity-50 disabled:cursor-not-allowed',
          ].join(' ')}
        >
          {saving ? (
            <>
              <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
              保存中
            </>
          ) : saved ? (
            <>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12" /></svg>
              已保存
            </>
          ) : '保存'}
        </button>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="flex items-start gap-2 px-3.5 py-2.5 rounded-xl bg-[var(--error-subtle)] border border-[var(--error)]/25 animate-fade-in">
          <svg className="text-[var(--error)] shrink-0 mt-0.5" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <p className="text-xs text-[var(--error)] font-mono break-all">{error}</p>
        </div>
      )}

      {/* 编辑器 */}
      <div className="flex-1 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border)] overflow-hidden">
        {loading ? (
          <div className="h-full flex items-center justify-center text-[var(--text-muted)] text-sm">
            <svg className="animate-spin w-4 h-4 mr-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
            加载中...
          </div>
        ) : (
          <textarea
            value={content}
            onChange={e => setContent(e.target.value)}
            spellCheck={false}
            className="w-full h-full px-4 py-3.5 text-xs font-mono bg-transparent text-[var(--text-primary)] resize-none focus:outline-none leading-relaxed"
            style={{ minHeight: 'calc(100vh - 320px)' }}
          />
        )}
      </div>
    </div>
  )
}

// ─── 日志面板 ──────────────────────────────────────────────────────────────

const LOG_LEVEL_COLORS: Record<string, string> = {
  debug: 'text-[var(--text-muted)]',
  info:  'text-[var(--info)]',
  warn:  'text-[var(--warning)]',
  error: 'text-[var(--error)]',
}

const LOG_LEVEL_BG: Record<string, string> = {
  debug: 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]',
  info:  'bg-[var(--info-subtle)] text-[var(--info)]',
  warn:  'bg-[var(--warning-subtle)] text-[var(--warning)]',
  error: 'bg-[var(--error-subtle)] text-[var(--error)]',
}

function LogsPanel() {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [levelFilter, setLevelFilter] = useState('all')
  const [search, setSearch] = useState('')

  const fetchLogs = useCallback(() => {
    setLoading(true)
    getLogs(500, levelFilter)
      .then(data => { setLogs(data.logs.reverse()); setTotal(data.total) })
      .catch(() => setLogs([]))
      .finally(() => setLoading(false))
  }, [levelFilter])

  useEffect(() => { fetchLogs() }, [fetchLogs])

  const filtered = search
    ? logs.filter(l => l.msg.toLowerCase().includes(search.toLowerCase()) || JSON.stringify(l).toLowerCase().includes(search.toLowerCase()))
    : logs

  return (
    <div className="flex flex-col gap-3">
      {/* 工具栏 */}
      <div className="flex items-center gap-2">
        {/* 搜索框 */}
        <div className="relative flex-1">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            placeholder="搜索日志..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-7 pr-3 py-1.5 rounded-lg text-xs bg-[var(--bg-secondary)] border border-[var(--border)] text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--border-focus)] transition-colors"
          />
        </div>

        {/* 级别筛选 */}
        <div className="flex gap-1 p-1 bg-[var(--bg-secondary)] rounded-lg border border-[var(--border)]">
          {['all', 'debug', 'info', 'warn', 'error'].map(lv => (
            <button
              key={lv}
              type="button"
              onClick={() => setLevelFilter(lv)}
              className={[
                'px-2.5 py-1 rounded-md text-[11px] font-medium transition-all duration-150 border-0 cursor-pointer',
                levelFilter === lv
                  ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)] shadow-sm'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]',
              ].join(' ')}
            >
              {lv === 'all' ? '全部' : lv.toUpperCase()}
            </button>
          ))}
        </div>

        {/* 刷新 + 计数 */}
        <button
          type="button"
          onClick={fetchLogs}
          title="刷新"
          className="w-7 h-7 flex items-center justify-center rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--border-focus)] cursor-pointer transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
        </button>
        <span className="text-[11px] text-[var(--text-muted)] whitespace-nowrap shrink-0">共 {total} 条</span>
      </div>

      {/* 日志列表 */}
      <div className="rounded-xl bg-[var(--bg-secondary)] border border-[var(--border)] overflow-hidden">
        {loading ? (
          <div className="h-64 flex items-center justify-center text-[var(--text-muted)] text-sm gap-2">
            <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
            加载中...
          </div>
        ) : filtered.length === 0 ? (
          <div className="h-64 flex flex-col items-center justify-center text-[var(--text-muted)] gap-2">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="opacity-40">
              <rect x="2" y="3" width="20" height="14" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" />
            </svg>
            <span className="text-xs">暂无日志</span>
          </div>
        ) : (
          <div className="overflow-y-auto font-mono text-[11px]" style={{ maxHeight: 'calc(100vh - 300px)' }}>
            {filtered.map((entry, i) => {
              const { ts, level, msg, component, ...rest } = entry
              const restKeys = Object.keys(rest)
              const lvStr = String(level ?? 'debug')
              return (
                <div
                  key={i}
                  className="flex gap-2.5 px-4 py-1.5 border-b border-[var(--border-subtle)] last:border-0 hover:bg-[var(--bg-tertiary)] transition-colors items-baseline"
                >
                  <span className="text-[var(--text-muted)] shrink-0 w-[130px] leading-5">
                    {String(ts ?? '').slice(0, 23).replace('T', ' ')}
                  </span>
                  <span className={['shrink-0 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase leading-none', LOG_LEVEL_BG[lvStr] ?? LOG_LEVEL_BG.debug].join(' ')}>
                    {lvStr.slice(0, 4)}
                  </span>
                  {component != null && (
                    <span className="text-[var(--text-muted)] shrink-0 leading-5">[{String(component)}]</span>
                  )}
                  <span className={['flex-1 break-all leading-5', LOG_LEVEL_COLORS[lvStr] ?? ''].join(' ')}>
                    {String(msg ?? '')}
                    {restKeys.length > 0 && (
                      <span className="text-[var(--text-muted)] ml-2 opacity-70">
                        {restKeys.map(k => `${k}=${JSON.stringify(rest[k])}`).join(' ')}
                      </span>
                    )}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── 用量面板 ──────────────────────────────────────────────────────────────

function UsagePanel() {
  const [data, setData] = useState<{
    sessions: UsageDayStats[]
    totals: { inputTokens: number; outputTokens: number; costUsd: number; calls: number }
  } | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getUsageStats()
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [])

  const fmt = (n: number) => n.toLocaleString('zh-CN')
  const fmtCost = (n: number) => n < 0.0001 ? '< $0.0001' : `$${n.toFixed(4)}`

  const statCards = [
    {
      label: 'API 调用',
      value: loading ? null : fmt(data?.totals.calls ?? 0),
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
        </svg>
      ),
      color: 'text-[var(--accent)] bg-[var(--accent-subtle)]',
    },
    {
      label: '输入 Tokens',
      value: loading ? null : fmt(data?.totals.inputTokens ?? 0),
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="17" y1="10" x2="3" y2="10" /><line x1="21" y1="6" x2="3" y2="6" /><line x1="21" y1="14" x2="3" y2="14" /><line x1="17" y1="18" x2="3" y2="18" />
        </svg>
      ),
      color: 'text-[var(--info)] bg-[var(--info-subtle)]',
    },
    {
      label: '输出 Tokens',
      value: loading ? null : fmt(data?.totals.outputTokens ?? 0),
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="21" y1="10" x2="7" y2="10" /><line x1="21" y1="6" x2="3" y2="6" /><line x1="21" y1="14" x2="3" y2="14" /><line x1="21" y1="18" x2="7" y2="18" />
        </svg>
      ),
      color: 'text-[var(--success)] bg-[var(--success-subtle)]',
    },
    {
      label: '估算费用',
      value: loading ? null : fmtCost(data?.totals.costUsd ?? 0),
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
        </svg>
      ),
      color: 'text-[var(--warning)] bg-[var(--warning-subtle)]',
    },
  ]

  return (
    <div className="flex flex-col gap-4">
      {/* 统计卡片 */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {statCards.map(card => (
          <div key={card.label} className="flex flex-col gap-3 px-4 py-3.5 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border)]">
            <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${card.color}`}>
              {card.icon}
            </div>
            <div>
              {card.value === null ? (
                <div className="h-5 w-16 rounded bg-[var(--bg-tertiary)] skeleton mb-1" />
              ) : (
                <p className="text-lg font-bold text-[var(--text-primary)] leading-tight tabular-nums">{card.value}</p>
              )}
              <p className="text-[11px] text-[var(--text-muted)] mt-0.5">{card.label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* 按日期明细 */}
      <div className="rounded-xl bg-[var(--bg-secondary)] border border-[var(--border)] overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-subtle)]">
          <span className="text-xs font-semibold text-[var(--text-primary)]">按日期明细</span>
          {data && (
            <span className="text-[10px] text-[var(--text-muted)] bg-[var(--bg-tertiary)] px-1.5 py-0.5 rounded-full">
              {data.sessions.length} 天
            </span>
          )}
        </div>
        {loading ? (
          <div className="h-40 flex items-center justify-center text-[var(--text-muted)] text-sm gap-2">
            <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
            加载中...
          </div>
        ) : !data || data.sessions.length === 0 ? (
          <div className="h-40 flex flex-col items-center justify-center text-[var(--text-muted)] gap-2">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="opacity-40">
              <line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" />
            </svg>
            <span className="text-xs">暂无用量数据</span>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--border-subtle)]">
                  {['日期', '调用次数', '输入 Tokens', '输出 Tokens', '估算费用'].map(h => (
                    <th key={h} className="px-4 py-2.5 text-left text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.sessions.map((row, i) => (
                  <tr key={row.date} className={['border-b border-[var(--border-subtle)] last:border-0 hover:bg-[var(--bg-tertiary)] transition-colors', i % 2 === 0 ? '' : ''].join(' ')}>
                    <td className="px-4 py-2.5 text-xs font-mono text-[var(--text-primary)]">{row.date}</td>
                    <td className="px-4 py-2.5 text-xs text-[var(--text-secondary)] tabular-nums">{fmt(row.calls)}</td>
                    <td className="px-4 py-2.5 text-xs text-[var(--text-secondary)] tabular-nums">{fmt(row.inputTokens)}</td>
                    <td className="px-4 py-2.5 text-xs text-[var(--text-secondary)] tabular-nums">{fmt(row.outputTokens)}</td>
                    <td className="px-4 py-2.5 text-xs text-[var(--text-secondary)] tabular-nums">{fmtCost(row.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── 主页面 ────────────────────────────────────────────────────────────────

export function SettingsPage() {
  const [activeSection, setActiveSection] = useState<SettingsSection>('general')

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-[var(--bg-primary)]">
      {/* 顶部 Tab 栏 */}
      <div className="flex items-center gap-1 px-5 pt-4 pb-0 border-b border-[var(--border)] bg-[var(--bg-secondary)] shrink-0">
        {/* 标题 */}
        <div className="flex items-center gap-2 mr-5">
          <div className="w-6 h-6 rounded-lg bg-[var(--accent-subtle)] flex items-center justify-center shrink-0">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--accent)]">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </div>
          <span className="text-sm font-semibold text-[var(--text-primary)]">系统设置</span>
        </div>

        {/* Tab 按钮 */}
        {TABS.map(tab => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveSection(tab.id)}
            className={[
              'relative flex items-center gap-1.5 px-3.5 py-2.5 text-xs font-medium transition-all duration-150 border-0 cursor-pointer rounded-t-lg',
              activeSection === tab.id
                ? 'text-[var(--accent)] bg-[var(--accent-subtle)]'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]',
            ].join(' ')}
          >
            <span className="opacity-80">{tab.icon}</span>
            {tab.label}
            {/* 激活下划线 */}
            {activeSection === tab.id && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-[var(--accent)] rounded-t-full" />
            )}
          </button>
        ))}
      </div>

      {/* 内容区域 */}
      <div className="flex-1 overflow-y-auto p-5">
        <div className="max-w-3xl animate-fade-in">
          {activeSection === 'general'  && <GeneralPanel />}
          {activeSection === 'config'   && <ConfigPanel />}
          {activeSection === 'logs'     && <LogsPanel />}
          {activeSection === 'usage'    && <UsagePanel />}
        </div>
      </div>
    </div>
  )
}
