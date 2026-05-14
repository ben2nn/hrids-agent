// ─── 服务端推送消息（WebSocket Server → Client） ───────────────────────────

export type ServerMessage =
  | { type: 'ready'; requestId?: string; sessionId: string; timestamp: number }
  | { type: 'request_start'; requestId: string; trigger: 'user' | 'cron'; description?: string; timestamp: number }
  | { type: 'cron_trigger'; requestId: string; description: string; timestamp: number }
  | { type: 'text_delta'; requestId: string; delta: string; timestamp: number }
  | { type: 'tool_start'; requestId: string; toolId: string; toolName: string; input: unknown; timestamp: number }
  | { type: 'tool_log'; requestId: string; toolId: string; log: string; timestamp: number }
  | { type: 'tool_end'; requestId: string; toolId: string; status: 'success' | 'error' | 'denied'; result?: unknown; timestamp: number }
  | { type: 'todos_updated'; requestId?: string; todos: Todo[]; timestamp: number }
  | { type: 'permission_request'; requestId?: string; key: string; toolName: string; description: string; readonly: boolean; isDestructive?: boolean; ruleContent?: string; timestamp: number }
  | { type: 'ask_user'; requestId?: string; question: string; options?: string[]; timestamp: number }
  | { type: 'usage'; requestId: string; inputTokens: number; outputTokens: number; cost: number; model: string; timestamp: number }
  | { type: 'cwd_changed'; requestId?: string; cwd: string; timestamp: number }
  | { type: 'permission_mode_changed'; requestId?: string; mode: 'ask' | 'craft' | 'plan'; timestamp: number }
  | { type: 'continuation_needed'; requestId: string; timestamp: number }
  | { type: 'compact_done'; requestId?: string; summary: string; timestamp: number }
  | { type: 'model_switched'; requestId?: string; model: string; reason: string; timestamp: number }
  | { type: 'done'; requestId: string; timestamp: number }
  | { type: 'error'; requestId: string; message: string; timestamp: number }
  | { type: 'budget_exceeded'; requestId?: string; message: string; timestamp: number }
  | { type: 'history_cleared'; requestId?: string; timestamp: number }
  | {
      type: 'decision_request'
      requestId?: string
      title: string
      context: string
      options: Array<{ label: string; description: string; risk?: 'low' | 'medium' | 'high' }>
      recommendation?: string
      deadline?: string
      impact?: string
      timestamp: number
    }
  | {
      /** IM 渠道（微信等）收到的用户消息，广播给 Web 界面显示 */
      type: 'im_user_message'
      requestId?: string
      /** 消息文本（已去掉 [图片] 占位符） */
      text: string
      /**
       * 图片列表：
       *   - data: URL（IM 渠道 base64 图片，直接显示）
       *   - 文件名（Web 上传图片，通过 getImageUrl 加载）
       */
      images?: string[]
      /** 来源平台标识，如 'weixin' */
      platform: string
      timestamp: number
    }

// ─── 客户端发送消息（WebSocket Client → Server） ───────────────────────────

// 附件（图片/PDF）：base64 编码的文件内容
export interface MessageAttachment {
  name: string
  data: string       // base64 编码
  mediaType: string  // 如 'image/jpeg', 'image/png', 'application/pdf'
}

export type ClientMessage =
  | { type: 'message'; content: string; attachments?: MessageAttachment[] }
  | { type: 'abort' }
  | { type: 'user_reply'; answer: string }
  | { type: 'decision_reply'; answer: string }
  | { type: 'permission_reply'; key: string; granted: boolean; permanent?: boolean; session?: boolean; ruleContent?: string }
  | { type: 'set_cwd'; cwd: string }
  | { type: 'set_permission_mode'; mode: 'ask' | 'craft' | 'plan' }
  | { type: 'clear_history' }

// ─── 文件上传 ──────────────────────────────────────────────────────────────

export interface UploadedFile {
  /** 原始文件名 */
  name: string
  /** 保存后的绝对路径 */
  path: string
  /** 文件大小（字节） */
  size: number
  /** 是否为图片文件 */
  isImage?: boolean
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
  lastUserMessage?: string
  permissionMode?: 'ask' | 'craft' | 'plan'
}

export interface CreateSessionRequest {
  model?: string
  cwd?: string
  /** 权限模式：ask / craft / plan */
  permissionMode?: 'ask' | 'craft' | 'plan'
  /** 恢复历史会话时传入旧会话 ID */
  resume?: string
  /** 会话标题 */
  title?: string
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
  acceptance?: string[]
  dependsOn?: string[]
  context?: string
  createdAt: number
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
  startDate?: string
  endDate?: string
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
  | { id: string; type: 'user'; content: string; timestamp: number; images?: string[] }
  | { id: string; type: 'request_start'; requestId: string; trigger: 'user' | 'cron'; description?: string; timestamp: number }
  | { id: string; type: 'cron_trigger'; requestId: string; description: string; timestamp: number }
  | { id: string; type: 'assistant'; requestId: string; content: string; thinking?: string; timestamp: number; usage?: CostInfo; isCron?: boolean; cronDescription?: string }
  | {
      id: string; type: 'tool'; requestId: string; toolId: string; toolName: string; timestamp: number
      /** 历史消息加载时携带，用于重建 toolCard */
      toolInput?: unknown
      toolStatus?: 'success' | 'error'
      toolResult?: unknown
      isCron?: boolean
    }
  | { id: string; type: 'system'; content: string; timestamp: number }
  | { id: string; type: 'error'; requestId?: string; content: string; timestamp: number }
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
      /** 归档文件名，用于按需加载实际历史消息 */
      filename?: string
      timestamp: number
    }

// ─── Agent 回合规范化结构 ──────────────────────────────────────────────────
//
// 由 groupMessages 在分组阶段生成，渲染层直接消费，不再做任何数据判断。
//
// 结构语义：
//   processMessages  运行过程消息（工具调用 + 中间说明文字），折叠显示
//   finalMessage     最终报告（最后一条有内容的 assistant 消息），独立展示
//                    运行中时为 null（流式文字由 streamingText 单独传入）
//   isRunning        是否正在运行
//   startTime        回合开始时间戳（ms）
//   endTime          回合结束时间戳（ms），运行中时为 undefined
//   cronDescription  定时任务描述，有值时以定时任务卡片样式渲染

export interface AgentTurnData {
  processMessages: DisplayMessage[]
  finalMessage: DisplayMessage | null
  isRunning: boolean
  startTime: number
  endTime?: number
  cronDescription?: string
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
  /** 是否为破坏性操作（如删除文件、rm 命令等） */
  isDestructive?: boolean
  /** 规则内容（bash 命令内容或文件路径），用于前端展示和会话级批准 */
  ruleContent?: string
  /** 请求到达的时间戳（ms），用于计算 5 分钟倒计时 */
  requestedAt: number
}

// ─── 决策请求 ──────────────────────────────────────────────────────────────

export interface DecisionOption {
  label: string
  description: string
  risk?: 'low' | 'medium' | 'high'
}

export interface DecisionRequest {
  title: string
  context: string
  options: DecisionOption[]
  recommendation?: string
  deadline?: string
  impact?: string
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
