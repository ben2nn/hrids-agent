// 定时调度工具 —— 让工作者能够设置定时任务，主动触发执行
// 基于 node-cron 实现，持久化到 ~/.hrids/crons.json
import { z } from 'zod'
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { join } from 'path'
import type { ToolDef } from '../core/Tool.js'
import { getCurrentSessionId } from '../core/sessionContext.js'
import { getConfigDir } from '../core/Config.js'
import { invalidateFileCache } from './FileReadTool.js'

const CRON_FILE = join(getConfigDir(), 'crons.json')

// ── 并发写入保护：防止同一轮次并行工具调用导致数据竞态 ──────────────────────
// 使用内存级互斥锁，确保所有读-改-写操作串行执行
let cronLock: Promise<void> = Promise.resolve()

export interface CronJob {
  id: string
  expression: string   // cron 表达式，如 "0 9 * * 1-5"
  description: string  // 人类可读描述
  task: string         // 触发时要执行的任务描述（注入给 agent 的 prompt）
  createdAt: number
  lastRunAt?: number
  nextRunAt?: number
  enabled: boolean
  once?: boolean       // 一次性任务：触发后自动删除
  startDate?: string   // 生效开始日期（ISO 日期字符串，如 "2026-05-01"）
  endDate?: string     // 生效结束日期（ISO 日期字符串，如 "2026-12-31"）
  sessionId?: string   // 归属会话 ID（Gateway 多会话下精确路由触发目标）
}

// ── 持久化 ──────────────────────────────────────────────────────────────────

function loadCrons(): CronJob[] {
  if (!existsSync(CRON_FILE)) return []
  try {
    return JSON.parse(readFileSync(CRON_FILE, 'utf-8')) as CronJob[]
  } catch {
    return []
  }
}

function saveCrons(crons: CronJob[]) {
  const dir = getConfigDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  // 原子写入：先写临时文件再 rename，防止并发写入时文件损坏
  const tmp = CRON_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(crons, null, 2), 'utf-8')
  renameSync(tmp, CRON_FILE)
  invalidateFileCache(CRON_FILE)
}

// ── cron 表达式解析（计算下次执行时间）────────────────────────────────────
//
// 支持格式（5位：分 时 日 月 周）：
//   固定值：  "0 9 * * *"      每天 09:00
//   步进值：  "*/30 * * * *"   每 30 分钟
//             "0 */2 * * *"    每 2 小时
//   范围：    "0 9 * * 1-5"    工作日 09:00
//   列表：    "0 9 * * 1,3,5"  周一三五 09:00
//   具体日期："0 15 15 4 *"    4 月 15 日 15:00

/** 解析单个 cron 字段，返回该字段在 [min, max] 范围内、大于 current 的最小合法值。
 *  若当前值已合法则返回 current，否则返回下一个合法值（可能需要进位）。
 *  返回 null 表示该字段无法在当前范围内满足（需要进位到上一级字段）。
 */
function nextValueInField(field: string, current: number, min: number, max: number): number | null {
  // 收集所有合法值
  const valid: number[] = []

  for (const part of field.split(',')) {
    if (part === '*') {
      for (let i = min; i <= max; i++) valid.push(i)
    } else if (part.startsWith('*/')) {
      const step = parseInt(part.slice(2), 10)
      if (isNaN(step) || step <= 0) continue
      for (let i = min; i <= max; i += step) valid.push(i)
    } else if (part.includes('/')) {
      const [rangeStr, stepStr] = part.split('/')
      const step = parseInt(stepStr, 10)
      const [rangeMin, rangeMax] = (rangeStr ?? '').includes('-')
        ? (rangeStr ?? '').split('-').map(Number)
        : [parseInt(rangeStr ?? '', 10), max]
      if (isNaN(step) || step <= 0) continue
      for (let i = (rangeMin ?? min); i <= (rangeMax ?? max); i += step) valid.push(i)
    } else if (part.includes('-')) {
      const [lo, hi] = part.split('-').map(Number)
      for (let i = (lo ?? min); i <= (hi ?? max); i++) valid.push(i)
    } else {
      const v = parseInt(part, 10)
      if (!isNaN(v)) valid.push(v)
    }
  }

  // 去重排序
  const sorted = [...new Set(valid)].sort((a, b) => a - b)
  if (sorted.length === 0) return null

  // 找到 >= current 的最小值
  const found = sorted.find(v => v >= current)
  return found ?? null
}

