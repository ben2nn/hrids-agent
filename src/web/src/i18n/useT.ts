// useT：快捷 hook，返回当前语言的翻译对象

import { useI18nStore } from '../store/i18nStore.js'
import type { Translations } from './locales/zh-CN.js'

export function useT(): Translations {
  return useI18nStore((state) => state.t)
}
