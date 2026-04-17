import { create } from 'zustand'
import { getSessionTodos } from '../lib/gateway.js'
import type { Todo } from '../lib/types.js'

// ─── Store 类型定义 ────────────────────────────────────────────────────────

interface TodoState {
  /** 按 sessionId 分组的任务列表 */
  todos: Map<string, Todo[]>
  /** 按 sessionId 分组的加载状态 */
  loading: Map<string, boolean>

  /**
   * 从 Gateway 拉取指定会话的任务列表。
   * 设置 loading[sessionId]=true，请求完成后更新 todos[sessionId]，最后恢复 loading=false。
   */
  fetchTodos: (sessionId: string) => Promise<void>

  /**
   * 处理 WebSocket `todos_updated` 事件，直接替换指定会话的任务列表。
   */
  handleTodosUpdated: (sessionId: string, todos: Todo[]) => void

  /**
   * 会话销毁时清理对应的 todos 和 loading 条目。
   */
  clearSession: (sessionId: string) => void
}

// ─── Store 实现 ────────────────────────────────────────────────────────────

export const useTodoStore = create<TodoState>((set) => ({
  todos: new Map(),
  loading: new Map(),

  async fetchTodos(sessionId: string) {
    // 设置 loading[sessionId] = true
    set((state) => {
      const newLoading = new Map(state.loading)
      newLoading.set(sessionId, true)
      return { loading: newLoading }
    })

    try {
      const todos = await getSessionTodos(sessionId)

      // 更新 todos[sessionId]，同时清除 loading
      set((state) => {
        const newTodos = new Map(state.todos)
        newTodos.set(sessionId, todos)
        const newLoading = new Map(state.loading)
        newLoading.set(sessionId, false)
        return { todos: newTodos, loading: newLoading }
      })
    } catch (err) {
      console.error(`[todoStore] fetchTodos 失败 (sessionId=${sessionId}):`, err)

      // 请求失败时也要清除 loading 状态
      set((state) => {
        const newLoading = new Map(state.loading)
        newLoading.set(sessionId, false)
        return { loading: newLoading }
      })
    }
  },

  handleTodosUpdated(sessionId: string, todos: Todo[]) {
    set((state) => {
      const newTodos = new Map(state.todos)
      newTodos.set(sessionId, todos)
      return { todos: newTodos }
    })
  },

  clearSession(sessionId: string) {
    set((state) => {
      const newTodos = new Map(state.todos)
      newTodos.delete(sessionId)
      const newLoading = new Map(state.loading)
      newLoading.delete(sessionId)
      return { todos: newTodos, loading: newLoading }
    })
  },
}))
