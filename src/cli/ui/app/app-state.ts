import type { Store } from './store.js'

// ─── 消息类型 ──────────────────────────────────────────────────────────────

export type MsgRole = 'user' | 'assistant' | 'tool' | 'system' | 'error' | 'splash'

export interface DisplayMsg {
  id?: string
  role: MsgRole
  text: string
  color?: string
  splashProps?: { version: string; model: string; providerName: string; projectPath: string }
}

// ─── 成本信息 ──────────────────────────────────────────────────────────────

export interface CostInfo {
  inputTokens: number
  outputTokens: number
  costUsd: number
}

// ─── 应用状态 ──────────────────────────────────────────────────────────────

export interface AppState {
  // 消息流
  msgs: DisplayMsg[]
  streamBuf: string
  toolProgress: string

  // 会话
  sessionId: string
  loading: boolean
  askUserPrompt: string | null

  // 显示
  costInfo: CostInfo | null
  displayProvider: string
  stderrOutput: string
  statusBarContent: string
}

// ─── 默认状态 ──────────────────────────────────────────────────────────────

export function getDefaultAppState(
  sessionId: string,
  model: string,
  providerName: string,
): AppState {
  return {
    msgs: [
      {
        id: 'splash',
        role: 'splash',
        text: '',
        splashProps: {
          version: '1.0.0',
          model,
          providerName,
          projectPath: process.cwd(),
        },
      },
      { role: 'system', text: '输入 /help 查看命令' },
    ],
    streamBuf: '',
    toolProgress: '',
    sessionId,
    loading: false,
    askUserPrompt: null,
    costInfo: null,
    displayProvider: providerName,
    stderrOutput: '',
    statusBarContent: '',
  }
}

// ─── Store 类型 ────────────────────────────────────────────────────────────

export type AppStateStore = Store<AppState>
