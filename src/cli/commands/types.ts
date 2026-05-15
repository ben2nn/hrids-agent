// ─── 命令类型定义 ──────────────────────────────────────────────────────────
//
// 简化版命令系统，参考 Claude Code 的 command.ts 设计
// 支持三种命令类型：local、local-jsx、prompt

// ─── 命令结果类型 ──────────────────────────────────────────────────────────

export type LocalCommandResult =
  | { type: 'exit' }
  | { type: 'message'; text: string }
  | { type: 'status'; text: string }
  | { type: 'noop' }
  | { type: 'inject'; prompt: string }

// ─── 命令类型 ──────────────────────────────────────────────────────────────

export type CommandType = 'local' | 'local-jsx' | 'prompt'

// ─── 命令基础定义 ──────────────────────────────────────────────────────────

export interface CommandBase {
  /** 命令名称（用户输入 /name 触发） */
  name: string
  /** 命令描述（显示在帮助列表中） */
  description: string
  /** 别名列表（可选） */
  aliases?: string[]
  /** 是否隐藏（不在帮助列表中显示） */
  isHidden?: boolean
  /** 是否启用（可用于动态禁用命令） */
  isEnabled?: () => boolean
  /** 参数提示（显示在命令名后面，如 /model <name>） */
  argumentHint?: string
  /** 命令分类（用于分组显示） */
  category?: 'builtin' | 'session' | 'config' | 'tools' | 'custom'
}

// ─── 本地命令 ──────────────────────────────────────────────────────────────

export interface LocalCommand extends CommandBase {
  type: 'local'
  /** 执行命令 */
  execute: (args: string, ctx: CommandContext) => Promise<LocalCommandResult>
}

// ─── JSX 命令 ──────────────────────────────────────────────────────────────

export interface LocalJSXCommand extends CommandBase {
  type: 'local-jsx'
  /** 执行命令，返回 React 节点 */
  execute: (args: string, ctx: CommandContext) => Promise<React.ReactNode>
}

// ─── Prompt 命令 ───────────────────────────────────────────────────────────

export interface PromptCommand extends CommandBase {
  type: 'prompt'
  /** 获取 prompt 内容 */
  getPrompt: (args: string) => Promise<string>
}

// ─── 命令联合类型 ──────────────────────────────────────────────────────────

export type Command = LocalCommand | LocalJSXCommand | PromptCommand

// ─── 命令上下文 ────────────────────────────────────────────────────────────

export interface CommandContext {
  clearHistory: () => void
  compactHistory: (summary: string) => Promise<void>
  generateCompactSummary: () => Promise<string>
  getHistoryLength: () => number
  getEstimatedTokens: () => number
  getCostSummary: () => { inputTokens: number; outputTokens: number; costUsd: number }
  getBudgetInfo: () => { spent: number; limit?: number }
  setModel: (model: string) => void
  getModel: () => string
  setMode: (mode: string) => void
  getMode: () => string
  sessionId: string
  listSessions: () => Array<{ id: string; createdAt: string }>
  listArchives: () => Array<{ id: string; createdAt: string; summary?: string }>
  newSession: () => void
  switchSession: (id: string) => boolean
  getAvailableModels: () => Array<{ provider: string; model: string; isDefault?: boolean }>
}

// ─── 工具函数 ──────────────────────────────────────────────────────────────

/** 获取命令显示名称 */
export function getCommandName(cmd: CommandBase): string {
  return cmd.name
}

/** 检查命令是否启用 */
export function isCommandEnabled(cmd: CommandBase): boolean {
  return cmd.isEnabled?.() ?? true
}

/** 检查命令是否可见（未隐藏且启用） */
export function isCommandVisible(cmd: CommandBase): boolean {
  return !cmd.isHidden && isCommandEnabled(cmd)
}
