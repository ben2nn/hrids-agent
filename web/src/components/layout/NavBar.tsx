import { useState } from 'react'
import { useSessionStore } from '../../store/sessionStore.js'
import { useThemeStore } from '../../store/themeStore.js'
import type { SessionInfo } from '../../lib/types.js'

// ─── 类型定义 ──────────────────────────────────────────────────────────────

export type NavView = 'chat' | 'skills' | 'automation'

export interface NavBarProps {
  activeView: NavView
  onViewChange: (view: NavView) => void
  onNewSession: () => void
  collapsed?: boolean
  onCollapsedChange?: (collapsed: boolean) => void
}


// ─── 会话列表项 ────────────────────────────────────────────────────────────

interface SessionItemProps {
  session: SessionInfo
  isActive: boolean
  onSelect: () => void
  onDelete: () => void
}

function SessionItem({ session, isActive, onSelect, onDelete }: SessionItemProps) {
  const [hovered, setHovered] = useState(false)

  const timeLabel = (() => {
    const d = new Date(session.createdAt ?? Date.now())
    const now = new Date()
    const isToday =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate()
    if (isToday) {
      return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    }
    return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
  })()

  const title = session.title || '新会话'

  return (
    <div
      className={[
        'relative flex items-center gap-2 px-2.5 py-2 cursor-pointer rounded-lg mx-2 group transition-all duration-150',
        isActive
          ? 'bg-[var(--accent-subtle)] border border-[var(--accent-border)]'
          : 'border border-transparent hover:bg-[var(--bg-tertiary)] hover:border-[var(--border-subtle)]',
      ].join(' ')}
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={session.title || '新会话'}
    >
      {/* 图标 */}
      <div className="w-6 h-6 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border)] flex items-center justify-center shrink-0">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--text-muted)]">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </div>

      {/* 内容区 */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-1">
          <span className={`text-xs font-medium truncate leading-tight ${isActive ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)] group-hover:text-[var(--text-primary)]'} transition-colors`}>
            {title}
          </span>
          <span className="text-[10px] text-[var(--text-muted)] shrink-0">
            {timeLabel}
          </span>
        </div>
        {/* 悬停时不显示任何副标题 */}
      </div>

      {/* 悬停时显示删除按钮 */}
      {hovered && (
        <button
          className="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--error)] rounded-md text-sm leading-none border-0 cursor-pointer bg-[var(--bg-elevated)] transition-colors"
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          title="删除会话"
        >
          ×
        </button>
      )}
    </div>
  )
}

// ─── 导航菜单项 ────────────────────────────────────────────────────────────

interface NavMenuItemProps {
  icon: React.ReactNode
  label: string
  isActive?: boolean
  onClick: () => void
  badge?: number
}

function NavMenuItem({ icon, label, isActive, onClick, badge }: NavMenuItemProps) {
  return (
    <button
      onClick={onClick}
      className={[
        'flex items-center gap-2.5 px-2.5 py-2 w-full text-xs font-medium rounded-lg mx-2 transition-all duration-150 text-left border-0 cursor-pointer',
        isActive
          ? 'bg-[var(--accent-subtle)] text-[var(--text-primary)] border border-[var(--accent-border)]'
          : 'bg-transparent border border-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]',
      ].join(' ')}
      style={{ width: 'calc(100% - 16px)' }}
    >
      <span className="w-4 h-4 flex items-center justify-center shrink-0 opacity-80">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="text-[10px] bg-[var(--accent)] text-white rounded-full px-1.5 py-0.5 leading-none shrink-0 font-semibold">
          {badge}
        </span>
      )}
    </button>
  )
}

// ─── SVG 图标 ──────────────────────────────────────────────────────────────

const ChatIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
)

const SkillsIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
  </svg>
)

const AutomationIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14" />
  </svg>
)

// ─── 主题切换按钮 ──────────────────────────────────────────────────────────

function ThemeToggle() {
  const { theme, toggle } = useThemeStore()
  const isDark = theme === 'dark'

  return (
    <button
      type="button"
      onClick={toggle}
      title={isDark ? '切换到日间模式' : '切换到夜间模式'}
      aria-label={isDark ? '切换到日间模式' : '切换到夜间模式'}
      className="w-7 h-7 flex items-center justify-center rounded-lg text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] transition-all duration-150 shrink-0 border-0 cursor-pointer"
    >
      {isDark ? (
        /* 太阳图标 — 切换到日间 */
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="5" />
          <line x1="12" y1="1" x2="12" y2="3" />
          <line x1="12" y1="21" x2="12" y2="23" />
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
          <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
          <line x1="1" y1="12" x2="3" y2="12" />
          <line x1="21" y1="12" x2="23" y2="12" />
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
          <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
        </svg>
      ) : (
        /* 月亮图标 — 切换到夜间 */
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )}
    </button>
  )
}

