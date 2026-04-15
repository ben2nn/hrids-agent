// SkillHubTool —— 从 SkillHub 搜索、推荐和安装技能
// SkillHub 是腾讯云优化的 AI Skills 社区（https://skillhub.cloud.tencent.com）
// 技能安装后放入 ~/.hrids-agent/skills/，由 SkillRegistry 自动加载

import { z } from 'zod'
import { readFileSync, existsSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'fs'
import { resolve, join } from 'path'
import { homedir } from 'os'
import type { ToolDef, ToolResult } from '../core/Tool.js'
import { auditLog } from '../core/audit.js'
import { getGlobalCwd } from './BashTool.js'

// ─────────────────────────────────────────────
// 常量与辅助
// ─────────────────────────────────────────────

const DEFAULT_SKILLHUB_URL = 'https://skillhub.cn'
const DEFAULT_SKILLHUB_API = 'https://skillhub.cn'

function getUserSkillsDir(): string {
  return join(homedir(), '.hrids-agent', 'skills')
}

function getProjectSkillsDir(): string {
  return join(getGlobalCwd(), '.agent', 'skills')
}

function getSkillHubUrl(): string {
  return (process.env.SKILLHUB_URL ?? DEFAULT_SKILLHUB_URL).replace(/\/$/, '')
}

function getSkillHubApiBase(): string {
  return (process.env.SKILLHUB_API_BASE ?? DEFAULT_SKILLHUB_API).replace(/\/$/, '')
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

function stripHtmlTags(str: string): string {
  return str.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ')
}

/**
 * 请求 SkillHub 页面（SSR 渲染，fetch 可直接拿到完整 HTML）。
 * skillhub.cn 是服务端渲染，不需要 JS 执行，直接 fetch 即可。
 */
async function fetchSkillHubPage(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`)
  return res.text()
}

/** 从搜索页 HTML 提取技能列表，链接格式：/skills/<id> */
function parseSkillListFromHtml(html: string): Array<{ id: string; title: string }> {
  const results: Array<{ id: string; title: string }> = []
  const seen = new Set<string>()
  // 匹配：<a href="/skills/xxx">查看 Title 详情</a>
  const re = /href="\/skills\/([^"]+)"[^>]*>查看\s+([^<]+?)\s+详情/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const id = m[1]!
    const title = m[2]!.trim()
    if (!seen.has(id)) {
      seen.add(id)
      results.push({ id, title })
    }
  }
  return results
}

/** 从技能详情页 HTML 提取 SKILL.md 正文内容 */
function extractSkillContent(html: string, skillId: string, skillTitle: string): string {
  // 提取页面描述（meta description）
  const descMatch = html.match(/<meta[^>]+name="description"[^>]+content="([^"]+)"/i)
  const description = descMatch
    ? decodeHtmlEntities(descMatch[1]!.trim())
    : `来自 SkillHub 的技能：${skillTitle}`

  // 提取正文：页面主体内容在 <h1> 之后到页脚之前
  // 去掉导航、页脚等无关内容，保留技能说明部分
  const bodyMatch = html.match(/<h1[^>]*>[\s\S]*?(?=<footer|<div[^>]*class="[^"]*footer)/i)
  if (bodyMatch) {
    const cleaned = stripHtmlTags(bodyMatch[0])
      .replace(/\s{3,}/g, '\n\n')
      .trim()
    if (cleaned.length > 200) {
      return buildSkillMd(skillId, skillTitle, description, cleaned)
    }
  }

  // 回退：提取所有 <pre> 代码块（技能内容通常包含代码示例）
  const preBlocks: string[] = []
  const preRe = /<pre[^>]*>([\s\S]*?)<\/pre>/gi
  let pm: RegExpExecArray | null
  while ((pm = preRe.exec(html)) !== null) {
    preBlocks.push('```\n' + decodeHtmlEntities(pm[1]!.trim()) + '\n```')
  }

  const body = preBlocks.length > 0
    ? `# ${skillTitle}\n\n${description}\n\n${preBlocks.join('\n\n')}`
    : `# ${skillTitle}\n\n${description}\n\n> 来源：https://skillhub.cn/skills/${skillId}`

  return buildSkillMd(skillId, skillTitle, description, body)
}

function buildSkillMd(id: string, title: string, description: string, body: string): string {
  const safeDesc = description.replace(/"/g, "'").slice(0, 200)
  return [
    '---',
    `description: "${safeDesc}"`,
    `when-to-use: "当需要使用 ${title} 相关功能时"`,
    `# 来源: https://skillhub.cn/skills/${id}`,
    '---',
    '',
    body.trim(),
    '',
  ].join('\n')
}

// ─────────────────────────────────────────────
// skillhub_config
// ─────────────────────────────────────────────

const configSchema = z.object({
  action: z.enum(['get', 'set']).describe('get = 查看当前配置；set = 修改配置'),
  skillhub_url: z.string().optional().describe('SkillHub 前端地址，例如 https://skillhub.cloud.tencent.com'),
  skillhub_api_base: z.string().optional().describe('SkillHub API 基础地址，例如 https://skillhub.cn'),
})

export const SkillHubConfigTool: ToolDef<typeof configSchema> = {
  name: 'skillhub_config',
  description: `查看或修改 SkillHub 的地址配置（写入项目根目录的 .env 文件）。

配置项（.env 中的环境变量）：
- SKILLHUB_URL        SkillHub 前端地址（默认 https://skillhub.cloud.tencent.com）
- SKILLHUB_API_BASE   SkillHub API 基础地址（默认 https://skillhub.cn）`,
  inputSchema: configSchema,
  readonly: false,

  describe(input) {
    return input.action === 'get' ? '查看 SkillHub 配置' : '修改 SkillHub 配置'
  },

  async execute(input) {
    if (input.action === 'get') {
      return {
        type: 'success',
        output: [
          '当前 SkillHub 配置（来自 .env）：',
          `  SKILLHUB_URL:      ${process.env.SKILLHUB_URL ?? DEFAULT_SKILLHUB_URL}（${process.env.SKILLHUB_URL ? '已自定义' : '默认值'}）`,
          `  SKILLHUB_API_BASE: ${process.env.SKILLHUB_API_BASE ?? DEFAULT_SKILLHUB_API}（${process.env.SKILLHUB_API_BASE ? '已自定义' : '默认值'}）`,
          '',
          `技能浏览地址：${getSkillHubUrl()}/skills`,
          `用户级技能目录：${getUserSkillsDir()}`,
        ].join('\n'),
      }
    }

    if (!input.skillhub_url && !input.skillhub_api_base) {
      return { type: 'error', message: '请提供至少一个要修改的配置项（skillhub_url 或 skillhub_api_base）' }
    }

    const envPath = resolve(getGlobalCwd(), '.env')
    let envContent = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : ''

    const updates: Record<string, string> = {}
    if (input.skillhub_url) updates['SKILLHUB_URL'] = input.skillhub_url
    if (input.skillhub_api_base) updates['SKILLHUB_API_BASE'] = input.skillhub_api_base

    for (const [key, value] of Object.entries(updates)) {
      const lineRe = new RegExp(`^(#\\s*)?${key}=.*$`, 'm')
      const newLine = `${key}=${value}`
      if (lineRe.test(envContent)) {
        envContent = envContent.replace(lineRe, newLine)
      } else {
        envContent = envContent.trimEnd() + `\n\n# SkillHub 配置\n${newLine}\n`
      }
      process.env[key] = value
    }

    writeFileSync(envPath, envContent, 'utf-8')
    auditLog({ action: 'skillhub_config_set', resource: envPath, result: 'allowed', details: updates })

    return {
      type: 'success',
      output: `✓ SkillHub 配置已写入 .env：\n${Object.entries(updates).map(([k, v]) => `  ${k}=${v}`).join('\n')}\n\n配置立即生效，无需重启。`,
    }
  },
}

// ─────────────────────────────────────────────
// SkillHub 搜索 API（对应 Python 的 fetch_remote_search_results）
// ─────────────────────────────────────────────

const DEFAULT_SEARCH_API = 'https://lightmake.site/api/v1/search'
const DEFAULT_DOWNLOAD_URL_TEMPLATE = 'https://lightmake.site/api/v1/download?slug={slug}'
const DEFAULT_FALLBACK_DOWNLOAD_TEMPLATE = 'https://skillhub-1388575217.cos.ap-guangzhou.myqcloud.com/skills/{slug}.zip'

function getSearchApiUrl(): string {
  return (process.env.SKILLHUB_SEARCH_URL ?? DEFAULT_SEARCH_API).replace(/\/$/, '')
}

function getDownloadUrl(slug: string): string {
  const template = process.env.SKILLHUB_PRIMARY_DOWNLOAD_URL_TEMPLATE ?? DEFAULT_DOWNLOAD_URL_TEMPLATE
  return template.replace('{slug}', encodeURIComponent(slug))
}

function getFallbackDownloadUrl(slug: string): string {
  return DEFAULT_FALLBACK_DOWNLOAD_TEMPLATE.replace('{slug}', encodeURIComponent(slug))
}

interface RemoteSkillInfo {
  slug: string
  name: string
  description: string
  version: string
}

async function fetchRemoteSkillInfo(slug: string): Promise<RemoteSkillInfo | null> {
  try {
    const url = `${getSearchApiUrl()}?q=${encodeURIComponent(slug)}&limit=20`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'hrids-agent/skillhub', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return null
    const data = await res.json() as { results?: unknown[] }
    if (!Array.isArray(data.results)) return null
    // 精确匹配 slug
    const exact = data.results.find((item): item is Record<string, unknown> => {
      return typeof item === 'object' && item !== null && (item as Record<string, unknown>)['slug'] === slug
    })
    if (!exact) return null
    return {
      slug,
      name: String(exact['displayName'] ?? exact['name'] ?? slug).trim() || slug,
      description: String(exact['summary'] ?? exact['description'] ?? '').trim(),
      version: String(exact['version'] ?? '').trim(),
    }
  } catch {
    return null
  }
}

/** 下载 zip 并解压到目标目录（带 fallback），对应 Python 的 install_zip_to_target_with_fallback */
async function downloadAndExtractSkill(
  slug: string,
  targetDir: string,
  force: boolean,
): Promise<void> {
  const { execSync } = await import('child_process')
  const os = await import('os')

  if (existsSync(targetDir) && !force) {
    throw new Error(`目标目录已存在: ${targetDir}（使用 force=true 覆盖）`)
  }

  const primaryUrl = getDownloadUrl(slug)
  const fallbackUrl = getFallbackDownloadUrl(slug)
  const tmpZip = join(os.tmpdir(), `skillhub-install-${slug}-${Date.now()}.zip`)
  const tmpDir = join(os.tmpdir(), `skillhub-install-${slug}-${Date.now()}`)

  // 尝试下载（主源 → 备用源）
  let lastErr = ''
  for (const url of [primaryUrl, fallbackUrl]) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'hrids-agent/skillhub', 'Accept': 'application/zip,application/octet-stream,*/*' },
        signal: AbortSignal.timeout(60000),
      })
      if (!res.ok) {
        lastErr = `HTTP ${res.status} — ${url}`
        continue
      }
      const buf = Buffer.from(await res.arrayBuffer())
      writeFileSync(tmpZip, buf)
      lastErr = ''
      break
    } catch (err) {
      lastErr = `${String(err)} — ${url}`
    }
  }
  if (lastErr) throw new Error(`下载失败: ${lastErr}`)

  try {
    mkdirSync(tmpDir, { recursive: true })

    // 跨平台解压
    if (process.platform === 'win32') {
      execSync(
        `powershell -NoProfile -NonInteractive -Command "Expand-Archive -Path '${tmpZip}' -DestinationPath '${tmpDir}' -Force"`,
        { timeout: 30000 },
      )
    } else {
      execSync(`unzip -o "${tmpZip}" -d "${tmpDir}"`, { timeout: 30000 })
    }

    // 替换目标目录
    if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true })
    }
    mkdirSync(resolve(targetDir, '..'), { recursive: true })
    cpSync(tmpDir, targetDir, { recursive: true })
  } finally {
    try { rmSync(tmpZip, { force: true }) } catch { /* 忽略 */ }
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
}

