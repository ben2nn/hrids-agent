import { create } from 'zustand'
import {
  getGlobalTodos,
  getCronJobs,
  toggleCron as apiToggleCron,
  deleteCron as apiDeleteCron,
} from '../lib/gateway.js'
import type { Todo, CronJob } from '../lib/types.js'

// ─── Store 类型定义 ────────────────────────────────────────────────────────

interface AutomationState {
  /** 全局任务列表（~/.hrids-agent/todos.json） */
  globalTodos: Todo[]
  /** 定时任务列表（~/.hrids-agent/crons.json） */
  cronJobs: CronJob[]
  /** 加载状态 */
  loading: {
    todos: boolean
    crons: boolean
  }

  /**
   * 拉取全局任务列表。
   */
  fetchGlobalTodos: () => Promise<void>

  /**
   * 拉取定时任务列表。
   */
  fetchCronJobs: () => Promise<void>

  /**
   * 启用或禁用指定定时任务。
   * 采用乐观更新：先更新本地状态，再调用 API；若 API 失败则回滚。
   */
  toggleCron: (id: string, enabled: boolean) => Promise<void>

  /**
   * 删除指定定时任务。
   * 调用 API 成功后从本地列表移除。
   */
  deleteCron: (id: string) => Promise<void>
}

// ─── Store 实现 ────────────────────────────────────────────────────────────

export const useAutomationStore = create<AutomationState>((set, get) => ({
  globalTodos: [],
  cronJobs: [],
  loading: {
    todos: false,
    crons: false,
  },

  async fetchGlobalTodos() {
    set((state) => ({ loading: { ...state.loading, todos: true } }))
    try {
      const todos = await getGlobalTodos()
      set({ globalTodos: todos })
    } finally {
      set((state) => ({ loading: { ...state.loading, todos: false } }))
    }
  },

  async fetchCronJobs() {
    set((state) => ({ loading: { ...state.loading, crons: true } }))
    try {
      const crons = await getCronJobs()
      set({ cronJobs: crons })
    } finally {
      set((state) => ({ loading: { ...state.loading, crons: false } }))
    }
  },

  async toggleCron(id: string, enabled: boolean) {
    // 保存原始状态，用于失败时回滚
    const previousCronJobs = get().cronJobs

    // 乐观更新：先更新本地状态
    set((state) => ({
      cronJobs: state.cronJobs.map((job) =>
        job.id === id ? { ...job, enabled } : job,
      ),
    }))

    try {
      await apiToggleCron(id, enabled)
    } catch (err) {
      // API 失败，回滚到原始状态
      console.error('[automationStore] toggleCron 失败，回滚状态:', err)
      set({ cronJobs: previousCronJobs })
      throw err
    }
  },

  async deleteCron(id: string) {
    await apiDeleteCron(id)
    // API 成功后从列表移除
    set((state) => ({
      cronJobs: state.cronJobs.filter((job) => job.id !== id),
    }))
  },
}))
