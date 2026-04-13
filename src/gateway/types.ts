// Gateway 类型定义

export interface SessionInfo {
  id: string
  status: 'starting' | 'ready' | 'busy' | 'stopped'
  createdAt: number
  lastActiveAt: number
  model: string
  cwd: string
}

export interface CreateSessionRequest {
  model?: string
  provider?: string
  apiKey?: string
  baseUrl?: string
  autoMode?: boolean
  cwd?: string
  resume?: string  // 恢复已有会话 ID
}

export interface CreateSessionResponse {
  session_id: string
  ws_url: string
}

// 客户端 → 服务端（通过 WebSocket 发送）
export type ClientMessage =
  | { type: 'message'; content: string }
  | { type: 'abort' }
  | { type: 'user_reply'; answer: string }
  | { type: 'set_cwd'; cwd: string }
  // 回复权限询问：key 对应 permission_request 中的 key，granted 表示是否允许
  | { type: 'permission_reply'; key: string; granted: boolean }

// 服务端 → 客户端（通过 WebSocket 推送，即 StreamEvent 的超集）
export type ServerMessage =
  | { type: 'ready' }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_start'; id: string; name: string; input: unknown }
  | { type: 'tool_log'; id: string; name: string; line: string }
  | { type: 'tool_end'; id: string; name: string; result: unknown }
  | { type: 'permission_denied'; id: string; toolName: string; description: string }
  // 服务端向客户端发起权限询问（ask 模式下）
  | { type: 'permission_request'; toolName: string; description: string; isReadonly: boolean; key: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; costUsd: number }
  | { type: 'turn_limit'; turns: number }
  | { type: 'budget_exceeded'; costUsd: number; limitUsd: number }
  | { type: 'compact_start' }
  | { type: 'compact_done'; summary: string }
  | { type: 'ask_user'; question: string; options: string[] }
  | { type: 'cwd_changed'; cwd: string }
  | { type: 'done' }
  | { type: 'error'; message: string }
