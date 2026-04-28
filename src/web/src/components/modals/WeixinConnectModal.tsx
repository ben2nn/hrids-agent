import { useState, useEffect, useRef } from 'react'
import { getWeixinConfig, saveWeixinConfig, getIMStatus } from '../../lib/gateway.js'

// ── 微信图标 ──────────────────────────────────────────────────────────────
const WeixinIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
    <path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.047c.134 0 .24-.111.24-.247 0-.06-.023-.12-.038-.177l-.327-1.233a.582.582 0 0 1-.023-.156.49.49 0 0 1 .201-.398C23.024 18.48 24 16.82 24 14.98c0-3.21-2.931-5.837-7.062-6.122zm-3.74 2.632c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982zm5.4 0c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982z" />
  </svg>
)

interface WeixinConnectModalProps {
  onClose: () => void
}

type Step = 'check' | 'form' | 'connected'

export function WeixinConnectModal({ onClose }: WeixinConnectModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null)
  const [step, setStep] = useState<Step>('check')
  const [token, setToken] = useState('')
  const [accountId, setAccountId] = useState('')
  const [allowedUsers, setAllowedUsers] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [, setIsConnected] = useState(false)

  // 初始化：读取现有配置 + 运行状态
  useEffect(() => {
    void (async () => {
      try {
        const [cfg, status] = await Promise.all([getWeixinConfig(), getIMStatus()])
        const wx = (cfg.platforms as { platform: string }[] | undefined)?.find((p) => p.platform === 'weixin')
        const running = status.status?.find((s: { platform: string; running: boolean }) => s.platform === 'weixin')?.running ?? false

        if (wx) {
          setToken((wx as { token?: string }).token ?? '')
          setAccountId((wx as { accountId?: string }).accountId ?? '')
          setAllowedUsers(((wx as { allowedUsers?: string[] }).allowedUsers ?? []).join(', '))
          setIsConnected(running && (wx as { enabled?: boolean }).enabled === true)
          setStep(running && (wx as { enabled?: boolean }).enabled ? 'connected' : 'form')
        } else {
          setStep('form')
        }
      } catch {
        setStep('form')
      }
    })()
  }, [])

  // ESC 关闭
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  async function handleSave() {
    if (!token.trim() || !accountId.trim()) {
      setError('Token 和 AccountId 均为必填项')
      return
    }
    setSaving(true)
    setError('')
    try {
      await saveWeixinConfig({
        token: token.trim(),
        accountId: accountId.trim(),
        allowedUsers: allowedUsers.trim()
          ? allowedUsers.split(',').map(s => s.trim()).filter(Boolean)
          : [],
      })
      // 等一下再查状态，给适配器启动时间
      await new Promise(r => setTimeout(r, 1200))
      const status = await getIMStatus()
      const running = status.status?.find((s: { platform: string; running: boolean }) => s.platform === 'weixin')?.running ?? false
      setIsConnected(running)
      setStep('connected')
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    } finally {
      setSaving(false)
    }
  }

  async function handleDisconnect() {
    setSaving(true)
    setError('')
    try {
      await saveWeixinConfig({ token: token.trim(), accountId: accountId.trim(), enabled: false })
      setIsConnected(false)
      setStep('form')
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
      onClick={(e) => { if (e.target === overlayRef.current) onClose() }}
    >
      <div
        className="bg-[var(--bg-secondary)] w-full max-w-md rounded-xl shadow-2xl border border-[var(--border)] mx-4 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {/* 头部 */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-[var(--border-subtle)]">
          <span className="text-[#07C160]"><WeixinIcon /></span>
          <span className="text-sm font-semibold text-[var(--text-primary)]">连接微信</span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto w-6 h-6 flex items-center justify-center rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors border-0 cursor-pointer"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-4">
          {/* 已连接状态 */}
          {step === 'connected' && (
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-3 p-3 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)]">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-[var(--text-primary)]">微信已连接</div>
                  <div className="text-[11px] text-[var(--text-muted)] truncate mt-0.5">AccountId: {accountId}</div>
                </div>
              </div>
              <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
                微信消息将通过 iLink Bot API 转发到 AI 助手。发送 <code className="bg-[var(--bg-tertiary)] px-1 rounded text-[var(--text-primary)]">/help</code> 查看可用命令。
              </p>
              {error && <p className="text-xs text-[var(--error)]">{error}</p>}
              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => setStep('form')}
                  className="px-3 py-1.5 rounded-lg text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors border border-[var(--border)] cursor-pointer"
                >
                  修改配置
                </button>
                <button
                  type="button"
                  onClick={() => void handleDisconnect()}
                  disabled={saving}
                  className="px-3 py-1.5 rounded-lg text-xs text-[var(--error)] hover:bg-[var(--error-subtle)] transition-colors border border-[var(--border)] cursor-pointer disabled:opacity-50"
                >
                  断开连接
                </button>
              </div>
            </div>
          )}

          {/* 配置表单 */}
          {step === 'form' && (
            <div className="flex flex-col gap-4">
              {/* 引导说明 */}
              <div className="p-3 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] text-xs text-[var(--text-secondary)] leading-relaxed">
                <p className="font-medium text-[var(--text-primary)] mb-1.5">使用前需在 iLink 平台完成授权</p>
                <ol className="list-decimal list-inside space-y-1">
                  <li>访问 <a href="https://ilinkai.weixin.qq.com" target="_blank" rel="noopener noreferrer" className="text-[var(--accent)] hover:underline">ilinkai.weixin.qq.com</a> 注册账号</li>
                  <li>扫码绑定你的微信账号</li>
                  <li>在控制台获取 <strong className="text-[var(--text-primary)]">Token</strong> 和 <strong className="text-[var(--text-primary)]">AccountId</strong></li>
                  <li>填入下方并点击连接</li>
                </ol>
              </div>

              {/* Token */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-[var(--text-secondary)]">
                  iLink Token <span className="text-[var(--error)]">*</span>
                </label>
                <input
                  type="password"
                  value={token}
                  onChange={e => setToken(e.target.value)}
                  placeholder="从 iLink 控制台复制"
                  className="w-full px-3 py-2 text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--accent-subtle)] transition-all"
                />
              </div>

              {/* AccountId */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-[var(--text-secondary)]">
                  AccountId <span className="text-[var(--error)]">*</span>
                </label>
                <input
                  type="text"
                  value={accountId}
                  onChange={e => setAccountId(e.target.value)}
                  placeholder="微信账号 ID"
                  className="w-full px-3 py-2 text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--accent-subtle)] transition-all"
                />
              </div>

              {/* 白名单（可选） */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-[var(--text-secondary)]">
                  允许的用户 ID <span className="text-[var(--text-muted)] font-normal">（可选，逗号分隔，留空允许所有人）</span>
                </label>
                <input
                  type="text"
                  value={allowedUsers}
                  onChange={e => setAllowedUsers(e.target.value)}
                  placeholder="wxid_xxx, wxid_yyy"
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
                  onClick={() => void handleSave()}
                  disabled={saving || !token.trim() || !accountId.trim()}
                  className="px-4 py-2 rounded-lg text-xs font-medium bg-[#07C160] hover:bg-[#06AD56] text-white transition-colors border-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
                >
                  {saving && (
                    <svg className="animate-spin" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                    </svg>
                  )}
                  {saving ? '连接中...' : '连接微信'}
                </button>
              </div>
            </div>
          )}

          {/* 加载中 */}
          {step === 'check' && (
            <div className="flex items-center justify-center py-8 gap-2 text-xs text-[var(--text-muted)]">
              <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
              </svg>
              加载中...
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
