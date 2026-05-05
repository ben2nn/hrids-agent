import { useState, useRef, useEffect } from 'react'
import { useSessionStore } from '../../store/sessionStore.js'
import { useThemeStore } from '../../store/themeStore.js'
import { useConnectionStore } from '../../store/connectionStore.js'
import { ConfirmModal } from '../modals/ConfirmModal.js'
import type { SessionInfo } from '../../lib/types.js'
import { useT } from '../../i18n/useT.js'
import { useI18nStore } from '../../store/i18nStore.js'

// ─── 类型定义 ──────────────────────────────────────────────────────────────

export type NavView = 'chat' | 'skills' | 'automation' | 'zhile' | 'settings'

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
  const { locale } = useI18nStore()
  const t = useT()

  const timeLabel = (() => {
    const d = new Date(session.createdAt ?? Date.now())
    const now = new Date()
    const isToday =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate()
    if (isToday) {
      return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
    }
    return d.toLocaleDateString(locale, { month: 'numeric', day: 'numeric' })
  })()

  const title = session.title || t.common.newSession

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
      title={session.title || t.common.newSession}
    >
      {/* 运行状态点 */}
      <div className="w-4 flex items-center justify-center shrink-0">
        {session.status === 'busy' ? (
          <span className="relative flex">
            <span className="absolute w-2 h-2 rounded-full bg-emerald-400 animate-ping opacity-60" />
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
          </span>
        ) : (
          <span className={`w-1.5 h-1.5 rounded-full ${session.status === 'stopped' ? 'bg-[var(--text-muted)] opacity-40' : 'bg-[var(--text-muted)] opacity-25'}`} />
        )}
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
        {/* 最近一次提问预览（与标题不同时才显示） */}
        {session.lastUserMessage && session.lastUserMessage !== title && (
          <div className="text-[10px] text-[var(--text-muted)] truncate mt-0.5 leading-tight">
            {session.lastUserMessage}
          </div>
        )}

      </div>

      {/* 悬停时显示删除按钮 */}
      {hovered && (
        <button
          className="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--error)] rounded-md text-sm leading-none border-0 cursor-pointer bg-[var(--bg-elevated)] transition-colors"
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          title={t.common.deleteSession}
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

// ─── 用户菜单（收起状态，图标触发） ──────────────────────────────────────

interface UserMenuCollapsedProps {
  wsStatus: 'connected' | 'reconnecting' | 'disconnected'
}

function UserMenuCollapsed({ wsStatus }: UserMenuCollapsedProps) {
  const { theme, toggle } = useThemeStore()
  const isDark = theme === 'dark'
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const t = useT()

  const wsColor = wsStatus === 'connected' ? '#4ade80' : wsStatus === 'reconnecting' ? '#fbbf24' : '#f87171'
  const wsLabel = wsStatus === 'connected' ? t.common.connected : wsStatus === 'reconnecting' ? t.common.reconnecting : t.common.disconnected

  // 菜单打开时注册点击外部关闭
  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  return (
    <div ref={menuRef} className="relative flex flex-col items-center">
      {/* 弹出菜单（向右展开） */}
      {open && (
        <div
          className="absolute bottom-0 left-full ml-2 w-52 rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] shadow-[var(--shadow-lg)] overflow-hidden animate-fade-in z-50"
        >
          {/* 用户信息 */}
          <div className="flex items-center gap-3 px-3.5 py-3 border-b border-[var(--border-subtle)]">
            <div className="relative shrink-0">
              <div className="w-8 h-8 rounded-full overflow-hidden border-2 border-[var(--accent-border)]">
                <img src="/avatar.png" alt={t.common.userAvatar} className="w-full h-full object-cover" />
              </div>
              <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-[var(--bg-elevated)]" style={{ background: wsColor }} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-semibold text-[var(--text-primary)] truncate">{t.common.admin}</div>
              <div className="text-[10px] text-[var(--text-muted)] flex items-center gap-1 mt-0.5">
                <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: wsColor }} />
                {wsLabel}
              </div>
            </div>
          </div>
          {/* 操作项 */}
          <div className="py-1">
            <button
              type="button"
              onClick={() => { toggle(); setOpen(false) }}
              className="flex items-center gap-2.5 w-full px-3.5 py-2 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors border-0 cursor-pointer text-left"
            >
              <span className="w-3.5 h-3.5 flex items-center justify-center shrink-0 text-[var(--text-muted)]">
                {isDark ? (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="5" />
                    <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
                    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                    <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
                    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                  </svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                  </svg>
                )}
              </span>
              {isDark ? t.common.switchToLight : t.common.switchToDark}
            </button>
          </div>
          <div className="border-t border-[var(--border-subtle)]">
            <button
              type="button"
              onClick={() => { useConnectionStore.getState().logout(); setOpen(false) }}
              className="flex items-center gap-2.5 w-full px-3.5 py-2 text-xs text-[var(--text-secondary)] hover:text-[var(--error)] hover:bg-[var(--error-subtle)] transition-colors border-0 cursor-pointer text-left"
            >
              <span className="w-3.5 h-3.5 flex items-center justify-center shrink-0">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                  <polyline points="16 17 21 12 16 7" />
                  <line x1="21" y1="12" x2="9" y2="12" />
                </svg>
              </span>
              {t.common.logout}
            </button>
          </div>
        </div>
      )}

      {/* 头像触发按钮 */}
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        title={t.common.userMenu}
        aria-label={t.common.userMenu}
        className={`relative w-8 h-8 flex items-center justify-center rounded-lg transition-all duration-150 border-0 cursor-pointer ${open ? 'bg-[var(--bg-tertiary)]' : 'hover:bg-[var(--bg-tertiary)]'}`}
      >
        <div className="relative">
          <div className="w-6 h-6 rounded-full overflow-hidden border border-[var(--border-subtle)]">
            <img src="/avatar.png" alt={t.common.userAvatar} className="w-full h-full object-cover" />
          </div>
          <span
            className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full border border-[var(--bg-secondary)]"
            style={{ background: wsColor }}
          />
        </div>
      </button>
    </div>
  )
}

