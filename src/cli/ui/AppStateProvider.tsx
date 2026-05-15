import React, { createContext, useContext, useState, useCallback } from 'react'
import { useSyncExternalStore } from 'react'
import { createStore } from './store.js'
import type { AppState, AppStateStore } from './AppState.js'

// ─── Context ──────────────────────────────────────────────────────────────

const AppStoreContext = createContext<AppStateStore | null>(null)

// ─── Provider ─────────────────────────────────────────────────────────────

interface Props {
  children: React.ReactNode
  initialState: AppState
  onChangeAppState?: (args: { newState: AppState; oldState: AppState }) => void
}

export function AppStateProvider({ children, initialState, onChangeAppState }: Props) {
  const [store] = useState(() => createStore(initialState, onChangeAppState))

  return (
    <AppStoreContext.Provider value={store}>
      {children}
    </AppStoreContext.Provider>
  )
}

// ─── Hooks ────────────────────────────────────────────────────────────────

function useAppStore(): AppStateStore {
  const store = useContext(AppStoreContext)
  if (!store) {
    throw new ReferenceError(
      'useAppState/useSetAppState cannot be called outside of an <AppStateProvider />',
    )
  }
  return store
}

/**
 * 订阅 AppState 的切片。仅在选中值变化时重新渲染（通过 Object.is 比较）。
 *
 * 用法：
 * ```
 * const loading = useAppState(s => s.loading)
 * const msgs = useAppState(s => s.msgs)
 * ```
 */
export function useAppState<T>(selector: (state: AppState) => T): T {
  const store = useAppStore()
  const get = useCallback(() => selector(store.getState()), [store, selector])
  return useSyncExternalStore(store.subscribe, get, get)
}

/**
 * 获取 setState 更新函数，不订阅任何状态。
 * 返回稳定引用——仅使用此 hook 的组件不会因状态变化而重渲染。
 */
export function useSetAppState(): (updater: (prev: AppState) => AppState) => void {
  return useAppStore().setState
}

/**
 * 直接获取 store（用于传递给非 React 代码）。
 */
export function useAppStateStore(): AppStateStore {
  return useAppStore()
}
