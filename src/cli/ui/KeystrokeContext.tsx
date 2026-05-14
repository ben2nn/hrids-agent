// KeystrokeContext —— ref + 回调模式，避免每次按键触发全树重渲染
import React, { createContext, useContext, useEffect, useRef } from 'react'
import { getStdinReader, type KeyEvent } from './StdinReader.js'

type KeystrokeHandler = (key: KeyEvent) => void

// 使用 Set 存储所有注册的 handler，直接从 StdinReader 回调中调用
const handlersRef: { current: Set<KeystrokeHandler> } = { current: new Set() }
let unsubscribe: (() => void) | null = null

function ensureSubscribed() {
  if (unsubscribe) return
  unsubscribe = getStdinReader().subscribe((key) => {
    for (const handler of handlersRef.current) handler(key)
  })
}

// Context 仅用于标记 Provider 已挂载，不传递按键数据
const KeystrokeReadyContext = createContext(false)

export function KeystrokeProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    ensureSubscribed()
    return () => {
      if (unsubscribe) { unsubscribe(); unsubscribe = null }
      handlersRef.current.clear()
    }
  }, [])
  return <KeystrokeReadyContext.Provider value={true}>{children}</KeystrokeReadyContext.Provider>
}

export function useKeystroke(handler: (key: KeyEvent) => void, isActive = true) {
  const handlerRef = useRef(handler)
  handlerRef.current = handler
  const ready = useContext(KeystrokeReadyContext)

  useEffect(() => {
    if (!ready || !isActive) return
    const wrapped: KeystrokeHandler = (key) => handlerRef.current(key)
    handlersRef.current.add(wrapped)
    return () => { handlersRef.current.delete(wrapped) }
  }, [ready, isActive])
}

export type { KeyEvent }
