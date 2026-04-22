import type {
  SessionInfo,
  CreateSessionRequest,
  DisplayMessage,
  Todo,
  FileListResponse,
  CronJob,
  Skill,
  UploadResponse,
  CompactArchive,
} from './types.js'

// ─── 内部配置（避免直接 import connectionStore 导致循环依赖） ──────────────

let _gatewayUrl = 'http://localhost:3282'
let _authToken = ''

/**
 * 设置 Gateway 连接配置。
 * 由 connectionStore 在初始化或配置变更时调用。
 */
export function setGatewayConfig(url: string, token: string): void {
  _gatewayUrl = url.replace(/\/$/, '') // 去掉末尾斜杠
  _authToken = token
}

// ─── 基础请求封装 ──────────────────────────────────────────────────────────

/**
 * 封装 fetch，自动拼接 baseURL 并添加 Authorization header。
 * 非 2xx 响应会抛出包含状态码的 Error。
 */
async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const url = `${_gatewayUrl}${path}`

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> | undefined),
  }

  if (_authToken) {
    headers['Authorization'] = `Bearer ${_authToken}`
  }

  const response = await fetch(url, { ...options, headers })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText} (${path})`)
  }

  return response
}

// ─── 连接检查 ──────────────────────────────────────────────────────────────

/** 检查 Gateway 是否可达，返回 true 表示健康 */
export async function checkHealth(): Promise<boolean> {
  try {
    await apiFetch('/health')
    return true
  } catch {
    return false
  }
}

// ─── 会话管理 ──────────────────────────────────────────────────────────────

/** 获取所有会话列表（含历史已停止的会话） */
export async function listSessions(): Promise<SessionInfo[]> {
  const res = await apiFetch('/sessions/history')
  return res.json()
}

/** 创建新会话 */
export async function createSession(req: CreateSessionRequest): Promise<SessionInfo> {
  const res = await apiFetch('/sessions', {
    method: 'POST',
    body: JSON.stringify(req),
  })
  return res.json()
}

/** 删除指定会话 */
export async function deleteSession(id: string): Promise<void> {
  await apiFetch(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// ─── 会话任务产物 ──────────────────────────────────────────────────────────

/** 获取指定会话的任务列表 */
export async function getSessionTodos(sessionId: string): Promise<Todo[]> {
  const res = await apiFetch(`/sessions/${encodeURIComponent(sessionId)}/todos`)
  return res.json()
}

/** 获取指定会话的历史消息（DisplayMessage 格式） */
export async function getSessionMessages(sessionId: string): Promise<DisplayMessage[]> {
  const res = await apiFetch(`/sessions/${encodeURIComponent(sessionId)}/messages`)
  return res.json()
}

/** 获取指定会话的压缩归档段列表 */
export async function getHistorySegments(sessionId: string): Promise<CompactArchive[]> {
  try {
    const res = await apiFetch(`/sessions/${encodeURIComponent(sessionId)}/history-segments`)
    return res.json()
  } catch {
    return []
  }
}

// ─── 会话文件树 ────────────────────────────────────────────────────────────

/** 获取指定会话工作目录下的文件列表，path 默认为根目录 */
export async function listFiles(sessionId: string, path?: string): Promise<FileListResponse> {
  const query = path ? `?path=${encodeURIComponent(path)}` : ''
  const res = await apiFetch(`/sessions/${encodeURIComponent(sessionId)}/files${query}`)
  return res.json()
}

export interface FileContentResponse {
  path: string
  content: string
  size: number
  mtime: number
}

/** 读取指定会话工作目录下单个文件的内容 */
export async function getFileContent(sessionId: string, path: string): Promise<FileContentResponse> {
  const res = await apiFetch(`/sessions/${encodeURIComponent(sessionId)}/file-content?path=${encodeURIComponent(path)}`)
  return res.json()
}

/** 保存指定会话工作目录下单个文件的内容 */
export async function saveFileContent(sessionId: string, path: string, content: string): Promise<void> {
  await apiFetch(`/sessions/${encodeURIComponent(sessionId)}/file-content`, {
    method: 'PUT',
    body: JSON.stringify({ path, content }),
  })
}

// ─── 文件预览（Word / Excel） ──────────────────────────────────────────────

export type FilePreviewResult =
  | { type: 'html'; html: string }
  | { type: 'table'; sheets: Array<{ name: string; headers: string[]; rows: string[][] }> }

/** 预览 Word/Excel 文件，后端转换后返回 HTML 或表格数据 */
export async function previewFile(sessionId: string, path: string): Promise<FilePreviewResult> {
  const res = await apiFetch(`/sessions/${encodeURIComponent(sessionId)}/file-preview?path=${encodeURIComponent(path)}`)
  return res.json()
}

// ─── 文件上传 ──────────────────────────────────────────────────────────────

/**
 * 将本地文件上传到指定会话的工作目录。
 * 文件内容以 base64 编码通过 JSON 传输。
 */
export async function uploadFiles(sessionId: string, files: File[]): Promise<UploadResponse> {
  // 将 File 对象读取为 base64
  const filePayloads = await Promise.all(
    files.map(async (file) => {
      const buffer = await file.arrayBuffer()
      const bytes = new Uint8Array(buffer)
      let binary = ''
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i])
      }
      const data = btoa(binary)
      return { name: file.name, data }
    }),
  )

  const res = await apiFetch(`/sessions/${encodeURIComponent(sessionId)}/upload`, {
    method: 'POST',
    body: JSON.stringify({ files: filePayloads }),
  })
  return res.json()
}

// ─── 全局任务 ──────────────────────────────────────────────────────────────

/** 获取全局任务列表（~/.hrids-agent/todos.json） */
export async function getGlobalTodos(): Promise<Todo[]> {
  const res = await apiFetch('/todos')
  return res.json()
}

// ─── 定时任务 ──────────────────────────────────────────────────────────────

/** 获取所有定时任务 */
export async function getCronJobs(): Promise<CronJob[]> {
  const res = await apiFetch('/crons')
  return res.json()
}

/** 启用或禁用指定定时任务 */
export async function toggleCron(id: string, enabled: boolean): Promise<void> {
  await apiFetch(`/crons/${encodeURIComponent(id)}/toggle`, {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
  })
}

/** 删除指定定时任务 */
export async function deleteCron(id: string): Promise<void> {
  await apiFetch(`/crons/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// ─── 技能 ──────────────────────────────────────────────────────────────────

