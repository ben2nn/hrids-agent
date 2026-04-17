// 多智能体团队工具集
import { z } from 'zod';
import { TeamManager } from '../core/coordinator/TeamManager.js';
import { MessageBus } from '../core/coordinator/MessageBus.js';
// ── team_create ──────────────────────────────────────────────
const teamCreateSchema = z.object({
    name: z.string().describe('团队名称'),
    max_concurrent: z.number().optional().describe('最大并发智能体数，默认 5'),
});
export const TeamCreateTool = {
    name: 'team_create',
    description: '创建一个智能体团队，用于并行执行多个子任务',
    inputSchema: teamCreateSchema,
    readonly: false,
    describe: (i) => `创建团队: ${i.name}`,
    async execute(input) {
        const mgr = TeamManager.get();
        if (!mgr)
            return { type: 'error', message: '团队管理器未初始化' };
        try {
            mgr.createTeam({ name: input.name, maxConcurrent: input.max_concurrent });
            return { type: 'success', output: `团队 "${input.name}" 已创建` };
        }
        catch (err) {
            return { type: 'error', message: String(err) };
        }
    },
};
// ── team_delete ──────────────────────────────────────────────
const teamDeleteSchema = z.object({
    name: z.string().describe('要删除的团队名称'),
});
export const TeamDeleteTool = {
    name: 'team_delete',
    description: '删除团队并中止其所有任务',
    inputSchema: teamDeleteSchema,
    readonly: false,
    describe: (i) => `删除团队: ${i.name}`,
    async execute(input) {
        const mgr = TeamManager.get();
        if (!mgr)
            return { type: 'error', message: '团队管理器未初始化' };
        const ok = mgr.deleteTeam(input.name);
        return ok
            ? { type: 'success', output: `团队 "${input.name}" 已删除` }
            : { type: 'error', message: `团队 "${input.name}" 不存在` };
    },
};
// ── agent_spawn ──────────────────────────────────────────────
const agentSpawnSchema = z.object({
    team: z.string().describe('所属团队名称'),
    name: z.string().describe('智能体名称（用于消息寻址）'),
    description: z.string().describe('3-5 词描述任务'),
    prompt: z.string().describe('完整的任务指令'),
    run_in_background: z.boolean().optional().describe('是否后台运行，默认 false（等待完成）'),
    allowed_tools: z.array(z.string()).optional().describe('允许的工具列表'),
});
export const AgentSpawnTool = {
    name: 'agent_spawn',
    description: '向团队派生一个子智能体。可后台运行（并行）或等待完成（串行）',
    inputSchema: agentSpawnSchema,
    readonly: false,
    describe: (i) => `派生智能体: ${i.name} → ${i.description}`,
    async execute(input) {
        const mgr = TeamManager.get();
        if (!mgr)
            return { type: 'error', message: '团队管理器未初始化，请先调用 team_create' };
        try {
            const taskId = mgr.submitToTeam(input.team, input.name, input.description, input.prompt, undefined, input.allowed_tools);
            if (input.run_in_background) {
                return { type: 'success', output: `智能体 "${input.name}" 已在后台启动，任务 ID: ${taskId}` };
            }
            // 等待完成
            const team = mgr.getTeam(input.team);
            const task = await team.pool.wait(taskId);
            if (task.status === 'failed') {
                return { type: 'error', message: `智能体 "${input.name}" 失败: ${task.error}` };
            }
            const elapsed = ((task.completedAt - task.startedAt) / 1000).toFixed(1);
            return {
                type: 'success',
                output: `[智能体 ${input.name} 完成，耗时 ${elapsed}s]\n${task.result ?? ''}`,
            };
        }
        catch (err) {
            return { type: 'error', message: String(err) };
        }
    },
};
// ── team_status ──────────────────────────────────────────────
const teamStatusSchema = z.object({
    team: z.string().describe('团队名称'),
});
export const TeamStatusTool = {
    name: 'team_status',
    description: '查看团队中所有智能体的运行状态',
    inputSchema: teamStatusSchema,
    readonly: true,
    describe: (i) => `查看团队状态: ${i.team}`,
    async execute(input) {
        const mgr = TeamManager.get();
        if (!mgr)
            return { type: 'error', message: '团队管理器未初始化' };
        const team = mgr.getTeam(input.team);
        if (!team)
            return { type: 'error', message: `团队 "${input.team}" 不存在` };
        const tasks = team.pool.listTasks();
        if (tasks.length === 0)
            return { type: 'success', output: '团队中没有任务' };
        const statusIcon = {
            pending: '⏳', running: '▸', completed: '✓', failed: '✗',
        };
        const lines = tasks.map(t => {
            const elapsed = t.startedAt
                ? `${(((t.completedAt ?? Date.now()) - t.startedAt) / 1000).toFixed(1)}s`
                : '-';
            return `${statusIcon[t.status]} [${t.name}] ${t.description} (${t.status}, ${elapsed})`;
        });
        const stat = mgr.getTeamStatus(input.team);
        lines.push(`\n合计: ${stat.total} 个 | 运行中: ${stat.running} | 完成: ${stat.completed} | 失败: ${stat.failed}`);
        return { type: 'success', output: lines.join('\n') };
    },
};
// ── team_wait ────────────────────────────────────────────────
const teamWaitSchema = z.object({
    team: z.string().describe('要等待的团队名称'),
    timeout_seconds: z.number().optional().describe('超时秒数，默认 300'),
});
export const TeamWaitTool = {
    name: 'team_wait',
    description: '等待团队所有智能体完成，返回汇总结果',
    inputSchema: teamWaitSchema,
    readonly: true,
    describe: (i) => `等待团队完成: ${i.team}`,
    async execute(input) {
        const mgr = TeamManager.get();
        if (!mgr)
            return { type: 'error', message: '团队管理器未初始化' };
        try {
            const tasks = await mgr.waitTeam(input.team, (input.timeout_seconds ?? 300) * 1000);
            const results = tasks.map(t => {
                const status = t.status === 'completed' ? '✓' : '✗';
                const content = t.status === 'completed' ? (t.result ?? '') : `失败: ${t.error}`;
                return `${status} [${t.name}]\n${content}`;
            });
            return { type: 'success', output: results.join('\n\n---\n\n') };
        }
        catch (err) {
            return { type: 'error', message: String(err) };
        }
    },
};
// ── send_message ─────────────────────────────────────────────
const sendMessageSchema = z.object({
    to: z.string().describe('接收方智能体名称，"*" 表示广播给所有智能体'),
    content: z.string().describe('消息内容'),
});
export const SendMessageTool = {
    name: 'send_message',
    description: '向其他智能体发送消息（需要知道自己的名称）',
    inputSchema: sendMessageSchema,
    readonly: false,
    describe: (i) => `发消息给 ${i.to}`,
    async execute(input) {
        const bus = MessageBus.getInstance();
        // 发送方名称从环境变量获取（由 AgentPool 在启动时注入）
        const from = process.env.AGENT_NAME ?? 'unknown';
        bus.send(from, input.to, input.content);
        return {
            type: 'success',
            output: `消息已发送给 "${input.to}"`,
        };
    },
};
// ── receive_message ──────────────────────────────────────────
const receiveMessageSchema = z.object({
    wait_seconds: z.number().optional().describe('等待消息的秒数，默认 10，0 表示只读取已有消息'),
});
export const ReceiveMessageTool = {
    name: 'receive_message',
    description: '接收其他智能体发来的消息',
    inputSchema: receiveMessageSchema,
    readonly: true,
    describe: () => '接收消息',
    async execute(input) {
        const bus = MessageBus.getInstance();
        const agentName = process.env.AGENT_NAME ?? 'unknown';
        const waitMs = (input.wait_seconds ?? 10) * 1000;
        if (waitMs === 0) {
            const msgs = bus.drain(agentName);
            if (msgs.length === 0)
                return { type: 'success', output: '没有新消息' };
            return {
                type: 'success',
                output: msgs.map(m => `[来自 ${m.from}]: ${m.content}`).join('\n'),
            };
        }
        const msg = await bus.waitForMessage(agentName, waitMs);
        if (!msg)
            return { type: 'success', output: '等待超时，没有收到消息' };
        return { type: 'success', output: `[来自 ${msg.from}]: ${msg.content}` };
    },
};
// 导出所有团队工具
export const TEAM_TOOLS = [
    TeamCreateTool,
    TeamDeleteTool,
    AgentSpawnTool,
    TeamStatusTool,
    TeamWaitTool,
    SendMessageTool,
    ReceiveMessageTool,
];
