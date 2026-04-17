// ─── 工具名称中文映射 ──────────────────────────────────────────────────────

const TOOL_NAME_MAP: Record<string, { label: string; icon: string }> = {
  // 文件操作
  file_read:        { label: '读取文件',     icon: '📄' },
  file_write:       { label: '写入文件',     icon: '✏️' },
  file_edit:        { label: '编辑文件',     icon: '🖊️' },
  // 搜索 & 查找
  glob:             { label: '查找文件',     icon: '🔍' },
  grep:             { label: '搜索内容',     icon: '🔎' },
  web_search:       { label: '网络搜索',     icon: '🌐' },
  web_fetch:        { label: '获取网页',     icon: '🌍' },
  // 执行命令
  bash:             { label: '执行命令',     icon: '⌨️' },
  powershell:       { label: '执行命令(PS)', icon: '🖥️' },
  // 任务 & 决策
  todo_write:       { label: '更新任务',     icon: '📝' },
  todo_read:        { label: '查看任务',     icon: '📋' },
  ask_user:         { label: '询问用户',     icon: '💬' },
  request_decision: { label: '请求决策',     icon: '🤔' },
  // 技能
  skill:            { label: '调用技能',     icon: '⚡' },
  skill_list:       { label: '列出技能',     icon: '📚' },
  skill_save:       { label: '保存技能',     icon: '💾' },
  // SkillHub
  skillhub_search:    { label: '搜索技能库',   icon: '🔍' },
  skillhub_install:   { label: '安装技能',     icon: '📦' },
  skillhub_uninstall: { label: '卸载技能',     icon: '🗑️' },
  skillhub_upgrade:   { label: '升级技能',     icon: '🔄' },
  skillhub_list:      { label: '已装技能',     icon: '📋' },
  skillhub_config:    { label: '技能库配置',   icon: '⚙️' },
  skillhub_setup:     { label: '安装 CLI',    icon: '🛠️' },
  skillhub_recommend: { label: '推荐技能',     icon: '💡' },
  // 定时任务
  schedule_cron:    { label: '定时任务',     icon: '⏰' },
  // 智能体团队
  agent:            { label: '子智能体',     icon: '🤖' },
  agent_spawn:      { label: '派生智能体',   icon: '🚀' },
  team_create:      { label: '创建团队',     icon: '👥' },
  team_delete:      { label: '解散团队',     icon: '🗂️' },
  team_status:      { label: '团队状态',     icon: '📊' },
  team_wait:        { label: '等待团队',     icon: '⏳' },
  send_message:     { label: '发送消息',     icon: '📤' },
  receive_message:  { label: '接收消息',     icon: '📥' },
}

/** 返回工具的中文名和图标，未收录的工具保留原名 */
function resolveToolLabel(toolName: string): { label: string; icon: string; raw: string } {
  const mapped = TOOL_NAME_MAP[toolName]
  return {
    label: mapped?.label ?? toolName,
    icon:  mapped?.icon  ?? '🔧',
    raw:   toolName,
  }
}

// ─── Props 接口 ────────────────────────────────────────────────────────────

interface ToolCardProps {
  toolName: string
  input: unknown
  status: 'pending' | 'success' | 'error' | 'denied'
  logs: string[]
  result?: unknown
  isExpanded?: boolean
  onToggle?: () => void
}

// ─── 状态配置 ──────────────────────────────────────────────────────────────

const STATUS_CONFIG = {
  pending: {
    icon: (
      <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      </svg>
    ),
    label: '执行中',
    textColor: 'text-amber-400',
    bgColor: 'bg-amber-400/8',
    borderColor: 'border-amber-400/20',
    dotColor: 'bg-amber-400',
    leftBorder: 'border-l-amber-400/60',
  },
  success: {
    icon: (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    ),
    label: '成功',
    textColor: 'text-emerald-400',
    bgColor: 'bg-emerald-400/8',
    borderColor: 'border-emerald-400/20',
    dotColor: 'bg-emerald-400',
    leftBorder: 'border-l-emerald-400/60',
  },
  error: {
    icon: (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    ),
    label: '失败',
    textColor: 'text-red-400',
    bgColor: 'bg-red-400/8',
    borderColor: 'border-red-400/20',
    dotColor: 'bg-red-400',
    leftBorder: 'border-l-red-400/60',
  },
  denied: {
    icon: (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
        <circle cx="12" cy="12" r="10" /><line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
      </svg>
    ),
    label: '已拒绝',
    textColor: 'text-orange-400',
    bgColor: 'bg-orange-400/8',
    borderColor: 'border-orange-400/20',
    dotColor: 'bg-orange-400',
    leftBorder: 'border-l-orange-400/60',
  },
} as const

// ─── 结果截断辅助函数 ──────────────────────────────────────────────────────

function truncateResult(result: unknown, maxLen = 500): string {
  const str =
    typeof result === 'string' ? result : JSON.stringify(result, null, 2)
  if (str.length > maxLen) {
    return str.slice(0, maxLen) + `\n… (已截断，共 ${str.length} 字符)`
  }
  return str
}

// ─── ToolCard 组件 ─────────────────────────────────────────────────────────