/** 获取已安装的技能列表 */
export async function getSkills(): Promise<Skill[]> {
  const res = await apiFetch('/skills')
  return res.json()
}

// ─── 技能市场 ──────────────────────────────────────────────────────────────

export interface MarketSkill {
  slug: string
  name: string
  description: string
  version: string
  category: string
  tags: string[]
  author: string
  downloads: number
  icon: string
}

export interface MarketSearchResponse {
  results: MarketSkill[]
  total: number
}

/** 切换用户技能启用/禁用状态 */
export async function toggleSkillEnabled(name: string, enabled: boolean): Promise<void> {
  await apiFetch(`/skills/${encodeURIComponent(name)}/toggle`, {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
  })
}

/** 搜索技能市场（代理 SkillHub API） */
export async function searchMarketSkills(query: string, limit = 20, page = 1): Promise<MarketSearchResponse> {
  const params = new URLSearchParams({ q: query, limit: String(limit), page: String(page) })
  const res = await apiFetch(`/skills/market/search?${params}`)
  return res.json()
}

/** 从技能市场安装技能 */
export async function installMarketSkill(slug: string, force = false): Promise<{ ok: boolean; message: string }> {
  const res = await apiFetch('/skills/market/install', {
    method: 'POST',
    body: JSON.stringify({ slug, force }),
  })
  return res.json()
}

/** 卸载技能 */
export async function uninstallMarketSkill(slug: string): Promise<{ ok: boolean; message: string }> {
  const res = await apiFetch(`/skills/market/uninstall/${encodeURIComponent(slug)}`, {
    method: 'DELETE',
  })
  return res.json()
}

// ─── 图片访问 ──────────────────────────────────────────────────────────────

/**
 * 获取会话工作目录中图片文件的访问 URL。
 * 直接返回后端图片端点 URL，供 <img src="..."> 使用。
 */
export function getImageUrl(sessionId: string, filename: string): string {
  return `${_gatewayUrl}/sessions/${encodeURIComponent(sessionId)}/image?path=${encodeURIComponent(filename)}`
}

/** 判断文件名是否为图片 */
export function isImageFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'tif'].includes(ext)
}

// ─── 配置 ──────────────────────────────────────────────────────────────────

export interface AgentConfigSummary {
  model: string
  permissionMode: 'ask' | 'auto' | 'readonly' | 'plan'
  maxTokens: number
  maxTurns: number
}

export interface ModelEntry {
  provider: string
  model: string
  isDefault: boolean
}

export interface ModelsResponse {
  models: ModelEntry[]
  defaultModel: string
}

/** 获取 agent 全局配置 */
export async function getAgentConfig(): Promise<AgentConfigSummary> {
  const res = await apiFetch('/config')
  return res.json()
}

/** 更新 agent 全局配置 */
export async function updateAgentConfig(patch: { model?: string; permissionMode?: string }): Promise<void> {
  await apiFetch('/config', {
    method: 'PUT',
    body: JSON.stringify(patch),
  })
}

/** 获取可用模型列表（从 LLM_FALLBACK_* 环境变量解析） */
export async function getAvailableModels(): Promise<ModelsResponse> {
  const res = await apiFetch('/config/models')
  return res.json()
}
