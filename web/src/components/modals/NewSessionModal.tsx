import React, { useEffect, useRef, useState } from 'react'
import { useSessionStore } from '../../store/sessionStore.js'

// ─── Props 接口 ────────────────────────────────────────────────────────────

interface NewSessionModalProps {
  onClose: () => void
  onCreated?: () => void
}

// ─── 权限模式配置 ──────────────────────────────────────────────────────────

type PermissionMode = 'ask' | 'plan' | 'auto'

const PERMISSION_MODES: Array<{
  value: PermissionMode
  label: string
  desc: string
  icon: string
  color: string
}> = [
  {
    value: 'ask',
    label: 'Ask',
    desc: '每次写操作都询问确认',
    icon: '❓',
    color: 'border-blue-500/40 bg-blue-500/10 text-blue-400',
  },
  {
    value: 'plan',
    label: 'Plan',
    desc: '只读模式，写操作需确认',
    icon: '📋',
    color: 'border-purple-500/40 bg-purple-500/10 text-purple-400',
  },
  {
    value: 'auto',
    label: 'Auto',
    desc: '自动允许所有操作',
    icon: '⚡',
    color: 'border-amber-500/40 bg-amber-500/10 text-amber-400',
  },
]

// ─── NewSessionModal 组件 ──────────────────────────────────────────────────

export function NewSessionModal({ onClose, onCreated }: NewSessionModalProps) {
  const [model, setModel] = useState('')
  const [cwd, setCwd] = useState('')
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('ask')
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const createSession = useSessionStore((s) => s.createSession)

  const overlayRef = useRef<HTMLDivElement>(null)

  // ESC 键关闭
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !isCreating) {
        onClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose, isCreating])

  // 点击遮罩关闭
  function handleOverlayClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === overlayRef.current && !isCreating) {
      onClose()
    }
  }

  async function handleCreate() {
    if (isCreating) return
    setIsCreating(true)
    setError(null)

    try {
      await createSession({
        model: model.trim() || undefined,
        cwd: cwd.trim() || undefined,
        permissionMode,
      })
      onCreated?.()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建会话失败，请重试')
    } finally {
      setIsCreating(false)
    }
  }

  async function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey && !isCreating) {
      e.preventDefault()
      await handleCreate()
    }
  }

  return (
    /* 模态遮罩 */
    <div
      ref={overlayRef}
      className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center animate-fade-in"
      onClick={handleOverlayClick}
    >
      {/* 居中卡片 */}
      <div
        className="bg-[var(--bg-secondary)] w-full max-w-sm rounded-2xl p-6 shadow-[var(--shadow-lg)] border border-[var(--border)] mx-4"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-session-modal-title"
      >
        {/* 标题 */}
        <h2
          id="new-session-modal-title"
          className="text-sm font-semibold text-[var(--text-primary)] mb-5 tracking-tight"
        >
          新对话
        </h2>

        {/* 表单 */}
        <div className="flex flex-col gap-4" onKeyDown={handleKeyDown}>
          {/* 模型输入框 */}
          <div className="flex flex-col gap-1.5">
            <label
              className="text-[11px] font-semibold text-[var(--text-secondary)] uppercase tracking-wide"
              htmlFor="new-session-model"
            >
              模型
            </label>
            <input
              id="new-session-model"
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={isCreating}
              placeholder="默认模型"
              className="w-full px-3.5 py-2.5 rounded-xl text-sm bg-[var(--bg-tertiary)] border border-[var(--border)] text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--accent-subtle)] disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            />
          </div>

          {/* 工作目录输入框 */}
          <div className="flex flex-col gap-1.5">
            <label
              className="text-[11px] font-semibold text-[var(--text-secondary)] uppercase tracking-wide"
              htmlFor="new-session-cwd"
            >
              工作目录
            </label>
            <input
              id="new-session-cwd"
              type="text"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              disabled={isCreating}
              placeholder="默认工作目录"
              className="w-full px-3.5 py-2.5 rounded-xl text-sm bg-[var(--bg-tertiary)] border border-[var(--border)] text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--accent-subtle)] disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            />
          </div>

          {/* Craft 权限模式选择器 */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-semibold text-[var(--text-secondary)] uppercase tracking-wide">
              Craft 权限模式
            </label>
            <div className="grid grid-cols-2 gap-1.5">
              {PERMISSION_MODES.map((mode) => (
                <button
                  key={mode.value}
                  type="button"
                  disabled={isCreating}
                  onClick={() => setPermissionMode(mode.value)}
                  className={[
                    'flex items-center gap-2 px-3 py-2.5 rounded-xl border text-left transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed',
                    permissionMode === mode.value
                      ? mode.color + ' border-opacity-100'
                      : 'border-[var(--border)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:border-[var(--border-focus)] hover:text-[var(--text-primary)]',
                  ].join(' ')}
                >
                  <span className="text-base leading-none shrink-0">{mode.icon}</span>
                  <div className="min-w-0">
                    <div className="text-xs font-semibold leading-tight">{mode.label}</div>
                    <div className="text-[10px] opacity-70 leading-tight mt-0.5 truncate">{mode.desc}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* 错误提示 */}
          {error && (
            <div className="flex items-center gap-2 bg-[var(--error-subtle)] border border-[var(--error)]/20 rounded-xl px-3.5 py-2.5 animate-fade-in">
              <svg className="text-[var(--error)] shrink-0" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <p className="text-sm text-[var(--error)]">{error}</p>
            </div>
          )}
        </div>

        {/* 按钮行 */}
        <div className="flex gap-2 justify-end mt-6">
          <button
            type="button"
            onClick={onClose}
            disabled={isCreating}
            className="px-4 py-2 rounded-xl text-sm font-medium bg-[var(--bg-tertiary)] border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-focus)] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            取消
          </button>

          <button
            type="button"
            onClick={handleCreate}
            disabled={isCreating}
            className="px-4 py-2 rounded-xl text-sm font-semibold bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white transition-all disabled:opacity-60 disabled:cursor-not-allowed shadow-sm"
          >
            {isCreating ? (
              <span className="flex items-center gap-2">
                <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
                创建中...
              </span>
            ) : '创建'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default NewSessionModal