// ─────────────────────────────────────────────
// skillhub_search
// ─────────────────────────────────────────────

const searchSchema = z.object({
  query: z.string().describe('搜索关键词，例如 "天气"、"github"、"PDF转换"'),
  limit: z.number().int().min(1).max(20).default(10).describe('返回结果数量，默认 10'),
})

export const SkillHubSearchTool: ToolDef<typeof searchSchema> = {
  name: 'skillhub_search',
  description: `在 SkillHub 上搜索可用的 AI 技能（收录 3.4 万个）。
通过 JSON API 搜索，不依赖页面渲染，网络可达即可使用。
搜索后可用 skillhub_install 安装技能到 ~/.hrids-agent/skills/。`,
  inputSchema: searchSchema,
  readonly: true,

  describe(input) {
    return `搜索 SkillHub 技能: "${input.query}"`
  },

  async execute(input) {
    const baseUrl = getSkillHubUrl()
    const searchApiUrl = `${getSearchApiUrl()}?q=${encodeURIComponent(input.query)}&limit=${input.limit}`

    try {
      const res = await fetch(searchApiUrl, {
        headers: { 'User-Agent': 'hrids-agent/skillhub', 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10000),
      })

      if (res.ok) {
        const data = await res.json() as { results?: unknown[] }
        if (Array.isArray(data.results) && data.results.length > 0) {
          const skills = data.results
            .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
            .slice(0, input.limit)

          const lines = [
            `在 SkillHub 找到 ${skills.length} 个技能（搜索词："${input.query}"）：`,
            '',
            ...skills.map((s, i) => {
              const slug = String(s['slug'] ?? '')
              const name = String(s['displayName'] ?? s['name'] ?? slug).trim() || slug
              const desc = String(s['summary'] ?? s['description'] ?? '').trim()
              const ver = String(s['version'] ?? '').trim()
              return [
                `${i + 1}. **${name}**${ver ? `  v${ver}` : ''}`,
                `   ID: ${slug}`,
                desc ? `   ${desc}` : '',
                `   安装: skillhub_install skill_id="${slug}"`,
              ].filter(Boolean).join('\n')
            }),
            '',
            `浏览更多：${baseUrl}/skills?q=${encodeURIComponent(input.query)}`,
          ]
          return { type: 'success', output: lines.join('\n') }
        }
      }

      // API 无结果时回退到页面解析
      const html = await fetchSkillHubPage(`${baseUrl}/skills?q=${encodeURIComponent(input.query)}`)
      const skills = parseSkillListFromHtml(html).slice(0, input.limit)

      if (skills.length === 0) {
        return {
          type: 'success',
          output: [
            `在 SkillHub 上未找到与 "${input.query}" 相关的技能。`,
            `可直接浏览：${baseUrl}/skills`,
          ].join('\n'),
        }
      }

      const lines = [
        `在 SkillHub 找到 ${skills.length} 个技能（搜索词："${input.query}"）：`,
        '',
        ...skills.map((s, i) =>
          `${i + 1}. **${s.title}**\n   ID: ${s.id}\n   安装: skillhub_install skill_id="${s.id}"`
        ),
        '',
        `浏览更多：${baseUrl}/skills?q=${encodeURIComponent(input.query)}`,
      ]
      return { type: 'success', output: lines.join('\n') }
    } catch (err) {
      return {
        type: 'error',
        message: [
          `搜索 SkillHub 失败: ${String(err)}`,
          '',
          `请检查网络是否能访问 ${baseUrl}，或通过浏览器访问：${baseUrl}/skills`,
        ].join('\n'),
      }
    }
  },
}