// ─── NavBar 主组件 ─────────────────────────────────────────────────────────

export function NavBar({ activeView, onViewChange, onNewSession, collapsed = false, onCollapsedChange }: NavBarProps) {
  const sessions = useSessionStore((state) => state.sessions)
  const activeSessionId = useSessionStore((state) => state.activeSessionId)
  const setActive = useSessionStore((state) => state.setActive)
  const wsClients = useSessionStore((state) => state.wsClients)
  const [searchQuery, setSearchQuery] = useState('')

  // 根据活跃会话的 WS 状态判断连接情况
  const wsStatus: 'connected' | 'reconnecting' | 'disconnected' = (() => {
    if (!activeSessionId) return 'connected' // 无会话时不报错
    const client = wsClients.get(activeSessionId)
    if (!client) return 'disconnected'
    return client.getStatus()
  })()

  const filteredSessions = searchQuery.trim()
    ? sessions.filter((s) =>
        (s.title || s.id).toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : sessions

  // ── 收起状态（图标栏） ─────────────────────────────────────────────────
  if (collapsed) {
    return (
      <div className="w-12 flex flex-col items-center bg-[var(--bg-secondary)] border-r border-[var(--border)] shrink-0 transition-all duration-200">
        {/* Logo */}
        <div className="py-3.5 flex items-center justify-center shrink-0">
          <div className="w-7 h-7 rounded-lg overflow-hidden shrink-0 shadow-[var(--shadow-glow)]">
            <img src="/avatar.png" alt="知了" className="w-full h-full object-cover" />
          </div>
        </div>

        {/* 新建按钮 */}
        <button
          type="button"
          onClick={onNewSession}
          title="新对话"
          aria-label="新对话"
          className="w-8 h-8 flex items-center justify-center rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white transition-all duration-150 border-0 cursor-pointer mb-2"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>

        {/* 分割线 */}
        <div className="w-6 border-t border-[var(--border-subtle)] mb-2 shrink-0" />

        {/* 导航图标 */}
        <div className="flex flex-col gap-1 items-center">
          <button
            type="button"
            onClick={() => { onViewChange('chat'); onCollapsedChange?.(false) }}
            title="对话"
            aria-label="对话"
            className={`w-8 h-8 flex items-center justify-center rounded-lg transition-all duration-150 border-0 cursor-pointer ${
              activeView === 'chat'
                ? 'bg-[var(--accent-subtle)] text-[var(--text-primary)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
            }`}
          >
            <ChatIcon />
          </button>
          <button
            type="button"
            onClick={() => { onViewChange('skills'); onCollapsedChange?.(false) }}
            title="Skills"
            aria-label="Skills"
            className={`w-8 h-8 flex items-center justify-center rounded-lg transition-all duration-150 border-0 cursor-pointer ${
              activeView === 'skills'
                ? 'bg-[var(--accent-subtle)] text-[var(--text-primary)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
            }`}
          >
            <SkillsIcon />
          </button>
          <button
            type="button"
            onClick={() => { onViewChange('automation'); onCollapsedChange?.(false) }}
            title="自动化"
            aria-label="自动化"
            className={`w-8 h-8 flex items-center justify-center rounded-lg transition-all duration-150 border-0 cursor-pointer ${
              activeView === 'automation'
                ? 'bg-[var(--accent-subtle)] text-[var(--text-primary)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
            }`}
          >
            <AutomationIcon />
          </button>
        </div>

        {/* 底部：连接状态 + 主题 */}
        <div className="mt-auto pb-3 flex flex-col items-center gap-2">
          {/* 连接状态点 */}
          {wsStatus === 'connected' && (
            <span className="relative flex shrink-0" title="已连接">
              <span className="absolute w-2 h-2 rounded-full bg-emerald-400 animate-ping opacity-60" />
              <span className="w-2 h-2 rounded-full bg-emerald-400" />
            </span>
          )}
          {wsStatus === 'reconnecting' && (
            <span className="relative flex shrink-0" title="重连中...">
              <span className="absolute w-2 h-2 rounded-full bg-amber-400 animate-ping opacity-75" />
              <span className="w-2 h-2 rounded-full bg-amber-400" />
            </span>
          )}
          {wsStatus === 'disconnected' && (
            <span className="w-2 h-2 rounded-full bg-red-500 shrink-0" title="失去连接" />
          )}
          <ThemeToggle />
        </div>
      </div>
    )
  }

  // ── 展开状态（完整侧边栏） ─────────────────────────────────────────────
  return (
    <div className="w-[300px] flex flex-col bg-[var(--bg-secondary)] border-r border-[var(--border)] shrink-0 transition-all duration-200">
      {/* ── Logo 区域 ── */}
      <div className="flex items-center gap-2.5 px-4 py-4 shrink-0">
        <div className="w-7 h-7 rounded-lg overflow-hidden shrink-0 shadow-[var(--shadow-glow)]">
          <img src="/avatar.png" alt="知了" className="w-full h-full object-cover" />
        </div>
        <span className="text-sm font-semibold text-[var(--text-primary)] truncate tracking-tight">
          知了
        </span>
        {/* 连接状态 */}
        {wsStatus === 'connected' && (
          <span className="relative flex ml-auto shrink-0" title="已连接">
            <span className="absolute w-2 h-2 rounded-full bg-emerald-400 animate-ping opacity-60" />
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
          </span>
        )}
        {wsStatus === 'reconnecting' && (
          <span className="relative flex ml-auto shrink-0" title="重连中...">
            <span className="absolute w-2 h-2 rounded-full bg-amber-400 animate-ping opacity-75" />
            <span className="w-2 h-2 rounded-full bg-amber-400" />
          </span>
        )}
        {wsStatus === 'disconnected' && (
          <span className="flex items-center gap-1.5 ml-auto shrink-0">
            <span className="w-2 h-2 rounded-full bg-red-500 shrink-0" />
            <span className="text-[10px] text-red-400 font-medium">失去连接</span>
          </span>
        )}
      </div>

      {/* ── 搜索框 ── */}
      <div className="px-3 pb-2 shrink-0">
        <div className="relative">
          <svg
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none"
            width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索会话..."
            className="w-full pl-7 pr-3 py-1.5 text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--accent-subtle)] transition-all"
          />
        </div>
      </div>

      {/* ── 新建任务按钮 ── */}
      <div className="px-3 pb-3 shrink-0">
        <button
          onClick={onNewSession}
          className="flex items-center gap-2 w-full px-3 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-xs font-semibold rounded-lg transition-all duration-150 border-0 cursor-pointer shadow-sm"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          <span>新对话</span>
        </button>
      </div>

      {/* ── 分割线 ── */}
      <div className="border-t border-[var(--border-subtle)] mx-3 mb-2 shrink-0" />

      {/* ── 导航菜单 ── */}
      <div className="flex flex-col gap-0.5 px-0 shrink-0">
        <NavMenuItem
          icon={<ChatIcon />}
          label="对话"
          isActive={activeView === 'chat'}
          onClick={() => onViewChange('chat')}
        />
        <NavMenuItem
          icon={<SkillsIcon />}
          label="Skills"
          isActive={activeView === 'skills'}
          onClick={() => onViewChange('skills')}
        />
        <NavMenuItem
          icon={<AutomationIcon />}
          label="自动化"
          isActive={activeView === 'automation'}
          onClick={() => onViewChange('automation')}
        />
      </div>

      {/* ── 分割线 + 会话列表标题 ── */}
      <div className="border-t border-[var(--border-subtle)] mx-3 mt-2 mb-1 shrink-0" />
      <div className="flex items-center justify-between px-4 py-2 shrink-0">
        <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest leading-none">
          最近会话
        </span>
        <span className="text-[10px] text-[var(--text-muted)] bg-[var(--bg-tertiary)] px-1.5 py-0.5 rounded-full">
          {sessions.length}
        </span>
      </div>

      {/* ── 会话列表（可滚动） ── */}
      <div className="flex-1 overflow-y-auto py-1">
        {filteredSessions.length === 0 ? (
          <div className="px-4 py-6 text-xs text-[var(--text-muted)] text-center">
            {searchQuery ? '无匹配会话' : '暂无会话'}
          </div>
        ) : (
          filteredSessions.map((session) => (
            <SessionItem
              key={session.id}
              session={session}
              isActive={session.id === activeSessionId}
              onSelect={() => {
                setActive(session.id)
                onViewChange('chat')
              }}
              onDelete={() => {
                void useSessionStore.getState().deleteSession(session.id)
              }}
            />
          ))
        )}
      </div>

      {/* ── 底部用户区域 ── */}
      <div className="border-t border-[var(--border-subtle)] px-3 py-3 shrink-0">
        <div className="flex items-center gap-2 px-2">
          <div className="w-6 h-6 rounded-full overflow-hidden border border-[var(--border-subtle)] shrink-0">
            <img src="/avatar.png" alt="用户头像" className="w-full h-full object-cover" />
          </div>
          <span className="text-xs text-[var(--text-secondary)] truncate flex-1">本地用户</span>
          {/* 主题切换按钮 */}
          <ThemeToggle />
        </div>
      </div>
    </div>
  )
}
