import { useThemeStore } from '../../../store/themeStore.js'
import { useI18nStore } from '../../../store/i18nStore.js'
import { useT } from '../../../i18n/useT.js'
import type { Locale } from '../../../store/i18nStore.js'

// ─── 通用行组件（本文件内部使用） ─────────────────────────────────────────

export function SettingRow({ label, desc, children }: { label: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3.5 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border)] hover:border-[var(--border-focus)] transition-colors group">
      <div className="min-w-0">
        <p className="text-sm font-medium text-[var(--text-primary)]">{label}</p>
        {desc && <p className="text-xs text-[var(--text-muted)] mt-0.5">{desc}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

// ─── 通用设置面板 ──────────────────────────────────────────────────────────

export function GeneralPanel() {
  const { theme, toggle } = useThemeStore()
  const { locale, setLocale } = useI18nStore()
  const t = useT()
  const g = t.settings.general

  return (
    <div className="space-y-2">
      {/* 主题 */}
      <SettingRow label={g.theme.label} desc={g.theme.desc}>
        <div className="flex gap-1.5 p-1 bg-[var(--bg-tertiary)] rounded-lg border border-[var(--border)]">
          {(['light', 'dark'] as const).map(mode => (
            <button
              key={mode}
              type="button"
              onClick={() => { if (theme !== mode) toggle() }}
              className={[
                'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all duration-150 border-0 cursor-pointer',
                theme === mode
                  ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm border border-[var(--border)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
              ].join(' ')}
            >
              {mode === 'light' ? (
                <>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="5" />
                    <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
                    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                    <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
                    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                  </svg>
                  {g.theme.light}
                </>
              ) : (
                <>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                  </svg>
                  {g.theme.dark}
                </>
              )}
            </button>
          ))}
        </div>
      </SettingRow>

      {/* 界面语言 */}
      <SettingRow label={g.language.label} desc={g.language.desc}>
        <div className="flex gap-1.5 p-1 bg-[var(--bg-tertiary)] rounded-lg border border-[var(--border)]">
          {(['zh-CN', 'en-US'] as Locale[]).map(lang => (
            <button
              key={lang}
              type="button"
              onClick={() => setLocale(lang)}
              className={[
                'px-3 py-1.5 rounded-md text-xs font-medium transition-all duration-150 border-0 cursor-pointer',
                locale === lang
                  ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm border border-[var(--border)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
              ].join(' ')}
            >
              {lang === 'zh-CN' ? g.language.zhCN : g.language.enUS}
            </button>
          ))}
        </div>
      </SettingRow>
    </div>
  )
}
