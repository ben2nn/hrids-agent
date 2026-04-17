import React, { useRef, useState, useCallback } from 'react'
import { useSessionStore } from '../../store/sessionStore.js'
import { useMessageStore } from '../../store/messageStore.js'
import { RightPanel } from '../layout/RightPanel.js'
import { MessageList } from '../chat/MessageList.js'
import { InputBar } from '../chat/InputBar.js'
import { PermissionModal } from '../modals/PermissionModal.js'
import { Toast } from '../ui/Toast.js'
import type { InputBarHandle } from '../chat/InputBar.js'

// ─── Props 接口 ────────────────────────────────────────────────────────────

interface ChatPageProps {
  onNewSession: () => void
  navCollapsed?: boolean
  onNavCollapsedChange?: (collapsed: boolean) => void
}

// ─── 首页（无活跃会话时显示） ──────────────────────────────────────────────

interface HomeViewProps {
  onSend: (text: string) => void
  isCreating: boolean
}

const QUICK_TASKS = [
  { icon: '📁', text: '分析项目结构', desc: '梳理目录与模块依赖' },
  { icon: '🔧', text: '定位并修复 Bug', desc: '描述问题，Agent 自动排查' },
  { icon: '📝', text: '生成代码注释', desc: '为函数和模块补全文档' },
  { icon: '🔍', text: '代码审查', desc: '检查潜在问题与改进点' },
  { icon: '🚀', text: '编写单元测试', desc: '自动生成测试用例' },
  { icon: '⚡', text: '性能优化建议', desc: '分析瓶颈并给出方案' },
]

const FEATURES = [
  {
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" />
      </svg>
    ),
    title: '读写文件',
    desc: '直接操作项目文件，创建、编辑、重构',
  },
  {
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="3" width="20" height="14" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" />
      </svg>
    ),
    title: '执行命令',
    desc: '运行 bash / PowerShell，安装依赖，构建项目',
  },
  {
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
    ),
    title: '搜索网络',
    desc: '实时查询文档、API 参考、最新资讯',
  },
  {
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
      </svg>
    ),
    title: 'Skills 技能',
    desc: '调用预置工作流，一键完成复杂任务',
  },
]

