// ProviderProfileLoader — 从 YAML 文件目录加载自定义提供商配置
// 扩展 config.yaml 的 customProviders，支持从目录批量加载
// 三层发现：内置 > 用户目录(~/.hrids/providers/) > 项目目录(.hrids/providers/)

import { existsSync, readdirSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { loadYamlFile } from '../shared/yaml-loader.js'
import type { CustomProviderConfig } from './registry.js'

const USER_PROVIDERS_DIR = join(homedir(), '.hrids', 'providers')
const PROJECT_PROVIDERS_DIR = '.hrids/providers'

/** 确保用户级 providers 目录存在 */
export function ensureUserProvidersDir(): string {
  if (!existsSync(USER_PROVIDERS_DIR)) {
    mkdirSync(USER_PROVIDERS_DIR, { recursive: true })
  }
  return USER_PROVIDERS_DIR
}

/** 获取用户级 providers 目录路径 */
export function getUserProvidersDir(): string {
  return USER_PROVIDERS_DIR
}

/**
 * 从 YAML 文件目录加载自定义提供商配置
 * @param projectCwd 项目根目录（可选，用于加载项目级配置）
 * @returns 合并后的自定义提供商列表
 */
export function loadProviderProfiles(projectCwd?: string): CustomProviderConfig[] {
  const profiles: CustomProviderConfig[] = []

  // 1. 用户级：~/.hrids/providers/*.yaml
  profiles.push(...loadFromDir(USER_PROVIDERS_DIR))

  // 2. 项目级：.hrids/providers/*.yaml（优先级更高，后加载覆盖先加载）
  if (projectCwd) {
    const projectDir = resolve(projectCwd, PROJECT_PROVIDERS_DIR)
    profiles.push(...loadFromDir(projectDir))
  }

  return profiles
}

/**
 * 从单个目录加载所有 .yaml/.yml 文件
 * 文件名作为提供商 ID 的备选来源
 */
function loadFromDir(dir: string): CustomProviderConfig[] {
  if (!existsSync(dir)) return []

  let files: string[]
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
  } catch {
    return []
  }

  const configs: CustomProviderConfig[] = []
  for (const file of files) {
    try {
      const raw = loadYamlFile<Record<string, unknown>>(join(dir, file))
      // 如果没有 name 字段，使用文件名（去掉扩展名）作为 name
      if (!raw.name) {
        raw.name = file.replace(/\.ya?ml$/, '')
      }
      configs.push(raw as unknown as CustomProviderConfig)
    } catch (err) {
      process.stderr.write(`[providers] 加载提供商配置失败 ${file}: ${String(err)}\n`)
    }
  }

  return configs
}
