import { BashTool } from './BashTool.js'
import { PowerShellTool } from './PowerShellTool.js'
import { FileReadTool } from './FileReadTool.js'
import { FileWriteTool } from './FileWriteTool.js'
import { FileEditTool } from './FileEditTool.js'
import { GlobTool } from './GlobTool.js'
import { GrepTool } from './GrepTool.js'
import { WebFetchTool } from './WebFetchTool.js'
import { WebSearchTool } from './WebSearchTool.js'
import { AskUserTool } from './AskUserTool.js'
import { TodoWriteTool, TodoReadTool } from './TodoWriteTool.js'
import { DecisionTool } from './DecisionTool.js'
import { ScheduleCronTool } from './ScheduleCronTool.js'
import { SkillTool, SkillListTool, SkillSaveTool } from './SkillTool.js'
import { SkillHubConfigTool, SkillHubSearchTool, SkillHubInstallTool, SkillHubRecommendTool, SkillHubSetupTool, SkillHubListTool, SkillHubUninstallTool, SkillHubUpgradeTool } from './SkillHubTool.js'
import { TEAM_TOOLS } from './TeamTools.js'
import { MEMORY_TOOLS } from '../memory/index.js'
import type { ToolDef } from '../core/Tool.js'

// 根据平台选择 shell 工具：Windows 使用 PowerShellTool，其他平台使用 BashTool
const shellTool = process.platform === 'win32' ? PowerShellTool : BashTool

export {
  BashTool, PowerShellTool, FileReadTool, FileWriteTool, FileEditTool,
  GlobTool, GrepTool, WebFetchTool, WebSearchTool,
  AskUserTool, TodoWriteTool, TodoReadTool,
  DecisionTool, ScheduleCronTool, SkillTool, SkillListTool, SkillSaveTool,
  SkillHubConfigTool, SkillHubSearchTool, SkillHubInstallTool, SkillHubRecommendTool, SkillHubSetupTool,
  SkillHubListTool, SkillHubUninstallTool, SkillHubUpgradeTool,
}
export { TEAM_TOOLS } from './TeamTools.js'
export { MEMORY_TOOLS } from '../memory/index.js'

export const ALL_TOOLS: ToolDef[] = [
  shellTool,  // Windows → PowerShellTool，Linux/macOS → BashTool
  FileReadTool,
  FileWriteTool,
  FileEditTool,
  GlobTool,
  GrepTool,
  WebFetchTool,
  WebSearchTool,
  AskUserTool,
  TodoWriteTool,
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
  SkillHubListTool,
  SkillHubUninstallTool,
  SkillHubUpgradeTool,
  ...TEAM_TOOLS,
  ...MEMORY_TOOLS,
]
