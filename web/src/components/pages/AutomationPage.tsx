import { useEffect } from 'react'
import { useAutomationStore } from '../../store/automationStore.js'
import { TodoItem } from '../panel/TodoItem.js'
import type { CronJob } from '../../lib/types.js'

// ─── 骨架屏 ────────────────────────────────────────────────────────────────

function SkeletonRow() {
  return (
    <div className="flex items-center gap-2 px-3 py-2 animate-pulse">
      <div className="w-4 h-4 rounded bg-[var(--bg-tertiary)] shrink-0" />
      <div className="w-8 h-4 rounded bg-[var(--bg-tertiary)] shrink-0" />
      <div className="flex-1 h-4 rounded bg-[var(--bg-tertiary)]" />
    </div>
  )
}

// ─── 定时任务行 ────────────────────────────────────────────────────────────

interface CronJobRowProps {
  job: CronJob
  onToggle: () => void
  onDelete: () => void
}

function CronJobRow({ job, onToggle, onDelete }: CronJobRowProps) {
  // 格式化下次执行时间
  const nextRunText = job.nextRunAt
    ? new Date(job.nextRunAt).toLocaleString()
    : null

  function handleDelete() {
    if (window.confirm(`确定要删除定时任务"${job.description}"吗？`)) {
      onDelete()
    }
  }

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 hover:bg-[var(--bg-tertiary)] rounded transition-colors group">
      {/* 启用/禁用开关 */}
      <button
        type="button"
        onClick={onToggle}
        className={`shrink-0 text-base leading-none transition-colors ${
          job.enabled
            ? 'text-green-400 hover:text-green-300'
            : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
        }`}
        aria-label={job.enabled ? '禁用定时任务' : '启用定时任务'}
        title={job.enabled ? '点击禁用' : '点击启用'}
      >
        {job.enabled ? '●' : '○'}
      </button>

      {/* 描述 + 表达式 + 下次执行时间 */}
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        <span className="text-sm text-[var(--text-primary)] truncate">{job.description}</span>
        <div className="flex items-center gap-2 flex-wrap">
          <code className="text-xs font-mono text-[var(--text-secondary)]">
            {job.expression}
          </code>
          {nextRunText && (
            <span className="text-xs text-[var(--text-secondary)]">
              下次: {nextRunText}
            </span>
          )}
        </div>
      </div>

      {/* 删除按钮 */}
      <button
        type="button"
        onClick={handleDelete}
        className="
          shrink-0 text-xs text-red-400 hover:text-red-300
          opacity-0 group-hover:opacity-100 transition-opacity
          px-1.5 py-0.5 rounded hover:bg-red-900/30
        "
        aria-label={`删除定时任务 ${job.description}`}
      >
        删除
      </button>
    </div>
  )
}

// ─── AutomationPage 主组件 ─────────────────────────────────────────────────

export function AutomationPage() {
  const {
    globalTodos,
    cronJobs,
    loading,
    fetchGlobalTodos,
    fetchCronJobs,
    toggleCron,
    deleteCron,
  } = useAutomationStore()

  // 挂载时拉取数据
  useEffect(() => {
    fetchGlobalTodos()
    fetchCronJobs()
  }, [fetchGlobalTodos, fetchCronJobs])

  return (
    <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-6">
      {/* ── 全局任务区块 ── */}
      <section>
        {/* 区块标题 */}
        <div className="text-sm font-medium text-[var(--text-primary)] flex items-center justify-between mb-3">
          <span>全局任务</span>
          <button
            type="button"
            onClick={fetchGlobalTodos}
            disabled={loading.todos}
            className="
              text-[var(--text-secondary)] hover:text-[var(--text-primary)]
              transition-colors disabled:opacity-50 disabled:cursor-not-allowed
              text-base leading-none
            "
            aria-label="刷新全局任务"
            title="刷新"
          >
            ↻
          </button>
        </div>

        {/* 分割线 */}
        <div className="border-t border-[var(--border)] mb-3" />

        {/* 内容 */}
        {loading.todos ? (
          // 骨架屏
          <div className="flex flex-col">
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </div>
        ) : globalTodos.length === 0 ? (
          // 空状态
          <p className="text-sm text-[var(--text-secondary)] text-center py-4">
            暂无全局任务
          </p>
        ) : (
          // 任务列表
          <div className="flex flex-col">
            {globalTodos.map((todo) => (
              <TodoItem key={todo.id} todo={todo} />
            ))}
          </div>
        )}
      </section>

      {/* ── 定时任务区块 ── */}
      <section>
        {/* 区块标题 */}
        <div className="text-sm font-medium text-[var(--text-primary)] flex items-center justify-between mb-3">
          <span>定时任务</span>
        </div>

        {/* 分割线 */}
        <div className="border-t border-[var(--border)] mb-3" />

        {/* 内容 */}
        {loading.crons ? (
          // 骨架屏
          <div className="flex flex-col">
            <SkeletonRow />
            <SkeletonRow />
          </div>
        ) : cronJobs.length === 0 ? (
          // 空状态
          <p className="text-sm text-[var(--text-secondary)] text-center py-4">
            暂无定时任务
          </p>
        ) : (
          // 定时任务列表
          <div className="flex flex-col">
            {cronJobs.map((job) => (
              <CronJobRow
                key={job.id}
                job={job}
                onToggle={() => toggleCron(job.id, !job.enabled)}
                onDelete={() => deleteCron(job.id)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

export default AutomationPage
