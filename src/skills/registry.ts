// Skills 注册表 —— 管理内置和用户自定义 skills

import { existsSync, readdirSync, readFileSync } from 'fs'
import { join, dirname, resolve, relative, isAbsolute } from 'path'
import { getConfigDir } from '../core/config.js'
import type { Skill, BundledSkillDefinition, SkillFrontmatter } from './types.js'

// ---- Frontmatter 解析 ----

function parseFrontmatter(content: string): { frontmatter: SkillFrontmatter; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { frontmatter: {}, body: content }

  const frontmatter: SkillFrontmatter = {}
  const raw = match[1]!
  const body = match[2]!

  for (const line of raw.split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim() as keyof SkillFrontmatter
    const val = line.slice(colonIdx + 1).trim()
    // 去掉引号
    ;(frontmatter as Record<string, unknown>)[key] = val.replace(/^["']|["']$/g, '')
  }

  return { frontmatter, body }
}

function parseAllowedTools(raw: string | string[] | undefined): string[] {
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  return raw.split(',').map(s => s.trim()).filter(Boolean)
}

function parseBool(val: boolean | string | undefined, defaultVal = true): boolean {
  if (val === undefined) return defaultVal
  if (typeof val === 'boolean') return val
  return val !== 'false'
}

// ---- 内置 skills 注册表 ----

const bundledSkills: Skill[] = []

export function registerBundledSkill(def: BundledSkillDefinition): void {
  if (def.isEnabled && !def.isEnabled()) return

  bundledSkills.push({
    name: def.name,
    description: def.description,
    whenToUse: def.whenToUse,
    argumentHint: def.argumentHint,
    allowedTools: def.allowedTools ?? [],
    userInvocable: def.userInvocable ?? true,
    source: 'bundled',
    getPrompt: def.getPrompt,
  })
}

export function getBundledSkills(): Skill[] {
  return [...bundledSkills]
}

export function clearBundledSkills(): void {
  bundledSkills.length = 0
}

// ---- 文件系统 skills 加载 ----

/**
 * 处理 SKILL.md 正文中的 #[[file:relative_path]] 引用。
 * 将引用替换为对应文件的实际内容，路径相对于 SKILL.md 所在目录。
 */
function resolveFileIncludes(body: string, skillMdDir: string): string {
  return body.replace(/#\[\[file:([^\]]+)\]\]/g, (match, relPath: string) => {
    const absPath = resolve(skillMdDir, relPath.trim())
    // 路径穿越防护：确保解析后的路径仍在 skillMdDir 内
    const relFromDir = relative(skillMdDir, absPath)
    if (relFromDir.startsWith('..') || isAbsolute(relFromDir)) {
      return `[引用文件路径越界: ${relPath}]`
    }
    try {
      if (!existsSync(absPath)) {
        return `[引用文件不存在: ${relPath}]`
      }
      const content = readFileSync(absPath, 'utf-8')
      return `\`\`\`\n${content}\n\`\`\``
    } catch (err) {
      return `[引用文件读取失败: ${relPath} — ${String(err)}]`
    }
  })
}

/**
 * 处理 {{args}} 占位符替换。
 * 如果 body 中包含 {{args}}，将其替换为实际参数；
 * 否则在末尾追加 ## 用户补充说明。
 */
function injectArgs(body: string, args: string): string {
  if (!args) return body
  if (body.includes('{{args}}')) {
    return body.replace(/\{\{args\}\}/g, args)
  }
  return body + `\n\n## 用户补充说明\n\n${args}`
}

/**
 * 从目录加载 skills。
 * 目录结构：<skillsDir>/<skill-name>/SKILL.md
 *
 * 支持功能：
 * - frontmatter（description / when-to-use / argument-hint / allowed-tools / user-invocable）
 * - #[[file:relative_path]] 文件引用（相对于 SKILL.md 所在目录）
 * - {{args}} 占位符替换（或末尾追加）
 *
 * @param skillsDir  skills 根目录
 * @param source     来源标记（'user' | 'project'）
 * @param onError    可选的错误回调，用于诊断加载失败的 skill
 */
export function loadSkillsFromDir(
  skillsDir: string,
  source: Skill['source'],
  onError?: (skillName: string, err: unknown) => void,
): Skill[] {
  if (!existsSync(skillsDir)) return []

  const skills: Skill[] = []

  let entries: string[]
  try {
    entries = readdirSync(skillsDir)
  } catch {
    return []
  }

  for (const entry of entries) {
    const skillMdPath = join(skillsDir, entry, 'SKILL.md')
    if (!existsSync(skillMdPath)) continue

    try {
      const raw = readFileSync(skillMdPath, 'utf-8')
      const { frontmatter, body } = parseFrontmatter(raw)
      const skillMdDir = dirname(skillMdPath)

      // 处理 #[[file:...]] 引用（在 getPrompt 时动态解析，保证文件内容最新）
      const skillName = entry
      const description = (frontmatter.description as string | undefined)
        ?? extractFirstLine(body)
        ?? skillName

      skills.push({
        name: skillName,
        description,
        whenToUse: frontmatter['when-to-use'],
        argumentHint: frontmatter['argument-hint'],
        allowedTools: parseAllowedTools(frontmatter['allowed-tools']),
        userInvocable: parseBool(frontmatter['user-invocable']),
        source,
        async getPrompt(args: string) {
          // 每次调用时重新读取文件，保证热更新（用户修改 SKILL.md 后立即生效）
          let currentBody = body
          try {
            const freshRaw = readFileSync(skillMdPath, 'utf-8')
            const { body: freshBody } = parseFrontmatter(freshRaw)
            currentBody = freshBody
          } catch { /* 读取失败时使用初始内容 */ }

          // 1. 解析 #[[file:...]] 引用
          const resolved = resolveFileIncludes(currentBody, skillMdDir)
          // 2. 注入 args（{{args}} 替换或末尾追加）
          return injectArgs(resolved, args)
        },
      })
    } catch (err) {
      // 通过回调上报错误，不再静默丢弃
      if (onError) onError(entry, err)
    }
  }

  return skills
}

function extractFirstLine(text: string): string | undefined {
  const line = text.split('\n').find(l => l.trim().length > 0)
  return line?.replace(/^#+\s*/, '').trim()
}

// ---- 全局 SkillRegistry ----

export class SkillRegistry {
  private skills = new Map<string, Skill>()

  /** 注册单个 skill（同名后注册覆盖先注册） */
  register(skill: Skill): void {
    this.skills.set(skill.name, skill)
  }

  /** 批量注册 */
  registerAll(skills: Skill[]): void {
    for (const s of skills) this.register(s)
  }

  find(name: string): Skill | undefined {
    return this.skills.get(name)
  }

  getAll(): Skill[] {
    return Array.from(this.skills.values()).filter(s => s.userInvocable)
  }
}

/** 默认 skills 目录：~/.hrids/skills/ */
export function getUserSkillsDir(): string {
  return join(getConfigDir(), 'skills')
}

/** 项目级 skills 目录：<cwd>/.agent/skills/ */
export function getProjectSkillsDir(cwd: string): string {
  return join(cwd, '.agent', 'skills')
}

/** 读取用户技能禁用列表（~/.hrids/skills-disabled.json） */
export function getDisabledUserSkills(): Set<string> {
  const disabledPath = join(getConfigDir(), 'skills-disabled.json')
  if (!existsSync(disabledPath)) return new Set()
  try {
    const arr = JSON.parse(readFileSync(disabledPath, 'utf-8')) as string[]
    return new Set(Array.isArray(arr) ? arr : [])
  } catch {
    return new Set()
  }
}

/**
 * 构建完整的 SkillRegistry：
 * 优先级：project > user > bundled
 *
 * @param cwd       项目工作目录（用于加载项目级 skills）
 * @param onError   可选的错误回调，用于诊断加载失败的外置 skill
 */
export function buildSkillRegistry(
  cwd?: string,
  onError?: (source: string, skillName: string, err: unknown) => void,
): SkillRegistry {
  const registry = new SkillRegistry()

  // 读取禁用列表（只影响 user 技能）
  const disabledUserSkills = getDisabledUserSkills()

  // 1. 内置 skills（最低优先级）
  registry.registerAll(getBundledSkills())

  // 2. 用户级 skills（过滤掉禁用的）
  const userSkills = loadSkillsFromDir(
    getUserSkillsDir(),
    'user',
    onError ? (name, err) => onError('user', name, err) : undefined,
  ).filter(s => !disabledUserSkills.has(s.name))
  registry.registerAll(userSkills)

  // 3. 项目级 skills（最高优先级）
  if (cwd) {
    registry.registerAll(loadSkillsFromDir(
      getProjectSkillsDir(cwd),
      'project',
      onError ? (name, err) => onError('project', name, err) : undefined,
    ))
  }

  return registry
}
