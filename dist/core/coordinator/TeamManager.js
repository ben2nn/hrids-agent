// 团队管理器 —— 创建和管理智能体团队
import { AgentPool } from './AgentPool.js';
import { MessageBus } from './MessageBus.js';
// 全局单例，跨工具调用共享状态
let globalTeamManager = null;
export class TeamManager {
    teams = new Map();
    provider;
    baseTools;
    bus;
    constructor(provider, baseTools) {
        this.provider = provider;
        this.baseTools = baseTools;
        this.bus = MessageBus.getInstance();
    }
    static init(provider, baseTools) {
        globalTeamManager = new TeamManager(provider, baseTools);
        return globalTeamManager;
    }
    static get() {
        return globalTeamManager;
    }
    createTeam(config) {
        if (this.teams.has(config.name)) {
            throw new Error(`团队 "${config.name}" 已存在`);
        }
        const pool = new AgentPool(this.provider, this.baseTools, config.maxConcurrent ?? 5);
        const team = {
            name: config.name,
            pool,
            createdAt: Date.now(),
            agentIds: [],
        };
        this.teams.set(config.name, team);
        return team;
    }
    deleteTeam(name) {
        const team = this.teams.get(name);
        if (!team)
            return false;
        // 中止所有运行中的任务
        for (const id of team.agentIds) {
            team.pool.abort(id);
        }
        this.teams.delete(name);
        return true;
    }
    getTeam(name) {
        return this.teams.get(name);
    }
    listTeams() {
        return Array.from(this.teams.keys());
    }
    // 向团队提交任务
    submitToTeam(teamName, agentName, description, prompt, systemPrompt, allowedTools) {
        const team = this.teams.get(teamName);
        if (!team)
            throw new Error(`团队 "${teamName}" 不存在`);
        const sp = systemPrompt ?? `你是团队 "${teamName}" 中的智能体 "${agentName}"。
专注完成分配的任务，可以通过 send_message 工具与团队其他成员通信。`;
        const id = team.pool.submit(agentName, description, prompt, sp, allowedTools);
        team.agentIds.push(id);
        return id;
    }
    // 等待团队所有任务完成，返回汇总结果
    async waitTeam(teamName, timeoutMs = 300000) {
        const team = this.teams.get(teamName);
        if (!team)
            throw new Error(`团队 "${teamName}" 不存在`);
        return team.pool.waitAll(team.agentIds, timeoutMs);
    }
    // 暴露给 AgentTool 使用，继承父智能体的 provider 和 tools
    getProvider() {
        return this.provider;
    }
    getBaseTools() {
        return this.baseTools;
    }
    getTeamStatus(teamName) {
        const team = this.teams.get(teamName);
        if (!team)
            return { total: 0, running: 0, completed: 0, failed: 0 };
        const tasks = team.pool.listTasks();
        return {
            total: tasks.length,
            running: tasks.filter(t => t.status === 'running').length,
            completed: tasks.filter(t => t.status === 'completed').length,
            failed: tasks.filter(t => t.status === 'failed').length,
        };
    }
}
