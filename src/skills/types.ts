// Skills 系统类型定义 —— 借鉴 claude-code-main 的 skills 架构

export type SkillSource = 'bundled' | 'user' | 'project'

// Skill 定义（对应 claude-code-main 的 PromptCommand）
export interface Skill {
  name: string
  description: string
  whenToUse?: string
  argumentHint?: string
  allowedTools?: string[]
  userInvocable: boolean
  source: SkillSource
  // 获取注入到对话的 prompt 内容
  getPrompt(args: string): Promise<string>
}

// 内置 skill 定义（编程注册，无需文件）
export interface BundledSkillDefinition {
  name: string
  description: string
  whenToUse?: string
  argumentHint?: string
  allowedTools?: string[]
  userInvocable?: boolean
  isEnabled?: () => boolean
  getPrompt(args: string): Promise<string>
}

// SKILL.md frontmatter 字段
export interface SkillFrontmatter {
  description?: string
  'when-to-use'?: string
  'argument-hint'?: string
  'allowed-tools'?: string | string[]
  'user-invocable'?: boolean | string
}
