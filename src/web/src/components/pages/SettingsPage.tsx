import { useState, useEffect, useCallback } from 'react'
import { useThemeStore } from '../../store/themeStore.js'
import { getLogs, getUsageStats, getConfigFile, saveConfigFile } from '../../lib/gateway.js'
import type { LogEntry, UsageDayStats } from '../../lib/gateway.js'

// ─── 左侧导航项 ────────────────────────────────────────────────────────────

type SettingsSection = 'general' | 'config' | 'logs' | 'usage'

interface NavItem {
  id: SettingsSection
  label: string
  icon: React.ReactNode
}

const NAV_ITEMS: NavItem[] = [
  {
    id: 'general',
    label: '通用设置',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    ),
  },
  {
    id: 'config',
    label: '配置',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
        <polyline points="10 9 9 9 8 9" />
      </svg>
    ),
  },
  {
    id: 'logs',
    label: '日志',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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

  const LANG_OPTIONS = [
    { value: 'zh-CN', label: '简体中文' },
    { value: 'en-US', label: 'English' },
  ]

  return (
    <div className="space-y-6">
      {/* 主题 */}
      <section className="bg-[var(--bg-secondary)] rounded-xl border border-[var(--border)] p-5">
        <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-4">主题</h2>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-[var(--text-primary)]">界面主题</p>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">切换日间 / 夜间模式</p>
          </div>
          <div className="flex gap-2">
            {(['light', 'dark'] as const).map(t => (
              <button
                key={t}
                type="button"
                onClick={() => { if (theme !== t) toggle() }}
                className={[
                  'px-4 py-2 rounded-lg text-sm font-medium transition-all duration-150 border cursor-pointer',
                  theme === t
                    ? 'bg-[var(--accent)] text-white border-[var(--accent)]'
                    : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)] border-[var(--border)] hover:border-[var(--accent)]',
                ].join(' ')}
              >
                {t === 'light' ? '☀️ 日间' : '🌙 夜间'}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* 语言 */}
      <section className="bg-[var(--bg-secondary)] rounded-xl border border-[var(--border)] p-5">
        <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-4">语言</h2>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-[var(--text-primary)]">界面语言</p>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">选择显示语言</p>
          </div>
          <select
            className="px-3 py-2 rounded-lg text-sm bg-[var(--bg-tertiary)] border border-[var(--border)] text-[var(--text-primary)] cursor-pointer"
            defaultValue="zh-CN"
          >
            {LANG_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      </section>
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
      .then(data => {
        setContent(data.content)
        setPath(data.path)
      })
      .catch(err => setError(String(err)))
      .finally(() => setLoading(false))
  }, [])

  const handleSave = async () => {
    setError('')
    setSaving(true)
    try {
      // 先验证 JSON
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
    <div className="space-y-4">
      <div className="bg-[var(--bg-secondary)] rounded-xl border border-[var(--border)] p-5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">config.json</h2>
            {path && <p className="text-xs text-[var(--text-muted)] mt-0.5 font-mono">{path}</p>}
          </div>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || loading}
            className={[
              'px-4 py-2 rounded-lg text-sm font-medium transition-all duration-150 border-0 cursor-pointer',
              saved
                ? 'bg-green-500 text-white'
                : 'bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white disabled:opacity-50 disabled:cursor-not-allowed',
            ].join(' ')}
          >
            {saving ? '保存中...' : saved ? '✓ 已保存' : '保存'}
          </button>
        </div>

        {error && (
          <div className="mb-3 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-400 font-mono">
            {error}
          </div>
        )}

        {loading ? (
          <div className="h-64 flex items-center justify-center text-[var(--text-muted)] text-sm">加载中...</div>
        ) : (
          <textarea
            value={content}
            onChange={e => setContent(e.target.value)}
            spellCheck={false}
            className="w-full h-[calc(100vh-320px)] min-h-64 px-3.5 py-3 rounded-lg text-xs font-mono bg-[var(--bg-tertiary)] border border-[var(--border)] text-[var(--text-primary)] resize-none focus:outline-none focus:border-[var(--accent)]"
          />
        )}
      </div>
    </div>
  )
}

// ─── 日志面板 ──────────────────────────────────────────────────────────────

