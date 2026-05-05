import { useRef, useState, useEffect } from 'react'
import { useSessionStore } from '../../store/sessionStore.js'
import { useMessageStore } from '../../store/messageStore.js'
import { RightPanel } from '../layout/RightPanel.js'
import { MessageList } from '../chat/MessageList.js'
import { InputBar } from '../chat/InputBar.js'
import { PermissionModal } from '../modals/PermissionModal.js'
import { AskUserModal } from '../modals/AskUserModal.js'
import { Toast } from '../ui/Toast.js'
import type { InputBarHandle } from '../chat/InputBar.js'
// ─── Props ─────────────────────────────────────────────────────────────────

interface ZhilePageProps {
  navCollapsed?: boolean
  onNavCollapsedChange?: (collapsed: boolean) => void
}

// ─── 加载中占位 ────────────────────────────────────────────────────────────

function LoadingView() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 text-[var(--text-muted)]">
      <img src="/avatar.png" alt="知了" className="w-10 h-10 rounded-full animate-pulse opacity-60" />
      <span className="text-sm">正在准备知了频道...</span>
    </div>
  )
}

// ─── ZhilePage 主组件 ──────────────────────────────────────────────────────

export function ZhilePage({ navCollapsed, onNavCollapsedChange }: ZhilePageProps) {
  const sessions = useSessionStore((s) => s.sessions)
  const zhileSessionId = useSessionStore((s) => s.zhileSessionId)
  const wsMaxRetriesExceeded = useSessionStore((s) => s.wsMaxRetriesExceeded)
  const manualReconnect = useSessionStore((s) => s.manualReconnect)
  const clearWsMaxRetries = useSessionStore((s) => s.clearWsMaxRetries)
  const sendPermissionReply = useSessionStore((s) => s.sendPermissionReply)
  const sendUserReply = useSessionStore((s) => s.sendUserReply)
  const setActive = useSessionStore((s) => s.setActive)
  const sendClearHistory = useSessionStore((s) => s.sendClearHistory)

  const pendingPermission = useMessageStore((s) => s.pendingPermission)
  const pendingAskUser = useMessageStore((s) => s.pendingAskUser)
  const clearPermission = useMessageStore((s) => s.clearPermission)
  const clearAskUser = useMessageStore((s) => s.clearAskUser)

  const inputBarRef = useRef<InputBarHandle>(null)
  const [rightPanelVisible, setRightPanelVisible] = useState(true)
  const [showClearConfirm, setShowClearConfirm] = useState(false)

  // 进入知了页面时，将知了会话设为活跃（确保 WS 连接建立）
  useEffect(() => {
    if (zhileSessionId) {
      setActive(zhileSessionId)
    }
  }, [zhileSessionId, setActive])

  const zhileSession = zhileSessionId
    ? sessions.find((s) => s.id === zhileSessionId) ?? null
    : null

  const isBusy = zhileSession?.status === 'busy'

  const currentPermission = zhileSessionId
    ? pendingPermission.get(zhileSessionId) ?? null
    : null

  const currentAskUser = zhileSessionId
    ? pendingAskUser.get(zhileSessionId) ?? null
    : null

  const showWsFailedToast = zhileSessionId
    ? wsMaxRetriesExceeded.has(zhileSessionId)
    : false

  function handlePermissionReply(granted: boolean, options?: { permanent?: boolean; session?: boolean; ruleContent?: string }) {
    if (!zhileSessionId || !currentPermission) return
    sendPermissionReply(zhileSessionId, currentPermission.key, granted, options)
    clearPermission(zhileSessionId)
  }

  function handleAskUserReply(answer: string) {
    if (!zhileSessionId || !currentAskUser) return
    sendUserReply(zhileSessionId, answer)
    clearAskUser(zhileSessionId)
  }

  return (
    <div className="flex h-full w-full overflow-hidden">
      {/* 中间对话区域 */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        {/* 顶部标题栏 */}
        <div className="h-11 flex items-center px-3 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)] shrink-0 gap-2">
          {/* 左侧面板切换 */}
          <button
            type="button"
            onClick={() => onNavCollapsedChange?.(!navCollapsed)}
            title={navCollapsed ? '展开左侧面板' : '收起左侧面板'}
            aria-label={navCollapsed ? '展开左侧面板' : '收起左侧面板'}
            className={`w-7 h-7 flex items-center justify-center rounded-lg transition-all duration-150 border-0 cursor-pointer shrink-0 ${
              !navCollapsed
                ? 'text-[var(--text-secondary)] bg-[var(--accent-subtle)] hover:bg-[var(--bg-tertiary)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
            }`}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <line x1="9" y1="3" x2="9" y2="21" />
            </svg>
          </button>

          <div className="w-px h-4 bg-[var(--border-subtle)] shrink-0" />

          {/* 知了图标 + 标题 */}
          <div className="w-5 h-5 rounded overflow-hidden shrink-0">
            <img src="/avatar.png" alt="知了" className="w-full h-full object-cover" />
          </div>
          <span className="text-sm font-semibold text-[var(--text-primary)] truncate flex-1">
            知了
          </span>

          {/* 执行中徽章 */}
          {isBusy && (
            <span className="flex items-center gap-1.5 text-[11px] text-amber-400 bg-[var(--warning-subtle)] border border-amber-400/20 px-2 py-0.5 rounded-full shrink-0 font-medium">
              <span className="relative flex">
                <span className="absolute w-1.5 h-1.5 rounded-full bg-amber-400 animate-ping opacity-75" />
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 inline-block" />
              </span>
              执行中
            </span>
          )}

          {/* 清除聊天按钮 */}
          {zhileSessionId && !isBusy && (
            <div className="relative">
              {showClearConfirm ? (
                <div className="flex items-center gap-1 animate-fade-in">
                  <span className="text-[11px] text-[var(--text-muted)] shrink-0">确认清除？</span>
                  <button
                    type="button"
                    onClick={() => {
                      sendClearHistory(zhileSessionId)
                      setShowClearConfirm(false)
                    }}
                    className="text-[11px] font-semibold text-[var(--error)] hover:text-[var(--error)] bg-[var(--error-subtle)] hover:bg-[var(--error)]/20 border border-[var(--error)]/30 px-2 py-0.5 rounded-md transition-all"
                  >
                    清除
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowClearConfirm(false)}
                    className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] bg-[var(--bg-tertiary)] border border-[var(--border)] px-2 py-0.5 rounded-md transition-all"
                  >
                    取消
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowClearConfirm(true)}
                  title="清除所有聊天记录"
                  aria-label="清除聊天"
                  className="w-7 h-7 flex items-center justify-center rounded-lg text-[var(--text-muted)] hover:text-[var(--error)] hover:bg-[var(--error-subtle)] transition-all duration-150 border-0 cursor-pointer shrink-0"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                    <path d="M10 11v6" /><path d="M14 11v6" />
                    <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                  </svg>
                </button>
              )}
            </div>
          )}

          {/* 右侧面板切换 */}
          <button
            type="button"
            onClick={() => setRightPanelVisible(v => !v)}
            title={rightPanelVisible ? '隐藏右侧面板' : '显示右侧面板'}
            aria-label={rightPanelVisible ? '隐藏右侧面板' : '显示右侧面板'}
            className={`w-7 h-7 flex items-center justify-center rounded-lg transition-all duration-150 border-0 cursor-pointer shrink-0 ${
              rightPanelVisible
                ? 'text-[var(--text-secondary)] bg-[var(--accent-subtle)] hover:bg-[var(--bg-tertiary)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
            }`}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <line x1="15" y1="3" x2="15" y2="21" />
            </svg>
          </button>
        </div>

        {/* 消息区 / 加载中 */}
        <div className="flex-1 min-h-0 overflow-hidden relative">
          {zhileSessionId ? (
            <MessageList sessionId={zhileSessionId} />
          ) : (
            <LoadingView />
          )}
        </div>

        {/* 输入栏 */}
        {zhileSessionId && (
          <InputBar
            ref={inputBarRef}
            sessionId={zhileSessionId}
            isBusy={isBusy ?? false}
          />
        )}
      </div>

      {/* 右侧面板 */}
      {rightPanelVisible && (
        <RightPanel
          sessionId={zhileSessionId}
          inputBarRef={inputBarRef}
        />
      )}

      {/* 权限确认弹窗 */}
      {currentPermission && zhileSessionId && (
        <PermissionModal
          sessionId={zhileSessionId}
          permission={currentPermission}
          onReply={handlePermissionReply}
        />
      )}

      {/* Agent 提问弹窗 */}
      {currentAskUser && zhileSessionId && (
        <AskUserModal
          sessionId={zhileSessionId}
          askUserState={currentAskUser}
          onReply={handleAskUserReply}
        />
      )}

      {/* WS 重连失败 Toast */}
      {showWsFailedToast && zhileSessionId && (
        <Toast
          message="WebSocket 连接失败，已超过最大重连次数"
          type="error"
          action={{
            label: '手动重连',
            onClick: () => manualReconnect(zhileSessionId),
          }}
          onDismiss={() => clearWsMaxRetries(zhileSessionId)}
        />
      )}
    </div>
  )
}

export default ZhilePage
