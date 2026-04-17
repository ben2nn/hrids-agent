import { useEffect, useRef } from 'react'
import { useTodoStore } from '../../store/todoStore.js'
import { TodoItem } from './TodoItem.js'
import type { Todo } from '../../lib/types.js'

// ─── 稳定的空数组默认值 ────────────────────────────────────────────────────

const EMPTY_TODOS: Todo[] = []

// ─── Props 接口 ────────────────────────────────────────────────────────────

interface TodoArtifactsProps {
  sessionId: string
}

// ─── 骨架屏占位块 ──────────────────────────────────────────────────────────

function SkeletonRow() {
  return (
    <div className="flex items-center gap-2.5 px-3 py-2">
      <div className="w-4 h-4 rounded-full skeleton shrink-0" />
      <div className="flex-1 h-3 skeleton rounded-md" />
    </div>
  )
}

// ─── TodoArtifacts 组件 ────────────────────────────────────────────────────

export function TodoArtifacts({ sessionId }: TodoArtifactsProps) {
  // 用模块级常量作为默认值，避免每次渲染产生新数组引用
  const todos = useTodoStore((s) => s.todos.get(sessionId) ?? EMPTY_TODOS)
  const isLoading = useTodoStore((s) => s.loading.get(sessionId) ?? false)

  // 用 ref 固定 fetchTodos 引用，避免放入 useEffect 依赖导致无限触发
  const fetchTodosRef = useRef(useTodoStore.getState().fetchTodos)

  useEffect(() => {
    fetchTodosRef.current(sessionId)
  }, [sessionId])

  // ── 统计数据 ───────────────────────────────────────────────────────────
  const total = todos.length
  const completedCount = todos.filter((t) => t.status === 'completed').length
  const inProgressCount = todos.filter((t) => t.status === 'in_progress').length
  const pendingCount = todos.filter((t) => t.status === 'pending').length
  const progress = total > 0 ? Math.round((completedCount / total) * 100) : 0

  // ── 渲染 ───────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full">
      {/* 顶部统计（有数据时显示） */}
      {!isLoading && total > 0 && (
        <div className="px-3 pt-3 pb-2.5 shrink-0 bg-[var(--bg-secondary)] border-b border-[var(--border-subtle)]">
          {/* 进度数字行 */}
          <div className="flex items-baseline justify-between mb-2">
            <span className="text-[11px] text-[var(--text-muted)]">
              <span className="text-[15px] font-semibold text-[var(--text-primary)] tabular-nums">{completedCount}</span>
              <span className="mx-1">/</span>
              <span className="font-medium text-[var(--text-secondary)]">{total}</span>
              <span className="ml-1">已完成</span>
            </span>
            <span
              className={`text-[11px] font-semibold tabular-nums px-1.5 py-0.5 rounded-md ${
                progress === 100
                  ? 'text-emerald-400 bg-emerald-400/10'
                  : 'text-[var(--text-secondary)] bg-[var(--bg-tertiary)]'
              }`}
            >
              {progress}%
            </span>
          </div>

          {/* 进度条 */}
          <div className="h-1.5 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-700"
              style={{
                width: `${progress}%`,
                background: progress === 100
                  ? 'linear-gradient(90deg, #34d399, #10b981)'
                  : 'linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent) 70%, #34d399))',
              }}
            />
          </div>

          {/* 状态标签行 */}
          {(inProgressCount > 0 || pendingCount > 0) && (
            <div className="flex items-center gap-2 mt-2">
              {inProgressCount > 0 && (
                <span className="flex items-center gap-1 text-[10px] text-[var(--accent)] font-medium bg-[var(--accent-subtle)] px-1.5 py-0.5 rounded-md">
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse inline-block" />
                  {inProgressCount} 进行中
                </span>
              )}
              {pendingCount > 0 && (
                <span className="text-[10px] text-[var(--text-muted)] bg-[var(--bg-tertiary)] px-1.5 py-0.5 rounded-md">
                  {pendingCount} 待处理
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* 任务列表区域 */}
      <div className="flex-1 overflow-y-auto py-1.5">
        {isLoading ? (
          <div className="pt-1">
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </div>
        ) : total === 0 ? (
          <div className="flex flex-col items-center justify-center h-full min-h-[140px] gap-3">
            <div className="w-12 h-12 rounded-2xl bg-[var(--bg-tertiary)] flex items-center justify-center">
              <svg className="text-[var(--text-muted)] opacity-40" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <polyline points="9 11 12 14 22 4" />
                <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
              </svg>
            </div>
            <div className="text-center">
              <p className="text-xs font-medium text-[var(--text-muted)]">暂无任务</p>
              <p className="text-[10px] text-[var(--text-muted)] opacity-60 mt-0.5">任务将在对话中自动生成</p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-0.5 px-1">
            {todos.map((todo) => (
              <TodoItem key={todo.id} todo={todo} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default TodoArtifacts
