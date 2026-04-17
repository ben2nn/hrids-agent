import { useEffect, useState } from 'react'
import { useConnectionStore } from '../../store/connectionStore.js'

interface ConnectPageProps {
  onConnected: () => void
}

export function ConnectPage({ onConnected }: ConnectPageProps) {
  const {
    gatewayUrl,
    authToken,
    isConnected,
    isChecking,
    setConfig,
    checkConnection,
    loadFromStorage,
  } = useConnectionStore()

  const [url, setUrl] = useState(gatewayUrl)
  const [token, setToken] = useState(authToken)
  const [hasError, setHasError] = useState(false)

  useEffect(() => {
    loadFromStorage()
  }, [loadFromStorage])

  useEffect(() => {
    setUrl(gatewayUrl)
    setToken(authToken)
  }, [gatewayUrl, authToken])

  useEffect(() => {
    if (isConnected) {
      onConnected()
    }
  }, [isConnected, onConnected])

  async function handleConnect() {
    setHasError(false)
    setConfig(url, token)
    await checkConnection()
    if (!useConnectionStore.getState().isConnected) {
      setHasError(true)
    }
  }

  return (
    <div className="flex items-center justify-center h-screen bg-[var(--bg-primary)]">
      {/* 背景装饰 */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full bg-[var(--accent)] opacity-[0.03] blur-3xl" />
      </div>

      <div className="relative w-[380px] bg-[var(--bg-secondary)] rounded-2xl p-8 border border-[var(--border)] shadow-[var(--shadow-lg)] animate-fade-in">
        {/* Logo / 标题 */}
        <div className="flex flex-col items-center mb-8">
          <div className="relative mb-4">
            <div className="w-14 h-14 rounded-full overflow-hidden border-2 border-[var(--accent-border)] shadow-[var(--shadow-glow)]">
              <img src="/avatar.png" alt="hrids-agent" className="w-full h-full object-cover" />
            </div>
            <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-[var(--bg-secondary)] border border-[var(--border)] flex items-center justify-center">
              <div className="w-2.5 h-2.5 rounded-full bg-[var(--accent)]" />
            </div>
          </div>
          <h1 className="text-xl font-semibold text-[var(--text-primary)] tracking-tight">
            知了
          </h1>
          <p className="text-sm text-[var(--text-secondary)] mt-1">连接到 Gateway 服务</p>
        </div>

        {/* 表单 */}
        <div className="flex flex-col gap-4">
          {/* Gateway URL */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-[var(--text-secondary)] uppercase tracking-wide" htmlFor="gateway-url">
              Gateway URL
            </label>
            <input
              id="gateway-url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={isChecking}
              placeholder="http://localhost:3282"
              className="w-full px-3.5 py-2.5 rounded-xl text-sm bg-[var(--bg-tertiary)] border border-[var(--border)] text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--accent-subtle)] disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            />
          </div>

          {/* Auth Token */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-[var(--text-secondary)] uppercase tracking-wide" htmlFor="auth-token">
              Auth Token
              <span className="ml-1.5 text-[var(--text-muted)] normal-case font-normal">（可选）</span>
            </label>
            <input
              id="auth-token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              disabled={isChecking}
              placeholder="Bearer token..."
              className="w-full px-3.5 py-2.5 rounded-xl text-sm bg-[var(--bg-tertiary)] border border-[var(--border)] text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--accent-subtle)] disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            />
          </div>

          {/* 错误提示 */}
          {hasError && (
            <div className="flex items-center gap-2 bg-[var(--error-subtle)] border border-[var(--error)]/20 rounded-xl px-3.5 py-2.5 animate-fade-in">
              <svg className="text-[var(--error)] shrink-0" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <p className="text-sm text-[var(--error)]">
                连接失败，请检查地址和 Token
              </p>
            </div>
          )}

          {/* 连接按钮 */}
          <button
            type="button"
            onClick={handleConnect}
            disabled={isChecking}
            className="w-full py-2.5 mt-1 rounded-xl text-sm font-semibold text-white bg-[var(--accent)] hover:bg-[var(--accent-hover)] active:scale-[0.98] transition-all duration-150 disabled:opacity-60 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-[var(--accent-subtle)] shadow-sm"
          >
            {isChecking ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
                连接中...
              </span>
            ) : '连接'}
          </button>
        </div>
      </div>
    </div>
  )
}
