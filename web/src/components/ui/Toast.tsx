import { useEffect } from 'react'

// ─── Props 接口 ────────────────────────────────────────────────────────────

export interface ToastProps {
  message: string
  type?: 'error' | 'warning' | 'info'
  action?: { label: string; onClick: () => void }
  onDismiss?: () => void
}

// ─── Toast 组件 ────────────────────────────────────────────────────────────

export function Toast({ message, type = 'info', action, onDismiss }: ToastProps) {
  useEffect(() => {
    if (!onDismiss) return
    const timer = setTimeout(onDismiss, 5000)
    return () => clearTimeout(timer)
  }, [onDismiss])

  const styles = {
    error: {
      bg: 'bg-[var(--bg-elevated)] border-[var(--error)]/30',
      icon: 'text-[var(--error)]',
      text: 'text-[var(--text-primary)]',
      iconSvg: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      ),
    },
    warning: {
      bg: 'bg-[var(--bg-elevated)] border-[var(--warning)]/30',
      icon: 'text-[var(--warning)]',
      text: 'text-[var(--text-primary)]',
      iconSvg: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      ),
    },
    info: {
      bg: 'bg-[var(--bg-elevated)] border-[var(--accent)]/30',
      icon: 'text-[var(--accent)]',
      text: 'text-[var(--text-primary)]',
      iconSvg: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
      ),
    },
  }

  const s = styles[type]

  return (
    <div
      className={`fixed bottom-4 right-4 z-50 flex items-center gap-3 px-4 py-3 rounded-xl border shadow-[var(--shadow-lg)] text-sm max-w-sm animate-fade-in ${s.bg}`}
      role="alert"
    >
      {/* 图标 */}
      <span className={`shrink-0 ${s.icon}`}>{s.iconSvg}</span>

      {/* 消息文字 */}
      <span className={`flex-1 ${s.text}`}>{message}</span>

      {/* 操作按钮 */}
      {action && (
        <button
          onClick={action.onClick}
          className="shrink-0 text-[var(--accent)] hover:text-[var(--accent-hover)] font-semibold text-xs transition-colors"
        >
          {action.label}
        </button>
      )}

      {/* 关闭按钮 */}
      {onDismiss && (
        <button
          onClick={onDismiss}
          className="shrink-0 text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
          aria-label="关闭"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      )}
    </div>
  )
}
