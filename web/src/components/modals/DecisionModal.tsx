import { useState, useCallback } from 'react'
import type { DecisionRequest } from '../../lib/types.js'

// ─── Props ─────────────────────────────────────────────────────────────────

interface DecisionModalProps {
  sessionId: string
  decision: DecisionRequest
  onReply: (answer: string) => void
}

// ─── 风险等级标签 ──────────────────────────────────────────────────────────

const RISK_LABELS: Record<string, { label: string; className: string }> = {
  low: { label: '低风险', className: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20' },
  medium: { label: '中风险', className: 'text-amber-400 bg-amber-400/10 border-amber-400/20' },
  high: { label: '高风险', className: 'text-red-400 bg-red-400/10 border-red-400/20' },
}

// ─── 组件 ──────────────────────────────────────────────────────────────────

export function DecisionModal({ sessionId: _sessionId, decision, onReply }: DecisionModalProps) {
  const [selected, setSelected] = useState<number | null>(null)
  const [customText, setCustomText] = useState('')
  const [replied, setReplied] = useState(false)

  const handleSelectOption = useCallback((idx: number) => {
    if (replied) return
    setSelected(idx)
    setCustomText('')
  }, [replied])

  const handleSubmit = useCallback(() => {
    if (replied) return
    let answer: string
    if (customText.trim()) {
      answer = customText.trim()
    } else if (selected !== null) {
      answer = String(selected + 1)
    } else {
      return
    }
    setReplied(true)
    onReply(answer)
  }, [replied, customText, selected, onReply])

  const canSubmit = !replied && (selected !== null || customText.trim().length > 0)

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center animate-fade-in"
      onClick={(e) => e.stopPropagation()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={decision.title || '决策请求'}
        className="bg-[var(--bg-secondary)] w-full max-w-lg rounded-2xl shadow-[var(--shadow-lg)] border border-[var(--border)] mx-4 flex flex-col"
        style={{ maxHeight: 'min(680px, calc(100vh - 48px))' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── 固定顶部：标题行 ── */}
        <div className="flex items-center gap-3 px-6 pt-6 pb-4 shrink-0 border-b border-[var(--border-subtle)]">
          <div className="w-9 h-9 rounded-xl bg-amber-400/10 border border-amber-400/20 flex items-center justify-center shrink-0">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-amber-400">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-[var(--text-primary)] tracking-tight truncate">
              {decision.title}
            </h2>
            <p className="text-xs text-[var(--text-secondary)] mt-0.5">需要您做出决策才能继续执行</p>
          </div>
        </div>

        {/* ── 可滚动内容区 ── */}
        <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0 flex flex-col gap-4">
          {/* 元信息 */}
          {(decision.impact || decision.deadline) && (
            <div className="flex flex-wrap gap-2">
              {decision.impact && (
                <span className="inline-flex items-center gap-1 text-[11px] text-[var(--text-secondary)] bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] px-2 py-0.5 rounded-full">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  影响：{decision.impact}
                </span>
              )}
              {decision.deadline && (
                <span className="inline-flex items-center gap-1 text-[11px] text-amber-400 bg-amber-400/10 border border-amber-400/20 px-2 py-0.5 rounded-full">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
                  </svg>
                  {decision.deadline}
                </span>
              )}
            </div>
          )}

          {/* 背景说明 */}
          <div className="p-3.5 bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] rounded-xl">
            <p className="text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-1.5">背景</p>
            <p className="text-sm text-[var(--text-primary)] leading-relaxed whitespace-pre-wrap break-words">
              {decision.context}
            </p>
          </div>

          {/* 可选方案 */}
          <div>
            <p className="text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-2">可选方案</p>
            <div className="flex flex-col gap-2">
              {decision.options.map((option, idx) => {
                const riskInfo = option.risk ? RISK_LABELS[option.risk] : null
                const isSelected = selected === idx
                return (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => handleSelectOption(idx)}
                    disabled={replied}
                    className={[
                      'flex items-start gap-3 w-full px-4 py-3 rounded-xl border text-left transition-all duration-150 cursor-pointer disabled:cursor-not-allowed',
                      isSelected
                        ? 'bg-[var(--accent-subtle)] border-[var(--accent-border)] text-[var(--accent)]'
                        : 'bg-[var(--bg-primary)] border-[var(--border)] hover:border-[var(--accent-border)] hover:bg-[var(--accent-subtle)]',
                    ].join(' ')}
                  >
                    {/* 序号 */}
                    <span className={[
                      'w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0 mt-0.5 border',
                      isSelected
                        ? 'bg-[var(--accent)] border-[var(--accent)] text-white'
                        : 'bg-[var(--bg-tertiary)] border-[var(--border)] text-[var(--text-muted)]',
                    ].join(' ')}>
                      {idx + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-[var(--text-primary)]">{option.label}</span>
                        {riskInfo && (
                          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${riskInfo.className}`}>
                            {riskInfo.label}
                          </span>
                        )}
                        {decision.recommendation === option.label && (
                          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded border text-emerald-400 bg-emerald-400/10 border-emerald-400/20">
                            推荐
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-[var(--text-secondary)] mt-1 leading-relaxed">
                        {option.description}
                      </p>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>

          {/* 自定义指示 */}
          <div>
            <p className="text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-2">
              或输入自定义指示
            </p>
            <textarea
              value={customText}
              onChange={(e) => { setCustomText(e.target.value); setSelected(null) }}
              disabled={replied}
              rows={2}
              placeholder="直接输入您的指示..."
              className="w-full bg-[var(--bg-primary)] border border-[var(--border)] focus:border-[var(--accent-border)] rounded-xl px-3.5 py-2.5 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] resize-none focus:outline-none transition-colors leading-relaxed disabled:opacity-40"
            />
          </div>
        </div>

        {/* ── 固定底部：按钮行 ── */}
        <div className="px-6 pb-6 pt-4 shrink-0 border-t border-[var(--border-subtle)]">
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="px-4 py-2 rounded-xl text-sm font-semibold bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-sm"
            >
              {replied ? '已提交' : '确认决策'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
