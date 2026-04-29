import { useRef, useState, useCallback, useEffect } from 'react'
import type { AskUserState } from '../../store/messageStore.js'

// ─── Props ─────────────────────────────────────────────────────────────────

interface AskUserModalProps {
  sessionId: string
  askUserState: AskUserState
  onReply: (answer: string) => void
}

// ─── 组件 ──────────────────────────────────────────────────────────────────

export function AskUserModal({ sessionId: _sessionId, askUserState, onReply }: AskUserModalProps) {
  const [inputText, setInputText] = useState('')
  const repliedRef = useRef<boolean>(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // 弹出时自动聚焦输入框
  useEffect(() => {
    const timer = setTimeout(() => {
      textareaRef.current?.focus()
    }, 50)
    return () => clearTimeout(timer)
  }, [])

  const handleReply = useCallback((answer: string) => {
    const trimmed = answer.trim()
    if (!trimmed || repliedRef.current) return
    repliedRef.current = true
    onReply(trimmed)
  }, [onReply])

  const handleOptionClick = useCallback((option: string) => {
    if (repliedRef.current) return
    repliedRef.current = true
    onReply(option)
  }, [onReply])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleReply(inputText)
    }
  }, [inputText, handleReply])

  const canSubmit = inputText.trim().length > 0

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center animate-fade-in"
      onClick={(e) => {
        // 点击遮罩不关闭（必须回答）
        e.stopPropagation()
      }}
    >
      <div
        className="bg-[var(--bg-secondary)] w-full max-w-md rounded-2xl shadow-[var(--shadow-lg)] border border-[var(--border)] mx-4 flex flex-col"
        style={{ maxHeight: 'min(560px, calc(100vh - 48px))' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── 固定顶部：标题行 ── */}
        <div className="flex items-center gap-3 px-6 pt-6 pb-5 shrink-0">
          <div className="w-9 h-9 rounded-xl bg-[var(--info-subtle)] border border-[var(--info)]/20 flex items-center justify-center shrink-0">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--info)]">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
          <div>
            <h2 className="text-sm font-semibold text-[var(--text-primary)] tracking-tight">
              Agent 提问
            </h2>
            <p className="text-xs text-[var(--text-secondary)] mt-0.5">请回答以下问题以继续执行</p>
          </div>
        </div>

        {/* ── 可滚动内容区 ── */}
        <div className="flex-1 overflow-y-auto px-6 min-h-0">
          {/* 问题内容 */}
          <div className="mb-4 p-3.5 bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] rounded-xl">
            <p className="text-sm text-[var(--text-primary)] leading-relaxed whitespace-pre-wrap break-words">
              {askUserState.question}
            </p>
          </div>

          {/* 快捷选项按钮 */}
          {Array.isArray(askUserState.options) && askUserState.options.length > 0 && (
            <div className="mb-4">
              <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider block mb-2">
                快捷选项
              </span>
              <div className="flex flex-wrap gap-2">
                {askUserState.options.map((option, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => handleOptionClick(option)}
                    className="px-3 py-1.5 bg-[var(--bg-primary)] hover:bg-[var(--accent-subtle)] border border-[var(--border)] hover:border-[var(--accent-border)] text-[var(--text-primary)] hover:text-[var(--accent)] rounded-lg text-xs font-medium transition-all"
                  >
                    {option}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 自由输入框 */}
          <div className="mb-4">
            <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider block mb-2">
              自定义回答
            </span>
            <textarea
              ref={textareaRef}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={3}
              placeholder="输入你的回答... (Enter 提交，Shift+Enter 换行)"
              className="w-full bg-[var(--bg-primary)] border border-[var(--border)] focus:border-[var(--accent-border)] rounded-xl px-3.5 py-2.5 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] resize-none focus:outline-none transition-colors leading-relaxed"
            />
          </div>
        </div>

        {/* ── 固定底部：按钮行 ── */}
        <div className="px-6 pb-6 pt-4 shrink-0 border-t border-[var(--border-subtle)]">
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={() => handleReply(inputText)}
              disabled={!canSubmit}
              className="px-4 py-2 rounded-xl text-sm font-semibold bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-sm"
            >
              提交回答
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
