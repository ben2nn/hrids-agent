// Agent Profile 加载器 —— 从多目录加载智能体角色模板
// 支持 YAML 文件和 Markdown Frontmatter 两种格式
//
// 优先级（后加载覆盖先加载）：
//   内置专家（builtin-profiles/）→ 项目级 .hrids/roles/ → 全局 ~/.hrids/roles/ → config.yaml 内联

import { existsSync, readFileSync, readdirSync } from 'fs'
import { join, resolve as resolvePath } from 'path'
import type { AgentProfile } from '../core/config.js'
import { getConfigDir } from '../core/config.js'
import { tryLoadYamlFile, parseYamlString } from '../shared/yaml-loader.js'
import { homedir } from 'os'
import { BUILTIN_PROFILES } from './builtin-profiles/index.js'

// ── 默认扫描目录 ──────────────────────────────────────────────

const GLOBAL_ROLES_DIR = join(getConfigDir(), 'roles')

// ── Markdown Frontmatter 解析 ─────────────────────────────────

/** 解析 Markdown 文件的 YAML Frontmatter（--- 包围的内容） */
function parseFrontmatter(content: string): {
  frontmatter: Record<string, unknown>
  body: string
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) {
    return { frontmatter: {}, body: content }
  }
  try {
    const frontmatter = parseYamlString<Record<string, unknown>>(match[1])
    return { frontmatter, body: match[2].trim() }
  } catch {
    // Frontmatter 解析失败，整文件作为 body
    return { frontmatter: {}, body: content }
  }
}

/**
 * 从 Markdown 角色模板文件加载 AgentProfile。
 * 支持两种模式：
 *   1. Frontmatter + Body：Frontmatter 定义元数据，Body 作为 systemPrompt
 *   2. 纯 Markdown：整文件作为 systemPrompt，无元数据（此时需要外部传入 name/description）
 */
function loadProfileFromMarkdown(filePath: string, defaults?: Partial<AgentProfile>): AgentProfile | null {
  try {
    const raw = readFileSync(filePath, 'utf-8')
    const { frontmatter, body } = parseFrontmatter(raw)

    // 必须有 name（来自 frontmatter 或 defaults 或文件名）
    const name = (frontmatter.name as string)
      ?? defaults?.name
      ?? filePath.split(/[/\\]/).pop()?.replace(/\.md$/, '')
    if (!name) return null

    const description = (frontmatter.description as string) ?? defaults?.description ?? ''
    const profile: AgentProfile = {
      name,
      description,
      model: (frontmatter.model as string) ?? defaults?.model,
      provider: (frontmatter.provider as string) ?? defaults?.provider,
      apiKey: (frontmatter.apiKey as string) ?? defaults?.apiKey,
      baseUrl: (frontmatter.baseUrl as string) ?? defaults?.baseUrl,
      systemPrompt: body || undefined,
      systemPromptFile: undefined, // 已经从文件加载，无需再次引用
      allowedTools: (frontmatter.allowedTools as string[]) ?? defaults?.allowedTools,
      maxTurns: (frontmatter.maxTurns as number) ?? defaults?.maxTurns,
      maxBudgetUsd: (frontmatter.maxBudgetUsd as number) ?? defaults?.maxBudgetUsd,
      isolated: (frontmatter.isolated as boolean) ?? defaults?.isolated,
      autoSelectable: (frontmatter.autoSelectable as boolean) ?? defaults?.autoSelectable ?? true,
      metadata: (frontmatter.metadata as Record<string, string>) ?? defaults?.metadata,
    }
    return profile
  } catch {
    return null
  }
}

/**
 * 从 YAML 文件加载 AgentProfile。
 * systemPromptFile 会被解析为绝对路径。兼容 role 字段作为 systemPromptFile 别名。
 */
function loadProfileFromYaml(filePath: string): AgentProfile | null {
  try {
    const raw = tryLoadYamlFile<Partial<AgentProfile> & Record<string, unknown>>(filePath)
    if (!raw?.name) return null

    const profile: AgentProfile = {
      name: raw.name,
      description: raw.description ?? '',
      model: raw.model,
      provider: raw.provider,
      apiKey: raw.apiKey,
      baseUrl: raw.baseUrl,
      systemPrompt: raw.systemPrompt,
      systemPromptFile: raw.systemPromptFile ?? (raw.role as string | undefined),
      tags: raw.tags,
      allowedTools: raw.allowedTools,
      maxTurns: raw.maxTurns,
      maxBudgetUsd: raw.maxBudgetUsd,
      isolated: raw.isolated,
      autoSelectable: raw.autoSelectable ?? true,
      metadata: raw.metadata,
    }
    return profile
  } catch {
    return null
  }
}

// ── 单例缓存 ──────────────────────────────────────────────────

let _cachedProfiles: AgentProfile[] | null = null
let _profileLoaderDirs: string[] | null = null

// ── 公开 API ───────────────────────────────────────────────────

/**
 * 从指定目录加载所有 AgentProfile。
 * 支持 .yaml / .yml / .md 文件。
 * 同名 profile 后加载的覆盖先加载的（项目级 > 全局）。
 */
