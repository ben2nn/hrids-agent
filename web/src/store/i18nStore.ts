import { create } from 'zustand'
import { zhCN } from '../i18n/locales/zh-CN.js'
import { enUS } from '../i18n/locales/en-US.js'
import type { Translations } from '../i18n/locales/zh-CN.js'

export type Locale = 'zh-CN' | 'en-US'

const LOCALES: Record<Locale, Translations> = {
  'zh-CN': zhCN,
  'en-US': enUS,
}

interface I18nState {
  locale: Locale
  t: Translations
  setLocale: (locale: Locale) => void
}

function loadLocale(): Locale {
  try {
    const saved = localStorage.getItem('locale')
    if (saved === 'zh-CN' || saved === 'en-US') return saved
  } catch { /* localStorage 不可用时使用默认值 */ }
  return 'zh-CN'
}

const initialLocale = loadLocale()

export const useI18nStore = create<I18nState>((set) => ({
  locale: initialLocale,
  t: LOCALES[initialLocale],

  setLocale(locale: Locale) {
    try { localStorage.setItem('locale', locale) } catch { /* 静默忽略 */ }
    set({ locale, t: LOCALES[locale] })
  },
}))
