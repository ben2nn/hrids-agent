// Plan 文件管理模块 —— 将计划持久化到 ~/.hrids/plans/ 目录
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, readdirSync } from 'fs'
import { join, basename } from 'path'
import { getConfigDir } from './config.js'

// ─── 数据类型定义 ────────────────────────────────────────────────────────────

export type PlanStatus = 'draft' | 'active' | 'completed' | 'archived'

export interface PlanMeta {
  id: string
  title: string
  created: string
  updated: string
  status: PlanStatus
  session_id?: string
  tags?: string[]
}

export interface Plan extends PlanMeta {
  content: string
}

export interface PlanFilter {
  status?: PlanStatus
  tags?: string[]
}

// ─── 路径解析 ────────────────────────────────────────────────────────────────

function getPlansDir(): string {
  return join(getConfigDir(), 'plans')
}

function getPlanFilePath(id: string): string {
  return join(getPlansDir(), `${id}.md`)
}

// ─── ID 生成 ─────────────────────────────────────────────────────────────────

/**
 * 生成 plan ID
 * 格式：plan-YYYYMMDD-NNN（NNN 为当日序号，从 001 开始）
 */
function generatePlanId(): string {
  const now = new Date()
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '')
  const prefix = `plan-${dateStr}-`

  // 确保目录存在
  const plansDir = getPlansDir()
  mkdirSync(plansDir, { recursive: true })

  // 查找当日最大序号
  const files = readdirSync(plansDir).filter(f => f.startsWith(prefix) && f.endsWith('.md'))
  let maxSeq = 0
  for (const file of files) {
    const seqStr = file.slice(prefix.length, -3)
    const seq = parseInt(seqStr, 10)
    if (!isNaN(seq) && seq > maxSeq) maxSeq = seq
  }

  const nextSeq = String(maxSeq + 1).padStart(3, '0')
  return `${prefix}${nextSeq}`
}

// ─── Frontmatter 解析 ────────────────────────────────────────────────────────

function parseFrontmatter(content: string): { meta: Partial<PlanMeta>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return { meta: {}, body: content }

  const metaBlock = match[1]!
  const body = match[2]!
  const meta: Partial<PlanMeta> = {}

  for (const line of metaBlock.split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    const value = line.slice(colonIdx + 1).trim()

    switch (key) {
      case 'id': meta.id = value; break
      case 'title': meta.title = value; break
      case 'created': meta.created = value; break
      case 'updated': meta.updated = value; break
      case 'status': meta.status = value as PlanStatus; break
      case 'session_id': meta.session_id = value; break
      case 'tags':
        // 解析 [tag1, tag2] 格式
        meta.tags = value.slice(1, -1).split(',').map(t => t.trim()).filter(Boolean)
        break
    }
  }

  return { meta, body }
}

function serializeFrontmatter(meta: PlanMeta, body: string): string {
  const lines = [
    '---',
    `id: ${meta.id}`,
    `title: ${meta.title}`,
    `created: ${meta.created}`,
    `updated: ${meta.updated}`,
    `status: ${meta.status}`,
  ]
  if (meta.session_id) lines.push(`session_id: ${meta.session_id}`)
  if (meta.tags && meta.tags.length > 0) lines.push(`tags: [${meta.tags.join(', ')}]`)
  lines.push('---')
  lines.push('')
  lines.push(body)
  return lines.join('\n')
}

// ─── 核心操作 ────────────────────────────────────────────────────────────────

/**
 * 创建新计划
 */
export function createPlan(
  title: string,
  content: string,
  options: { tags?: string[]; session_id?: string } = {},
): Plan {
  const id = generatePlanId()
  const now = new Date().toISOString()

  const meta: PlanMeta = {
    id,
    title,
    created: now,
    updated: now,
    status: 'draft',
    session_id: options.session_id,
    tags: options.tags,
  }

  const plansDir = getPlansDir()
  mkdirSync(plansDir, { recursive: true })

  const filePath = getPlanFilePath(id)
  const serialized = serializeFrontmatter(meta, content)
  writeFileSync(filePath, serialized, 'utf-8')

  return { ...meta, content }
}

