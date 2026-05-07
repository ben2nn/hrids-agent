// YAML 配置加载器 —— 封装 js-yaml 的读/写操作
// 用于替代 JSON 配置，提供更好的可读性和注释支持

import { readFileSync, writeFileSync, renameSync } from 'fs'
import { load as parseYaml, dump as stringifyYaml } from 'js-yaml'

/**
 * 从文件读取并解析 YAML。
 * 解析失败时抛出带文件名和行号的详细错误。
 */
export function loadYamlFile<T = unknown>(path: string): T {
  try {
    const raw = readFileSync(path, 'utf-8')
    return parseYaml(raw) as T
  } catch (err: unknown) {
    const yamlErr = err as { mark?: { line: number; column: number }; message?: string }
    if (yamlErr.mark) {
      throw new Error(`YAML 解析失败 [${path}:${yamlErr.mark.line + 1}:${yamlErr.mark.column + 1}]: ${String(yamlErr.message ?? err)}`)
    }
    throw new Error(`YAML 文件读取失败 [${path}]: ${String(err)}`)
  }
}

/**
 * 尝试从文件读取 YAML，文件不存在时返回 undefined。
 */
export function tryLoadYamlFile<T = unknown>(path: string): T | undefined {
  try {
    return loadYamlFile<T>(path)
  } catch {
    return undefined
  }
}

/**
 * 原子写入 YAML 文件（先写 tmp，再 rename）。
 * 默认使用 2 空格缩进，保持与 JSON config 一致的可读性。
 */
export function saveYamlFile(path: string, data: unknown, options?: { indent?: number; noRefs?: boolean }): void {
  const indent = options?.indent ?? 2
  const tmpFile = path + '.tmp'
  const yaml = stringifyYaml(data, {
    indent,
    lineWidth: 120,
    noRefs: options?.noRefs ?? true,
    quotingType: '"',
    forceQuotes: false,
    noCompatMode: true,
  })
  writeFileSync(tmpFile, yaml, 'utf-8')
  renameSync(tmpFile, path)
}

/**
 * 解析 YAML 字符串内容。
 * 用于内联解析（如 Markdown Frontmatter）。
 */
export function parseYamlString<T = unknown>(content: string): T {
  return parseYaml(content) as T
}

/**
 * 将对象转换为 YAML 字符串。
 */
export function toYamlString(data: unknown, options?: { indent?: number }): string {
  return stringifyYaml(data, {
    indent: options?.indent ?? 2,
    lineWidth: 120,
    noRefs: true,
    quotingType: '"',
    forceQuotes: false,
    noCompatMode: true,
  })
}