export function loadProfilesFromDir(dir: string): AgentProfile[] {
  if (!existsSync(dir)) return []

  const profiles: AgentProfile[] = []
  try {
    const entries = readdirSync(dir)
    for (const entry of entries) {
      const filePath = join(dir, entry)
      let profile: AgentProfile | null = null

      if (entry.endsWith('.yaml') || entry.endsWith('.yml')) {
        profile = loadProfileFromYaml(filePath)
      } else if (entry.endsWith('.md')) {
        profile = loadProfileFromMarkdown(filePath)
      }

      if (profile) {
        // 检查是否已有同名 profile，后加载的覆盖
        const existingIdx = profiles.findIndex(p => p.name === profile!.name)
        if (existingIdx >= 0) {
          profiles[existingIdx] = profile
        } else {
          profiles.push(profile)
        }
      }
    }
  } catch {
    // 目录读取失败，静默跳过
  }
  return profiles
}

/**
 * 初始化 ProfileLoader，设置扫描目录列表。
 * 应在 main.ts 启动时调用一次。
 *
 * @param extraDirs 额外扫描的目录（如 config.multiAgent.profileDirs）
 * @param projectRoot 项目根目录，用于查找项目级 .hrids/roles/
 */
export function initProfileLoader(extraDirs?: string[], projectRoot?: string) {
  const dirs: string[] = []

  // 项目级 .hrids/roles/（优先级最高）
  if (projectRoot) {
    const projectDir = resolvePath(projectRoot, '.hrids', 'roles')
    if (existsSync(projectDir)) {
      dirs.push(projectDir)
    }
  }

  // 全局 ~/.hrids/roles/
  if (existsSync(GLOBAL_ROLES_DIR)) {
    dirs.push(GLOBAL_ROLES_DIR)
  }

  // 额外指定的目录
  if (extraDirs) {
    for (const d of extraDirs) {
      const resolved = d.startsWith('~') ? join(homedir(), d.slice(1)) : resolvePath(d)
      if (existsSync(resolved)) {
        dirs.push(resolved)
      }
    }
  }

  _profileLoaderDirs = dirs
  _cachedProfiles = null // 清除缓存，下次 listProfiles 重新加载
}

/**
 * 列出所有可用的 AgentProfile。
 * 合并顺序：内置专家 → config 内联 profiles → 各目录 profiles（后覆盖前）
 *
 * @param inlineProfiles 配置文件中内联定义的 profiles
 */
export function listProfiles(inlineProfiles?: AgentProfile[]): AgentProfile[] {
  // 无内联 profiles 时使用磁盘 profiles 缓存
  if (!inlineProfiles?.length) {
    if (_cachedProfiles) return _cachedProfiles
  }

  // 1. 内置专家作为基础
  const profiles: AgentProfile[] = [...BUILTIN_PROFILES]

  // 2. 合并 config 内联 profiles（覆盖同名内置专家）
  if (inlineProfiles) {
    for (const p of inlineProfiles) {
      const existingIdx = profiles.findIndex(ep => ep.name === p.name)
      if (existingIdx >= 0) {
        profiles[existingIdx] = p
      } else {
        profiles.push(p)
      }
    }
  }

  // 3. 从各目录加载（覆盖同名）
  const dirsToScan = _profileLoaderDirs ?? (existsSync(GLOBAL_ROLES_DIR) ? [GLOBAL_ROLES_DIR] : [])
  for (const dir of dirsToScan) {
    const loaded = loadProfilesFromDir(dir)
    for (const p of loaded) {
      const existingIdx = profiles.findIndex(ep => ep.name === p.name)
      if (existingIdx >= 0) {
        profiles[existingIdx] = p // 目录中的覆盖内置/内联
      } else {
        profiles.push(p)
      }
    }
  }

  // 仅在无内联 profiles 时缓存（合并结果不应被缓存，因为内联内容每次可能不同）
  if (!inlineProfiles?.length) {
    _cachedProfiles = profiles
  }
  return profiles
}

/**
 * 按名称查找 AgentProfile。
 */
export function resolveProfile(name: string, inlineProfiles?: AgentProfile[]): AgentProfile | undefined {
  const profiles = listProfiles(inlineProfiles)
  return profiles.find(p => p.name === name)
}

/**
 * 解析 AgentProfile 的 systemPrompt。
 * 优先级：systemPromptFile > systemPrompt > 空字符串
 */
export function resolveSystemPrompt(profile: AgentProfile): string {
  // 如果有 systemPromptFile，读取文件内容
  if (profile.systemPromptFile) {
    const filePath = profile.systemPromptFile.startsWith('~')
      ? join(homedir(), profile.systemPromptFile.slice(1))
      : resolvePath(profile.systemPromptFile)

    // 先检查是否相对于全局 roles 目录
    const globalRolePath = join(GLOBAL_ROLES_DIR, profile.systemPromptFile)
    if (existsSync(globalRolePath)) {
      try {
        return readFileSync(globalRolePath, 'utf-8')
      } catch { /* fall through */ }
    }

    if (existsSync(filePath)) {
      try {
        return readFileSync(filePath, 'utf-8')
      } catch { /* fall through */ }
    }
  }

  // 回退到内联 systemPrompt
  return profile.systemPrompt ?? ''
}

/**
 * 替换模板变量（{{变量名}}）。
 */
export function applyTemplateVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? `{{${key}}}`)
}

/**
 * 清除 ProfileLoader 缓存（测试用）。
 */
export function _resetProfileCache() {
  _cachedProfiles = null
  _profileLoaderDirs = null
}
