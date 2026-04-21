import type { DisplayMessage, ToolCardState } from '../../lib/types.js'
import { MarkdownRenderer } from '../../lib/markdown.js'
import { ToolCard } from './ToolCard.js'
import { useMessageStore } from '../../store/messageStore.js'

// ─── 工具名称简单中文化（用于 fallback pending 状态） ───────────────────────

const TOOL_LABEL_MAP: Record<string, string> = {
  file_read: '读取文件', file_write: '写入文件', file_edit: '编辑文件',
  glob: '查找文件', grep: '搜索内容', web_search: '网络搜索', web_fetch: '获取网页',
  bash: '执行命令', powershell: '执行命令(PS)',
  todo_write: '更新任务', todo_read: '查看任务',
  ask_user: '询问用户', request_decision: '请求决策',
  skill: '调用技能', skill_list: '列出技能', skill_save: '保存技能',
  schedule_cron: '定时任务',
  agent: '子智能体', agent_spawn: '派生智能体',
  team_create: '创建团队', team_delete: '解散团队', team_status: '团队状态',
  team_wait: '等待团队', send_message: '发送消息', receive_message: '接收消息',
}

// ─── Props 接口 ────────────────────────────────────────────────────────────

interface MessageItemProps {
  message: DisplayMessage
  toolCard?: ToolCardState
  onToggleToolCard?: () => void
  onToggleCompact?: () => void
  /** 是否显示头像（Agent 回合第一条才显示） */
  showAvatar?: boolean
  sessionId?: string
}

// ─── 头像占位（保持列对齐） ────────────────────────────────────────────────

const AVATAR_W = 'w-8'   // 头像宽度 class，统一用于占位

function AgentAvatar() {
  return (
    <div className={`${AVATAR_W} h-8 rounded-full overflow-hidden shrink-0 border border-[var(--border-subtle)]`}>
      <img src="/avatar.png" alt="Agent" className="w-full h-full object-cover" />
    </div>
  )
}


function UserAvatar() {
  return (
    <div className={`${AVATAR_W} h-8 rounded-full overflow-hidden shrink-0 border border-[var(--border-subtle)] bg-[var(--accent-subtle)]`}>
      <div className="w-full h-full flex items-center justify-center text-[var(--accent)] text-xs font-semibold">
        U
      </div>
    </div>
  )
}

// ─── 内容列宽度（tool 和 assistant 统一，保证对齐） ──────────────────────
const CONTENT_COL = ''  // 内容区撑满 ml-10 后的剩余空间

// ─── MessageItem 组件 ──────────────────────────────────────────────────────

