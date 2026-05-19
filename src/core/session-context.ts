// 会话上下文 —— 通过 AsyncLocalStorage 在调用链中传递当前 sessionId
// 工具层通过 getCurrentSessionId() 获取，无需显式传参。

import { AsyncLocalStorage } from 'async_hooks'

const sessionStorage = new AsyncLocalStorage<{ sessionId: string }>()

/** 在指定 sessionId 上下文中运行 fn（由 SessionManager.runMessage 调用） */
export function runWithSession<T>(sessionId: string, fn: () => T): T {
  return sessionStorage.run({ sessionId }, fn)
}

/** 获取当前调用链的 sessionId，CLI 模式下返回 undefined */
export function getCurrentSessionId(): string | undefined {
  return sessionStorage.getStore()?.sessionId
}