export function ToolCard({
  toolName,
  input,
  status,
  logs,
  result,
  isExpanded = false,
  onToggle,
}: ToolCardProps) {
  const cfg = STATUS_CONFIG[status]
  const visibleLogs = logs.slice(0, 30)

  // ask_user 工具特殊处理：从 input 中提取问题文本
  const isAskUser = toolName === 'ask_user'
  const askQuestion = isAskUser && input && typeof input === 'object'
    ? (input as Record<string, unknown>).question as string | undefined
    : undefined

  // 工具中文名解析
  const { label: toolLabel, icon: toolIcon, raw: toolRaw } = resolveToolLabel(toolName)

  return (
    <div
      className={`rounded-xl border border-l-2 ${cfg.borderColor} ${cfg.leftBorder} bg-[var(--bg-secondary)] overflow-hidden transition-all duration-150`}
    >
      {/* ── 标题行 ── */}
      <div
        className={`flex items-center gap-2.5 px-3 py-2 ${isAskUser && status === 'pending' ? 'cursor-default' : 'cursor-pointer'} select-none hover:bg-[var(--bg-tertiary)] transition-colors`}
        onClick={isAskUser && status === 'pending' ? undefined : onToggle}
        role={isAskUser && status === 'pending' ? undefined : 'button'}
        aria-expanded={isAskUser && status === 'pending' ? undefined : isExpanded}
        tabIndex={isAskUser && status === 'pending' ? undefined : 0}
        onKeyDown={(e) => {
          if (isAskUser && status === 'pending') return
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggle?.()
          }
        }}
      >
        {/* 状态图标 */}
        <span className={`shrink-0 ${cfg.textColor}`} aria-hidden="true">
          {cfg.icon}
        </span>

        {/* 工具名称：中文名 + 原始名（ask_user 时显示问题摘要） */}
        <span className="text-xs text-[var(--text-primary)] flex-1 truncate flex items-center gap-1.5">
          {isAskUser && askQuestion
            ? <span className="font-sans text-[var(--text-secondary)]">💬 {askQuestion}</span>
            : (
              <>
                <span>{toolIcon}</span>
                <span className="font-medium">{toolLabel}</span>
                {toolLabel !== toolRaw && (
                  <span className="font-mono text-[10px] text-[var(--text-muted)] shrink-0">
                    {toolRaw}
                  </span>
                )}
              </>
            )
          }
        </span>

        {/* 状态标签 */}
        <span className={`text-[10px] font-semibold ${cfg.textColor} shrink-0`}>
          {cfg.label}
        </span>

        {/* ask_user pending 时不显示折叠箭头（InputBar 已展示问题） */}
        {!(isAskUser && status === 'pending') && (
          <svg
            className={`text-[var(--text-muted)] transition-transform duration-150 shrink-0 ${isExpanded ? 'rotate-180' : ''}`}
            width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
            aria-hidden="true"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        )}
      </div>

      {/* ── 折叠内容（ask_user pending 时不展开） ── */}
      {isExpanded && !(isAskUser && status === 'pending') && (
        <div className="border-t border-[var(--border-subtle)] px-3 pb-3 flex flex-col gap-2.5">
          {/* 输入参数区块 */}
          <div className="mt-2.5">
            <p className="text-[10px] font-semibold text-[var(--text-muted)] mb-1.5 uppercase tracking-wider">
              输入参数
            </p>
            <pre className="bg-[var(--bg-primary)] border border-[var(--border-subtle)] rounded-lg text-xs font-mono p-2.5 overflow-x-auto text-[var(--text-secondary)] whitespace-pre-wrap break-all leading-relaxed">
              {JSON.stringify(input, null, 2)}
            </pre>
          </div>

          {/* 执行日志区块 */}
          <div>
            <p className="text-[10px] font-semibold text-[var(--text-muted)] mb-1.5 uppercase tracking-wider">
              执行日志
              {logs.length > 30 && (
                <span className="ml-1 normal-case font-normal">
                  （前 30 / 共 {logs.length} 行）
                </span>
              )}
            </p>
            <div className="bg-[var(--bg-primary)] border border-[var(--border-subtle)] rounded-lg p-2.5 max-h-36 overflow-y-auto">
              {visibleLogs.length === 0 ? (
                <p className="text-xs text-[var(--text-muted)] italic">暂无日志</p>
              ) : (
                visibleLogs.map((line, idx) => (
                  <div
                    key={idx}
                    className="text-[11px] font-mono text-[var(--text-secondary)] leading-5"
                  >
                    {line}
                  </div>
                ))
              )}
            </div>
          </div>

          {/* 执行结果区块 */}
          {result !== undefined && (
            <div>
              <p className="text-[10px] font-semibold text-[var(--text-muted)] mb-1.5 uppercase tracking-wider">
                执行结果
              </p>
              <pre className="bg-[var(--bg-primary)] border border-[var(--border-subtle)] rounded-lg text-xs font-mono p-2.5 overflow-x-auto text-[var(--text-primary)] whitespace-pre-wrap break-all leading-relaxed">
                {truncateResult(result)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default ToolCard
