import { useEffect, useState, useCallback } from 'react'
import { useAutomationStore } from '../../store/automationStore.js'
import type { CronJob } from '../../lib/types.js'

// ─── 自动化任务模板 ────────────────────────────────────────────────────────

interface AutomationTemplate {
  id: string
  icon: string
  title: string
  description: string
  expression: string
  task: string
}

const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  {
    id: 'daily-ai-news',
    icon: '📰',
    title: '每日 AI 新闻推送',
    description: '汇总当天 AI 领域的重要动态，帮 AI coding 与具身智能前沿进展，筛选 3-5 条值得关注的。',
    expression: '0 9 * * *',
    task: '请帮我汇总今天 AI 领域的重要动态，包括 AI coding 与具身智能前沿进展，筛选 3-5 条值得关注的新闻，并给出简要点评。',
  },
  {
    id: 'daily-english-words',
    icon: '📚',
    title: '每日 5 个英语单词',
    description: '每天推荐 5 个实用的常见英语单词，包含词义、词性、例句与记忆提示。',
    expression: '0 8 * * *',
    task: '请每天推荐 5 个实用的常见英语单词，包含词义、词性、例句与记忆提示，帮助我提升英语词汇量。',
  },
  {
    id: 'daily-bedtime-story',
    icon: '🌙',
    title: '每日儿童睡前故事',
    description: '生成 3-5 分钟可朗读的温馨睡前故事，题材丰富，结局积极向上。',
    expression: '0 21 * * *',
    task: '请为我生成一个 3-5 分钟可朗读的温馨儿童睡前故事，题材丰富，结局积极向上，适合 3-8 岁儿童。',
  },
  {
    id: 'weekly-work-report',
    icon: '📊',
    title: '每周工作周报',
    description: '每周五汇总本周 Git issue 进展，梳理出更新与待关注事项。',
    expression: '0 17 * * 5',
    task: '请帮我整理本周的工作进展，汇总 Git issue 完成情况，梳理出本周更新与下周待关注事项，生成一份简洁的工作周报。',
  },
  {
    id: 'classic-movie',
    icon: '🎬',
    title: '经典电影推荐',
    description: '每周推荐一部经典电影，深度介绍剧情梗概、亮点与推荐理由，全程剧透。',
    expression: '0 10 * * 6',
    task: '请为我推荐一部经典电影，深度介绍剧情梗概、亮点与推荐理由，可以适当剧透，帮助我决定是否观看。',
  },
  {
    id: 'history-today',
    icon: '📅',
    title: '历史上的今天',
    description: '每天早上分享历史上的今天发生的重大事件，200-300 字通俗易懂。',
    expression: '0 7 * * *',
    task: '请分享历史上的今天（{{date}}）发生的 1-2 件重大历史事件，用 200-300 字通俗易懂地介绍，让我了解历史。',
  },
  {
    id: 'daily-why',
    icon: '💡',
    title: '每日一个为什么',
    description: '每天提出一个有趣问题，先提问再解答，语气轻松，通俗易懂，篇幅控制在 200-300 字。',
    expression: '0 9 * * *',
    task: '请每天提出一个有趣的科学或生活问题，先提问再解答，语气轻松，通俗易懂，篇幅控制在 200-300 字。',
  },
  {
    id: 'parent-reminder',
    icon: '👨‍👩‍👧',
    title: '父母联系提醒',
    description: '每周提醒给父母打电话或发消息，简单回应即可。',
    expression: '0 10 * * 0',
    task: '提醒我今天记得给父母打个电话或发条消息，问候一下他们的近况，表达关心。',
  },
  {
    id: 'health-checkup-reminder',
    icon: '🏥',
    title: '体检预约提醒',
    description: '定期提醒体检时间，准备证件，并注意空腹与其他注意事项。',
    expression: '0 9 1 * *',
    task: '提醒我本月需要安排体检预约，准备好身份证等证件，注意体检前空腹要求及其他注意事项。',
  },
  {
    id: 'interview-prep',
    icon: '💼',
    title: '面试准备提醒',
    description: '工作日每 2 小时提醒复习大模型面试内容，并生成 3 个模拟问题。',
    expression: '0 */2 * * 1-5',
    task: '提醒我复习大模型相关面试知识，并随机生成 3 个常见面试问题供我练习作答。',
  },
  {
    id: 'meeting-prep',
    icon: '📋',
    title: '会议前准备',
    description: '在会议开始前提醒整理议题目标、待确认问题和关键决策点。',
    expression: '0 9 * * 1-5',
    task: '提醒我在会议开始前整理好议题目标、待确认问题和关键决策点，确保会议高效进行。',
  },
  {
    id: 'cute-wallpaper',
    icon: '🖼️',
    title: '可爱萌宠手机壁纸',
    description: '随机从 7 种不同风格中选一种，为你生成一张 9:16 竖版清晰萌宠壁纸。',
    expression: '0 8 * * *',
    task: '请随机从 7 种不同风格（写实、卡通、水彩、像素、油画、素描、赛博朋克）中选一种，为我生成一张 9:16 竖版清晰萌宠壁纸的详细描述，包括动物种类、场景、色调和风格。',
  },
]

