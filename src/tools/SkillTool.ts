// SkillTool —— 让工作者（LLM）能够主动调用已注册的 skill
// 对应 claude-code-main 的 SkillTool，填补"工作者无法自主触发 skill"的缺口
import { z } from 'zod'
import type { ToolDef } from '../core/Tool.js'
import { buildSkillRegistry, getUserSkillsDir } from '../skills/registry.js'
import { registerAllBundledSkills, getBundledSkills } from '../skills/index.js'
import { getGlobalCwd } from '../core/cwd.js'
import { invalidateFileCache } from './FileReadTool.js'

// 确保内置 skills 已注册（子智能体环境里可能未初始化）
function ensureBundledSkillsRegistered() {
  if (getBundledSkills().length === 0) {
    registerAllBundledSkills()
  }
}

const inputSchema = z.object({
  skill_name: z.string().describe('skill 名称，例如 commit、review、research、plan'),
  args: z.string().optional().describe('传给 skill 的参数，例如文件路径、主题描述等'),
})

export const SkillTool: ToolDef<typeof inputSchema> = {
  name: 'skill',
  description: `调用已注册的 skill（内置或自定义）。
skill 是预定义的任务模板，封装了常用工作流的 prompt。

可用的内置 skill：
通用工作者类：research（深度调研）、plan（制定计划）、report（生成报告）、monitor（设置监控）、summarize（内容摘要）
代码开发类：commit（提交代码）、review（代码审查）、explain（解释代码）、fix（修复 bug）、scaffold（生成骨架）、refactor（重构）、test（生成测试）、docs（生成文档）

使用 skill 而不是自己重复 prompt 的好处：
- skill 包含完整的步骤说明和原则
- 用户可以自定义 skill 覆盖内置行为
- 保持工作流一致性`,
  inputSchema,
  readonly: true,
  capabilities: { parallelSafe: true },

  describe(input) {
    return `调用 skill: /${input.skill_name}${input.args ? ' ' + input.args : ''}`
  },

  async execute(input) {
    ensureBundledSkillsRegistered()
    const loadErrors: string[] = []
    const registry = buildSkillRegistry(
      getGlobalCwd(),
      (source, skillName, err) => { loadErrors.push(`[${source}] ${skillName}: ${String(err)}`) },
    )
    const skill = registry.find(input.skill_name)

    if (!skill) {
      const available = registry.getAll().map(s => s.name).join(', ')
      const errHint = loadErrors.length > 0
        ? `\n\n加载时发生错误（可能导致部分 skill 不可用）:\n${loadErrors.join('\n')}`
        : ''
      return {
        type: 'error',
        message: `未找到 skill "${input.skill_name}"。可用的 skill：${available}${errHint}`,
      }
    }

    try {
      const prompt = await skill.getPrompt(input.args ?? '')
      // 返回 skill 的 prompt 内容，QueryEngine 会将其作为工具结果注入对话
      // LLM 读取后按照 prompt 的步骤执行
      return {
        type: 'success',
        output: `[Skill: ${skill.name}]\n\n${prompt}`,
      }
    } catch (err) {
      return {
        type: 'error',
        message: `skill "${input.skill_name}" 执行失败: ${String(err)}`,
      }
    }
  },
}

// 列出所有可用 skill 的工具（供 LLM 发现）
const listSchema = z.object({})

