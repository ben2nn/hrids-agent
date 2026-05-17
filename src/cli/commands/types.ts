// ─── 命令类型定义 ──────────────────────────────────────────────────────────
// Re-export from core/command-types.ts for backward compatibility

export type {
  LocalCommandResult,
  CommandType,
  CommandBase,
  LocalCommand,
  LocalJSXCommand,
  PromptCommand,
  Command,
  CommandContext,
} from '../../core/command-types.js'

export {
  getCommandName,
  isCommandEnabled,
  isCommandVisible,
} from '../../core/command-types.js'