export function MessageItem({ message, toolCard, onToggleToolCard, onToggleCompact, showAvatar = false, sessionId }: MessageItemProps) {
  // ── user 消息：右对齐，头像+名称在上，内容在下 ────────────────────────
  if (message.type === 'user') {
    return (
      <div className="flex flex-col items-end px-4 pt-4 pb-1 animate-fade-in">
        {/* 头像 + 名称（右对齐） */}
        <div className="flex items-center gap-2 mb-1.5 flex-row-reverse">
          <UserAvatar />
          <span className="text-xs font-semibold text-[var(--text-secondary)]">我</span>
        </div>
        {/* 内容气泡，右对齐，右边缘与头像对齐 */}
        <div className="mr-10 flex justify-end">
          <div className="bg-[var(--accent)] text-white rounded-2xl rounded-tr-sm px-4 py-2.5 text-sm leading-relaxed break-words shadow-sm max-w-full">
            {message.content}
          </div>
        </div>
      </div>
    )
  }

  // ── assistant 消息：头像+名称在上，内容在下 ──────────────────────────
  if (message.type === 'assistant') {
    return (
      <div className="flex flex-col px-4 py-1 animate-fade-in">
        {showAvatar && (
          <div className="flex items-center gap-2 mb-1.5">
            <AgentAvatar />
            <span className="text-xs font-semibold text-[var(--text-secondary)]">知了</span>
          </div>
        )}
        <div className={`ml-10 mr-10 ${CONTENT_COL}`}>
          <div className="bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-2xl rounded-tl-sm px-4 py-3">
            <MarkdownRenderer content={message.content} />
          </div>
        </div>
      </div>
    )
  }

  // ── tool 消息：与 assistant 同列对齐 ──────────────────────────────────
  if (message.type === 'tool') {
    const cardContent = !toolCard ? (
      <div className="bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-xl px-3 py-2">
        <div className="flex items-center gap-2">
          <svg className="animate-spin text-amber-400 shrink-0" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
          <span className="text-xs text-[var(--text-secondary)]">
            {TOOL_LABEL_MAP[message.toolName] ?? message.toolName}
          </span>
          {TOOL_LABEL_MAP[message.toolName] && (
            <span className="font-mono text-[10px] text-[var(--text-muted)]">{message.toolName}</span>
          )}
        </div>
      </div>
    ) : (
      <ToolCard
        toolName={toolCard.toolName}
        input={toolCard.input}
        status={toolCard.status}
        logs={toolCard.logs}
        result={toolCard.result}
        isExpanded={toolCard.isExpanded}
        onToggle={onToggleToolCard}
      />
    )

    return (
      <div className="flex flex-col px-4 py-0.5 animate-fade-in">
        {showAvatar && (
          <div className="flex items-center gap-2 mb-1.5">
            <AgentAvatar />
            <span className="text-xs font-semibold text-[var(--text-secondary)]">知了</span>
          </div>
        )}
        <div className={`ml-10 mr-10 ${CONTENT_COL}`}>
          {cardContent}
        </div>
      </div>
    )
  }

  // ── compact 消息：归档分隔线 ──────────────────────────────────────────
  if (message.type === 'compact') {
    const time = new Date(message.archivedAt).toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    })
    const countLabel = message.messageCount > 0 ? `${message.messageCount} 条消息` : '历史消息'
    const toggleCompact = onToggleCompact ?? (() => {
      if (sessionId) useMessageStore.getState().toggleCompact(sessionId, message.id)
    })

    return (
      <div className="flex flex-col px-4 py-2 animate-fade-in">
        {/* 分隔线 + 标签 */}
        <div className="flex items-center gap-2 my-1">
          <div className="flex-1 h-px bg-[var(--border-subtle)]" />
          <button
            type="button"
            onClick={toggleCompact}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] text-[11px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:border-[var(--accent-border)] transition-all duration-150 cursor-pointer select-none"
            title={message.expanded ? '收起摘要' : '展开摘要'}
          >
            {/* 压缩图标 */}
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--accent)] shrink-0">
              <polyline points="17 1 21 5 17 9" />
              <path d="M3 11V9a4 4 0 0 1 4-4h14" />
              <polyline points="7 23 3 19 7 15" />
              <path d="M21 13v2a4 4 0 0 1-4 4H3" />
            </svg>
            <span>上下文已压缩</span>
            <span className="text-[var(--text-muted)] opacity-70">·</span>
            <span>{countLabel}</span>
            <span className="text-[var(--text-muted)] opacity-70">·</span>
            <span>{time}</span>
            {/* 展开/收起箭头 */}
            <svg
              width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
              className={`transition-transform duration-200 ${message.expanded ? 'rotate-180' : ''}`}
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          <div className="flex-1 h-px bg-[var(--border-subtle)]" />
        </div>

        {/* 展开后的摘要内容 */}
        {message.expanded && (
          <div className="mx-4 mt-1 mb-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] overflow-hidden animate-fade-in">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border-subtle)] bg-[var(--bg-tertiary)]">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--accent)] shrink-0">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
                <polyline points="10 9 9 9 8 9" />
              </svg>
              <span className="text-[11px] font-semibold text-[var(--text-secondary)]">压缩摘要</span>
              <span className="text-[10px] text-[var(--text-muted)] ml-auto">{time}</span>
            </div>
            <div className="px-4 py-3 max-h-80 overflow-y-auto">
              <MarkdownRenderer content={message.summary} />
            </div>
          </div>
        )}
      </div>
    )
  }

  // ── system / error 消息：不显示 ───────────────────────────────────────
  return null
}
export default MessageItem
