import type { DisplayMessage, ToolCardState } from '../../lib/types.js'
import { MarkdownRenderer } from '../../lib/markdown.js'
import { ToolCard } from './ToolCard.js'

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
  /** 是否显示头像（Agent 回合第一条才显示） */
  showAvatar?: boolean
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

export function MessageItem({ message, toolCard, onToggleToolCard, showAvatar = false }: MessageItemProps) {
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

  // ── system / error 消息：不显示 ───────────────────────────────────────
  return null
}

export default MessageItem
