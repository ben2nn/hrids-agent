import React, { createContext, useContext, useMemo, useCallback } from 'react'
import { createScrollStore, type ScrollStore, type ScrollSnapshot } from './scroll-store.js'

// ─── Context ───────────────────────────────────────────────────────────────

const StoreCtx = createContext<ScrollStore | null>(null)

// ─── Provider ──────────────────────────────────────────────────────────────

export function ScrollProvider({ children }: { children: React.ReactNode }) {
  const store = useMemo(() => createScrollStore(), [])
  return <StoreCtx.Provider value={store}>{children}</StoreCtx.Provider>
}

// ─── Hooks ─────────────────────────────────────────────────────────────────

function useStore(): ScrollStore {
  const store = useContext(StoreCtx)
  if (!store) throw new Error('useScrollStore must be used inside ScrollProvider')
  return store
}

/** 返回 store 引用（稳定，不触发重渲染） */
export function useScrollStore(): ScrollStore {
  return useStore()
}

/** 选择器式订阅，仅当选中切片变化时重渲染 */
export function useScrollSnapshot<T>(selector: (s: ScrollSnapshot) => T): T {
  const store = useStore()
  const subscribe = useCallback((cb: () => void) => store.subscribe(cb), [store])
  const getSnapshot = useCallback(() => selector(store.getState()), [store, selector])
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