// ─── 用户菜单（DeepSeek 风格弹出菜单） ────────────────────────────────────

interface UserMenuProps {
  onViewChange: (view: NavView) => void
  wsStatus: 'connected' | 'reconnecting' | 'disconnected'
}

function UserMenu({ onViewChange, wsStatus }: UserMenuProps) {
  const { theme, toggle } = useThemeStore()
  const isDark = theme === 'dark'
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const t = useT()

  // 点击外部关闭
  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  const wsLabel = wsStatus === 'connected' ? t.common.connected : wsStatus === 'reconnecting' ? t.common.reconnecting : t.common.disconnected
  const wsColor = wsStatus === 'connected' ? '#4ade80' : wsStatus === 'reconnecting' ? '#fbbf24' : '#f87171'

  return (
    <div ref={menuRef} className="relative border-t border-[var(--border-subtle)] shrink-0">
      {/* 弹出菜单 */}
      {open && (
        <div
          className="absolute bottom-full left-2 right-2 mb-1 rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] shadow-[var(--shadow-lg)] overflow-hidden animate-fade-in z-50"
          style={{ boxShadow: '0 -4px 24px rgba(0,0,0,0.35), 0 0 0 1px var(--border)' }}
        >
          {/* 用户信息头部 */}
          <div className="flex items-center gap-3 px-4 py-3.5 border-b border-[var(--border-subtle)]">
            <div className="relative shrink-0">
              <div className="w-9 h-9 rounded-full overflow-hidden border-2 border-[var(--accent-border)]">
                <img src="/avatar.png" alt={t.common.userAvatar} className="w-full h-full object-cover" />
              </div>
              {/* 连接状态角标 */}
              <span
                className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-[var(--bg-elevated)]"
                style={{ background: wsColor }}
                title={wsLabel}
              />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-[var(--text-primary)] truncate leading-tight">{t.common.admin}</div>
              <div className="text-[11px] text-[var(--text-muted)] mt-0.5 flex items-center gap-1">
                <span
                  className="inline-block w-1.5 h-1.5 rounded-full"
                  style={{ background: wsColor }}
                />
                {wsLabel}
              </div>
            </div>
          </div>

          {/* 功能菜单 */}
          <div className="py-1.5">
            {/* 主题切换 */}
            <button
              type="button"
              onClick={() => { toggle(); setOpen(false) }}
              className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors duration-100 border-0 cursor-pointer text-left"
            >
              <span className="w-4 h-4 flex items-center justify-center shrink-0 text-[var(--text-muted)]">
                {isDark ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="5" />
                    <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
                    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                    <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
                    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                  </svg>
                ) : (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                  </svg>
                )}
              </span>
              <span className="flex-1">{isDark ? t.common.switchToLight : t.common.switchToDark}</span>
            </button>

            {/* 设置 */}
            <button
              type="button"
              onClick={() => { onViewChange('settings'); setOpen(false) }}
              className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors duration-100 border-0 cursor-pointer text-left"
            >
              <span className="w-4 h-4 flex items-center justify-center shrink-0 text-[var(--text-muted)]">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
              </span>
              <span className="flex-1">{t.common.settings}</span>
            </button>
          </div>

          {/* 分割线 + 退出 */}
          <div className="border-t border-[var(--border-subtle)]">
            <button
              type="button"
              onClick={() => { useConnectionStore.getState().logout(); setOpen(false) }}
              className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-[var(--text-secondary)] hover:text-[var(--error)] hover:bg-[var(--error-subtle)] transition-colors duration-100 border-0 cursor-pointer text-left"
            >
              <span className="w-4 h-4 flex items-center justify-center shrink-0">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                  <polyline points="16 17 21 12 16 7" />
                  <line x1="21" y1="12" x2="9" y2="12" />
                </svg>
              </span>
              <span className="flex-1">{t.common.logout}</span>
            </button>
          </div>
        </div>
      )}

      {/* 触发按钮 */}
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className={[
          'flex items-center gap-2.5 w-full px-4 py-3 transition-colors duration-150 border-0 cursor-pointer text-left',
          open
            ? 'bg-[var(--bg-tertiary)]'
            : 'hover:bg-[var(--bg-tertiary)]',
        ].join(' ')}
      >
        {/* 头像 */}
        <div className="relative shrink-0">
          <div className="w-7 h-7 rounded-full overflow-hidden border border-[var(--border-subtle)]">
            <img src="/avatar.png" alt={t.common.userAvatar} className="w-full h-full object-cover" />
          </div>
          <span
            className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-[var(--bg-secondary)]"
            style={{ background: wsColor }}
          />
        </div>
        {/* 用户名 */}
        <span className="text-xs font-medium text-[var(--text-secondary)] truncate flex-1">{t.common.admin}</span>
        {/* 展开箭头 */}
        <svg
          width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
          className={`text-[var(--text-muted)] shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        >
          <polyline points="18 15 12 9 6 15" />
        </svg>
      </button>

    </div>
  )
}

// ─── NavBar 主组件 ─────────────────────────────────────────────────────────

export function NavBar({ activeView, onViewChange, onNewSession, collapsed = false, onCollapsedChange }: NavBarProps) {
  const sessions = useSessionStore((state) => state.sessions)
  const activeSessionId = useSessionStore((state) => state.activeSessionId)
  const setActive = useSessionStore((state) => state.setActive)
  const wsClients = useSessionStore((state) => state.wsClients)
  const [searchQuery, setSearchQuery] = useState('')
  // 待删除的会话（null 表示未触发确认弹窗）
  const [pendingDeleteSession, setPendingDeleteSession] = useState<SessionInfo | null>(null)
  const t = useT()

  // 根据活跃会话的 WS 状态判断连接情况
  const wsStatus: 'connected' | 'reconnecting' | 'disconnected' = (() => {
    if (!activeSessionId) return 'connected' // 无会话时不报错
    const client = wsClients.get(activeSessionId)
    if (!client) return 'disconnected'
    return client.getStatus()
  })()

  const zhileSessionId = useSessionStore((state) => state.zhileSessionId)

  const sortedSessions = [...sessions]
    .filter((s) => s.id !== zhileSessionId)
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))

  const filteredSessions = searchQuery.trim()
    ? sortedSessions.filter((s) =>
        (s.title || s.id).toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : sortedSessions

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
          title={t.common.newSession}
          aria-label={t.common.newSession}
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
            onClick={() => { onViewChange('skills'); onCollapsedChange?.(false) }}
            title={t.nav.skills}
            aria-label={t.nav.skills}
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
            title={t.nav.automation}
            aria-label={t.nav.automation}
            className={`w-8 h-8 flex items-center justify-center rounded-lg transition-all duration-150 border-0 cursor-pointer ${
              activeView === 'automation'
                ? 'bg-[var(--accent-subtle)] text-[var(--text-primary)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
            }`}
          >
            <AutomationIcon />
          </button>
          <button
            type="button"
            onClick={() => { onViewChange('zhile'); onCollapsedChange?.(false) }}
            title={t.nav.zhile}
            aria-label={t.nav.zhile}
            className={`w-8 h-8 flex items-center justify-center rounded-lg transition-all duration-150 border-0 cursor-pointer ${
              activeView === 'zhile'
                ? 'bg-[var(--accent-subtle)] text-[var(--text-primary)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
            }`}
          >
            <img src="/avatar.png" alt={t.nav.zhile} className="w-5 h-5 rounded object-cover" />
          </button>
        </div>

        {/* 底部：用户菜单 */}
        <div className="mt-auto pb-3 flex flex-col items-center gap-2">
          <UserMenuCollapsed wsStatus={wsStatus} />
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
          <img src="/avatar.png" alt={t.nav.zhile} className="w-full h-full object-cover" />
        </div>
        <span className="text-sm font-semibold text-[var(--text-primary)] truncate tracking-tight">
          {t.nav.zhile}
        </span>

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
            placeholder={t.common.searchSessions}
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
          <span>{t.common.newSession}</span>
        </button>
      </div>

      {/* ── 分割线 ── */}
      <div className="border-t border-[var(--border-subtle)] mx-3 mb-2 shrink-0" />

      {/* ── 导航菜单 ── */}
      <div className="flex flex-col gap-0.5 px-0 shrink-0">
        <NavMenuItem
          icon={<img src="/avatar.png" alt={t.nav.zhile} className="w-4 h-4 rounded object-cover" />}
          label={t.nav.zhile}
          isActive={activeView === 'zhile'}
          onClick={() => onViewChange('zhile')}
        />
        <NavMenuItem
          icon={<SkillsIcon />}
          label={t.nav.skills}
          isActive={activeView === 'skills'}
          onClick={() => onViewChange('skills')}
        />
        <NavMenuItem
          icon={<AutomationIcon />}
          label={t.nav.automation}
          isActive={activeView === 'automation'}
          onClick={() => onViewChange('automation')}
        />
      </div>

      {/* ── 分割线 + 会话列表标题 ── */}
      <div className="border-t border-[var(--border-subtle)] mx-3 mt-2 mb-1 shrink-0" />
      <div className="flex items-center justify-between px-4 py-2 shrink-0">
        <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest leading-none">
          {t.common.recentSessions}
        </span>
        <span className="text-[10px] text-[var(--text-muted)] bg-[var(--bg-tertiary)] px-1.5 py-0.5 rounded-full">
          {sessions.length}
        </span>
      </div>

      {/* ── 会话列表（可滚动） ── */}
      <div className="flex-1 overflow-y-auto py-1">
        {filteredSessions.length === 0 ? (
          <div className="px-4 py-6 text-xs text-[var(--text-muted)] text-center">
            {searchQuery ? t.common.noMatchSessions : t.common.noSessions}
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
              onDelete={() => setPendingDeleteSession(session)}
            />
          ))
        )}
      </div>

      {/* ── 底部用户区域 ── */}
      <UserMenu onViewChange={onViewChange} wsStatus={wsStatus} />

      {/* ── 删除确认弹窗 ── */}
      {pendingDeleteSession && (
        <ConfirmModal
          title={t.modal.deleteSession.title}
          message={t.modal.deleteSession.message(pendingDeleteSession.title || t.common.newSession)}
          confirmText={t.common.delete}
          cancelText={t.common.cancel}
          danger
          onConfirm={() => {
            void useSessionStore.getState().deleteSession(pendingDeleteSession.id)
            setPendingDeleteSession(null)
          }}
          onCancel={() => setPendingDeleteSession(null)}
        />
      )}
    </div>
  )
}