const LOG_LEVEL_COLORS: Record<string, string> = {
  debug: 'text-[var(--text-muted)]',
  info: 'text-blue-400',
  warn: 'text-yellow-400',
  error: 'text-red-400',
}

const LOG_LEVEL_BG: Record<string, string> = {
  debug: 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]',
  info: 'bg-blue-500/15 text-blue-400',
  warn: 'bg-yellow-500/15 text-yellow-400',
  error: 'bg-red-500/15 text-red-400',
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
      .then(data => {
        setLogs(data.logs.reverse()) // 最新的在前
        setTotal(data.total)
      })
      .catch(() => setLogs([]))
      .finally(() => setLoading(false))
  }, [levelFilter])

  useEffect(() => { fetchLogs() }, [fetchLogs])

  const filtered = search
    ? logs.filter(l => l.msg.toLowerCase().includes(search.toLowerCase()) || JSON.stringify(l).toLowerCase().includes(search.toLowerCase()))
    : logs

  return (
    <div className="space-y-4">
      {/* 工具栏 */}
      <div className="flex items-center gap-3">
        <input
          type="text"
          placeholder="搜索日志..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="flex-1 px-3 py-2 rounded-lg text-sm bg-[var(--bg-secondary)] border border-[var(--border)] text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
        />
        <select
          value={levelFilter}
          onChange={e => setLevelFilter(e.target.value)}
          className="px-3 py-2 rounded-lg text-sm bg-[var(--bg-secondary)] border border-[var(--border)] text-[var(--text-primary)] cursor-pointer"
        >
          <option value="all">全部级别</option>
          <option value="debug">Debug</option>
          <option value="info">Info</option>
          <option value="warn">Warn</option>
          <option value="error">Error</option>
        </select>
        <button
          type="button"
          onClick={fetchLogs}
          className="px-3 py-2 rounded-lg text-sm bg-[var(--bg-secondary)] border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer transition-colors"
        >
          刷新
        </button>
        <span className="text-xs text-[var(--text-muted)] whitespace-nowrap">共 {total} 条</span>
      </div>

      {/* 日志列表 */}
      <div className="bg-[var(--bg-secondary)] rounded-xl border border-[var(--border)] overflow-hidden">
        {loading ? (
          <div className="h-64 flex items-center justify-center text-[var(--text-muted)] text-sm">加载中...</div>
        ) : filtered.length === 0 ? (
          <div className="h-64 flex items-center justify-center text-[var(--text-muted)] text-sm">暂无日志</div>
        ) : (
          <div className="overflow-y-auto max-h-[calc(100vh-280px)] font-mono text-xs">
            {filtered.map((entry, i) => {
              const { ts, level, msg, component, ...rest } = entry
              const restKeys = Object.keys(rest)
              return (
                <div
                  key={i}
                  className="flex gap-3 px-4 py-2 border-b border-[var(--border)] last:border-0 hover:bg-[var(--bg-tertiary)] transition-colors"
                >
                  <span className="text-[var(--text-muted)] shrink-0 w-[140px]">
                    {String(ts ?? '').slice(0, 23).replace('T', ' ')}
                  </span>
                  <span className={['shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase h-fit', LOG_LEVEL_BG[String(level)] ?? LOG_LEVEL_BG.debug].join(' ')}>
                    {String(level ?? 'dbg')}
                  </span>
                  {component != null && (
                    <span className="text-[var(--text-muted)] shrink-0">[{String(component)}]</span>
                  )}
                  <span className={['flex-1 break-all', LOG_LEVEL_COLORS[String(level)] ?? ''].join(' ')}>
                    {String(msg ?? '')}
                    {restKeys.length > 0 && (
                      <span className="text-[var(--text-muted)] ml-2">
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
  const [data, setData] = useState<{ sessions: UsageDayStats[]; totals: { inputTokens: number; outputTokens: number; costUsd: number; calls: number } } | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getUsageStats()
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [])

  const fmt = (n: number) => n.toLocaleString('zh-CN')
  const fmtCost = (n: number) => n < 0.0001 ? '< $0.0001' : `$${n.toFixed(4)}`

  return (
    <div className="space-y-6">
      {/* 总计卡片 */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          { label: '总调用次数', value: loading ? '—' : fmt(data?.totals.calls ?? 0), sub: 'API 调用' },
          { label: '输入 Tokens', value: loading ? '—' : fmt(data?.totals.inputTokens ?? 0), sub: '累计' },
          { label: '输出 Tokens', value: loading ? '—' : fmt(data?.totals.outputTokens ?? 0), sub: '累计' },
          { label: '估算费用', value: loading ? '—' : fmtCost(data?.totals.costUsd ?? 0), sub: 'USD' },
        ].map(card => (
          <div key={card.label} className="bg-[var(--bg-secondary)] rounded-xl border border-[var(--border)] p-4">
            <p className="text-xs text-[var(--text-muted)] mb-1">{card.label}</p>
            <p className="text-xl font-semibold text-[var(--text-primary)]">{card.value}</p>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">{card.sub}</p>
          </div>
        ))}
      </div>

      {/* 按日期明细 */}
      <div className="bg-[var(--bg-secondary)] rounded-xl border border-[var(--border)] overflow-hidden">
        <div className="px-5 py-3 border-b border-[var(--border)]">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">按日期明细</h2>
        </div>
        {loading ? (
          <div className="h-40 flex items-center justify-center text-[var(--text-muted)] text-sm">加载中...</div>
        ) : !data || data.sessions.length === 0 ? (
          <div className="h-40 flex items-center justify-center text-[var(--text-muted)] text-sm">暂无用量数据</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)]">
                  {['日期', '调用次数', '输入 Tokens', '输出 Tokens', '估算费用'].map(h => (
                    <th key={h} className="px-5 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.sessions.map(row => (
                  <tr key={row.date} className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--bg-tertiary)] transition-colors">
                    <td className="px-5 py-3 text-[var(--text-primary)] font-mono">{row.date}</td>
                    <td className="px-5 py-3 text-[var(--text-secondary)]">{fmt(row.calls)}</td>
                    <td className="px-5 py-3 text-[var(--text-secondary)]">{fmt(row.inputTokens)}</td>
                    <td className="px-5 py-3 text-[var(--text-secondary)]">{fmt(row.outputTokens)}</td>
                    <td className="px-5 py-3 text-[var(--text-secondary)]">{fmtCost(row.costUsd)}</td>
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

  const sectionTitles: Record<SettingsSection, { title: string; desc: string }> = {
    general: { title: '通用设置', desc: '主题与语言偏好' },
    config: { title: '配置', desc: 'config.json 编辑器' },
    logs: { title: '日志', desc: '控制台日志查看' },
    usage: { title: '用量', desc: '模型调用与 Token 统计' },
  }

  const current = sectionTitles[activeSection]

  return (
    <div className="flex-1 flex overflow-hidden bg-[var(--bg-primary)]">
      {/* 左侧导航 */}
      <aside className="w-52 shrink-0 flex flex-col border-r border-[var(--border)] bg-[var(--bg-secondary)]">
        {/* 标题 */}
        <div className="px-5 py-4 border-b border-[var(--border)]">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-[var(--accent-subtle)] flex items-center justify-center shrink-0">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </div>
            <span className="text-sm font-semibold text-[var(--text-primary)]">系统设置</span>
          </div>
        </div>

        {/* 导航列表 */}
        <nav className="flex-1 p-2 space-y-0.5">
          {NAV_ITEMS.map(item => (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveSection(item.id)}
              className={[
                'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all duration-150 cursor-pointer border-0 text-left',
                activeSection === item.id
                  ? 'bg-[var(--accent-subtle)] text-[var(--accent)] font-medium'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]',
              ].join(' ')}
            >
              <span className="shrink-0">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>
      </aside>

      {/* 右侧内容 */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* 顶部标题栏 */}
        <div className="px-6 py-4 border-b border-[var(--border)] bg-[var(--bg-secondary)] shrink-0">
          <h1 className="text-base font-semibold text-[var(--text-primary)]">{current.title}</h1>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">{current.desc}</p>
        </div>

        {/* 内容区域 */}
        <div className="flex-1 overflow-y-auto p-6">
          <div className="max-w-3xl">
            {activeSection === 'general' && <GeneralPanel />}
            {activeSection === 'config' && <ConfigPanel />}
            {activeSection === 'logs' && <LogsPanel />}
            {activeSection === 'usage' && <UsagePanel />}
          </div>
        </div>
      </div>
    </div>
  )
}
