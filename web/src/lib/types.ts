// ─── 服务端推送消息（WebSocket Server → Client） ───────────────────────────

export type ServerMessage =
  | { type: 'ready'; sessionId: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_start'; toolId: string; toolName: string; input: unknown }
  | { type: 'tool_log'; toolId: string; log: string }
  | { type: 'tool_end'; toolId: string; status: 'success' | 'error' | 'denied'; result?: unknown }
  | { type: 'todos_updated'; todos: Todo[] }
  | { type: 'permission_request'; key: string; toolName: string; description: string; readonly: boolean }
  | { type: 'ask_user'; question: string; options?: string[] }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cost: number; model: string }
  | { type: 'cwd_changed'; cwd: string }
  | { type: 'permission_mode_changed'; mode: 'ask' | 'auto' | 'plan' }
  | { type: 'continuation_needed' }
  | { type: 'compact_done'; summary: string }
  | { type: 'done' }
  | { type: 'error'; message: string }
  | { type: 'budget_exceeded'; message: string }

// ─── 客户端发送消息（WebSocket Client → Server） ───────────────────────────

export type ClientMessage =
  | { type: 'message'; content: string }
  | { type: 'abort' }
  | { type: 'user_reply'; answer: string }
  | { type: 'permission_reply'; key: string; granted: boolean }
  | { type: 'set_cwd'; cwd: string }
  | { type: 'set_permission_mode'; mode: 'ask' | 'auto' | 'plan' }

// ─── 文件上传 ──────────────────────────────────────────────────────────────

export interface UploadedFile {
  /** 原始文件名 */
  name: string
  /** 保存后的绝对路径 */
  path: string
  /** 文件大小（字节） */
  size: number
}

export interface UploadResponse {
  files: UploadedFile[]
}

// ─── 会话信息 ──────────────────────────────────────────────────────────────

export interface SessionInfo {
  id: string
  status: 'ready' | 'busy' | 'stopped'
  model?: string
  cwd?: string
  createdAt: number
  title?: string
  permissionMode?: 'ask' | 'auto' | 'plan'
}

export interface CreateSessionRequest {
  model?: string
  cwd?: string
  autoMode?: boolean
  /** 权限模式（优先级高于 autoMode）：ask / auto / readonly / plan */
  permissionMode?: 'ask' | 'auto' | 'readonly' | 'plan'
  /** 恢复历史会话时传入旧会话 ID */
  resume?: string
}

// ─── 文件系统 ──────────────────────────────────────────────────────────────

export interface FileEntry {
  name: string
  type: 'file' | 'dir'
  size?: number
  mtime?: number
}

export interface FileListResponse {
  cwd: string
  path: string
  entries: FileEntry[]
}

/** 文件树节点（前端懒加载用） */
export interface FileNode {
  name: string
  path: string
  type: 'file' | 'dir'
  children?: FileNode[]
  loaded: boolean
}

// ─── 任务 ──────────────────────────────────────────────────────────────────

export interface Todo {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  priority: 'high' | 'medium' | 'low'
}

// ─── 定时任务 ──────────────────────────────────────────────────────────────

export interface CronJob {
  id: string
  expression: string
  description: string
  task: string
  createdAt: number
  lastRunAt?: number
  nextRunAt?: number
  enabled: boolean
  once?: boolean
}

// ─── 技能 ──────────────────────────────────────────────────────────────────

export interface Skill {
  name: string
  description: string
  source: 'builtin' | 'user' | 'project'
  /** 用户技能中，是否通过 skillhub 安装（true=安装技能，false/undefined=自建技能） */
  installed?: boolean
  /** 用户技能是否启用（undefined 表示不支持切换，如内置技能） */
  enabled?: boolean
  prompt?: string
}

// ─── 消息列表渲染（DisplayMessage） ───────────────────────────────────────

export type DisplayMessage =
  | { id: string; type: 'user'; content: string; timestamp: number }
  | { id: string; type: 'assistant'; content: string; timestamp: number; usage?: CostInfo }
  | {
      id: string; type: 'tool'; toolId: string; toolName: string; timestamp: number
      /** 历史消息加载时携带，用于重建 toolCard */
      toolInput?: unknown
      toolStatus?: 'success' | 'error'
      toolResult?: unknown
    }
  | { id: string; type: 'system'; content: string; timestamp: number }
  | { id: string; type: 'error'; content: string; timestamp: number }
  | {
      id: string; type: 'compact'
      /** 归档时间 ISO 字符串 */
      archivedAt: string
      /** 归档前的消息数量 */
      messageCount: number
      /** 压缩摘要文本 */
      summary: string
      /** 是否展开摘要 */
      expanded?: boolean
      timestamp: number
    }

// ─── 工具卡片状态 ──────────────────────────────────────────────────────────

export interface ToolCardState {
  toolId: string
  toolName: string
  input: unknown
  status: 'pending' | 'success' | 'error' | 'denied'
  logs: string[]
  result?: unknown
  isExpanded: boolean
}

// ─── 权限请求 ──────────────────────────────────────────────────────────────

export interface PermissionRequest {
  key: string
  toolName: string
  description: string
  readonly: boolean
  /** 请求到达的时间戳（ms），用于计算 5 分钟倒计时 */
  requestedAt: number
}

// ─── 费用信息 ──────────────────────────────────────────────────────────────

export interface CostInfo {
  inputTokens: number
  outputTokens: number
  cost: number
  model: string
}

// ─── 压缩归档段 ────────────────────────────────────────────────────────────

export interface CompactArchive {
  filename: string
  archivedAt: string
  messageCount: number
  summary: string
}
