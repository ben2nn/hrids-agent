import type { Todo } from '../../lib/types.js'

// ─── Props 接口 ────────────────────────────────────────────────────────────

interface TodoItemProps {
  todo: Todo
}

// ─── 状态图标 ──────────────────────────────────────────────────────────────

function StatusIcon({ status }: { status: Todo['status'] }) {
  if (status === 'completed') {
    return (
      <span
        className="w-4 h-4 rounded-full bg-emerald-400/15 border border-emerald-400/40 flex items-center justify-center shrink-0"
        aria-label="已完成"
      >
        <svg width="8" height="8" viewBox="0 0 12 12" fill="none">
          <path d="M2 6l3 3 5-5" stroke="#34d399" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    )
  }
  if (status === 'in_progress') {
    return (
      <span
        className="w-4 h-4 rounded-full border border-[var(--accent)]/50 bg-[var(--accent-subtle)] flex items-center justify-center shrink-0"
        aria-label="进行中"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse inline-block" />
      </span>
    )
  }
  return (
    <span
      className="w-4 h-4 rounded-full border border-[var(--border)] flex items-center justify-center shrink-0"
      aria-label="待处理"
    />
  )
}

// ─── TodoItem 组件 ─────────────────────────────────────────────────────────

export function TodoItem({ todo }: TodoItemProps) {
  const isCompleted = todo.status === 'completed'

  return (
    <div className="flex items-start gap-2.5 px-3 py-2 hover:bg-[var(--bg-tertiary)] rounded-lg transition-all duration-100 group">
      {/* 状态图标 */}
      <div className="mt-0.5">
        <StatusIcon status={todo.status} />
      </div>

      {/* 任务内容 */}
      <div className="flex-1 min-w-0">
        <span
          className={`text-xs leading-relaxed break-words ${
            isCompleted
              ? 'line-through text-[var(--text-muted)]'
              : 'text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] transition-colors'
          }`}
        >
          {todo.content}
        </span>

        {/* 优先级标签 */}
        {todo.priority !== 'low' && (
          <div className="mt-1">
            {todo.priority === 'high' ? (
              <span className="text-[10px] text-[var(--error)] bg-[var(--error-subtle)] border border-[var(--error)]/15 px-1.5 py-0.5 rounded-md font-medium">
                高优先级
              </span>
            ) : (
              <span className="text-[10px] text-[var(--warning)] bg-[var(--warning-subtle)] border border-[var(--warning)]/15 px-1.5 py-0.5 rounded-md font-medium">
                中优先级
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default TodoItem