// ─── 工具函数：构建 cron 表达式 ───────────────────────────────────────────

type FrequencyType = 'daily' | 'interval' | 'once'

function buildCronExpression(
  frequency: FrequencyType,
  time: string,
  weekdays: number[],
  intervalHours: number,
): string {
  const [h, m] = time.split(':').map(Number)
  const hh = isNaN(h) ? 9 : h
  const mm = isNaN(m) ? 0 : m

  if (frequency === 'once') {
    // 单次：今天的指定时间
    const now = new Date()
    return `${mm} ${hh} ${now.getDate()} ${now.getMonth() + 1} *`
  }

  if (frequency === 'interval') {
    return `0 */${intervalHours} * * *`
  }

  // daily：按星期
  if (weekdays.length === 0 || weekdays.length === 7) {
    return `${mm} ${hh} * * *`
  }
  // 将 0=周一 ... 6=周日 转换为 cron 的 1=周一 ... 0/7=周日
  const cronDays = weekdays.map(d => (d + 1) % 7).join(',')
  return `${mm} ${hh} * * ${cronDays}`
}

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
  const nextRunText = job.nextRunAt
    ? new Date(job.nextRunAt).toLocaleString('zh-CN')
    : null

  function handleDelete() {
    if (window.confirm(`确定要删除定时任务"${job.description}"吗？`)) {
      onDelete()
    }
  }

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 hover:bg-[var(--bg-tertiary)] rounded transition-colors group">
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

      <button
        type="button"
        onClick={handleDelete}
        className="shrink-0 text-xs text-red-400 hover:text-red-300 opacity-0 group-hover:opacity-100 transition-opacity px-1.5 py-0.5 rounded hover:bg-red-900/30"
        aria-label={`删除定时任务 ${job.description}`}
      >
        删除
      </button>
    </div>
  )
}

// ─── 添加自动化任务弹窗 ────────────────────────────────────────────────────

interface AddAutomationModalProps {
  onClose: () => void
  onAdd: (data: {
    expression: string
    description: string
    task: string
    once?: boolean
    startDate?: string
    endDate?: string
  }) => Promise<void>
  prefill?: Partial<AutomationTemplate>
}

const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

