// 团队管理器 —— 创建和管理智能体团队
import { AgentPool, type AgentTask } from './AgentPool.js'
import { MessageBus } from './MessageBus.js'
import type { LLMProvider } from '../providers/index.js'
import type { ToolDef } from '../Tool.js'

export interface TeamConfig {
  name: string
  systemPrompt?: string
  maxConcurrent?: number
}

export interface Team {
  name: string
  pool: AgentPool
  createdAt: number
  agentIds: string[]
}

// 进程级全局单例（CLI 单会话模式使用）
// Gateway 多会话模式下，每个 ManagedSession 持有自己的 TeamManager 实例，
// 通过 AsyncLocalStorage 上下文绑定，避免跨会话污染。
let globalTeamManager: TeamManager | null = null

// 会话级 TeamManager 存储（sessionId → TeamManager）
const sessionManagers = new Map<string, TeamManager>()

export class TeamManager {
  private teams = new Map<string, Team>()
  private provider: LLMProvider
  private baseTools: ToolDef[]
  private bus: MessageBus
  // 所属会话 ID（Gateway 模式下传入，用于 AgentPool 获取会话级记忆）
  private sessionId: string | undefined

  constructor(provider: LLMProvider, baseTools: ToolDef[], sessionId?: string) {
    this.provider = provider
    this.baseTools = baseTools
    this.bus = MessageBus.getInstance()
    this.sessionId = sessionId
  }

  /** CLI 模式：初始化进程级全局单例 */
  static init(provider: LLMProvider, baseTools: ToolDef[]): TeamManager {
    globalTeamManager = new TeamManager(provider, baseTools)
    return globalTeamManager
  }

  /** CLI 模式：获取进程级全局单例 */
  static get(): TeamManager | null {
    return globalTeamManager
  }

  /** Gateway 模式：为指定会话创建独立实例 */
  static initForSession(sessionId: string, provider: LLMProvider, baseTools: ToolDef[]): TeamManager {
    const mgr = new TeamManager(provider, baseTools, sessionId)
    sessionManagers.set(sessionId, mgr)
    return mgr
  }

  /** Gateway 模式：获取指定会话的实例，不存在时回退到全局单例 */
  static getForSession(sessionId: string): TeamManager | null {
    return sessionManagers.get(sessionId) ?? globalTeamManager
  }

  /** Gateway 模式：销毁会话实例，释放资源 */
  static destroySession(sessionId: string): void {
    const mgr = sessionManagers.get(sessionId)
    if (mgr) {
      // 中止所有团队的所有任务
      for (const team of mgr.teams.values()) {
        for (const id of team.agentIds) {
          team.pool.abort(id)
        }
      }
      sessionManagers.delete(sessionId)
    }
  }

  createTeam(config: TeamConfig): Team {
    if (this.teams.has(config.name)) {
      throw new Error(`团队 "${config.name}" 已存在`)
    }
    const pool = new AgentPool(this.provider, this.baseTools, config.maxConcurrent ?? 5, this.sessionId)
    const team: Team = {
      name: config.name,
      pool,
      createdAt: Date.now(),
      agentIds: [],
    }
    this.teams.set(config.name, team)
    return team
  }

  deleteTeam(name: string): boolean {
    const team = this.teams.get(name)
    if (!team) return false
    // 中止所有运行中的任务
    for (const id of team.agentIds) {
      team.pool.abort(id)
    }
    this.teams.delete(name)
    return true
  }

  getTeam(name: string): Team | undefined {
    return this.teams.get(name)
  }

  listTeams(): string[] {
    return Array.from(this.teams.keys())
  }

  // 向团队提交任务
  submitToTeam(
    teamName: string,
    agentName: string,
    description: string,
    prompt: string,
    systemPrompt?: string,
    allowedTools?: string[],
  ): string {
    const team = this.teams.get(teamName)
    if (!team) throw new Error(`团队 "${teamName}" 不存在`)

    const sp = systemPrompt ?? `你是团队 "${teamName}" 中的智能体 "${agentName}"。
专注完成分配的任务，可以通过 send_message 工具与团队其他成员通信。`

    const id = team.pool.submit(agentName, description, prompt, sp, allowedTools)
    team.agentIds.push(id)
    return id
  }

  // 等待团队所有任务完成，返回汇总结果
  async waitTeam(teamName: string, timeoutMs = 300000): Promise<AgentTask[]> {
    const team = this.teams.get(teamName)
    if (!team) throw new Error(`团队 "${teamName}" 不存在`)
    return team.pool.waitAll(team.agentIds, timeoutMs)
  }

  // 暴露给 AgentTool 使用，继承父智能体的 provider 和 tools
  getProvider(): LLMProvider {
    return this.provider
  }

  getBaseTools(): ToolDef[] {
    return this.baseTools
  }

  getTeamStatus(teamName: string): {
    total: number
    running: number
    completed: number
    failed: number
  } {
    const team = this.teams.get(teamName)
    if (!team) return { total: 0, running: 0, completed: 0, failed: 0 }

    const tasks = team.pool.listTasks()
    return {
      total: tasks.length,
      running: tasks.filter(t => t.status === 'running').length,
      completed: tasks.filter(t => t.status === 'completed').length,
      failed: tasks.filter(t => t.status === 'failed').length,
    }
  }
}
