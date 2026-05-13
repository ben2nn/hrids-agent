/**
 * Shell 工具核心模块 —— shell:false 架构
 *
 * 导出层级：
 * - parse: 命令解析、白名单、操作符检测
 * - exec: 低级执行引擎、PATHEXT、cmd.exe 包装、进程树杀死
 * - chain: 命令链解析与执行（|、&&、||、;、重定向）
 */

export {
  BUILTIN_ALLOWLIST,
  tokenizeCommand,
  detectShellOperator,
  isDqEscape,
  isAllowed,
  isCommandAllowed,
} from './parse.js'

export {
  DEFAULT_TIMEOUT_SEC,
  DEFAULT_MAX_OUTPUT_CHARS,
  killProcessTree,
  runCommand,
  smartDecodeOutput,
  resolveExecutable,
  normalizeWindowsEnvVars,
  prepareSpawn,
  injectPowerShellUtf8,
  withUtf8Codepage,
  quoteForCmdExe,
} from './exec.js'

export type { RunCommandResult, ResolveExecutableOptions } from './exec.js'

export {
  parseCommandChain,
  chainAllowed,
  UnsupportedSyntaxError,
} from './chain.js'

export type { CommandChain, ChainSegment, ChainOp, Redirect, RedirectKind } from './chain.js'
