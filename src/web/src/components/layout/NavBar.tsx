import { useState, useRef, useEffect } from 'react'
import { useSessionStore } from '../../store/sessionStore.js'
import { useThemeStore } from '../../store/themeStore.js'
import { useConnectionStore } from '../../store/connectionStore.js'
import { ConfirmModal } from '../modals/ConfirmModal.js'
import { WeixinConnectModal } from '../modals/WeixinConnectModal.js'
import type { SessionInfo } from '../../lib/types.js'

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
  const [showWeixin, setShowWeixin] = useState(false)
  const [weixinBound, setWeixinBound] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  const wsColor = wsStatus === 'connected' ? '#4ade80' : wsStatus === 'reconnecting' ? '#fbbf24' : '#f87171'
  const wsLabel = wsStatus === 'connected' ? '已连接' : wsStatus === 'reconnecting' ? '重连中' : '已断开'

  // 菜单打开时检查微信绑定状态
  useEffect(() => {
    if (!open) return
    void (async () => {
      try {
        const { getWeixinConfig, getIMStatus } = await import('../../lib/gateway.js')
        const [cfg, status] = await Promise.all([getWeixinConfig(), getIMStatus()])
        const wx = (cfg.platforms as Record<string, unknown>[] | undefined)?.find(p => p.platform === 'weixin')
        const running = status.status?.find((s: { platform: string; running: boolean }) => s.platform === 'weixin')?.running ?? false
        setWeixinBound(!!(wx && wx.enabled === true && running))
      } catch { /* 忽略 */ }
    })()
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
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
                <img src="/avatar.png" alt="用户头像" className="w-full h-full object-cover" />
              </div>
              <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-[var(--bg-elevated)]" style={{ background: wsColor }} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-semibold text-[var(--text-primary)] truncate">admin</div>
              <div className="text-[10px] text-[var(--text-muted)] flex items-center gap-1 mt-0.5">
                <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: wsColor }} />
                {wsLabel}
              </div>
            </div>
          </div>
          {/* 操作项 */}
          <div className="py-1">
            {/* 微信绑定状态 */}
            <button
              type="button"
              onClick={() => { setShowWeixin(true); setOpen(false) }}
              className="flex items-center gap-2.5 w-full px-3.5 py-2 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors border-0 cursor-pointer text-left"
            >
              <span className="relative w-3.5 h-3.5 flex items-center justify-center shrink-0 text-[#07C160]">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.047c.134 0 .24-.111.24-.247 0-.06-.023-.12-.038-.177l-.327-1.233a.582.582 0 0 1-.023-.156.49.49 0 0 1 .201-.398C23.024 18.48 24 16.82 24 14.98c0-3.21-2.931-5.837-7.062-6.122zm-3.74 2.632c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982zm5.4 0c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982z" />
                </svg>
                {weixinBound && (
                  <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-emerald-400 border border-[var(--bg-elevated)]" />
                )}
              </span>
              {weixinBound ? '微信已绑定' : '连接微信'}
            </button>
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
              {isDark ? '日间模式' : '夜间模式'}
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
              退出登录
            </button>
          </div>
        </div>
      )}

      {/* 头像触发按钮 */}
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        title="用户菜单"
        aria-label="用户菜单"
        className={`relative w-8 h-8 flex items-center justify-center rounded-lg transition-all duration-150 border-0 cursor-pointer ${open ? 'bg-[var(--bg-tertiary)]' : 'hover:bg-[var(--bg-tertiary)]'}`}
      >
        <div className="relative">
          <div className="w-6 h-6 rounded-full overflow-hidden border border-[var(--border-subtle)]">
            <img src="/avatar.png" alt="用户头像" className="w-full h-full object-cover" />
          </div>
          <span
            className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full border border-[var(--bg-secondary)]"
            style={{ background: wsColor }}
          />
        </div>
      </button>

      {/* 微信连接弹窗 */}
      {showWeixin && <WeixinConnectModal onClose={() => setShowWeixin(false)} onDisconnected={() => setWeixinBound(false)} />}
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
  const [showWeixin, setShowWeixin] = useState(false)
  const [weixinBound, setWeixinBound] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // 点击外部关闭 + 菜单打开时检查微信绑定状态
  useEffect(() => {
    if (!open) return
    void (async () => {
      try {
        const { getWeixinConfig, getIMStatus } = await import('../../lib/gateway.js')
        const [cfg, status] = await Promise.all([getWeixinConfig(), getIMStatus()])
        const wx = (cfg.platforms as Record<string, unknown>[] | undefined)?.find(p => p.platform === 'weixin')
        const running = status.status?.find((s: { platform: string; running: boolean }) => s.platform === 'weixin')?.running ?? false
        setWeixinBound(!!(wx && wx.enabled === true && running))
      } catch { /* 忽略 */ }
    })()
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  const wsLabel = wsStatus === 'connected' ? '已连接' : wsStatus === 'reconnecting' ? '重连中' : '已断开'
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
                <img src="/avatar.png" alt="用户头像" className="w-full h-full object-cover" />
              </div>
              {/* 连接状态角标 */}
              <span
                className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-[var(--bg-elevated)]"
                style={{ background: wsColor }}
                title={wsLabel}
              />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-[var(--text-primary)] truncate leading-tight">admin</div>
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
            {/* 微信绑定状态 */}
            <button
              type="button"
              onClick={() => { setShowWeixin(true); setOpen(false) }}
              className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors duration-100 border-0 cursor-pointer text-left"
            >
              <span className="relative w-4 h-4 flex items-center justify-center shrink-0 text-[#07C160]">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.047c.134 0 .24-.111.24-.247 0-.06-.023-.12-.038-.177l-.327-1.233a.582.582 0 0 1-.023-.156.49.49 0 0 1 .201-.398C23.024 18.48 24 16.82 24 14.98c0-3.21-2.931-5.837-7.062-6.122zm-3.74 2.632c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982zm5.4 0c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982z" />
                </svg>
                {weixinBound && (
                  <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-emerald-400 border border-[var(--bg-elevated)]" />
                )}
              </span>
              <span className="flex-1">{weixinBound ? '微信已绑定' : '连接微信'}</span>
            </button>

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
              <span className="flex-1">{isDark ? '切换到日间模式' : '切换到夜间模式'}</span>
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
              <span className="flex-1">系统设置</span>
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
              <span className="flex-1">退出登录</span>
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
            <img src="/avatar.png" alt="用户头像" className="w-full h-full object-cover" />
          </div>
          <span
            className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-[var(--bg-secondary)]"
            style={{ background: wsColor }}
          />
        </div>
        {/* 用户名 */}
        <span className="text-xs font-medium text-[var(--text-secondary)] truncate flex-1">admin</span>
        {/* 展开箭头 */}
        <svg
          width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
          className={`text-[var(--text-muted)] shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        >
          <polyline points="18 15 12 9 6 15" />
        </svg>
      </button>

      {/* 微信连接弹窗 */}
      {showWeixin && <WeixinConnectModal onClose={() => setShowWeixin(false)} onDisconnected={() => setWeixinBound(false)} />}
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
            onClick={() => { onViewChange('skills'); onCollapsedChange?.(false) }}
            title="技能"
            aria-label="技能"
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
          <button
            type="button"
            onClick={() => { onViewChange('zhile'); onCollapsedChange?.(false) }}
            title="知了"
            aria-label="知了"
            className={`w-8 h-8 flex items-center justify-center rounded-lg transition-all duration-150 border-0 cursor-pointer ${
              activeView === 'zhile'
                ? 'bg-[var(--accent-subtle)] text-[var(--text-primary)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
            }`}
          >
            <img src="/avatar.png" alt="知了" className="w-5 h-5 rounded object-cover" />
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
          <img src="/avatar.png" alt="知了" className="w-full h-full object-cover" />
        </div>
        <span className="text-sm font-semibold text-[var(--text-primary)] truncate tracking-tight">
          知了
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
          icon={<img src="/avatar.png" alt="知了" className="w-4 h-4 rounded object-cover" />}
          label="知了"
          isActive={activeView === 'zhile'}
          onClick={() => onViewChange('zhile')}
        />
        <NavMenuItem
          icon={<SkillsIcon />}
          label="技能"
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
          title="删除会话"
          message={`确定要删除「${pendingDeleteSession.title || '新会话'}」吗？此操作将同时删除该会话的所有工作区文件，且无法恢复。`}
          confirmText="删除"
          cancelText="取消"
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
