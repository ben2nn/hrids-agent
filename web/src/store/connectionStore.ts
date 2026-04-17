import { create } from 'zustand'
import { setGatewayConfig, checkHealth } from '../lib/gateway.js'

// localStorage 键名
const STORAGE_KEY_URL = 'hrids_gateway_url'
const STORAGE_KEY_TOKEN = 'hrids_auth_token'

interface ConnectionState {
  /** Gateway 服务地址 */
  gatewayUrl: string
  /** Bearer 认证 Token */
  authToken: string
  /** 是否已连接（健康检查通过） */
  isConnected: boolean
  /** 是否正在检查连接 */
  isChecking: boolean

  /**
   * 保存连接配置到 localStorage，并同步更新 gateway.ts 内部配置。
   */
  setConfig: (url: string, token: string) => void

  /**
   * 检查 Gateway 连接状态，调用 /health 接口更新 isConnected。
   */
  checkConnection: () => Promise<void>

  /**
   * 从 localStorage 恢复上次保存的连接配置。
   * 若存在则调用 setConfig() 恢复，否则保持默认值。
   */
  loadFromStorage: () => void
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  gatewayUrl: 'http://localhost:3282',
  authToken: '',
  isConnected: false,
  isChecking: false,

  setConfig(url: string, token: string) {
    // 持久化到 localStorage
    localStorage.setItem(STORAGE_KEY_URL, url)
    localStorage.setItem(STORAGE_KEY_TOKEN, token)

    // 同步更新 gateway.ts 内部配置（避免循环依赖，通过函数调用传递）
    setGatewayConfig(url, token)

    // 更新 store 状态
    set({ gatewayUrl: url, authToken: token })
  },

  async checkConnection() {
    set({ isChecking: true })
    try {
      const healthy = await checkHealth()
      set({ isConnected: healthy })
    } catch {
      set({ isConnected: false })
    } finally {
      set({ isChecking: false })
    }
  },

  loadFromStorage() {
    const savedUrl = localStorage.getItem(STORAGE_KEY_URL)
    const savedToken = localStorage.getItem(STORAGE_KEY_TOKEN)

    if (savedUrl !== null) {
      // 使用 setConfig 恢复，确保 gateway.ts 内部配置也同步更新
      get().setConfig(savedUrl, savedToken ?? '')
    }
  },
}))
