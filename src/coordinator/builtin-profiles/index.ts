// 内置专家注册入口
//
// 每个专家独立一个文件，此处统一导出 BUILTIN_PROFILES 数组。
// 用户自定义专家放在 ~/.hrids/roles/ 目录，同名时用户定义覆盖内置。

import type { AgentProfile } from '../../core/config.js'
import { EXPLORE_AGENT } from './exploreAgent.js'
import { CODE_REVIEWER_AGENT } from './codeReviewerAgent.js'
import { DATA_ANALYST_AGENT } from './dataAnalystAgent.js'
import { SECURITY_AUDITOR_AGENT } from './securityAuditorAgent.js'

export const BUILTIN_PROFILES: AgentProfile[] = [
  EXPLORE_AGENT,
  CODE_REVIEWER_AGENT,
  DATA_ANALYST_AGENT,
  SECURITY_AUDITOR_AGENT,
]