function parseNextRun(expression: string, fromTime?: number): number | undefined {
  try {
    const parts = expression.trim().split(/\s+/)
    if (parts.length !== 5) return undefined

    const [minField, hourField, domField, monField, dowField] = parts as [string, string, string, string, string]

    // 从 fromTime（默认 now+1分钟）开始向前搜索，最多搜索 366 天
    const start = new Date(fromTime ?? Date.now())
    start.setSeconds(0, 0)
    start.setMinutes(start.getMinutes() + 1)

    const candidate = new Date(start)
    const deadline = new Date(start)
    deadline.setDate(deadline.getDate() + 366)

    // 最多迭代 366*24*60 次（分钟级步进），实际上会快得多
    for (let iter = 0; iter < 366 * 24 * 60; iter++) {
      if (candidate >= deadline) return undefined

      // 检查月份（1-12）
      const mon = nextValueInField(monField, candidate.getMonth() + 1, 1, 12)
      if (mon === null) return undefined
      if (mon !== candidate.getMonth() + 1) {
        // 跳到下个合法月份的第一天 00:00
        candidate.setMonth(mon - 1, 1)
        candidate.setHours(0, 0, 0, 0)
        continue
      }

      // 检查日期（1-31）
      const daysInMonth = new Date(candidate.getFullYear(), candidate.getMonth() + 1, 0).getDate()
      const dom = nextValueInField(domField, candidate.getDate(), 1, daysInMonth)
      if (dom === null || dom > daysInMonth) {
        // 跳到下个月
        candidate.setMonth(candidate.getMonth() + 1, 1)
        candidate.setHours(0, 0, 0, 0)
        continue
      }
      if (dom !== candidate.getDate()) {
        candidate.setDate(dom)
        candidate.setHours(0, 0, 0, 0)
        continue
      }

      // 检查星期（0=周日，1=周一，...，6=周六；cron 中 7 也表示周日）
      if (dowField !== '*') {
        const dow = candidate.getDay() // 0=周日
        // 将 cron 的 7 映射为 0
        const normalizedField = dowField.replace(/\b7\b/g, '0')
        const validDow = nextValueInField(normalizedField, dow, 0, 6)
        if (validDow === null || validDow !== dow) {
          // 跳到明天
          candidate.setDate(candidate.getDate() + 1)
          candidate.setHours(0, 0, 0, 0)
          continue
        }
      }

      // 检查小时（0-23）
      const hour = nextValueInField(hourField, candidate.getHours(), 0, 23)
      if (hour === null) {
        // 跳到明天
        candidate.setDate(candidate.getDate() + 1)
        candidate.setHours(0, 0, 0, 0)
        continue
      }
      if (hour !== candidate.getHours()) {
        candidate.setHours(hour, 0, 0, 0)
        continue
      }

      // 检查分钟（0-59）
      const min = nextValueInField(minField, candidate.getMinutes(), 0, 59)
      if (min === null) {
        // 跳到下一小时
        candidate.setHours(candidate.getHours() + 1, 0, 0, 0)
        continue
      }
      if (min !== candidate.getMinutes()) {
        candidate.setMinutes(min, 0, 0)
        continue
      }

      // 所有字段都匹配，找到了
      return candidate.getTime()
    }

    return undefined
  } catch {
    return undefined
  }
}

// ── 判断 cron 表达式是否为周期性（含通配符）────────────────────────────────

