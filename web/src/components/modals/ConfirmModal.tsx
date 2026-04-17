import React, { useEffect, useRef } from 'react'

// ─── Props 接口 ────────────────────────────────────────────────────────────

interface ConfirmModalProps {
  title: string
  message: string
  confirmText?: string  // 默认"确认"
  cancelText?: string   // 默认"取消"
  onConfirm: () => void
  onCancel: () => void
  danger?: boolean      // true 时确认按钮为红色
}

// ─── ConfirmModal 组件 ─────────────────────────────────────────────────────

export function ConfirmModal({
  title,
  message,
  confirmText = '确认',
  cancelText = '取消',
  onConfirm,
  onCancel,
  danger = false,
}: ConfirmModalProps) {
  // 点击遮罩关闭
  const overlayRef = useRef<HTMLDivElement>(null)

  // ESC 键关闭
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onCancel()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onCancel])

  function handleOverlayClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === overlayRef.current) {
      onCancel()
    }
  }

  return (
    /* 模态遮罩 */
    <div
      ref={overlayRef}
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
      onClick={handleOverlayClick}
    >
      {/* 居中卡片 */}
      <div
        className="bg-[var(--bg-secondary)] w-full max-w-sm rounded-xl p-6 shadow-2xl border border-[var(--border)] mx-4"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
      >
        {/* 标题 */}
        <h2
          id="confirm-modal-title"
          className="text-base font-medium text-[var(--text-primary)] mb-2"
        >
          {title}
        </h2>

        {/* 消息文字 */}
        <p className="text-sm text-[var(--text-secondary)] leading-relaxed mb-6">
          {message}
        </p>

        {/* 按钮行 */}
        <div className="flex gap-3 justify-end">
          {/* 取消按钮（灰色） */}
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-[var(--bg-tertiary)] text-[var(--text-primary)] hover:bg-[var(--border)] transition-colors"
          >
            {cancelText}
          </button>

          {/* 确认按钮（danger=true 时红色，否则蓝色） */}
          <button
            type="button"
            onClick={onConfirm}
            className={`px-4 py-2 rounded-lg text-sm font-medium text-white transition-colors ${
              danger
                ? 'bg-red-600 hover:bg-red-700'
                : 'bg-blue-600 hover:bg-blue-700'
            }`}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}

export default ConfirmModal