// ─────────────────────────────────────────────
// skillhub_install
// ─────────────────────────────────────────────

const installSchema = z.object({
  skill_id: z.string().describe('技能 ID，例如 "github"、"tencent-meeting-skill"'),
  scope: z.enum(['user', 'project']).default('user').describe(
    'user（默认）= 安装到 ~/.hrids-agent/skills/；project = 安装到 .agent/skills/',
  ),
  force: z.boolean().default(false).describe('是否覆盖已存在的同名技能'),
})

export const SkillHubInstallTool: ToolDef<typeof installSchema> = {
  name: 'skillhub_install',
  description: `从 SkillHub 下载并安装技能到本地。

优先使用 skillhub CLI（skillhub install <id>），CLI 未安装时引导安装。
安装后技能立即可用，可通过 skill <技能名> 调用。

安装位置：
- user（默认）：~/.hrids-agent/skills/<技能名>/SKILL.md
- project：.agent/skills/<技能名>/SKILL.md`,
  inputSchema: installSchema,
  readonly: false,

  describe(input) {
    return `从 SkillHub 安装技能: ${input.skill_id} → ${input.scope === 'user' ? '~/.hrids-agent/skills/' : '.agent/skills/'}`
  },

  async execute(input) {
    const baseUrl = getSkillHubUrl()

    // 优先路径：skillhub CLI
    const cliResult = await tryInstallViaCli(input.skill_id, input.scope, input.force)
    if (cliResult.used) {
      return cliResult.success
        ? { type: 'success', output: cliResult.output! }
        : { type: 'error', message: cliResult.error! }
    }

    // 回退路径：CLI 未安装，直接通过 API 下载 zip 包安装
    const skillsDir = input.scope === 'user' ? getUserSkillsDir() : getProjectSkillsDir()
    const targetDir = join(skillsDir, input.skill_id)
    const targetMd = join(targetDir, 'SKILL.md')

    if (existsSync(targetMd) && !input.force) {
      return {
        type: 'error',
        message: `技能 "${input.skill_id}" 已存在（${targetDir}）。如需覆盖，请设置 force=true。`,
      }
    }

    try {
      // 查询技能信息（用于 lockfile 记录）
      const remoteInfo = await fetchRemoteSkillInfo(input.skill_id)
      const skillName = remoteInfo?.name ?? input.skill_id
      const skillVersion = remoteInfo?.version ?? ''

      // 下载 zip 并解压
      await downloadAndExtractSkill(input.skill_id, targetDir, input.force)

      // 写入 lockfile
      const lock = loadLockfile(skillsDir)
      lock.skills[input.skill_id] = {
        name: skillName,
        zip_url: getDownloadUrl(input.skill_id),
        source: 'skillhub',
        version: skillVersion,
      }
      saveLockfile(skillsDir, lock)

      auditLog({
        action: 'skillhub_install_cli',
        resource: targetDir,
        result: 'allowed',
        details: { skillId: input.skill_id, scope: input.scope, version: skillVersion },
      })

      const lines = [
        `✓ 已安装技能 "${skillName}"（${input.scope === 'user' ? '用户级' : '项目级'}）`,
        skillVersion ? `  版本: ${skillVersion}` : '',
        `  路径: ${targetDir}`,
        existsSync(targetMd) ? `  现在可以通过 \`skill ${input.skill_id}\` 调用它。` : `  注意：未找到 SKILL.md，技能可能使用其他格式。`,
      ].filter(Boolean).join('\n')

      return { type: 'success', output: lines }
    } catch (err) {
      // zip 下载失败时，回退到从页面抓取 SKILL.md（最后手段）
      try {
        const skillPageUrl = `${baseUrl}/skills/${input.skill_id}`
        const html = await fetchSkillHubPage(skillPageUrl)
        const titleMatch = html.match(/<h1[^>]*>\s*([^<]+)\s*<\/h1>/i)
        const skillTitle = titleMatch ? decodeHtmlEntities(titleMatch[1]!.trim()) : input.skill_id
        const content = extractSkillContent(html, input.skill_id, skillTitle)

        mkdirSync(targetDir, { recursive: true })
        writeFileSync(targetMd, content, 'utf-8')

        // 写入 lockfile
        const lock = loadLockfile(skillsDir)
        lock.skills[input.skill_id] = {
          name: skillTitle,
          zip_url: '',
          source: 'skillhub-page',
          version: '',
        }
        saveLockfile(skillsDir, lock)

        auditLog({
          action: 'skillhub_install_cli',
          resource: targetMd,
          result: 'allowed',
          details: { skillId: input.skill_id, scope: input.scope, source: 'page-fallback' },
        })

        return {
          type: 'success',
          output: [
            `✓ 已安装技能 "${skillTitle}"（页面抓取模式，zip 下载失败）`,
            `  来源: ${skillPageUrl}`,
            `  路径: ${targetMd}`,
            `  现在可以通过 \`skill ${input.skill_id}\` 调用它。`,
            `  提示：安装 skillhub CLI 可获得完整的 zip 包安装体验。`,
          ].join('\n'),
        }
      } catch (fallbackErr) {
        auditLog({
          action: 'skillhub_install_cli',
          resource: input.skill_id,
          result: 'error',
          details: { error: String(err), fallbackError: String(fallbackErr) },
        })
        return {
          type: 'error',
          message: [
            `安装技能 "${input.skill_id}" 失败。`,
            `  zip 下载错误: ${String(err)}`,
            `  页面抓取错误: ${String(fallbackErr)}`,
            '',
            `请检查网络是否能访问 ${baseUrl}，或先安装 skillhub CLI（skillhub_setup）。`,
          ].join('\n'),
        }
      }
    }
  },
}

