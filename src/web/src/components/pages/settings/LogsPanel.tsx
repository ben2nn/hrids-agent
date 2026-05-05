import { useState, useEffect, useCallback } from 'react'
import { getLogs } from '../../../lib/gateway.js'
import type { LogEntry } from '../../../lib/gateway.js'

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

export function LogsPanel() {
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
