import { create } from 'zustand'
import {
  getGlobalTodos,
  getCronJobs,
  toggleCron as apiToggleCron,
  deleteCron as apiDeleteCron,
  createCron as apiCreateCron,
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

  fetchGlobalTodos: () => Promise<void>
  fetchCronJobs: () => Promise<void>
  toggleCron: (id: string, enabled: boolean) => Promise<void>
  deleteCron: (id: string) => Promise<void>
  createCron: (data: {
    expression: string
    description: string
    task: string
    once?: boolean
    startDate?: string
    endDate?: string
  }) => Promise<void>
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
    const previousCronJobs = get().cronJobs
    set((state) => ({
      cronJobs: state.cronJobs.map((job) =>
        job.id === id ? { ...job, enabled } : job,
      ),
    }))
    try {
      await apiToggleCron(id, enabled)
    } catch (err) {
      console.error('[automationStore] toggleCron 失败，回滚状态:', err)
      set({ cronJobs: previousCronJobs })
      throw err
    }
  },

  async deleteCron(id: string) {
    await apiDeleteCron(id)
    set((state) => ({
      cronJobs: state.cronJobs.filter((job) => job.id !== id),
    }))
  },

  async createCron(data) {
    const job = await apiCreateCron(data)
    set((state) => ({ cronJobs: [...state.cronJobs, job] }))
  },
}))
