import { useState, useEffect, useCallback } from 'react'
import { getWeixinConfig, getIMStatus } from '../../../lib/gateway.js'
import { WeixinConnectModal } from '../../modals/WeixinConnectModal.js'

// ─── 微信图标 ──────────────────────────────────────────────────────────────

const WeixinIcon = ({ size = 22 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.047c.134 0 .24-.111.24-.247 0-.06-.023-.12-.038-.177l-.327-1.233a.582.582 0 0 1-.023-.156.49.49 0 0 1 .201-.398C23.024 18.48 24 16.82 24 14.98c0-3.21-2.931-5.837-7.062-6.122zm-3.74 2.632c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982zm5.4 0c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982z" />
  </svg>
)

// ─── 渠道卡片 ──────────────────────────────────────────────────────────────

interface ChannelCardProps {
  icon: React.ReactNode
  name: string
  desc: string
  connected: boolean
  accountId?: string
  loading: boolean
  comingSoon?: boolean
  accentColor?: string
  onClick: () => void
}

function ChannelCard({ icon, name, desc, connected, accountId, loading, comingSoon, accentColor, onClick }: ChannelCardProps) {
  const isDisabled = comingSoon || loading
  return (
    <button
      type="button"
      onClick={isDisabled ? undefined : onClick}
      disabled={isDisabled}
      className={[
        'group relative flex flex-col gap-4 p-4 rounded-xl border text-left transition-all duration-200 bg-[var(--bg-secondary)]',
        comingSoon
          ? 'border-[var(--border)] opacity-60 cursor-not-allowed'
          : connected
            ? 'border-emerald-500/30 hover:border-emerald-500/60 hover:shadow-md cursor-pointer'
            : 'border-[var(--border)] hover:border-[var(--accent-border)] hover:shadow-md cursor-pointer',
      ].join(' ')}
      style={connected && accentColor ? { boxShadow: `0 0 0 1px ${accentColor}22` } : undefined}
    >
      {comingSoon && (
        <span className="absolute top-3 right-3 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-muted)] border border-[var(--border)]">
          即将推出
        </span>
      )}

      <div className="flex items-start justify-between">
        <div className="w-11 h-11 rounded-xl bg-[var(--bg-tertiary)] border border-[var(--border)] flex items-center justify-center shrink-0 group-hover:border-[var(--border-focus)] transition-colors">
          {loading ? (
            <svg className="animate-spin text-[var(--text-muted)]" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
          ) : icon}
        </div>
        {!comingSoon && (
          <div className={[
            'flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] font-semibold border',
            connected
              ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
              : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)] border-[var(--border)]',
          ].join(' ')}>
            <span className={['w-1.5 h-1.5 rounded-full', connected ? 'bg-emerald-400 animate-pulse' : 'bg-[var(--text-muted)] opacity-50'].join(' ')} />
            {loading ? '检查中' : connected ? '已连接' : '未连接'}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-sm font-semibold text-[var(--text-primary)]">{name}</span>
        <span className="text-xs text-[var(--text-muted)] leading-relaxed">{desc}</span>
        {connected && accountId && (
          <span className="text-[11px] text-emerald-400/80 font-mono truncate mt-0.5">{accountId}</span>
        )}
      </div>

      {!comingSoon && (
        <div className={[
          'flex items-center gap-1.5 text-[11px] font-medium transition-colors',
          connected ? 'text-[var(--text-muted)] group-hover:text-emerald-400' : 'text-[var(--text-muted)] group-hover:text-[var(--accent)]',
        ].join(' ')}>
          {connected ? (
            <>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
              管理连接
            </>
          ) : (
            <>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
              </svg>
              立即连接
            </>
          )}
        </div>
      )}
    </button>
  )
}

// ─── 渠道面板 ──────────────────────────────────────────────────────────────

export function ChannelsPanel() {
  const [weixinConnected, setWeixinConnected] = useState(false)
  const [weixinAccountId, setWeixinAccountId] = useState('')
  const [weixinLoading, setWeixinLoading] = useState(true)
  const [showWeixinModal, setShowWeixinModal] = useState(false)

  const loadWeixinStatus = useCallback(async () => {
    setWeixinLoading(true)
    try {
      const [cfg, status] = await Promise.all([getWeixinConfig(), getIMStatus()])
      const wx = (cfg.platforms as Record<string, unknown>[] | undefined)
        ?.find((p) => p.platform === 'weixin')
      const running = status.status
        ?.find((s: { platform: string; running: boolean }) => s.platform === 'weixin')
        ?.running ?? false
      void running
      if (wx && wx.enabled === true) {
        setWeixinConnected(true)
        setWeixinAccountId(String(wx.accountId ?? ''))
      } else {
        setWeixinConnected(false)
        setWeixinAccountId('')
      }
    } catch {
      setWeixinConnected(false)
      setWeixinAccountId('')
    } finally {
      setWeixinLoading(false)
    }
  }, [])

  useEffect(() => { void loadWeixinStatus() }, [loadWeixinStatus])

  return (
    <div className="flex flex-col gap-5">
      {/* 说明 */}
      <div className="flex items-start gap-3 px-4 py-3.5 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border)]">
        <div className="w-7 h-7 rounded-lg bg-[var(--accent-subtle)] flex items-center justify-center shrink-0 mt-0.5">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--accent)]">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        </div>
        <div>
          <p className="text-sm font-semibold text-[var(--text-primary)]">消息渠道</p>
          <p className="text-xs text-[var(--text-muted)] mt-0.5 leading-relaxed">
            连接即时通讯平台，让 AI 助手通过这些渠道接收和回复消息。
          </p>
        </div>
      </div>

      {/* 卡片网格 */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <ChannelCard
          icon={<span className="text-[#07C160]"><WeixinIcon size={24} /></span>}
          name="微信"
          desc="通过 iLink Bot API 接入微信个人号，支持扫码授权或手动配置 Token。"
          connected={weixinConnected}
          accountId={weixinAccountId}
          loading={weixinLoading}
          accentColor="#07C160"
          onClick={() => setShowWeixinModal(true)}
        />
        <ChannelCard
          icon={
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--text-muted)]">
              <rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /><path d="M7 8h.01M12 8h.01M17 8h.01" />
            </svg>
          }
          name="企业微信"
          desc="接入企业微信机器人，支持群消息和单聊。"
          connected={false}
          loading={false}
          comingSoon
          onClick={() => {}}
        />
        <ChannelCard
          icon={
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--text-muted)]">
              <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
            </svg>
          }
          name="钉钉"
          desc="接入钉钉机器人，支持工作群消息和任务通知。"
          connected={false}
          loading={false}
          comingSoon
          onClick={() => {}}
        />
      </div>

      {showWeixinModal && (
        <WeixinConnectModal
          onClose={() => { setShowWeixinModal(false); void loadWeixinStatus() }}
          onDisconnected={() => { setWeixinConnected(false); setWeixinAccountId('') }}
        />
      )}
    </div>
  )
}
