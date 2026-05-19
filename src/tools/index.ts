import { BashTool } from './bash-tool.js'
import { FileReadTool } from './file-read-tool.js'
import { FileWriteTool } from './file-write-tool.js'
import { FileEditTool } from './file-edit-tool.js'
import { GlobTool } from './glob-tool.js'
import { GrepTool } from './grep-tool.js'
import { WebFetchTool } from './web-fetch-tool.js'
import { WebSearchTool } from './web-search-tool.js'
import { AskUserTool } from './ask-user-tool.js'
import { TodoWriteTool, TodoUpdateTool, TodoAppendTool, TodoResetTool, TodoReadTool } from './todo-tool.js'
import { DecisionTool } from './decision-tool.js'
import { ScheduleCronTool } from './schedule-cron-tool.js'
import { SkillTool, SkillListTool, SkillSaveTool } from './skill-tool.js'
import { SkillHubConfigTool, SkillHubSearchTool, SkillHubInstallTool, SkillHubRecommendTool, SkillHubSetupTool, SkillHubListTool, SkillHubUninstallTool, SkillHubUpgradeTool } from './skill-hub-tool.js'
import { TEAM_TOOLS } from './team-tools.js'
import { MEMORY_TOOLS } from '../memory/index.js'
import { PlanCreateTool, PlanUpdateTool, PlanListTool, PlanReadTool, PlanStatusTool, PlanArchiveTool } from './plan-tool.js'
import type { ToolDef } from '../core/tool.js'
import { ToolRegistry, createBatchRegistrar } from '../core/tool-registry.js'

const shellTool = BashTool

export {
  BashTool, FileReadTool, FileWriteTool, FileEditTool,
  GlobTool, GrepTool, WebFetchTool, WebSearchTool,
  AskUserTool, TodoWriteTool, TodoUpdateTool, TodoAppendTool, TodoResetTool, TodoReadTool,
  DecisionTool, ScheduleCronTool, SkillTool, SkillListTool, SkillSaveTool,
  SkillHubConfigTool, SkillHubSearchTool, SkillHubInstallTool, SkillHubRecommendTool, SkillHubSetupTool,
  SkillHubListTool, SkillHubUninstallTool, SkillHubUpgradeTool,
  PlanCreateTool, PlanUpdateTool, PlanListTool, PlanReadTool, PlanStatusTool, PlanArchiveTool,
}
export { TEAM_TOOLS } from './team-tools.js'
export { MEMORY_TOOLS } from '../memory/index.js'
export { ToolRegistry, createBatchRegistrar } from '../core/tool-registry.js'

export const ALL_TOOLS: ToolDef[] = [
  GlobTool,
  GrepTool,
  FileReadTool,
  FileWriteTool,
  FileEditTool,
  shellTool,
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
  PlanCreateTool,
  PlanUpdateTool,
  PlanListTool,
  PlanReadTool,
  PlanStatusTool,
  PlanArchiveTool,
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
 * 注册计划管理工具到 ToolRegistry
 */
export const registerPlanTools = createBatchRegistrar((registry: ToolRegistry) => {
  registry.register(PlanCreateTool)
  registry.register(PlanUpdateTool)
  registry.register(PlanListTool)
  registry.register(PlanReadTool)
  registry.register(PlanStatusTool)
  registry.register(PlanArchiveTool)
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
  // 计划管理工具
  registerPlanTools(registry)
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
  // 团队工具
  registry.registerAll(TEAM_TOOLS)
  // 记忆工具
  registry.registerAll(MEMORY_TOOLS)
})