function HomeView({ onSend, isCreating }: HomeViewProps) {
  const [text, setText] = useState('')

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      const trimmed = text.trim()
      if (trimmed && !isCreating) onSend(trimmed)
    }
  }, [text, isCreating, onSend])

  const handleSend = useCallback(() => {
    const trimmed = text.trim()
    if (trimmed && !isCreating) onSend(trimmed)
  }, [text, isCreating, onSend])

  const handleQuickTask = useCallback((taskText: string) => {
    if (!isCreating) onSend(taskText)
  }, [isCreating, onSend])

  return (
    <div className="flex flex-col h-full overflow-y-auto bg-[var(--bg-primary)]">
      <div className="flex flex-col items-center w-full max-w-2xl mx-auto px-6 py-10 gap-10">

        {/* ── 品牌区 ── */}
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="relative">
            <div className="w-16 h-16 rounded-full overflow-hidden border-2 border-[var(--accent-border)] shadow-[var(--shadow-glow)]">
              <img src="/avatar.png" alt="hrids-agent" className="w-full h-full object-cover" />
            </div>
            <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-emerald-400 border-2 border-[var(--bg-primary)] flex items-center justify-center">
              <span className="text-[8px] text-white font-bold">✓</span>
            </div>
          </div>
          <div>
            <h1 className="text-2xl font-bold text-[var(--text-primary)] tracking-tight mb-1.5">
              知了
            </h1>
            <p className="text-sm text-[var(--text-secondary)] leading-relaxed max-w-sm">
              你的 AI 开发助手。描述任务，Agent 自动读写文件、执行命令、搜索网络，帮你完成开发工作。
            </p>
          </div>
        </div>

        {/* ── 输入框 ── */}
        <div className="w-full">
          <div className="input-container px-4 py-3 shadow-[var(--shadow-lg)]">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isCreating}
              rows={3}
              placeholder="描述你想完成的任务，例如：帮我分析这个项目的结构并生成 README..."
              className="w-full bg-transparent text-[var(--text-primary)] text-sm resize-none focus:outline-none placeholder-[var(--text-muted)] leading-5 disabled:opacity-40"
              aria-label="输入任务描述"
            />
            <div className="flex items-center justify-between mt-2 pt-2 border-t border-[var(--border-subtle)]">
              <span className="text-[11px] text-[var(--text-muted)]">
                Enter 发送 · Shift+Enter 换行
              </span>
              <button
                type="button"
                onClick={handleSend}
                disabled={!text.trim() || isCreating}
                className="flex items-center gap-1.5 px-3.5 py-1.5 bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:bg-[var(--bg-tertiary)] disabled:text-[var(--text-muted)] text-white text-xs font-semibold rounded-lg transition-all duration-150 disabled:cursor-not-allowed shadow-sm"
              >
                {isCreating ? (
                  <>
                    <svg className="animate-spin" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                    </svg>
                    创建中...
                  </>
                ) : (
                  <>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
                    </svg>
                    开始任务
                  </>
                )}
              </button>
            </div>
          </div>
        </div>

        {/* ── 快捷任务 ── */}
        <div className="w-full">
          <p className="text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-3">
            快捷任务
          </p>
          <div className="grid grid-cols-2 gap-2">
            {QUICK_TASKS.map((task) => (
              <button
                key={task.text}
                type="button"
                onClick={() => handleQuickTask(task.text)}
                disabled={isCreating}
                className="flex items-start gap-3 px-4 py-3 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl text-left hover:border-[var(--accent-border)] hover:bg-[var(--accent-subtle)] transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed group"
              >
                <span className="text-lg shrink-0 mt-0.5">{task.icon}</span>
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-[var(--text-primary)] leading-tight group-hover:text-[var(--accent-light,#60a5fa)] transition-colors">
                    {task.text}
                  </div>
                  <div className="text-[11px] text-[var(--text-muted)] mt-0.5 leading-tight">
                    {task.desc}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* ── 能力说明 ── */}
        <div className="w-full">
          <p className="text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-3">
            Agent 能力
          </p>
          <div className="grid grid-cols-2 gap-2">
            {FEATURES.map((f) => (
              <div
                key={f.title}
                className="flex items-start gap-3 px-4 py-3 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl"
              >
                <span className="text-[var(--accent)] shrink-0 mt-0.5">{f.icon}</span>
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-[var(--text-primary)] leading-tight">
                    {f.title}
                  </div>
                  <div className="text-[11px] text-[var(--text-muted)] mt-0.5 leading-tight">
                    {f.desc}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── 底部提示 ── */}
        <p className="text-[11px] text-[var(--text-muted)] text-center pb-2">
          每次对话都是独立会话 · 历史记录保存在左侧列表
        </p>

      </div>
    </div>
  )
}

// ─── ChatPage 主组件 ───────────────────────────────────────────────────────

export function ChatPage({ onNewSession: _onNewSession, navCollapsed, onNavCollapsedChange }: ChatPageProps) {
  // ── Store 状态 ─────────────────────────────────────────────────────────
  const sessions = useSessionStore((s) => s.sessions)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const wsMaxRetriesExceeded = useSessionStore((s) => s.wsMaxRetriesExceeded)
  const manualReconnect = useSessionStore((s) => s.manualReconnect)
  const clearWsMaxRetries = useSessionStore((s) => s.clearWsMaxRetries)
  const sendPermissionReply = useSessionStore((s) => s.sendPermissionReply)
  const createSession = useSessionStore((s) => s.createSession)
  const sendMessage = useSessionStore((s) => s.sendMessage)

  const pendingPermission = useMessageStore((s) => s.pendingPermission)
  const clearPermission = useMessageStore((s) => s.clearPermission)
  const appendUserMessage = useMessageStore((s) => s.appendUserMessage)

  // ── 首页创建中状态 ─────────────────────────────────────────────────────
  const [isCreating, setIsCreating] = useState(false)

  // ── 当前活跃会话信息 ───────────────────────────────────────────────────
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null
  const isBusy = activeSession?.status === 'busy'

  // ── 权限请求 ───────────────────────────────────────────────────────────
  const currentPermission = activeSessionId
    ? pendingPermission.get(activeSessionId) ?? null
    : null

  // ── InputBar ref（供 RightPanel 的 FileTreeNode 插入文本） ─────────────
  const inputBarRef = useRef<InputBarHandle>(null)

  // ── 右侧面板显示状态 ───────────────────────────────────────────────────
  const [rightPanelVisible, setRightPanelVisible] = useState(true)

  // ── 权限回复处理 ───────────────────────────────────────────────────────
  function handlePermissionReply(granted: boolean) {
    if (!activeSessionId || !currentPermission) return
    sendPermissionReply(activeSessionId, currentPermission.key, granted)
    clearPermission(activeSessionId)
  }

  // ── WS 超限 toast 显示 ─────────────────────────────────────────────────
  const showWsFailedToast = activeSessionId
    ? wsMaxRetriesExceeded.has(activeSessionId)
    : false

  // ── 首页直接发送：创建会话后立即发送消息 ──────────────────────────────
  const handleHomeSend = useCallback(async (text: string) => {
    if (isCreating) return
    setIsCreating(true)
    try {
      await createSession({})
      // createSession 会设置 activeSessionId，稍等一帧再读取
      await new Promise<void>(resolve => setTimeout(resolve, 50))
      const sessionId = useSessionStore.getState().activeSessionId
      if (sessionId) {
        appendUserMessage(sessionId, text)
        sendMessage(sessionId, text)
      }
    } catch (err) {
      console.error('[ChatPage] 创建会话失败:', err)
    } finally {
      setIsCreating(false)
    }
  }, [isCreating, createSession, appendUserMessage, sendMessage])

  // ── 渲染 ───────────────────────────────────────────────────────────────
  return (
    <div className="flex h-full w-full overflow-hidden">
      {/* 中间对话区域（flex-1） */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        {activeSessionId ? (
          <>
            {/* 顶部标题栏 */}
            <div className="h-11 flex items-center px-3 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)] shrink-0 gap-2">
              {/* 左侧面板切换按钮 */}
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

              {/* 分隔线 */}
              <div className="w-px h-4 bg-[var(--border-subtle)] shrink-0" />

              {/* 会话标题 */}
              <span className="text-sm font-medium text-[var(--text-primary)] truncate flex-1">
                {activeSession?.title || '新对话'}
              </span>

              {/* 状态徽章：仅执行中时显示 */}
              {isBusy && (
                <span className="flex items-center gap-1.5 text-[11px] text-amber-400 bg-[var(--warning-subtle)] border border-amber-400/20 px-2 py-0.5 rounded-full shrink-0 font-medium">
                  <span className="relative flex">
                    <span className="absolute w-1.5 h-1.5 rounded-full bg-amber-400 animate-ping opacity-75" />
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400 inline-block" />
                  </span>
                  执行中
                </span>
              )}

              {/* 右侧面板切换按钮 */}
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

            {/* 消息列表（flex-1，可滚动） */}
            <div className="flex-1 min-h-0 overflow-hidden">
              <MessageList sessionId={activeSessionId} />
            </div>

            {/* 输入栏 */}
            <InputBar
              ref={inputBarRef}
              sessionId={activeSessionId}
              isBusy={isBusy}
            />
          </>
        ) : (
          /* 无活跃会话：首页 */
          <HomeView onSend={handleHomeSend} isCreating={isCreating} />
        )}
      </div>

      {/* 右侧面板（无会话或隐藏时不渲染） */}
      {rightPanelVisible && (
        <RightPanel
          sessionId={activeSessionId}
          inputBarRef={inputBarRef}
        />
      )}

      {/* 权限确认弹窗 */}
      {currentPermission && activeSessionId && (
        <PermissionModal
          sessionId={activeSessionId}
          permission={currentPermission}
          onReply={handlePermissionReply}
        />
      )}

      {/* WS 重连失败 Toast */}
      {showWsFailedToast && activeSessionId && (
        <Toast
          message="WebSocket 连接失败，已超过最大重连次数"
          type="error"
          action={{
            label: '手动重连',
            onClick: () => manualReconnect(activeSessionId),
          }}
          onDismiss={() => clearWsMaxRetries(activeSessionId)}
        />
      )}
    </div>
  )
}

export default ChatPage