// ─────────────────────────────────────────────
// skillhub_setup
// ─────────────────────────────────────────────

const setupSchema = z.object({
  confirm: z.boolean().default(false).describe('确认安装（设为 true 才会执行）'),
})

export const SkillHubSetupTool: ToolDef<typeof setupSchema> = {
  name: 'skillhub_setup',
  description: `安装 skillhub CLI 工具。

安全说明：脚本先下载到本地临时文件，再执行（不走管道）。
安装到 ~/.skillhub/bin/，不影响系统目录。

使用前请确认：confirm=true`,
  inputSchema: setupSchema,
  readonly: false,

  describe() {
    return '安装 skillhub CLI'
  },

  async execute(input) {
    if (!input.confirm) {
      return {
        type: 'error',
        message: '请设置 confirm=true 确认安装 skillhub CLI。\n\n安装来源：https://skillhub.cn/install/install.sh',
      }
    }

    const existing = await checkCliInstalled()
    if (existing) {
      return { type: 'success', output: `skillhub CLI 已安装（${existing}），无需重复安装。` }
    }

    const installScriptUrl = `${getSkillHubApiBase()}/install/install.sh`
    return isWindows ? installOnWindows(installScriptUrl) : installOnUnix(installScriptUrl)
  },
}

// ─────────────────────────────────────────────
// skillhub_recommend
// ─────────────────────────────────────────────

const recommendSchema = z.object({
  task: z.string().describe('描述你要完成的任务，例如 "我需要操作腾讯文档"、"帮我搜索网页"'),
})

export const SkillHubRecommendTool: ToolDef<typeof recommendSchema> = {
  name: 'skillhub_recommend',
  description: `根据任务描述，推荐合适的 SkillHub 技能并给出安装建议。`,
  inputSchema: recommendSchema,
  readonly: true,

  describe(input) {
    return `为任务推荐 SkillHub 技能: "${input.task.slice(0, 40)}"`
  },

  async execute(input) {
    const baseUrl = getSkillHubUrl()
    const keywords = extractKeywords(input.task)
    const results: Array<{ id: string; title: string; relevance: string }> = []

    for (const kw of keywords.slice(0, 3)) {
      try {
        const html = await fetchSkillHubPage(`${baseUrl}/skills?q=${encodeURIComponent(kw)}`)
        const skills = parseSkillListFromHtml(html)
        const seen = new Set(results.map(r => r.id))
        for (const s of skills.slice(0, 3)) {
          if (!seen.has(s.id)) {
            seen.add(s.id)
            results.push({ id: s.id, title: s.title, relevance: kw })
          }
        }
      } catch { /* 单个关键词失败不影响整体 */ }
    }

    if (results.length === 0) {
      return {
        type: 'success',
        output: [
          `未在 SkillHub 找到与"${input.task}"直接相关的技能。`,
          `可直接浏览 ${baseUrl}/skills 查找，或用 skillhub_search 尝试不同关键词。`,
        ].join('\n'),
      }
    }

    const lines = [
      `根据任务"${input.task}"，推荐以下技能：`,
      '',
      ...results.slice(0, 6).map((r, i) =>
        `${i + 1}. **${r.title}**（关键词：${r.relevance}）\n   安装: skillhub_install skill_id="${r.id}"`
      ),
      '',
      '如需安装，直接告诉我"安装 <技能名>"。',
    ]

    return { type: 'success', output: lines.join('\n') }
  },
}