function AddAutomationModal({ onClose, onAdd, prefill }: AddAutomationModalProps) {
  const [name, setName] = useState(prefill?.title ?? '')
  const [task, setTask] = useState(prefill?.task ?? '')
  const [frequency, setFrequency] = useState<FrequencyType>('daily')
  const [time, setTime] = useState('09:00')
  const [weekdays, setWeekdays] = useState<number[]>([0, 1, 2, 3, 4, 5, 6])
  const [intervalHours, setIntervalHours] = useState(1)
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  // 如果是从模板填充，解析模板的 expression
  useEffect(() => {
    if (prefill?.expression) {
      const parts = prefill.expression.trim().split(/\s+/)
      if (parts.length === 5) {
        const [min, hour] = parts
        if (hour !== '*' && min !== '*') {
          setTime(`${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`)
        }
        if (parts[2] === '*' && parts[3] === '*') {
          setFrequency('daily')
          // 解析星期
          if (parts[4] !== '*') {
            const days = parts[4].split(',').map(d => {
              const n = Number(d)
              // cron 0=周日,1=周一...6=周六 → 我们的 0=周一...6=周日
              return n === 0 ? 6 : n - 1
            })
            setWeekdays(days)
          }
        }
      }
    }
  }, [prefill])

  function toggleWeekday(idx: number) {
    setWeekdays(prev =>
      prev.includes(idx) ? prev.filter(d => d !== idx) : [...prev, idx]
    )
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) { setError('请填写名称'); return }
    if (!task.trim()) { setError('请填写提示词'); return }
    if (frequency === 'daily' && weekdays.length === 0) { setError('请至少选择一天'); return }

    const expression = buildCronExpression(frequency, time, weekdays, intervalHours)
    const once = frequency === 'once'

    setSubmitting(true)
    setError('')
    try {
      await onAdd({
        expression,
        description: name.trim(),
        task: task.trim(),
        once,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
      })
      onClose()
    } catch (err) {
      setError(String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl w-full max-w-lg mx-4 shadow-2xl flex flex-col max-h-[90vh]">
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border)] shrink-0">
          <h2 className="text-base font-semibold text-[var(--text-primary)]">添加自动化任务</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors text-lg leading-none"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>

        {/* 表单内容 */}
        <form onSubmit={handleSubmit} className="flex flex-col gap-4 px-5 py-4 overflow-y-auto flex-1">
          {/* 名称 */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm text-[var(--text-primary)]">名称</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="给这个自动化任务起个名字"
              className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-secondary)] focus:outline-none focus:border-[var(--accent)] transition-colors"
            />
          </div>

          {/* 提示词 */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm text-[var(--text-primary)]">提示词</label>
            <textarea
              value={task}
              onChange={e => setTask(e.target.value)}
              placeholder="描述这个任务要做什么..."
              rows={4}
              className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-secondary)] focus:outline-none focus:border-[var(--accent)] transition-colors resize-none"
            />
          </div>

          {/* 执行频率 */}
          <div className="flex flex-col gap-2">
            <label className="text-sm text-[var(--text-primary)]">执行频率</label>
            <div className="flex gap-2">
              {(['daily', 'interval', 'once'] as FrequencyType[]).map(f => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFrequency(f)}
                  className={`px-4 py-1.5 rounded-full text-sm transition-colors ${
                    frequency === f
                      ? 'bg-[var(--accent)] text-white'
                      : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  {f === 'daily' ? '每天' : f === 'interval' ? '按间隔' : '单次'}
                </button>
              ))}
            </div>

            {/* 每天：时间 + 星期 */}
            {frequency === 'daily' && (
              <div className="flex flex-col gap-2 mt-1">
                <div className="flex items-center gap-2">
                  <input
                    type="time"
                    value={time}
                    onChange={e => setTime(e.target.value)}
                    className="bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-3 py-1.5 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] transition-colors"
                  />
                </div>
                <div className="flex gap-1.5 flex-wrap">
                  {WEEKDAY_LABELS.map((label, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => toggleWeekday(idx)}
                      className={`px-2.5 py-1 rounded-full text-xs transition-colors ${
                        weekdays.includes(idx)
                          ? 'bg-[var(--accent)] text-white'
                          : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* 按间隔：小时数 */}
            {frequency === 'interval' && (
              <div className="flex items-center gap-2 mt-1">
                <span className="text-sm text-[var(--text-secondary)]">每</span>
                <input
                  type="number"
                  min={1}
                  max={24}
                  value={intervalHours}
                  onChange={e => setIntervalHours(Math.max(1, Math.min(24, Number(e.target.value))))}
                  className="w-16 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-2 py-1.5 text-sm text-[var(--text-primary)] text-center focus:outline-none focus:border-[var(--accent)] transition-colors"
                />
                <span className="text-sm text-[var(--text-secondary)]">小时执行一次</span>
              </div>
            )}

            {/* 单次：时间 */}
            {frequency === 'once' && (
              <div className="flex items-center gap-2 mt-1">
                <input
                  type="time"
                  value={time}
                  onChange={e => setTime(e.target.value)}
                  className="bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-3 py-1.5 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] transition-colors"
                />
                <span className="text-sm text-[var(--text-secondary)]">今天执行一次</span>
              </div>
            )}
          </div>

          {/* 生效日期区间 */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm text-[var(--text-secondary)]">
              生效日期区间 <span className="text-xs">(可选，留空表示永久生效)</span>
            </label>
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={startDate}
                onChange={e => setStartDate(e.target.value)}
                placeholder="选择生效日期"
                className="flex-1 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-3 py-1.5 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] transition-colors"
              />
              <span className="text-[var(--text-secondary)] text-sm">至</span>
              <input
                type="date"
                value={endDate}
                onChange={e => setEndDate(e.target.value)}
                placeholder="选择结束日期"
                className="flex-1 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-3 py-1.5 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] transition-colors"
              />
            </div>
          </div>

          {/* 错误提示 */}
          {error && (
            <p className="text-sm text-red-400">{error}</p>
          )}
        </form>

        {/* 底部按钮 */}
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-[var(--border)] shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
          >
            取消
          </button>
          <button
            type="submit"
            form=""
            onClick={handleSubmit as unknown as React.MouseEventHandler}
            disabled={submitting}
            className="px-5 py-2 text-sm bg-[var(--accent)] text-white rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {submitting ? '添加中...' : '添加'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── 模板卡片 ──────────────────────────────────────────────────────────────

interface TemplateCardProps {
  template: AutomationTemplate
  onUse: (template: AutomationTemplate) => void
}

function TemplateCard({ template, onUse }: TemplateCardProps) {
  return (
    <button
      type="button"
      onClick={() => onUse(template)}
      className="flex flex-col gap-2 p-4 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl text-left hover:border-[var(--accent)] hover:bg-[var(--bg-tertiary)] transition-all group"
    >
      <div className="flex items-center gap-2">
        <span className="text-xl">{template.icon}</span>
        <span className="text-sm font-medium text-[var(--text-primary)] group-hover:text-[var(--accent)] transition-colors">
          {template.title}
        </span>
      </div>
      <p className="text-xs text-[var(--text-secondary)] leading-relaxed line-clamp-2">
        {template.description}
      </p>
    </button>
  )
}

// ─── AutomationPage 主组件 ─────────────────────────────────────────────────

export function AutomationPage() {
  const {
    cronJobs,
    loading,
    fetchCronJobs,
    toggleCron,
    deleteCron,
    createCron,
  } = useAutomationStore()

  const [showAddModal, setShowAddModal] = useState(false)
  const [prefillTemplate, setPrefillTemplate] = useState<Partial<AutomationTemplate> | undefined>()

  useEffect(() => {
    fetchCronJobs()
  }, [fetchCronJobs])

  const handleOpenAdd = useCallback(() => {
    setPrefillTemplate(undefined)
    setShowAddModal(true)
  }, [])

  const handleUseTemplate = useCallback((template: AutomationTemplate) => {
    setPrefillTemplate(template)
    setShowAddModal(true)
  }, [])

  const handleCloseModal = useCallback(() => {
    setShowAddModal(false)
    setPrefillTemplate(undefined)
  }, [])

  return (
    <div className="flex-1 overflow-y-auto flex flex-col">
      {/* ── 顶部标题栏 ── */}
      <div className="flex items-center justify-between px-5 pt-5 pb-3 shrink-0">
        <div>
          <h1 className="text-base font-semibold text-[var(--text-primary)]">自动化</h1>
          <p className="text-xs text-[var(--text-secondary)] mt-0.5">管理自动化任务并查看近期运行记录。</p>
        </div>
        <button
          type="button"
          onClick={handleOpenAdd}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-[var(--accent)] text-white rounded-lg hover:opacity-90 transition-opacity"
        >
          <span>+</span>
          <span>添加</span>
        </button>
      </div>

      <div className="flex flex-col gap-6 px-5 pb-6">
        {/* ── 已添加任务区块 ── */}
        <section>
          <div className="text-xs font-medium text-[var(--text-secondary)] uppercase tracking-wider mb-2">
            已添加
          </div>
          <div className="border-t border-[var(--border)] mb-2" />

          {loading.crons ? (
            <div className="flex flex-col">
              <SkeletonRow />
              <SkeletonRow />
            </div>
          ) : cronJobs.length === 0 ? (
            <p className="text-sm text-[var(--text-secondary)] text-center py-6">
              暂无自动化任务，点击右上角「添加」或从下方模板快速创建
            </p>
          ) : (
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

        {/* ── 模板区块 ── */}
        <section>
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-medium text-[var(--text-secondary)] uppercase tracking-wider">
              快速入手
            </div>
          </div>
          <div className="border-t border-[var(--border)] mb-3" />
          <div className="grid grid-cols-3 gap-3">
            {AUTOMATION_TEMPLATES.map(template => (
              <TemplateCard
                key={template.id}
                template={template}
                onUse={handleUseTemplate}
              />
            ))}
          </div>
        </section>
      </div>

      {/* ── 添加弹窗 ── */}
      {showAddModal && (
        <AddAutomationModal
          onClose={handleCloseModal}
          onAdd={createCron}
          prefill={prefillTemplate}
        />
      )}
    </div>
  )
}

export default AutomationPage
