import { create } from 'zustand'

type Theme = 'dark' | 'light'

interface ThemeState {
  theme: Theme
  toggle: () => void
  setTheme: (t: Theme) => void
}

/** 将主题 class 应用到 <html>，并加短暂过渡动画 */
function applyTheme(theme: Theme) {
  const html = document.documentElement

  // 加过渡 class，动画结束后移除
  html.classList.add('theme-transitioning')
  setTimeout(() => html.classList.remove('theme-transitioning'), 300)

  if (theme === 'light') {
    html.classList.add('light')
  } else {
    html.classList.remove('light')
  }
}

// 读取持久化主题，默认 dark
function loadTheme(): Theme {
  try {
    const saved = localStorage.getItem('theme')
    if (saved === 'light' || saved === 'dark') return saved
  } catch { /* localStorage 不可用时使用默认值 */ }
  return 'dark'
}

const initialTheme = loadTheme()
applyTheme(initialTheme)

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: initialTheme,

  toggle() {
    const next: Theme = get().theme === 'dark' ? 'light' : 'dark'
    applyTheme(next)
    try { localStorage.setItem('theme', next) } catch { /* 静默忽略 */ }
    set({ theme: next })
  },

  setTheme(t: Theme) {
    applyTheme(t)
    try { localStorage.setItem('theme', t) } catch { /* 静默忽略 */ }
    set({ theme: t })
  },
}))