// 判断 cron 表达式是否为周期性任务。
// 规则：5个字段中，只要有任意一个字段含 * / - , 就认为是周期性任务。
// 例如：
//   "0 * * * *"    → true（每小时）
//   "*/30 * * * *" → true（每30分钟）
//   "0 9 * * 1-5"  → true（工作日每天）
//   "0 15 15 4 *"  → true（4月15日，每年重复）
// 只有所有字段都是纯数字时才视为一次性任务（实际上极少见）。
function isRecurringExpression(expression: string): boolean {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) return false
  // 只要有任意字段含 * 或 / 就是周期性
  return parts.some(p => p.includes('*') || p.includes('/') || p.includes('-') || p.includes(','))
}

// ── 运行时调度器（进程内，重启后需重新注册）──────────────────────────────────

const activeTimers = new Map<string, ReturnType<typeof setTimeout>>()

// 触发回调：由外部（main.ts）注入，实际执行任务
let onTrigger: ((job: CronJob) => void) | null = null

export function setCronTriggerCallback(cb: (job: CronJob) => void) {
  onTrigger = cb
}

/** 导出 parseNextRun 供外部（server.ts）复用 */
export { parseNextRun as parseCronNextRun }

/** 供外部（server.ts POST /crons）调用，注册新创建的任务到调度器 */
export function scheduleNewJob(job: CronJob) {
  scheduleJob(job)
}

/**
 * 供外部（server.ts PUT /crons/:id/toggle）调用，同步更新内存调度器。
 * 禁用时清除 timer，启用时重新调度。
 */
export function toggleJobInScheduler(id: string, enabled: boolean): void {
  if (!enabled) {
    const timer = activeTimers.get(id)
    if (timer) { clearTimeout(timer); activeTimers.delete(id) }
  } else {
    // 从文件读取最新状态后重新调度
    const crons = loadCrons()
    const job = crons.find(c => c.id === id)
    if (job && job.enabled) scheduleJob(job)
  }
}

/**
 * 供外部（server.ts DELETE /crons/:id）调用，清除内存中的 timer。
 */
export function deleteJobFromScheduler(id: string): void {
  const timer = activeTimers.get(id)
  if (timer) { clearTimeout(timer); activeTimers.delete(id) }
}

function scheduleJob(job: CronJob) {
  if (!job.enabled) return

  const now = Date.now()

  // 检查 endDate：已过有效期则跳过调度（契约落地）
  if (job.endDate) {
    // 使用当天结束时间（23:59:59.999），确保 endDate 当天全天都有效
    // 避免 new Date('2026-05-01') 解析为 00:00:00 导致当天就失效的问题
    const endDay = new Date(job.endDate)
    endDay.setHours(23, 59, 59, 999)
    const end = endDay.getTime()
    if (!isNaN(end) && now > end) {
      console.info(`[cron] 任务已过有效期，跳过调度: ${job.id} (endDate: ${job.endDate})`)
      return
    }
  }

  // 检查 startDate：未到生效日期则从 startDate 当天开始时间起算第一次执行时间
  let fromTime: number | undefined
  if (job.startDate) {
    // 使用当天开始时间（00:00:00.000），确保 startDate 当天就能触发
    const startDay = new Date(job.startDate)
    startDay.setHours(0, 0, 0, 0)
    const start = startDay.getTime()
    if (!isNaN(start) && now < start) {
      fromTime = start  // parseNextRun 将从此时间点开始搜索
    }
  }

  // 计算下次执行时间：优先使用已保存的 nextRunAt，若已过期则重新计算
  let nextRun = job.nextRunAt
  let delay = nextRun ? nextRun - now : -1

  if (delay <= 0) {
    // 已过期或未设置，重新计算（传入 fromTime 影响起算点）
    nextRun = parseNextRun(job.expression, fromTime)
    if (!nextRun) {
      console.warn(`[cron] 无法解析 cron 表达式，跳过任务: ${job.id} (${job.expression})`)
      return
    }
    delay = nextRun - now
    // 更新到磁盘，避免下次重启再次过期
    const crons = loadCrons()
    const idx = crons.findIndex(c => c.id === job.id)
    if (idx >= 0) {
      crons[idx]!.nextRunAt = nextRun
      saveCrons(crons)
    }
  }

  if (delay <= 0) {
    console.warn(`[cron] 计算出的下次执行时间仍然过期，跳过任务: ${job.id}`)
    return
  }

  // setTimeout 最大延迟约 24.8 天（2^31 - 1 ms），超限时分段调度
  const MAX_TIMER_DELAY = 2_147_483_647

  const trigger = () => {
    activeTimers.delete(job.id)

    // 纳入 cronLock 保护，与 create/delete/toggle 串行执行
    let resolveTrigger!: () => void
    const prevLockTrig = cronLock
    cronLock = new Promise<void>(resolve => { resolveTrigger = resolve })
    prevLockTrig.then(() => {
      try {
        const crons = loadCrons()
        const idx = crons.findIndex(c => c.id === job.id)
        if (idx >= 0) {
          if (crons[idx]!.once) {
            // 一次性任务：触发后直接删除，不再重新调度
            crons.splice(idx, 1)
            saveCrons(crons)
          } else {
            // 周期性任务：更新执行记录并重新调度
            crons[idx]!.lastRunAt = Date.now()
            crons[idx]!.nextRunAt = parseNextRun(job.expression)
            saveCrons(crons)
            scheduleJob(crons[idx]!)
          }
        }
      } finally {
        resolveTrigger()
      }
    })

    // 触发任务（不阻塞锁链，onTrigger 在锁外执行）
    if (onTrigger) onTrigger(job)
  }

  let timer: ReturnType<typeof setTimeout>
  if (delay > MAX_TIMER_DELAY) {
    // 递归分段：每段最多 MAX_TIMER_DELAY，剩余时间重新调度
    timer = setTimeout(() => {
      activeTimers.delete(job.id)
      scheduleJob(job)
    }, MAX_TIMER_DELAY)
  } else {
    timer = setTimeout(trigger, delay)
  }

  activeTimers.set(job.id, timer)
}