export const SkillListTool: ToolDef<typeof listSchema> = {
  name: 'skill_list',
  description: '列出所有可用的 skill（内置 + 用户自定义 + 项目级），并报告加载失败的 skill',
  inputSchema: listSchema,
  readonly: true,
  capabilities: { parallelSafe: true },

  async execute() {
    ensureBundledSkillsRegistered()

    const loadErrors: string[] = []
    const registry = buildSkillRegistry(
      getGlobalCwd(),
      (source, skillName, err) => {
        loadErrors.push(`  [${source}] ${skillName}: ${String(err)}`)
      },
    )
    const skills = registry.getAll()

    const lines: string[] = []

    if (skills.length === 0) {
      lines.push('暂无可用 skill。')
    } else {
      lines.push(`共 ${skills.length} 个可用 skill:\n`)
      for (const s of skills) {
        const hint = s.argumentHint ? ` ${s.argumentHint}` : ''
        const when = s.whenToUse ? `\n   适用场景: ${s.whenToUse}` : ''
        lines.push(`/${s.name}${hint}  [${s.source}]\n   ${s.description}${when}`)
      }
    }

    if (loadErrors.length > 0) {
      lines.push(`\n⚠ 以下 skill 加载失败（请检查 SKILL.md 格式）:\n${loadErrors.join('\n')}`)
    }

    return { type: 'success', output: lines.join('\n') }
  },
}

// SkillSaveTool —— 让 agent 自行提炼并保存 skill
// agent 完成某个任务后，可主动将工作流沉淀为可复用的 skill
import { mkdirSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'

const saveSchema = z.object({
  name: z.string().describe('skill 名称（英文小写，用连字符分隔，如 deploy-check）'),
  description: z.string().describe('一句话描述这个 skill 的用途'),
  prompt: z.string().describe('skill 的完整 prompt 内容（Markdown 格式，描述执行步骤和原则）'),
  when_to_use: z.string().optional().describe('适用场景描述，帮助 agent 判断何时调用此 skill'),
  argument_hint: z.string().optional().describe('参数提示，如 <文件路径> 或 <主题描述>'),
  scope: z.enum(['user', 'project']).default('user').describe(
    'user = 保存到 ~/.hrids/skills/（跨项目可用）；project = 保存到 .agent/skills/（仅当前项目）',
  ),
})

export const SkillSaveTool: ToolDef<typeof saveSchema> = {
  name: 'skill_save',
  description: `将当前工作流提炼为可复用的 skill，保存到本地文件系统。

适合在以下情况主动调用：
- 完成了一个有价值的、可重复使用的工作流
- 用户明确要求"把这个保存为 skill"
- 发现某个任务模式值得沉淀，避免下次重复描述

保存后可通过 skill 工具直接调用，也可用 skill_list 查看。`,
  inputSchema: saveSchema,
  readonly: false,
  capabilities: { parallelSafe: false },

  describe(input) {
    return `提炼 skill: ${input.name} → ${input.scope === 'project' ? '.agent/skills/' : '~/.hrids/skills/'}`
  },

  async execute(input) {
    // 确定保存目录
    const baseDir = input.scope === 'project'
      ? join(getGlobalCwd(), '.agent', 'skills')
      : getUserSkillsDir()

    const skillDir = join(baseDir, input.name)

    // 防止覆盖已有 skill（除非用户明确知道）
    const skillMdPath = join(skillDir, 'SKILL.md')
    const isUpdate = existsSync(skillMdPath)

    // 构建 SKILL.md 内容
    const frontmatterLines = [
      '---',
      `description: "${input.description}"`,
    ]
    if (input.when_to_use) {
      frontmatterLines.push(`when-to-use: "${input.when_to_use}"`)
    }
    if (input.argument_hint) {
      frontmatterLines.push(`argument-hint: "${input.argument_hint}"`)
    }
    frontmatterLines.push('---')

    const content = frontmatterLines.join('\n') + '\n\n' + input.prompt.trim() + '\n'

    try {
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(skillMdPath, content, 'utf-8')
      invalidateFileCache(skillMdPath)
    } catch (err) {
      return {
        type: 'error',
        message: `保存 skill 失败: ${String(err)}`,
      }
    }

    const action = isUpdate ? '更新' : '创建'
    return {
      type: 'success',
      output: `✓ 已${action} skill "${input.name}"（${input.scope === 'project' ? '项目级' : '用户级'}）\n路径: ${skillMdPath}\n\n现在可以通过 \`skill ${input.name}\` 调用它。`,
    }
  },
}
