import { useEffect, useState } from 'react'
import { useConnectionStore } from './store/connectionStore.js'
import { useSessionStore } from './store/sessionStore.js'
import { ConnectPage } from './components/pages/ConnectPage.js'
import { ChatPage } from './components/pages/ChatPage.js'
import { SkillsPage } from './components/pages/SkillsPage.js'
import { AutomationPage } from './components/pages/AutomationPage.js'
import { ZhilePage } from './components/pages/ZhilePage.js'
import { SettingsPage } from './components/pages/SettingsPage.js'
import { NavBar } from './components/layout/NavBar.js'
import type { NavView } from './components/layout/NavBar.js'
import { useT } from './i18n/useT.js'

// ─── 加载中界面 ────────────────────────────────────────────────────────────

function LoadingScreen() {
  const t = useT()
  return (
    <div className="flex items-center justify-center h-screen bg-[var(--bg-primary)]">
      <div className="flex flex-col items-center gap-3">
        <img src="/avatar.png" alt="loading" className="w-10 h-10 rounded-full animate-pulse" />
        <p className="text-sm text-[var(--text-secondary)]">{t.common.connecting}</p>
      </div>
    </div>
  )
}

// ─── App 根组件 ────────────────────────────────────────────────────────────

export function App() {
  const { isConnected, isChecking, needsLogin, loadFromStorage, checkConnection } = useConnectionStore()
  // 当前视图
  const [view, setView] = useState<NavView>('chat')
  // 左侧边栏折叠状态
  const [navCollapsed, setNavCollapsed] = useState(false)
  // 是否已完成初始化（连接检查完成）
  const [initialized, setInitialized] = useState(false)

  // ── 启动时：恢复配置 → 检查连接 ───────────────────────────────────────
  useEffect(() => {
    async function init() {
      loadFromStorage()
      await checkConnection()
      setInitialized(true)
    }
    void init()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── 连接成功后：拉取会话列表，并自动恢复上次活跃会话 ─────────────────
  useEffect(() => {
    if (isConnected) {
      void useSessionStore.getState().fetchSessions().then(() => {
        const { sessions, activeSessionId, setActive, initZhileSession } = useSessionStore.getState()

        // 初始化知了专属会话
        void initZhileSession()

        // 过滤掉已停止的会话（stopped 状态需要 resume，不自动恢复）
        const liveSessions = sessions.filter(s => s.status !== 'stopped')
        if (liveSessions.length === 0) return

        // 优先恢复上次活跃的会话（内存中或 localStorage 持久化的），否则选第一个
        const savedId = (() => { try { return localStorage.getItem('hrids_active_session_id') } catch { return null } })()
        const preferredId = activeSessionId ?? savedId
        const targetId = (preferredId && liveSessions.some(s => s.id === preferredId))
          ? preferredId
          : liveSessions[0].id

        setActive(targetId)
      })
    }
  }, [isConnected])

  async function handleNewSession() {
    try {
      await useSessionStore.getState().createSession({})
      setView('chat')
    } catch (err) {
      console.error('[App] 新建会话失败:', err)
    }
  }

  // ── 渲染 ───────────────────────────────────────────────────────────────

  // 初始化中（正在检查连接）
  if (!initialized || isChecking) {
    return <LoadingScreen />
  }

  // 未连接或需要登录：显示登录页
  if (!isConnected || needsLogin) {
    return (
      <ConnectPage
        onConnected={() => {
          void useSessionStore.getState().fetchSessions()
        }}
      />
    )
  }

  // 已连接：显示主界面（NavBar 全局固定 + 内容区域）
  return (
    <>
      <div className="flex h-screen w-screen overflow-hidden bg-[var(--bg-primary)]">
        {/* 左侧导航栏（全局，64px） */}
        <NavBar
          activeView={view}
          onViewChange={setView}
          onNewSession={handleNewSession}
          collapsed={navCollapsed}
          onCollapsedChange={setNavCollapsed}
        />

        {/* 内容区域（flex-1） */}
        <div className="flex flex-1 min-w-0 overflow-hidden">
          {view === 'chat' && (
            <ChatPage
              onNewSession={handleNewSession}
              navCollapsed={navCollapsed}
              onNavCollapsedChange={setNavCollapsed}
            />
          )}
          {view === 'skills' && (
            <div className="flex-1 overflow-hidden">
              <SkillsPage />
            </div>
          )}
          {view === 'automation' && (
            <div className="flex-1 overflow-hidden">
              <AutomationPage />
            </div>
          )}
          {view === 'zhile' && (
            <div className="flex-1 overflow-hidden">
              <ZhilePage
                navCollapsed={navCollapsed}
                onNavCollapsedChange={setNavCollapsed}
              />
            </div>
          )}
          {view === 'settings' && (
            <div className="flex-1 overflow-hidden">
              <SettingsPage />
            </div>
          )}
        </div>
      </div>
    </>
  )
}

export default App