/**
 * 读取指定计划
 */
export function getPlan(id: string): Plan | null {
  const filePath = getPlanFilePath(id)
  if (!existsSync(filePath)) return null

  try {
    const raw = readFileSync(filePath, 'utf-8')
    const { meta, body } = parseFrontmatter(raw)

    return {
      id: meta.id ?? id,
      title: meta.title ?? 'Untitled',
      created: meta.created ?? '',
      updated: meta.updated ?? '',
      status: meta.status ?? 'draft',
      session_id: meta.session_id,
      tags: meta.tags,
      content: body,
    }
  } catch {
    return null
  }
}

/**
 * 更新计划内容
 */
export function updatePlan(id: string, content: string): Plan | null {
  const existing = getPlan(id)
  if (!existing) return null

  const now = new Date().toISOString()
  const { content: _, ...rest } = existing
  const meta: PlanMeta = {
    ...rest,
    updated: now,
  }

  const filePath = getPlanFilePath(id)
  const serialized = serializeFrontmatter(meta, content)
  writeFileSync(filePath, serialized, 'utf-8')

  return { ...meta, content }
}

/**
 * 更新计划状态
 */
export function updatePlanStatus(id: string, status: PlanStatus): Plan | null {
  const existing = getPlan(id)
  if (!existing) return null

  const now = new Date().toISOString()
  const { content: _, ...rest } = existing
  const meta: PlanMeta = {
    ...rest,
    status,
    updated: now,
  }

  const filePath = getPlanFilePath(id)
  const serialized = serializeFrontmatter(meta, existing.content)
  writeFileSync(filePath, serialized, 'utf-8')

  return { ...meta, content: existing.content }
}

/**
 * 列出所有计划（可选过滤）
 */
export function listPlans(filter?: PlanFilter): Plan[] {
  const plansDir = getPlansDir()
  if (!existsSync(plansDir)) return []

  const files = readdirSync(plansDir).filter(f => f.endsWith('.md'))
  const plans: Plan[] = []

  for (const file of files) {
    const id = file.slice(0, -3)
    const plan = getPlan(id)
    if (!plan) continue

    // 应用过滤器
    if (filter?.status && plan.status !== filter.status) continue
    if (filter?.tags && filter.tags.length > 0) {
      const planTags = plan.tags ?? []
      if (!filter.tags.some(t => planTags.includes(t))) continue
    }

    plans.push(plan)
  }

  // 按创建时间降序排序
  plans.sort((a, b) => b.created.localeCompare(a.created))

  return plans
}

/**
 * 归档计划
 */
export function archivePlan(id: string): Plan | null {
  return updatePlanStatus(id, 'archived')
}

/**
 * 格式化计划列表为可读字符串
 */
export function formatPlanList(plans: Plan[]): string {
  if (plans.length === 0) return '暂无计划。'

  const statusIcon: Record<PlanStatus, string> = {
    draft: '○',
    active: '▸',
    completed: '✓',
    archived: '◇',
  }

  return plans.map(p => {
    const icon = statusIcon[p.status]
    const tags = p.tags && p.tags.length > 0 ? ` [${p.tags.join(', ')}]` : ''
    const date = p.created.slice(0, 10)
    return `${icon} ${p.id} | ${p.title}${tags} (${date})`
  }).join('\n')
}

/**
 * 格式化单个计划为可读字符串
 */
export function formatPlan(plan: Plan): string {
  const statusLabel: Record<PlanStatus, string> = {
    draft: '草稿',
    active: '进行中',
    completed: '已完成',
    archived: '已归档',
  }

  const lines = [
    `# ${plan.title}`,
    '',
    `状态：${statusLabel[plan.status]} | 创建：${plan.created.slice(0, 10)} | 更新：${plan.updated.slice(0, 10)}`,
  ]
  if (plan.tags && plan.tags.length > 0) lines.push(`标签：${plan.tags.join(', ')}`)
  lines.push('')
  lines.push(plan.content)

  return lines.join('\n')
}
