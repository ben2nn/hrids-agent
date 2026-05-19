// 会话级工作目录管理（AsyncLocalStorage 隔离）
// 原先住在 BashTool.ts，现抽离为独立基础设施模块，
// 所有工具统一从这里 import，避免对 BashTool 的隐性依赖。

import { AsyncLocalStorage } from 'async_hooks'
import { existsSync, mkdirSync } from 'fs'
import { execSync } from 'child_process'
import { join } from 'path'
import { getConfigDir } from '../core/Config.js'

const DEFAULT_CWD = join(getConfigDir(), 'work')

// 每个异步上下文存储 { cwd: string }
const cwdStorage = new AsyncLocalStorage<{ cwd: string }>()

/**
 * 在指定 cwd 上下文中运行 fn。
 * SessionManager.runMessage 在调用前用此函数包裹，确保整个调用链使用会话自己的 cwd。
 */
export function runWithCwd<T>(cwd: string, fn: () => T): T {
  return cwdStorage.run({ cwd }, fn)
}

/**
 * 获取当前异步上下文的 cwd。
 * 若不在任何上下文中（CLI 单会话模式），返回全局 fallback。
 */
export function getGlobalCwd(): string {
  return cwdStorage.getStore()?.cwd ?? _fallbackCwd
}

// 确保目录存在（含 git init），供需要写入时按需调用
export function ensureWorkDir(dir: string): void {
  if (existsSync(dir)) return
  mkdirSync(dir, { recursive: true })
  try {
    execSync('git init', { cwd: dir, stdio: 'ignore' })
    execSync('git commit --allow-empty -m "init"', { cwd: dir, stdio: 'ignore' })
  } catch {
    // git 不可用时静默忽略
  }
}

/**
 * 确保当前会话的工作目录实际存在（惰性初始化）。
 * 返回 true 表示此次新建了目录，false 表示目录已存在。
 */
export function ensureWorkDirForCurrentCwd(): boolean {
  const dir = getGlobalCwd()
  if (existsSync(dir)) return false
  ensureWorkDir(dir)
  return true
}

/**
 * 更新当前异步上下文的 cwd。
 * 只影响当前会话的调用链，不影响其他会话。
 */
export function setGlobalCwd(dir: string): void {
  const store = cwdStorage.getStore()
  if (store) {
    store.cwd = dir
  } else {
    // 不在任何上下文中（CLI 模式）：回退到模块级变量
    _fallbackCwd = dir
  }
}

// CLI 模式（无 AsyncLocalStorage 上下文）的 fallback
let _fallbackCwd: string = DEFAULT_CWD
