import { create } from 'zustand'
import { setGatewayConfig, checkHealthStatus, login } from '../lib/gateway.js'

// localStorage 键名
const STORAGE_KEY_TOKEN = 'hrids_auth_token'

interface ConnectionState {
  /** Gateway 服务地址 */
  gatewayUrl: string
  /** Bearer 认证 Token */
  authToken: string
  /** Gateway 可达且已授权（可以正常使用） */
  isConnected: boolean
  /** 是否正在检查连接 */
  isChecking: boolean
  /**
   * 是否需要显示登录页：
   * - false：无需登录（无鉴权或已有有效 token）
   * - true：需要用户名/密码登录
   */
  needsLogin: boolean

  /** 保存连接配置到 localStorage，并同步更新 gateway.ts 内部配置 */
  setConfig: (url: string, token: string) => void

  /**
   * 检查 Gateway 连接状态。
   * - ok → isConnected=true, needsLogin=false
   * - unauthorized → isConnected=false, needsLogin=true
   * - unreachable → isConnected=false, needsLogin=false
   */
  checkConnection: () => Promise<void>

  /** 从 localStorage 恢复上次保存的连接配置 */
  loadFromStorage: () => void

  /**
   * 用用户名/密码登录：调用 /api/login，成功后保存 token 并检查连接。
   * 返回错误信息字符串，成功返回 null。
   */
  loginWithCredentials: (url: string, username: string, password: string) => Promise<string | null>

  /** 登出：清除 token，重置为需要登录状态 */
  logout: () => void
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  gatewayUrl: typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3282',
  authToken: '',
  isConnected: false,
  isChecking: false,
  needsLogin: false,

  setConfig(url: string, token: string) {
    // 只有非空 token 才持久化到 localStorage
    if (token) {
      localStorage.setItem(STORAGE_KEY_TOKEN, token)
    } else {
      localStorage.removeItem(STORAGE_KEY_TOKEN)
    }
    setGatewayConfig(url, token)
    set({ gatewayUrl: url, authToken: token })
  },

  async checkConnection() {
    set({ isChecking: true })
    try {
      const status = await checkHealthStatus()
      if (status === 'ok') {
        set({ isConnected: true, needsLogin: false })
      } else if (status === 'needs-login') {
        set({ isConnected: false, needsLogin: true })
      } else if (status === 'unauthorized') {
        // token 已失效，清除后要求重新登录
        localStorage.removeItem(STORAGE_KEY_TOKEN)
        setGatewayConfig(
          typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3282',
          ''
        )
        set({ authToken: '', isConnected: false, needsLogin: true })
      } else {
        set({ isConnected: false, needsLogin: false })
      }
    } catch {
      set({ isConnected: false, needsLogin: false })
    } finally {
      set({ isChecking: false })
    }
  },

  loadFromStorage() {
    const savedToken = localStorage.getItem(STORAGE_KEY_TOKEN)
    if (savedToken) {  // 非空字符串才恢复
      const url = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3282'
      get().setConfig(url, savedToken)
    }
  },

  async loginWithCredentials(url: string, username: string, password: string) {
    set({ isChecking: true })
    try {
      setGatewayConfig(url, '')
      const token = await login(username, password)
      // token 非空（token 模式或 login/JWT 模式）：持久化到 localStorage
      // token 为空（无鉴权模式）：不持久化，但标记已连接
      get().setConfig(url, token)
      set({ isConnected: true, needsLogin: false })
      return null
    } catch (err) {
      set({ isConnected: false })
      return err instanceof Error ? err.message : '登录失败'
    } finally {
      set({ isChecking: false })
    }
  },

  logout() {
    localStorage.removeItem(STORAGE_KEY_TOKEN)
    setGatewayConfig(get().gatewayUrl, '')
    set({ authToken: '', isConnected: false, needsLogin: true })
  },
}))
