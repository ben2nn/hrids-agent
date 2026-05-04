import { useState, useEffect, useRef, useCallback } from 'react'
import {
  getWeixinConfig,
  saveWeixinConfig,
  getIMStatus,
  startWeixinLogin,
  getWeixinLoginStatus,
} from '../../lib/gateway.js'

// ── 微信图标 ──────────────────────────────────────────────────────────────
const WeixinIcon = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.047c.134 0 .24-.111.24-.247 0-.06-.023-.12-.038-.177l-.327-1.233a.582.582 0 0 1-.023-.156.49.49 0 0 1 .201-.398C23.024 18.48 24 16.82 24 14.98c0-3.21-2.931-5.837-7.062-6.122zm-3.74 2.632c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982zm5.4 0c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982z" />
  </svg>
)

const SpinIcon = ({ size = 14 }: { size?: number }) => (
  <svg className="animate-spin" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
  </svg>
)

const CloseIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
  </svg>
)

// ── 类型 ──────────────────────────────────────────────────────────────────

interface WeixinConnectModalProps {
  onClose: () => void
  /** 解绑成功后的回调，用于通知父组件刷新绑定状态 */
  onDisconnected?: () => void
}

// check: 初始化加载中
// qrcode: 展示二维码等待扫码
// scaned: 已扫码等待手机确认
// connected: 已连接
// manual: 手动填写 token/accountId
type Step = 'check' | 'qrcode' | 'scaned' | 'connected' | 'manual'

// ── 主组件 ────────────────────────────────────────────────────────────────

