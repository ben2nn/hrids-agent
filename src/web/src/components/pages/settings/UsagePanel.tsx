import { useState, useEffect } from 'react'
import { getUsageStats } from '../../../lib/gateway.js'
import type { UsageDayStats } from '../../../lib/gateway.js'

export function UsagePanel() {
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
  const fmtCost = (n: number) => n < 0.0001 ? '< $0.0001' : `${n.toFixed(4)}`

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
