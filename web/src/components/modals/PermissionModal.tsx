import { useEffect, useRef, useState } from 'react'
import type { PermissionRequest } from '../../lib/types.js'

// ─── 常量 ──────────────────────────────────────────────────────────────────

const TIMEOUT_SECONDS = 300 // 5 分钟

// ─── Props ─────────────────────────────────────────────────────────────────

interface PermissionModalProps {
  sessionId: string
  permission: PermissionRequest
  onReply: (granted: boolean, options?: { permanent?: boolean; session?: boolean; ruleContent?: string }) => void
}

// ─── 组件 ──────────────────────────────────────────────────────────────────

export function PermissionModal({ sessionId: _sessionId, permission, onReply }: PermissionModalProps) {
  const calcRemaining = () => {
    const elapsed = Math.floor((Date.now() - permission.requestedAt) / 1000)
    return Math.max(0, TIMEOUT_SECONDS - elapsed)
  }

  const [remainingSeconds, setRemainingSeconds] = useState<number>(calcRemaining)
  const [timedOut, setTimedOut] = useState<boolean>(false)
  const [approvalScope, setApprovalScope] = useState<'once' | 'session' | 'permanent'>('once')
  const repliedRef = useRef<boolean>(false)

  useEffect(() => {
    if (calcRemaining() <= 0) {
      if (!repliedRef.current) {
        repliedRef.current = true
        setTimedOut(true)
        onReply(false)
      }
      return
    }

    const timer = setInterval(() => {
      const remaining = calcRemaining()
      setRemainingSeconds(remaining)

      if (remaining <= 0 && !repliedRef.current) {
        repliedRef.current = true
        setTimedOut(true)
        onReply(false)
        clearInterval(timer)
      }
    }, 1000)

    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permission.requestedAt])

  const handleReply = (granted: boolean) => {
    if (repliedRef.current) return
    repliedRef.current = true
    // 传递批准范围和规则内容
    onReply(granted, {
      permanent: approvalScope === 'permanent',
      session: approvalScope === 'session',
      ruleContent: permission.ruleContent,
    })
  }

  const progressPercent = (remainingSeconds / TIMEOUT_SECONDS) * 100

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center animate-fade-in">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="权限请求"
        className="bg-[var(--bg-secondary)] w-full max-w-md rounded-2xl shadow-[var(--shadow-lg)] border border-[var(--border)] mx-4 flex flex-col"
        style={{ maxHeight: 'min(620px, calc(100vh - 48px))' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── 固定顶部：标题行 ── */}
        <div className="flex items-center gap-3 px-6 pt-6 pb-5 shrink-0">
          <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${permission.isDestructive ? 'bg-[var(--error-subtle)] border border-[var(--error)]/20' : 'bg-[var(--warning-subtle)] border border-[var(--warning)]/20'}`}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={permission.isDestructive ? 'text-[var(--error)]' : 'text-[var(--warning)]'}>
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>
          <div>
            <h2 className="text-sm font-semibold text-[var(--text-primary)] tracking-tight">
              {permission.isDestructive ? '危险操作请求' : '权限请求'}
            </h2>
            <p className="text-xs text-[var(--text-secondary)] mt-0.5">Agent 请求执行以下操作</p>
          </div>
        </div>

        {/* ── 可滚动内容区 ── */}
        <div className="flex-1 overflow-y-auto px-6 min-h-0">
          {/* 工具名称 */}
          <div className="mb-4 p-3 bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] rounded-xl">
            <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider block mb-1">工具</span>
            <p className="text-base font-bold font-mono text-[var(--accent)]">
              {permission.toolName}
            </p>
          </div>

          {/* 操作描述 */}
          <div className="mb-4">
            <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider block mb-1.5">操作描述</span>
            <p className="text-[var(--text-primary)] text-sm leading-relaxed whitespace-pre-wrap break-words bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] rounded-xl px-3.5 py-2.5">
              {permission.description}
            </p>
          </div>

          {/* 规则内容（如 bash 命令） */}
          {permission.ruleContent && (
            <div className="mb-4">
              <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider block mb-1.5">具体内容</span>
              <p className="text-[var(--text-primary)] text-sm font-mono leading-relaxed whitespace-pre-wrap break-words bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] rounded-xl px-3.5 py-2.5">
                {permission.ruleContent}
              </p>
            </div>
          )}

          {/* 破坏性操作警告 */}
          {permission.isDestructive && (
            <div className="mb-4 p-3 bg-[var(--error-subtle)] border border-[var(--error)]/20 rounded-xl">
              <div className="flex items-start gap-2">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--error)] shrink-0 mt-0.5">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <p className="text-xs text-[var(--error)] leading-relaxed">
                  此操作具有破坏性，可能导致数据丢失或不可逆更改，请谨慎确认。
                </p>
              </div>
            </div>
          )}

          {/* 只读/写操作标签 */}
          <div className="mb-4">
            {permission.readonly ? (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-[var(--success-subtle)] text-[var(--success)] border border-[var(--success)]/20">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
                </svg>
                只读操作
              </span>
            ) : (
              <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border ${permission.isDestructive ? 'bg-[var(--error-subtle)] text-[var(--error)] border-[var(--error)]/20' : 'bg-[var(--warning-subtle)] text-[var(--warning)] border-[var(--warning)]/20'}`}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                </svg>
                {permission.isDestructive ? '破坏性操作' : '写操作'}
              </span>
            )}
          </div>

          {/* 批准范围选择（仅写操作显示） */}
          {!permission.readonly && (
            <div className="mb-4">
              <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider block mb-2">批准范围</span>
              <div className="flex flex-col gap-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="approvalScope"
                    value="once"
                    checked={approvalScope === 'once'}
                    onChange={() => setApprovalScope('once')}
                    className="w-3.5 h-3.5 accent-[var(--accent)]"
                  />
                  <span className="text-xs text-[var(--text-secondary)]">仅本次</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="approvalScope"
                    value="session"
                    checked={approvalScope === 'session'}
                    onChange={() => setApprovalScope('session')}
                    className="w-3.5 h-3.5 accent-[var(--accent)]"
                  />
                  <span className="text-xs text-[var(--text-secondary)]">
                    本次会话{permission.ruleContent ? `内所有 "${permission.toolName}" 的相同操作` : `内所有 "${permission.toolName}" 操作`}
                  </span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="approvalScope"
                    value="permanent"
                    checked={approvalScope === 'permanent'}
                    onChange={() => setApprovalScope('permanent')}
                    className="w-3.5 h-3.5 accent-[var(--accent)]"
                  />
                  <span className="text-xs text-[var(--text-secondary)]">
                    永久允许{permission.ruleContent ? `此操作` : `此工具`}
                  </span>
                </label>
              </div>
            </div>
          )}
        </div>

        {/* ── 固定底部：进度条 + 按钮 ── */}
        <div className="px-6 pb-6 pt-4 shrink-0 border-t border-[var(--border-subtle)]">
          {/* 倒计时进度条 */}
          <div className="mb-1">
            <div className="w-full h-1 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
              <div
                className="h-full bg-[var(--accent)] rounded-full transition-all duration-1000 ease-linear"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>

          {/* 倒计时文字 */}
          <div className="mb-4 text-right">
            {timedOut ? (
              <span className="text-[11px] text-[var(--error)]">已超时，自动拒绝</span>
            ) : (
              <span className="text-[11px] text-[var(--text-muted)]">
                {remainingSeconds} 秒后自动拒绝
              </span>
            )}
          </div>

          {/* 按钮行 */}
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => handleReply(false)}
              disabled={timedOut}
              className="px-4 py-2 rounded-xl text-sm font-medium bg-[var(--bg-tertiary)] border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-focus)] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              拒绝
            </button>
            <button
              onClick={() => handleReply(true)}
              disabled={timedOut}
              className={`px-4 py-2 rounded-xl text-sm font-semibold text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-sm ${permission.isDestructive ? 'bg-[var(--error)] hover:bg-[var(--error-hover)]' : 'bg-[var(--accent)] hover:bg-[var(--accent-hover)]'}`}
            >
              {approvalScope === 'permanent' ? '永久允许' : approvalScope === 'session' ? '会话允许' : '允许执行'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
