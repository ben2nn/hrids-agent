import { BashTool } from './BashTool.js'
import { FileReadTool } from './FileReadTool.js'
import { FileWriteTool } from './FileWriteTool.js'
import { FileEditTool } from './FileEditTool.js'
import { GlobTool } from './GlobTool.js'
import { GrepTool } from './GrepTool.js'
import { WebFetchTool } from './WebFetchTool.js'
import { WebSearchTool } from './WebSearchTool.js'
import { AskUserTool } from './AskUserTool.js'
import { TodoWriteTool, TodoUpdateTool, TodoAppendTool, TodoResetTool, TodoReadTool } from './TodoTool.js'
import { DecisionTool } from './DecisionTool.js'
import { ScheduleCronTool } from './ScheduleCronTool.js'
import { SkillTool, SkillListTool, SkillSaveTool } from './SkillTool.js'
import { SkillHubConfigTool, SkillHubSearchTool, SkillHubInstallTool, SkillHubRecommendTool, SkillHubSetupTool, SkillHubListTool, SkillHubUninstallTool, SkillHubUpgradeTool } from './SkillHubTool.js'
import { TEAM_TOOLS } from './TeamTools.js'
import { MEMORY_TOOLS } from '../memory/index.js'
import { WorkdirInitTool, WorkdirDeliverTool, WorkdirCleanupTool, WorkdirListTool } from './WorkdirTools.js'
import type { ToolDef } from '../core/Tool.js'
import { ToolRegistry, createBatchRegistrar } from '../core/ToolRegistry.js'

const shellTool = BashTool

export {
  BashTool, FileReadTool, FileWriteTool, FileEditTool,
  GlobTool, GrepTool, WebFetchTool, WebSearchTool,
  AskUserTool, TodoWriteTool, TodoUpdateTool, TodoAppendTool, TodoResetTool, TodoReadTool,
  DecisionTool, ScheduleCronTool, SkillTool, SkillListTool, SkillSaveTool,
  SkillHubConfigTool, SkillHubSearchTool, SkillHubInstallTool, SkillHubRecommendTool, SkillHubSetupTool,
  SkillHubListTool, SkillHubUninstallTool, SkillHubUpgradeTool,
  WorkdirInitTool, WorkdirDeliverTool, WorkdirCleanupTool, WorkdirListTool,
}
export { TEAM_TOOLS } from './TeamTools.js'
export { MEMORY_TOOLS } from '../memory/index.js'
export { ToolRegistry, createBatchRegistrar } from '../core/ToolRegistry.js'

export const ALL_TOOLS: ToolDef[] = [
  shellTool,
  FileReadTool,
  FileWriteTool,
  FileEditTool,
  GlobTool,
  GrepTool,
  WebFetchTool,
  WebSearchTool,
  AskUserTool,
  TodoWriteTool,
  TodoUpdateTool,
  TodoAppendTool,
  TodoResetTool,
  TodoReadTool,
  DecisionTool,
  ScheduleCronTool,
  SkillTool,
  SkillListTool,
  SkillSaveTool,
  SkillHubConfigTool,
  SkillHubSearchTool,
  SkillHubInstallTool,
  SkillHubRecommendTool,
  SkillHubSetupTool,
  WorkdirInitTool,
  WorkdirDeliverTool,
  WorkdirCleanupTool,
  WorkdirListTool,
  // SkillHubListTool、SkillHubUninstallTool、SkillHubUpgradeTool 已从 ALL_TOOLS 移除，
  // 减少 LLM 工具列表膨胀。如需使用，可通过 bash 命令或直接 import 调用。
  ...TEAM_TOOLS,
  ...MEMORY_TOOLS,
]

/**
 * 注册文件系统工具到 ToolRegistry
 *
 * 使用方式：
 * ```typescript
 * import { ToolRegistry, registerFilesystemTools } from './tools/index.js'
 *
 * const registry = new ToolRegistry()
 * registerFilesystemTools(registry)
 * ```
 */
export const registerFilesystemTools = createBatchRegistrar((registry: ToolRegistry) => {
  registry.register(FileReadTool)
  registry.register(FileWriteTool)
  registry.register(FileEditTool)
  registry.register(GlobTool)
  registry.register(GrepTool)
})

/**
 * 注册 Shell 工具到 ToolRegistry
 *
 * 使用方式：
 * ```typescript
 * import { ToolRegistry, registerShellTools } from './tools/index.js'
 *
 * const registry = new ToolRegistry()
 * registerShellTools(registry)
 * ```
 */
export const registerShellTools = createBatchRegistrar((registry: ToolRegistry) => {
  registry.register(shellTool)
})

/**
 * 注册 Web 工具到 ToolRegistry
 *
 * 使用方式：
 * ```typescript
 * import { ToolRegistry, registerWebTools } from './tools/index.js'
 *
 * const registry = new ToolRegistry()
 * registerWebTools(registry)
 * ```
 */
export const registerWebTools = createBatchRegistrar((registry: ToolRegistry) => {
  registry.register(WebFetchTool)
  registry.register(WebSearchTool)
})

/**
 * 注册任务管理工具到 ToolRegistry
 *
 * 使用方式：
 * ```typescript
 * import { ToolRegistry, registerTodoTools } from './tools/index.js'
 *
 * const registry = new ToolRegistry()
 * registerTodoTools(registry)
 * ```
 */
export const registerTodoTools = createBatchRegistrar((registry: ToolRegistry) => {
  registry.register(TodoWriteTool)
  registry.register(TodoUpdateTool)
  registry.register(TodoAppendTool)
  registry.register(TodoResetTool)
  registry.register(TodoReadTool)
})

/**
 * 注册所有核心工具到 ToolRegistry
 *
 * 使用方式：
 * ```typescript
 * import { ToolRegistry, registerAllCoreTools } from './tools/index.js'
 *
 * const registry = new ToolRegistry()
 * registerAllCoreTools(registry)
 * ```
 */
export const registerAllCoreTools = createBatchRegistrar((registry: ToolRegistry) => {
  // 文件系统工具
  registerFilesystemTools(registry)
  // Shell 工具
  registerShellTools(registry)
  // Web 工具
  registerWebTools(registry)
  // 任务管理工具
  registerTodoTools(registry)
  // 其他核心工具
  registry.register(AskUserTool)
  registry.register(DecisionTool)
  registry.register(ScheduleCronTool)
  registry.register(SkillTool)
  registry.register(SkillListTool)
  registry.register(SkillSaveTool)
  registry.register(SkillHubConfigTool)
  registry.register(SkillHubSearchTool)
  registry.register(SkillHubInstallTool)
  registry.register(SkillHubRecommendTool)
  registry.register(SkillHubSetupTool)
  registry.register(WorkdirInitTool)
  registry.register(WorkdirDeliverTool)
  registry.register(WorkdirCleanupTool)
  registry.register(WorkdirListTool)
  // 团队工具
  registry.registerAll(TEAM_TOOLS)
  // 记忆工具
  registry.registerAll(MEMORY_TOOLS)
})