/** 启动时恢复所有已保存的 cron 任务 */
export function restoreScheduledJobs() {
  const crons = loadCrons()
  for (const job of crons) {
    if (job.enabled) scheduleJob(job)
  }
}

// ── 工具定义 ─────────────────────────────────────────────────────────────────

const createSchema = z.object({
  action: z.literal('create'),
  expression: z.string().describe('cron 表达式（5位：分 时 日 月 周），例如 "0 9 * * 1-5" 表示工作日早9点'),
  description: z.string().describe('任务的人类可读描述，例如"每天早9点汇报昨日进展"'),
  task: z.string().describe('触发时注入给工作者的任务 prompt，应自包含、无需额外上下文'),
  once: z.preprocess(v => v === 'true' || v === true ? true : v === 'false' || v === false ? false : v, z.boolean().optional()).describe(
    '是否为一次性任务，触发后自动删除。\n' +
    '判断规则（必须严格遵守）：\n' +
    '- once=false（默认）：周期性任务，cron 表达式中含有 * 或 */n 通配符，如"每小时"、"每天"、"每周"、"每30分钟"等\n' +
    '- once=true：仅当任务明确只执行一次时才设为 true，如"今天查一次天气"、"这次提醒我"、"明天早上叫我起床"（特定日期/时间，不重复）\n' +
    '⚠️ 含有"每"字或周期性描述的任务绝对不能设为 once=true'
  ),
})

const deleteSchema = z.object({
  action: z.literal('delete'),
  id: z.string().optional().describe('要删除的 cron 任务 ID（精确匹配，优先使用）'),
  description: z.string().optional().describe('任务描述关键词（模糊匹配，id 未知时使用）'),
})

const listSchema = z.object({
  action: z.literal('list'),
})

const toggleSchema = z.object({
  action: z.literal('toggle'),
  id: z.string().describe('要启用/禁用的 cron 任务 ID'),
  enabled: z.preprocess(v => v === 'true' || v === true ? true : v === 'false' || v === false ? false : v, z.boolean()).describe('true 启用，false 禁用'),
})

