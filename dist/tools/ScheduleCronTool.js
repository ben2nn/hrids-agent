// 定时调度工具 —— 让工作者能够设置定时任务，主动触发执行
// 基于 node-cron 实现，持久化到 ~/.hrids-agent/crons.json
import { z } from 'zod';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
const CRON_FILE = join(homedir(), '.hrids-agent', 'crons.json');
// ── 持久化 ──────────────────────────────────────────────────────────────────
function loadCrons() {
    if (!existsSync(CRON_FILE))
        return [];
    try {
        return JSON.parse(readFileSync(CRON_FILE, 'utf-8'));
    }
    catch {
        return [];
    }
}
function saveCrons(crons) {
    const dir = join(homedir(), '.hrids-agent');
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    writeFileSync(CRON_FILE, JSON.stringify(crons, null, 2), 'utf-8');
}
// ── 简单 cron 表达式解析（计算下次执行时间）────────────────────────────────
function parseNextRun(expression) {
    // 支持常用格式：分 时 日 月 周
    // 这里用简单估算，生产环境建议引入 cron-parser
    try {
        const parts = expression.trim().split(/\s+/);
        if (parts.length !== 5)
            return undefined;
        const now = new Date();
        const next = new Date(now);
        next.setSeconds(0, 0);
        next.setMinutes(next.getMinutes() + 1); // 至少1分钟后
        // 简单处理：只解析固定值（非 * 的情况）
        const [min, hour, , , weekday] = parts;
        if (hour !== '*' && !isNaN(Number(hour))) {
            const h = Number(hour);
            if (next.getHours() > h || (next.getHours() === h && next.getMinutes() > Number(min))) {
                next.setDate(next.getDate() + 1);
            }
            next.setHours(h);
        }
        if (min !== '*' && !isNaN(Number(min))) {
            next.setMinutes(Number(min));
        }
        if (weekday !== '*' && !isNaN(Number(weekday))) {
            const targetDay = Number(weekday) % 7;
            const currentDay = next.getDay();
            const daysUntil = (targetDay - currentDay + 7) % 7 || 7;
            next.setDate(next.getDate() + daysUntil);
        }
        return next.getTime();
    }
    catch {
        return undefined;
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
function isRecurringExpression(expression) {
    const parts = expression.trim().split(/\s+/);
    if (parts.length !== 5)
        return false;
    // 只要有任意字段含 * 或 / 就是周期性
    return parts.some(p => p.includes('*') || p.includes('/') || p.includes('-') || p.includes(','));
}
// ── 运行时调度器（进程内，重启后需重新注册）──────────────────────────────────
const activeTimers = new Map();
// 触发回调：由外部（main.ts）注入，实际执行任务
let onTrigger = null;
export function setCronTriggerCallback(cb) {
    onTrigger = cb;
}
function scheduleJob(job) {
    if (!job.enabled)
        return;
    const nextRun = job.nextRunAt ?? parseNextRun(job.expression);
    if (!nextRun)
        return;
    const delay = nextRun - Date.now();
    if (delay <= 0)
        return;
    const timer = setTimeout(() => {
        activeTimers.delete(job.id);
        const crons = loadCrons();
        const idx = crons.findIndex(c => c.id === job.id);
        if (idx >= 0) {
            if (crons[idx].once) {
                // 一次性任务：触发后直接删除，不再重新调度
                crons.splice(idx, 1);
                saveCrons(crons);
            }
            else {
                // 周期性任务：更新执行记录并重新调度
                crons[idx].lastRunAt = Date.now();
                crons[idx].nextRunAt = parseNextRun(job.expression);
                saveCrons(crons);
                scheduleJob(crons[idx]);
            }
        }
        // 触发任务
        if (onTrigger)
            onTrigger(job);
    }, delay);
    activeTimers.set(job.id, timer);
}
/** 启动时恢复所有已保存的 cron 任务 */
export function restoreScheduledJobs() {
    const crons = loadCrons();
    for (const job of crons) {
        if (job.enabled)
            scheduleJob(job);
    }
}
// ── 工具定义 ─────────────────────────────────────────────────────────────────
const createSchema = z.object({
    action: z.literal('create'),
    expression: z.string().describe('cron 表达式（5位：分 时 日 月 周），例如 "0 9 * * 1-5" 表示工作日早9点'),
    description: z.string().describe('任务的人类可读描述，例如"每天早9点汇报昨日进展"'),
    task: z.string().describe('触发时注入给工作者的任务 prompt，应自包含、无需额外上下文'),
    once: z.boolean().optional().describe('是否为一次性任务，触发后自动删除。\n' +
        '判断规则（必须严格遵守）：\n' +
        '- once=false（默认）：周期性任务，cron 表达式中含有 * 或 */n 通配符，如"每小时"、"每天"、"每周"、"每30分钟"等\n' +
        '- once=true：仅当任务明确只执行一次时才设为 true，如"今天查一次天气"、"这次提醒我"、"明天早上叫我起床"（特定日期/时间，不重复）\n' +
        '⚠️ 含有"每"字或周期性描述的任务绝对不能设为 once=true'),
});
const deleteSchema = z.object({
    action: z.literal('delete'),
    id: z.string().describe('要删除的 cron 任务 ID'),
});
const listSchema = z.object({
    action: z.literal('list'),
});
const toggleSchema = z.object({
    action: z.literal('toggle'),
    id: z.string().describe('要启用/禁用的 cron 任务 ID'),
    enabled: z.boolean().describe('true 启用，false 禁用'),
});
const inputSchema = z.discriminatedUnion('action', [
    createSchema,
    deleteSchema,
    listSchema,
    toggleSchema,
]);
export const ScheduleCronTool = {
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
    describe(input) {
        if (input.action === 'create')
            return `创建定时任务: ${input.description}`;
        if (input.action === 'delete')
            return `删除定时任务: ${input.id}`;
        if (input.action === 'toggle')
            return `${input.enabled ? '启用' : '禁用'}定时任务: ${input.id}`;
        return '查看定时任务列表';
    },
    async execute(input) {
        const crons = loadCrons();
        if (input.action === 'list') {
            if (crons.length === 0)
                return { type: 'success', output: '暂无定时任务。' };
            const lines = crons.map(c => {
                const status = c.enabled ? '✅ 启用' : '⏸ 禁用';
                const onceTag = c.once ? ' 🔂一次性' : '';
                const next = c.nextRunAt ? `下次: ${new Date(c.nextRunAt).toLocaleString('zh-CN')}` : '未调度';
                const last = c.lastRunAt ? `上次: ${new Date(c.lastRunAt).toLocaleString('zh-CN')}` : '从未执行';
                return `[${c.id}] ${status}${onceTag} | ${c.expression} | ${c.description}\n  ${next} | ${last}\n  任务: ${c.task.slice(0, 80)}${c.task.length > 80 ? '...' : ''}`;
            });
            return { type: 'success', output: `共 ${crons.length} 个定时任务:\n\n${lines.join('\n\n')}` };
        }
        if (input.action === 'create') {
            const id = `cron-${Date.now().toString(36)}`;
            const nextRunAt = parseNextRun(input.expression);
            // 自动推断 once：如果 cron 表达式含有 * 或 */n 通配符（周期性），强制 once=false
            const isRecurring = isRecurringExpression(input.expression);
            const once = isRecurring ? false : (input.once ?? false);
            const job = {
                id,
                expression: input.expression,
                description: input.description,
                task: input.task,
                createdAt: Date.now(),
                nextRunAt,
                enabled: true,
                once,
            };
            crons.push(job);
            saveCrons(crons);
            scheduleJob(job);
            const nextStr = nextRunAt
                ? `下次执行: ${new Date(nextRunAt).toLocaleString('zh-CN')}`
                : '（无法解析下次执行时间，请检查 cron 表达式）';
            const onceStr = job.once ? '\n⚠️ 一次性任务：触发后将自动删除' : '\n🔁 周期性任务：将持续重复执行';
            const correctedStr = (isRecurring && input.once === true) ? '\n📌 注意：检测到周期性 cron 表达式，已自动将 once 修正为 false' : '';
            return {
                type: 'success',
                output: `✅ 定时任务已创建\nID: ${id}\n表达式: ${input.expression}\n描述: ${input.description}\n${nextStr}${onceStr}${correctedStr}`,
            };
        }
        if (input.action === 'delete') {
            const idx = crons.findIndex(c => c.id === input.id);
            if (idx === -1)
                return { type: 'error', message: `未找到任务 ID: ${input.id}` };
            const timer = activeTimers.get(input.id);
            if (timer) {
                clearTimeout(timer);
                activeTimers.delete(input.id);
            }
            crons.splice(idx, 1);
            saveCrons(crons);
            return { type: 'success', output: `✅ 定时任务 ${input.id} 已删除` };
        }
        if (input.action === 'toggle') {
            const job = crons.find(c => c.id === input.id);
            if (!job)
                return { type: 'error', message: `未找到任务 ID: ${input.id}` };
            job.enabled = input.enabled;
            if (!input.enabled) {
                const timer = activeTimers.get(input.id);
                if (timer) {
                    clearTimeout(timer);
                    activeTimers.delete(input.id);
                }
            }
            else {
                scheduleJob(job);
            }
            saveCrons(crons);
            return { type: 'success', output: `✅ 任务 ${input.id} 已${input.enabled ? '启用' : '禁用'}` };
        }
        return { type: 'error', message: '未知操作' };
    },
};