export function WeixinConnectModal({ onClose, onDisconnected }: WeixinConnectModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null)
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [step, setStep] = useState<Step>('check')
  const [accountId, setAccountId] = useState('')
  const [qrcodeImgUrl, setQrcodeImgUrl] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  // 手动配置表单
  const [manualToken, setManualToken] = useState('')
  const [manualAccountId, setManualAccountId] = useState('')
  const [manualAllowedUsers, setManualAllowedUsers] = useState('')

  // ── 初始化：检查现有配置 ──────────────────────────────────────────────
  useEffect(() => {
    void (async () => {
      try {
        const [cfg, status] = await Promise.all([getWeixinConfig(), getIMStatus()])
        const wx = (cfg.platforms as Record<string, unknown>[] | undefined)
          ?.find((p) => p.platform === 'weixin')
        const running = status.status
          ?.find((s: { platform: string; running: boolean }) => s.platform === 'weixin')
          ?.running ?? false

        if (wx && running && wx.enabled === true) {
          // 已绑定且运行中 → 直接显示已连接
          setAccountId(String(wx.accountId ?? ''))
          setStep('connected')
        } else if (wx && wx.enabled === true) {
          // 有配置但适配器未运行（可能刚重启）→ 也显示已连接，让用户决定是否解绑
          setAccountId(String(wx.accountId ?? ''))
          setStep('connected')
        } else {
          // 没有配置或已禁用 → 发起扫码
          setStep('qrcode')
          void handleStartQrCode()
        }
      } catch {
        setStep('qrcode')
        void handleStartQrCode()
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── ESC 关闭 ──────────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  // ── 清理轮询定时器 ────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current)
    }
  }, [])

  // ── 发起扫码登录 ──────────────────────────────────────────────────────
  async function handleStartQrCode() {
    setError('')
    setQrcodeImgUrl('')
    try {
      const qr = await startWeixinLogin()
      setQrcodeImgUrl(qr.qrcodeImgUrl)
      setStep('qrcode')
      startPolling()
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
      setStep('manual')
    }
  }

  // ── 轮询扫码状态 ──────────────────────────────────────────────────────
  const startPolling = useCallback(() => {
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current)

    async function poll() {
      try {
        const result = await getWeixinLoginStatus()

        if (result.status === 'scaned') {
          setStep('scaned')
          // 继续轮询等待确认
          pollTimerRef.current = setTimeout(() => void poll(), 2000)
          return
        }

        if (result.status === 'confirmed') {
          // 登录成功，更新二维码图片（可能已更新）
          if (result.qrcodeImgUrl) setQrcodeImgUrl(result.qrcodeImgUrl)
          setAccountId(result.accountId ?? '')
          setStep('connected')
          return
        }

        if (result.status === 'expired') {
          setError('二维码已过期，请重新获取')
          setStep('qrcode')
          setQrcodeImgUrl('')
          return
        }

        if (result.status === 'error') {
          setError(result.error ?? '扫码登录出错，请重试')
          setStep('qrcode')
          return
        }

        // pending：继续轮询
        pollTimerRef.current = setTimeout(() => void poll(), 2000)
      } catch {
        // 网络错误，稍后重试
        pollTimerRef.current = setTimeout(() => void poll(), 3000)
      }
    }

    pollTimerRef.current = setTimeout(() => void poll(), 2000)
  }, [])

  // ── 手动保存配置 ──────────────────────────────────────────────────────
  async function handleManualSave() {
    if (!manualToken.trim() || !manualAccountId.trim()) {
      setError('Token 和 AccountId 均为必填项')
      return
    }
    setSaving(true)
    setError('')
    try {
      await saveWeixinConfig({
        token: manualToken.trim(),
        accountId: manualAccountId.trim(),
        allowedUsers: manualAllowedUsers.trim()
          ? manualAllowedUsers.split(',').map(s => s.trim()).filter(Boolean)
          : [],
      })
      await new Promise(r => setTimeout(r, 1200))
      const status = await getIMStatus()
      const running = status.status
        ?.find((s: { platform: string; running: boolean }) => s.platform === 'weixin')
        ?.running ?? false
      if (running) {
        setAccountId(manualAccountId.trim())
        setStep('connected')
      } else {
        setError('适配器启动失败，请检查 Token 是否有效')
      }
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    } finally {
      setSaving(false)
    }
  }

  // ── 断开连接 ──────────────────────────────────────────────────────────
  async function handleDisconnect() {
    setSaving(true)
    setError('')
    try {
      const cfg = await getWeixinConfig()
      const wx = (cfg.platforms as Record<string, unknown>[] | undefined)
        ?.find((p) => p.platform === 'weixin')
      if (wx) {
        await saveWeixinConfig({
          token: String(wx.token ?? ''),
          accountId: String(wx.accountId ?? ''),
          enabled: false,
        })
      }
      // 解绑成功，通知父组件刷新状态
      onDisconnected?.()
      // 重置状态并重新发起扫码，让用户可以重新绑定
      setSaving(false)
      setAccountId('')
      setError('')
      setStep('qrcode')
      void handleStartQrCode()
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
      setSaving(false)
    }
  }

  // ── 渲染 ──────────────────────────────────────────────────────────────
  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
      onClick={(e) => { if (e.target === overlayRef.current) onClose() }}
    >
      <div
        className="bg-[var(--bg-secondary)] w-full max-w-sm rounded-xl shadow-2xl border border-[var(--border)] mx-4 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="连接微信"
      >
        {/* 头部 */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-[var(--border-subtle)]">
          <span className="text-[#07C160]"><WeixinIcon size={18} /></span>
          <span className="text-sm font-semibold text-[var(--text-primary)]">连接微信</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="ml-auto w-6 h-6 flex items-center justify-center rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors border-0 cursor-pointer"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="px-5 py-5">

          {/* ── 加载中 ── */}
          {step === 'check' && (
            <div className="flex items-center justify-center py-10 gap-2 text-xs text-[var(--text-muted)]">
              <SpinIcon />
              加载中...
            </div>
          )}

          {/* ── 二维码扫码 ── */}
          {(step === 'qrcode' || step === 'scaned') && (
            <div className="flex flex-col items-center gap-4">
              <p className="text-xs text-[var(--text-secondary)] text-center leading-relaxed">
                使用微信扫描下方二维码，完成授权绑定
              </p>

              {/* 二维码区域 */}
              <div className="relative w-44 h-44 rounded-xl overflow-hidden border-2 border-[var(--border)] bg-white flex items-center justify-center">
                {qrcodeImgUrl ? (
                  <>
                    <img
                      src={qrcodeImgUrl}
                      alt="微信登录二维码"
                      className="w-full h-full object-contain"
                    />
                    {/* 已扫码遮罩 */}
                    {step === 'scaned' && (
                      <div className="absolute inset-0 bg-black/50 flex flex-col items-center justify-center gap-2">
                        <div className="w-10 h-10 rounded-full bg-[#07C160] flex items-center justify-center">
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        </div>
                        <span className="text-white text-xs font-medium">已扫码</span>
                        <span className="text-white/70 text-[10px]">请在手机上确认</span>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="flex flex-col items-center gap-2 text-[var(--text-muted)]">
                    <SpinIcon size={20} />
                    <span className="text-xs">获取二维码...</span>
                  </div>
                )}
              </div>

              {/* 状态提示 */}
              {step === 'scaned' ? (
                <div className="flex items-center gap-2 text-xs text-amber-400">
                  <SpinIcon size={12} />
                  已扫码，请在手机微信上点击确认
                </div>
              ) : (
                <div className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
                  <SpinIcon size={11} />
                  等待扫码...
                </div>
              )}

              {error && (
                <p className="text-xs text-[var(--error)] text-center">{error}</p>
              )}

              {/* 操作按钮 */}
              <div className="flex items-center gap-3 w-full">
                <button
                  type="button"
                  onClick={() => void handleStartQrCode()}
                  className="flex-1 py-2 rounded-lg text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors border border-[var(--border)] cursor-pointer"
                >
                  刷新二维码
                </button>
                <button
                  type="button"
                  onClick={() => { setStep('manual'); setError('') }}
                  className="flex-1 py-2 rounded-lg text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors border border-[var(--border)] cursor-pointer"
                >
                  手动填写 Token
                </button>
              </div>
            </div>
          )}

          {/* ── 已连接 ── */}
          {step === 'connected' && (
            <div className="flex flex-col gap-4">
              {/* 状态卡片 */}
              <div className="flex items-center gap-3 p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
                <div className="w-8 h-8 rounded-full bg-[#07C160] flex items-center justify-center shrink-0">
                  <WeixinIcon size={16} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-semibold text-emerald-400">微信已绑定</div>
                  {accountId && (
                    <div className="text-[11px] text-[var(--text-muted)] truncate mt-0.5">
                      {accountId}
                    </div>
                  )}
                </div>
                <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0 animate-pulse" />
              </div>

              <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
                微信消息将通过 iLink Bot API 转发到 AI 助手。在微信中发送{' '}
                <code className="bg-[var(--bg-tertiary)] px-1 py-0.5 rounded text-[var(--text-primary)] font-mono">/help</code>{' '}
                查看可用命令。
              </p>

              {error && <p className="text-xs text-[var(--error)]">{error}</p>}

              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => void handleDisconnect()}
                  disabled={saving}
                  className="flex-1 py-2 rounded-lg text-xs font-medium text-[var(--error)] hover:bg-[var(--error-subtle)] transition-colors border border-[var(--border)] cursor-pointer disabled:opacity-50 flex items-center justify-center gap-1.5"
                >
                  {saving ? (
                    <><SpinIcon size={11} />解绑中...</>
                  ) : (
                    <>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                        <polyline points="16 17 21 12 16 7" />
                        <line x1="21" y1="12" x2="9" y2="12" />
                      </svg>
                      解除绑定
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  disabled={saving}
                  className="flex-1 py-2 rounded-lg text-xs font-medium bg-[var(--accent)] hover:opacity-90 text-white transition-colors border-0 cursor-pointer disabled:opacity-50"
                >
                  完成
                </button>
              </div>
            </div>
          )}

          {/* ── 手动填写 Token ── */}
          {step === 'manual' && (
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => { setStep('qrcode'); setError(''); void handleStartQrCode() }}
                  className="text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors flex items-center gap-1"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <polyline points="15 18 9 12 15 6" />
                  </svg>
                  返回扫码
                </button>
                <span className="text-xs text-[var(--text-secondary)] ml-1">手动配置</span>
              </div>

              <div className="p-3 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] text-xs text-[var(--text-secondary)] leading-relaxed">
                访问{' '}
                <a
                  href="https://ilinkai.weixin.qq.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--accent)] hover:underline"
                >
                  ilinkai.weixin.qq.com
                </a>{' '}
                完成扫码授权后，在控制台获取 Token 和 AccountId 填入下方。
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-[var(--text-secondary)]">
                  iLink Token <span className="text-[var(--error)]">*</span>
                </label>
                <input
                  type="password"
                  value={manualToken}
                  onChange={e => setManualToken(e.target.value)}
                  placeholder="从 iLink 控制台复制"
                  className="w-full px-3 py-2 text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--accent-subtle)] transition-all"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-[var(--text-secondary)]">
                  AccountId <span className="text-[var(--error)]">*</span>
                </label>
                <input
                  type="text"
                  value={manualAccountId}
                  onChange={e => setManualAccountId(e.target.value)}
                  placeholder="微信账号 ID"
                  className="w-full px-3 py-2 text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--accent-subtle)] transition-all"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-[var(--text-secondary)]">
                  允许的用户 ID{' '}
                  <span className="text-[var(--text-muted)] font-normal">（可选，逗号分隔）</span>
                </label>
                <input
                  type="text"
                  value={manualAllowedUsers}
                  onChange={e => setManualAllowedUsers(e.target.value)}
                  placeholder="留空允许所有人"
                  className="w-full px-3 py-2 text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--accent-subtle)] transition-all"
                />
              </div>

              {error && <p className="text-xs text-[var(--error)]">{error}</p>}

              <div className="flex gap-2 justify-end pt-1">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 rounded-lg text-xs font-medium bg-[var(--bg-tertiary)] text-[var(--text-primary)] hover:bg-[var(--border)] transition-colors border-0 cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => void handleManualSave()}
                  disabled={saving || !manualToken.trim() || !manualAccountId.trim()}
                  className="px-4 py-2 rounded-lg text-xs font-medium bg-[#07C160] hover:bg-[#06AD56] text-white transition-colors border-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
                >
                  {saving && <SpinIcon size={11} />}
                  {saving ? '连接中...' : '连接微信'}
                </button>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  )
}