const inputSchema = z.discriminatedUnion('action', [
  createSchema,
  deleteSchema,
  listSchema,
  toggleSchema,
])

export const ScheduleCronTool: ToolDef<typeof inputSchema> = {
  name: 'schedule_cron',
  description: `管理定时任务，让工作者能够在指定时间自动触发执行。
- create: 创建新的定时任务
- list: 查看所有定时任务及其状态
- delete: 删除定时任务
- toggle: 启用或禁用定时任务

⚠️ once 字段判断规则（极其重要，必须严格遵守）：
- once=false（默认，周期性任务）：用户说"每小时"、"每天"、"每30分钟"、"每周"等含有周期性含义的任务
  → cron 表达式通常含有 * 或 */n，如 "0 * * * *"（每小时）、"*/30 * * * *"（每30分钟）
- once=true（一次性任务）：用户明确说只执行一次，如"今天下午3点提醒我"、"明天早上叫我起床"
  → cron 表达式通常是固定的具体时间，如 "0 15 15 4 *"（4月15日下午3点）

❌ 错误示例：用户说"每小时提醒我"→ once 绝对不能设为 true
✅ 正确示例：用户说"每小时提醒我"→ once=false，expression="0 * * * *"

cron 表达式格式（5位）：分 时 日 月 周
常用示例：
  "0 * * * *"     每小时整点（周期性，once=false）
  "*/30 * * * *"  每30分钟（周期性，once=false）
  "0 9 * * 1-5"   工作日早9点（周期性，once=false）
  "0 18 * * *"    每天下午6点（周期性，once=false）
  "0 9 * * 1"     每周一早9点（周期性，once=false）
  "0 15 15 4 *"   4月15日下午3点（一次性，once=true）`,
  inputSchema,
  readonly: false,
  capabilities: { parallelSafe: false },

  describe(input) {
    if (input.action === 'create') return `创建定时任务: ${input.description}`
    if (input.action === 'delete') return `删除定时任务: ${input.id}`
    if (input.action === 'toggle') return `${input.enabled ? '启用' : '禁用'}定时任务: ${input.id}`
    return '查看定时任务列表'
  },

  async execute(input) {
    const crons = loadCrons()

    if (input.action === 'list') {
      if (crons.length === 0) return { type: 'success', output: '暂无定时任务。' }
      const lines = crons.map(c => {
        const status = c.enabled ? '✅ 启用' : '⏸ 禁用'
        const onceTag = c.once ? ' 🔂一次性' : ''
        const next = c.nextRunAt ? `下次: ${new Date(c.nextRunAt).toLocaleString('zh-CN')}` : '未调度'
        const last = c.lastRunAt ? `上次: ${new Date(c.lastRunAt).toLocaleString('zh-CN')}` : '从未执行'
        return `[${c.id}] ${status}${onceTag} | ${c.expression} | ${c.description}\n  ${next} | ${last}\n  任务: ${c.task.slice(0, 80)}${c.task.length > 80 ? '...' : ''}`
      })
      return { type: 'success', output: `共 ${crons.length} 个定时任务:\n\n${lines.join('\n\n')}` }
    }

    if (input.action === 'create') {
      // ── 串行化保护：防止并行工具调用导致重复创建（竞态条件）──
      let resolveCreate!: () => void
      const prevLock = cronLock
      cronLock = new Promise<void>(resolve => { resolveCreate = resolve })
      await prevLock

      try {
      // ── 去重检查：相同 expression + description 的任务已存在时，直接返回已有任务 ──
      const sessionId = getCurrentSessionId()
      const crons = loadCrons()
      const duplicate = crons.find(c =>
        c.expression === input.expression &&
        c.description === input.description &&
        // 同一会话内去重（sessionId 相同或均为空）
        (c.sessionId ?? '') === (sessionId ?? '')
      )
      if (duplicate) {
        const nextStr = duplicate.nextRunAt
          ? `下次执行: ${new Date(duplicate.nextRunAt).toLocaleString('zh-CN')}`
          : '未调度'
        return {
          type: 'success',
          output: `⚠️ 相同的定时任务已存在，未重复创建，操作已完成。\nID: ${duplicate.id}\n表达式: ${duplicate.expression}\n描述: ${duplicate.description}\n${nextStr}`,
        }
      }

      const id = `cron-${Date.now().toString(36)}`
      const nextRunAt = parseNextRun(input.expression)

      // 自动推断 once：如果 cron 表达式含有 * 或 */n 通配符（周期性），强制 once=false
      const isRecurring = isRecurringExpression(input.expression)
      const once = isRecurring ? false : (input.once ?? false)

      const job: CronJob = {
        id,
        expression: input.expression,
        description: input.description,
        task: input.task,
        createdAt: Date.now(),
        nextRunAt,
        enabled: true,
        once,
        ...(sessionId ? { sessionId } : {}),
      }
      crons.push(job)
      saveCrons(crons)
      scheduleJob(job)

      const nextStr = nextRunAt
        ? `下次执行: ${new Date(nextRunAt).toLocaleString('zh-CN')}`
        : '（无法解析下次执行时间，请检查 cron 表达式）'
      const onceStr = job.once ? '\n⚠️ 一次性任务：触发后将自动删除' : '\n🔁 周期性任务：将持续重复执行'
      const correctedStr = (isRecurring && input.once === true) ? '\n📌 注意：检测到周期性 cron 表达式，已自动将 once 修正为 false' : ''
      return {
        type: 'success',
        output: `✅ 定时任务已创建，无需再次查询验证，操作已完成。\nID: ${id}\n表达式: ${input.expression}\n描述: ${input.description}\n${nextStr}${onceStr}${correctedStr}`,
      }
      } finally {
        resolveCreate()
      }
    }

    if (input.action === 'delete') {
      if (!input.id && !input.description) {
        return { type: 'error', message: '必须提供 id 或 description 之一' }
      }

      let resolveDelete!: () => void
      const prevLockD = cronLock
      cronLock = new Promise<void>(resolve => { resolveDelete = resolve })
      await prevLockD

      try {
      const crons = loadCrons()

      // 优先按 id 精确匹配，否则按 description 模糊匹配
      let idx = -1
      if (input.id) {
        idx = crons.findIndex(c => c.id === input.id)
      } else if (input.description) {
        const keyword = input.description.toLowerCase()
        idx = crons.findIndex(c => c.description.toLowerCase().includes(keyword))
      }

      if (idx === -1) {
        const hint = input.id
          ? `未找到 ID 为 "${input.id}" 的定时任务`
          : `未找到描述包含 "${input.description}" 的定时任务`
        return { type: 'error', message: `${hint}，无需删除，操作已完成。` }
      }

      const job = crons[idx]
      const timer = activeTimers.get(job.id)
      if (timer) { clearTimeout(timer); activeTimers.delete(job.id) }
      crons.splice(idx, 1)
      saveCrons(crons)
      return { type: 'success', output: `✅ 定时任务已删除，无需再次查询验证，操作已完成。\nID: ${job.id}\n描述: ${job.description}` }
      } finally {
        resolveDelete()
      }
    }

    if (input.action === 'toggle') {
      let resolveToggle!: () => void
      const prevLockT = cronLock
      cronLock = new Promise<void>(resolve => { resolveToggle = resolve })
      await prevLockT

      try {
      const crons = loadCrons()
      const job = crons.find(c => c.id === input.id)
      if (!job) return { type: 'error', message: `未找到任务 ID: ${input.id}` }
      job.enabled = input.enabled
      if (!input.enabled) {
        const timer = activeTimers.get(input.id)
        if (timer) { clearTimeout(timer); activeTimers.delete(input.id) }
      } else {
        scheduleJob(job)
      }
      saveCrons(crons)
      return { type: 'success', output: `✅ 任务 ${input.id} 已${input.enabled ? '启用' : '禁用'}` }
      } finally {
        resolveToggle()
      }
    }

    return { type: 'error', message: '未知操作' }
  },
}