// ─────────────────────────────────────────────
// 内部辅助
// ─────────────────────────────────────────────

const isWindows = process.platform === 'win32'

async function checkCliInstalled(): Promise<string | null> {
  try {
    const { execSync } = await import('child_process')
    const out = execSync('skillhub --version 2>&1', { timeout: 5000, encoding: 'utf-8' })
    return out.trim() || 'installed'
  } catch {
    return null
  }
}

interface CliInstallResult {
  used: boolean
  success?: boolean
  output?: string
  error?: string
}

async function tryInstallViaCli(
  skillId: string,
  scope: 'user' | 'project',
  force: boolean,
): Promise<CliInstallResult> {
  const cliVersion = await checkCliInstalled()
  if (!cliVersion) return { used: false }

  const { execSync } = await import('child_process')
  const cwd = getGlobalCwd()

  const targetDir = scope === 'user'
    ? join(getUserSkillsDir(), skillId)
    : join(getProjectSkillsDir(), skillId)
  const targetMd = join(targetDir, 'SKILL.md')

  if (existsSync(targetMd) && !force) {
    return {
      used: true,
      success: false,
      error: `技能 "${skillId}" 已存在（${targetMd}）。如需覆盖，请设置 force=true。`,
    }
  }

  const cliDefaultDir = join(cwd, '.agent', 'skills', skillId)
  const forceFlag = force ? ' --force' : ''
  const cmd = `skillhub install ${skillId}${forceFlag}`

  try {
    execSync(cmd, { cwd, timeout: 60000, encoding: 'utf-8', env: { ...process.env } })

    // user 级别：将 CLI 安装的文件从 .agent/skills/ 移动到 ~/.hrids-agent/skills/
    if (scope === 'user' && existsSync(cliDefaultDir)) {
      mkdirSync(getUserSkillsDir(), { recursive: true })
      cpSync(cliDefaultDir, targetDir, { recursive: true, force: true })
      try { rmSync(cliDefaultDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
    }

    auditLog({ action: 'skillhub_install_cli', resource: targetMd, result: 'allowed', details: { cmd, scope } })

    return {
      used: true,
      success: true,
      output: [
        `✓ 已安装技能 "${skillId}"（${scope === 'user' ? '用户级' : '项目级'}）`,
        `  路径: ${targetMd}`,
        `  现在可以通过 \`skill ${skillId}\` 调用它。`,
      ].join('\n'),
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    auditLog({ action: 'skillhub_install_cli', resource: skillId, result: 'error', details: { cmd, error: msg } })
    return { used: true, success: false, error: `skillhub CLI 安装失败: ${msg}` }
  }
}

async function installOnUnix(scriptUrl: string): Promise<ToolResult> {
  const { execSync } = await import('child_process')
  const tmpScript = `/tmp/skillhub-install-${Date.now()}.sh`
  try {
    execSync(`curl -fsSL "${scriptUrl}" -o "${tmpScript}"`, { timeout: 30000, encoding: 'utf-8' })
    execSync(`bash "${tmpScript}"`, { timeout: 120000, encoding: 'utf-8', stdio: 'pipe' })
    try { execSync(`rm -f "${tmpScript}"`) } catch { /* 忽略 */ }
    auditLog({ action: 'skillhub_setup', resource: 'cli', result: 'allowed', details: { platform: 'unix' } })
    const version = await checkCliInstalled()
    return {
      type: 'success',
      output: [
        `✓ skillhub CLI 安装成功${version ? `（${version}）` : ''}`,
        '现在可以使用 skillhub_install 安装技能了。',
        '如果命令未找到，请执行：source ~/.bashrc  # 或 source ~/.zshrc',
      ].join('\n'),
    }
  } catch (err) {
    try { execSync(`rm -f "${tmpScript}"`) } catch { /* 忽略 */ }
    auditLog({ action: 'skillhub_setup', resource: 'cli', result: 'error', details: { error: String(err) } })
    return { type: 'error', message: `安装 skillhub CLI 失败: ${String(err)}` }
  }
}

async function installOnWindows(scriptUrl: string): Promise<ToolResult> {
  const { execSync } = await import('child_process')
  const tmpDir = process.env.TEMP ?? 'C:\\Windows\\Temp'
  const tmpScript = `${tmpDir}\\skillhub-install-${Date.now()}.ps1`
  const psScriptUrl = scriptUrl.replace(/\.sh$/, '.ps1')
  try {
    execSync(
      `powershell -NoProfile -NonInteractive -Command "Invoke-WebRequest -Uri '${psScriptUrl}' -OutFile '${tmpScript}'"`,
      { timeout: 30000, encoding: 'utf-8' },
    )
    execSync(
      `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${tmpScript}"`,
      { timeout: 120000, encoding: 'utf-8', stdio: 'pipe' },
    )
    try { execSync(`del /f "${tmpScript}"`) } catch { /* 忽略 */ }
    auditLog({ action: 'skillhub_setup', resource: 'cli', result: 'allowed', details: { platform: 'windows' } })
    const version = await checkCliInstalled()
    return {
      type: 'success',
      output: [
        `✓ skillhub CLI 安装成功${version ? `（${version}）` : ''}`,
        '现在可以使用 skillhub_install 安装技能了。',
        '如果命令未找到，请重启终端让 PATH 生效。',
      ].join('\n'),
    }
  } catch (err) {
    try { execSync(`del /f "${tmpScript}"`) } catch { /* 忽略 */ }
    auditLog({ action: 'skillhub_setup', resource: 'cli', result: 'error', details: { error: String(err) } })
    return { type: 'error', message: `安装 skillhub CLI 失败: ${String(err)}` }
  }
}

function extractKeywords(task: string): string[] {
  const keywords: string[] = []
  const serviceMap: Array<[RegExp, string]> = [
    [/腾讯会议|tencent meeting/i, '腾讯会议'],
    [/腾讯文档|tencent docs/i, '腾讯文档'],
    [/腾讯云|tencent cloud/i, 'tencent cloud'],
    [/微信|wechat/i, 'wechat'],
    [/github/i, 'github'],
    [/notion/i, 'notion'],
    [/obsidian/i, 'obsidian'],
    [/pdf/i, 'pdf'],
    [/excel|xlsx/i, 'excel'],
    [/word|docx/i, 'word'],
    [/ppt|powerpoint/i, 'powerpoint'],
    [/搜索|search/i, 'search'],
    [/浏览器|browser/i, 'browser'],
    [/邮件|email|mail/i, 'email'],
    [/天气|weather/i, 'weather'],
    [/股票|stock/i, 'stock'],
    [/新闻|news/i, 'news'],
    [/视频|video/i, 'video'],
    [/图片|image/i, 'image'],
    [/数据分析|data analysis/i, 'data analysis'],
    [/自动化|automation/i, 'automation'],
  ]
  for (const [re, kw] of serviceMap) {
    if (re.test(task)) keywords.push(kw)
  }
  const chineseWords = task.match(/[\u4e00-\u9fa5]{2,4}/g) ?? []
  for (const w of chineseWords) {
    if (!keywords.includes(w) && keywords.length < 5) keywords.push(w)
  }
  const englishWords = task.match(/[a-zA-Z]{3,}/g) ?? []
  for (const w of englishWords) {
    if (!keywords.includes(w.toLowerCase()) && keywords.length < 5) keywords.push(w.toLowerCase())
  }
  return keywords.length > 0 ? keywords : [task.slice(0, 20)]
}

// ─────────────────────────────────────────────
// Lockfile 辅助（对应 Python 的 load_lockfile / save_lockfile）
// ─────────────────────────────────────────────

const LOCKFILE_NAME = '.skills_store_lock.json'

interface SkillLockMeta {
  name?: string
  version?: string
  zip_url?: string
  update_url?: string
  source?: string
}

interface LockFile {
  version: number
  skills: Record<string, SkillLockMeta>
}

function loadLockfile(skillsDir: string): LockFile {
  const lockPath = join(skillsDir, LOCKFILE_NAME)
  if (!existsSync(lockPath)) return { version: 1, skills: {} }
  try {
    const raw = JSON.parse(readFileSync(lockPath, 'utf-8')) as unknown
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { version: 1, skills: {} }
    const obj = raw as Record<string, unknown>
    if (typeof obj['skills'] !== 'object' || obj['skills'] === null || Array.isArray(obj['skills'])) {
      obj['skills'] = {}
    }
    return obj as unknown as LockFile
  } catch {
    return { version: 1, skills: {} }
  }
}

function saveLockfile(skillsDir: string, lock: LockFile): void {
  mkdirSync(skillsDir, { recursive: true })
  const lockPath = join(skillsDir, LOCKFILE_NAME)
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n', 'utf-8')
}

/** 版本比较：candidate 是否比 current 更新 */
function versionIsNewer(candidate: string, current: string): boolean {
  const c = candidate.trim()
  const cur = current.trim()
  if (!c) return false
  if (!cur) return true
  const parseVer = (v: string) => {
    const raw = v.replace(/^v/i, '').split('-')[0]!.split('+')[0]!
    const parts = raw.split('.').map(Number)
    return parts.every(n => !isNaN(n)) ? parts : null
  }
  const a = parseVer(c)
  const b = parseVer(cur)
  if (a && b) {
    const len = Math.max(a.length, b.length)
    for (let i = 0; i < len; i++) {
      const ai = a[i] ?? 0
      const bi = b[i] ?? 0
      if (ai !== bi) return ai > bi
    }
    return false
  }
  return c !== cur
}

/** 从技能 config.json 中提取 update_url */
function extractUpdateUrl(config: Record<string, unknown>): string {
  const directKeys = ['update_url', 'updateUrl', 'upgrade_url', 'upgradeUrl', 'manifest_url', 'manifestUrl']
  for (const key of directKeys) {
    const v = config[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  for (const containerKey of ['update', 'upgrade', 'autoupdate']) {
    const nested = config[containerKey]
    if (typeof nested === 'object' && nested !== null && !Array.isArray(nested)) {
      const n = nested as Record<string, unknown>
      for (const urlKey of ['url', 'uri', 'manifest', 'manifest_url']) {
        const v = n[urlKey]
        if (typeof v === 'string' && v.trim()) return v.trim()
      }
    }
  }
  return ''
}

/** 从更新 manifest 中提取 version / package_url / sha256 */
function extractUpdateManifestInfo(manifest: Record<string, unknown>): { version: string; packageUrl: string; sha256: string } {
  const candidates: Record<string, unknown>[] = [manifest]
  for (const key of ['latest', 'release', 'data', 'skill', 'package']) {
    const nested = manifest[key]
    if (typeof nested === 'object' && nested !== null && !Array.isArray(nested)) {
      candidates.push(nested as Record<string, unknown>)
    }
  }
  let version = ''
  let packageUrl = ''
  let sha256 = ''
  for (const item of candidates) {
    if (!version) {
      for (const k of ['version', 'latest_version', 'latestVersion']) {
        const v = item[k]
        if (typeof v === 'string' && v.trim()) { version = v.trim(); break }
      }
    }
    if (!packageUrl) {
      for (const k of ['zip_url', 'zipUrl', 'download_url', 'downloadUrl', 'package_url', 'packageUrl', 'url']) {
        const v = item[k]
        if (typeof v === 'string' && v.trim()) { packageUrl = v.trim(); break }
      }
    }
    if (!sha256) {
      for (const k of ['sha256', 'sha_256', 'checksum']) {
        const v = item[k]
        if (typeof v === 'string' && v.trim()) { sha256 = v.trim().toLowerCase(); break }
      }
    }
  }
  return { version, packageUrl, sha256 }
}

// ─────────────────────────────────────────────
// skillhub_list
// ─────────────────────────────────────────────

const listSchema = z.object({
  scope: z.enum(['user', 'project', 'all']).default('all').describe(
    'user = ~/.hrids-agent/skills/；project = .agent/skills/；all（默认）= 两者都列出',
  ),
})

export const SkillHubListTool: ToolDef<typeof listSchema> = {
  name: 'skillhub_list',
  description: `列出本地已安装的 SkillHub 技能（从 lockfile 读取）。

显示技能 slug、版本、来源和安装路径。`,
  inputSchema: listSchema,
  readonly: true,

  describe(input) {
    return `列出已安装技能（${input.scope}）`
  },

  async execute(input) {
    const scopes: Array<{ label: string; dir: string }> = []
    if (input.scope === 'user' || input.scope === 'all') {
      scopes.push({ label: '用户级', dir: getUserSkillsDir() })
    }
    if (input.scope === 'project' || input.scope === 'all') {
      scopes.push({ label: '项目级', dir: join(getProjectSkillsDir()) })
    }

    const lines: string[] = []
    let totalCount = 0

    for (const { label, dir } of scopes) {
      const lock = loadLockfile(dir)
      const skills = lock.skills ?? {}
      const slugs = Object.keys(skills).sort()

      lines.push(`── ${label}（${dir}）`)
      if (slugs.length === 0) {
        lines.push('   （无已安装技能）')
      } else {
        for (const slug of slugs) {
          const meta = skills[slug] ?? {}
          const version = meta.version?.trim() || '<未知版本>'
          const source = meta.source?.trim() || 'skillhub'
          lines.push(`   ${slug}  ${version}  [${source}]`)
          totalCount++
        }
      }
      lines.push('')
    }

    if (totalCount === 0) {
      lines.push('提示：使用 skillhub_install 安装技能，或 skillhub_search 搜索可用技能。')
    } else {
      lines.push(`共 ${totalCount} 个已安装技能。`)
    }

    return { type: 'success', output: lines.join('\n') }
  },
}

// ─────────────────────────────────────────────
// skillhub_uninstall
// ─────────────────────────────────────────────

const uninstallSchema = z.object({
  skill_id: z.string().describe('要卸载的技能 ID（slug），例如 "github"'),
  scope: z.enum(['user', 'project']).default('user').describe(
    'user（默认）= 从 ~/.hrids-agent/skills/ 卸载；project = 从 .agent/skills/ 卸载',
  ),
})

export const SkillHubUninstallTool: ToolDef<typeof uninstallSchema> = {
  name: 'skillhub_uninstall',
  description: `卸载本地已安装的 SkillHub 技能。

删除技能目录并从 lockfile 中移除记录。`,
  inputSchema: uninstallSchema,
  readonly: false,

  describe(input) {
    return `卸载技能: ${input.skill_id}（${input.scope}）`
  },

  async execute(input) {
    const skillsDir = input.scope === 'user' ? getUserSkillsDir() : getProjectSkillsDir()
    const targetDir = join(skillsDir, input.skill_id)

    const lock = loadLockfile(skillsDir)
    const inLock = input.skill_id in (lock.skills ?? {})
    const dirExists = existsSync(targetDir)

    if (!inLock && !dirExists) {
      return {
        type: 'error',
        message: `技能 "${input.skill_id}" 未安装（在 ${skillsDir} 中未找到）。`,
      }
    }

    try {
      // 删除技能目录
      if (dirExists) {
        rmSync(targetDir, { recursive: true, force: true })
      }

      // 从 lockfile 移除记录
      if (inLock) {
        delete lock.skills[input.skill_id]
        saveLockfile(skillsDir, lock)
      }

      auditLog({
        action: 'skillhub_uninstall',
        resource: targetDir,
        result: 'allowed',
        details: { skillId: input.skill_id, scope: input.scope },
      })

      return {
        type: 'success',
        output: [
          `✓ 已卸载技能 "${input.skill_id}"（${input.scope === 'user' ? '用户级' : '项目级'}）`,
          `  已删除目录: ${targetDir}`,
          inLock ? '  已从 lockfile 移除记录。' : '  （lockfile 中无记录，仅删除目录）',
        ].join('\n'),
      }
    } catch (err) {
      auditLog({
        action: 'skillhub_uninstall',
        resource: targetDir,
        result: 'error',
        details: { error: String(err) },
      })
      return { type: 'error', message: `卸载技能 "${input.skill_id}" 失败: ${String(err)}` }
    }
  },
}

// ─────────────────────────────────────────────
// skillhub_upgrade
// ─────────────────────────────────────────────

const upgradeSchema = z.object({
  skill_id: z.string().optional().describe('指定要升级的技能 ID；留空则升级所有已安装技能'),
  scope: z.enum(['user', 'project']).default('user').describe(
    'user（默认）= ~/.hrids-agent/skills/；project = .agent/skills/',
  ),
  check_only: z.boolean().default(false).describe('仅检查可用更新，不实际安装'),
})

export const SkillHubUpgradeTool: ToolDef<typeof upgradeSchema> = {
  name: 'skillhub_upgrade',
  description: `升级本地已安装的 SkillHub 技能。

从每个技能的 config.json 中读取 update_url，拉取更新 manifest，
比较版本后下载并安装新版本（对应 Python CLI 的 upgrade 子命令）。

- 不指定 skill_id：升级所有已安装技能
- check_only=true：仅检查可用更新，不实际安装`,
  inputSchema: upgradeSchema,
  readonly: false,

  describe(input) {
    const target = input.skill_id ? `技能 "${input.skill_id}"` : '所有技能'
    return `升级 ${target}（${input.scope}）${input.check_only ? ' [仅检查]' : ''}`
  },

  async execute(input) {
    const skillsDir = input.scope === 'user' ? getUserSkillsDir() : getProjectSkillsDir()
    const lock = loadLockfile(skillsDir)
    const skills = lock.skills ?? {}

    // 确定要处理的 slug 列表
    const targets: string[] = input.skill_id
      ? [input.skill_id]
      : Object.keys(skills).sort()

    if (targets.length === 0) {
      return {
        type: 'error',
        message: `lockfile 中没有已安装的技能（${skillsDir}/${LOCKFILE_NAME}）。`,
      }
    }

    let checked = 0
    let upgraded = 0
    let skipped = 0
    let failed = 0
    const details: string[] = []

    for (const slug of targets) {
      checked++
      const targetDir = join(skillsDir, slug)

      if (!existsSync(targetDir)) {
        details.push(`[${slug}] 跳过：技能目录不存在（${targetDir}）`)
        skipped++
        continue
      }

      const configPath = join(targetDir, 'config.json')
      if (!existsSync(configPath)) {
        details.push(`[${slug}] 跳过：缺少 config.json`)
        skipped++
        continue
      }

      let rawConfig: Record<string, unknown>
      try {
        rawConfig = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>
        if (typeof rawConfig !== 'object' || rawConfig === null || Array.isArray(rawConfig)) {
          details.push(`[${slug}] 失败：config.json 必须是 JSON 对象`)
          failed++
          continue
        }
      } catch (err) {
        details.push(`[${slug}] 失败：config.json 解析错误 — ${String(err)}`)
        failed++
        continue
      }

      const updateUrl = extractUpdateUrl(rawConfig)
      if (!updateUrl) {
        details.push(`[${slug}] 跳过：config.json 中缺少 update_url`)
        skipped++
        continue
      }

      try {
        // 保存当前 config.json 内容（升级后可能被覆盖）
        const preservedConfig = readFileSync(configPath, 'utf-8')

        // 拉取更新 manifest
        const manifestRes = await fetch(updateUrl, {
          headers: { 'User-Agent': 'hrids-agent/skillhub', 'Accept': 'application/json' },
          signal: AbortSignal.timeout(20000),
        })
        if (!manifestRes.ok) {
          details.push(`[${slug}] 失败：拉取 manifest 失败 HTTP ${manifestRes.status} — ${updateUrl}`)
          failed++
          continue
        }
        const manifest = await manifestRes.json() as Record<string, unknown>
        const { version: latestVersion, packageUrl, sha256: _sha256 } = extractUpdateManifestInfo(manifest)

        if (!latestVersion) {
          details.push(`[${slug}] 失败：manifest 缺少 version — ${updateUrl}`)
          failed++
          continue
        }
        if (!packageUrl) {
          details.push(`[${slug}] 失败：manifest 缺少 package URL — ${updateUrl}`)
          failed++
          continue
        }

        // 读取当前版本
        const lockMeta = skills[slug] ?? {}
        let currentVersion = lockMeta.version?.trim() ?? ''
        if (!currentVersion) {
          // 尝试从 _meta.json 读取
          const metaPath = join(targetDir, '_meta.json')
          if (existsSync(metaPath)) {
            try {
              const metaRaw = JSON.parse(readFileSync(metaPath, 'utf-8')) as Record<string, unknown>
              const v = metaRaw['version']
              if (typeof v === 'string' && v.trim()) currentVersion = v.trim()
            } catch { /* 忽略 */ }
          }
        }

        if (!versionIsNewer(latestVersion, currentVersion)) {
          details.push(`[${slug}] 已是最新：current=${currentVersion || '<未知>'} latest=${latestVersion}`)
          skipped++
          continue
        }

        if (input.check_only) {
          details.push(`[${slug}] 可升级：current=${currentVersion || '<未知>'} → latest=${latestVersion}  package=${packageUrl}`)
          continue
        }

        // 下载并解压 zip 包
        const zipRes = await fetch(packageUrl, {
          headers: { 'User-Agent': 'hrids-agent/skillhub', 'Accept': 'application/zip,application/octet-stream,*/*' },
          signal: AbortSignal.timeout(60000),
        })
        if (!zipRes.ok) {
          details.push(`[${slug}] 失败：下载包失败 HTTP ${zipRes.status} — ${packageUrl}`)
          failed++
          continue
        }

        const zipBuffer = Buffer.from(await zipRes.arrayBuffer())

        // 使用 Node.js 内置 zlib 解压（通过 child_process 调用系统工具）
        const { execSync } = await import('child_process')
        const os = await import('os')
        const tmpDir = join(os.tmpdir(), `skillhub-upgrade-${slug}-${Date.now()}`)
        const tmpZip = `${tmpDir}.zip`

        try {
          writeFileSync(tmpZip, zipBuffer)
          mkdirSync(tmpDir, { recursive: true })

          // 跨平台解压
          if (process.platform === 'win32') {
            execSync(
              `powershell -NoProfile -NonInteractive -Command "Expand-Archive -Path '${tmpZip}' -DestinationPath '${tmpDir}' -Force"`,
              { timeout: 30000 },
            )
          } else {
            execSync(`unzip -o "${tmpZip}" -d "${tmpDir}"`, { timeout: 30000 })
          }

          // 替换技能目录
          rmSync(targetDir, { recursive: true, force: true })
          cpSync(tmpDir, targetDir, { recursive: true })

          // 恢复 config.json（如果被覆盖）
          if (!existsSync(configPath)) {
            writeFileSync(configPath, preservedConfig, 'utf-8')
          }
        } finally {
          try { rmSync(tmpZip, { force: true }) } catch { /* 忽略 */ }
          try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
        }

        // 更新 lockfile
        skills[slug] = {
          ...lockMeta,
          zip_url: packageUrl,
          version: latestVersion,
          update_url: updateUrl,
          name: lockMeta.name || slug,
          source: lockMeta.source || 'skillhub',
        }
        upgraded++
        details.push(`[${slug}] 已升级：${currentVersion || '<未知>'} → ${latestVersion}`)
      } catch (err) {
        details.push(`[${slug}] 失败：${String(err)}`)
        failed++
      }
    }

    // 保存 lockfile（即使 check_only，也不修改）
    if (!input.check_only) {
      lock.skills = skills
      saveLockfile(skillsDir, lock)
    }

    auditLog({
      action: 'skillhub_upgrade',
      resource: skillsDir,
      result: failed > 0 ? 'error' : 'allowed',
      details: { checked, upgraded, skipped, failed, checkOnly: input.check_only },
    })

    const summary = input.check_only
      ? `检查完成：共检查 ${checked} 个，可升级 ${details.filter(l => l.includes('可升级')).length} 个，已是最新 ${skipped} 个，失败 ${failed} 个`
      : `升级完成：共检查 ${checked} 个，已升级 ${upgraded} 个，跳过 ${skipped} 个，失败 ${failed} 个`

    return {
      type: 'success',
      output: [...details, '', summary].join('\n'),
    }
  },
}
