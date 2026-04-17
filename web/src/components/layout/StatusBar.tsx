import { useMessageStore } from '../../store/messageStore.js'

// ─── Props 接口 ────────────────────────────────────────────────────────────

interface StatusBarProps {
  sessionId: string | null
  wsStatus: 'connected' | 'reconnecting' | 'disconnected'
  onManualReconnect?: () => void
}

// ─── WS 状态指示器 ─────────────────────────────────────────────────────────

interface WsIndicatorProps {
  status: 'connected' | 'reconnecting' | 'disconnected'
}

function WsIndicator({ status }: WsIndicatorProps) {
  if (status === 'connected') {
    return (
      <span className="flex items-center gap-1.5 text-emerald-400">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block" />
        <span>已连接</span>
      </span>
    )
  }
  if (status === 'reconnecting') {
    return (
      <span className="flex items-center gap-1.5 text-amber-400">
        <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse inline-block" />
        <span>重连中...</span>
      </span>
    )
  }
  return (
    <span className="flex items-center gap-1.5 text-[var(--error)]">
      <span className="w-1.5 h-1.5 rounded-full bg-[var(--error)] inline-block" />
      <span>断开</span>
    </span>
  )
}

// ─── StatusBar 组件 ────────────────────────────────────────────────────────

export function StatusBar({ sessionId, wsStatus, onManualReconnect }: StatusBarProps) {
  const costInfo = useMessageStore((state) =>
    sessionId ? state.costInfo.get(sessionId) : undefined,
  )

  const model = costInfo?.model ?? '—'
  const inputTokens = costInfo?.inputTokens ?? 0
  const outputTokens = costInfo?.outputTokens ?? 0
  const cost = costInfo?.cost ?? 0

  return (
    <div className="h-7 flex items-center gap-3 px-4 text-[11px] text-[var(--text-secondary)] bg-[var(--bg-secondary)] border-t border-[var(--border-subtle)] select-none">
      {/* 模型名称 */}
      <span className="font-mono text-[var(--text-muted)]">{model}</span>

      <span className="text-[var(--text-muted)] opacity-40">·</span>

      {/* 累计 token */}
      <span className="text-[var(--text-muted)]">
        ↑{inputTokens.toLocaleString()} ↓{outputTokens.toLocaleString()}
      </span>

      <span className="text-[var(--text-muted)] opacity-40">·</span>

      {/* 累计费用 */}
      <span className="text-[var(--text-muted)]">${cost.toFixed(4)}</span>

      {/* 弹性空间 */}
      <span className="flex-1" />

      {/* WS 连接状态 */}
      <WsIndicator status={wsStatus} />

      {/* 断开时显示手动重连按钮 */}
      {wsStatus === 'disconnected' && onManualReconnect && (
        <button
          onClick={onManualReconnect}
          className="text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors text-[11px] font-medium"
        >
          重连
        </button>
      )}
    </div>
  )
}
