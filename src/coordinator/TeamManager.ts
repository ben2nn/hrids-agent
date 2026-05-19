// 团队管理器 —— 创建和管理智能体团队
// 每个 TeamManager 持有独立的 MessageBus，避免多会话消息混串
import { AgentPool, type AgentTask } from './AgentPool.js'
import { MessageBus } from './MessageBus.js'
import type { LLMProvider } from '../providers/index.js'
import type { ToolDef } from '../core/Tool.js'
import type { AgentProfile } from '../core/Config.js'

export interface TeamConfig {
  name: string
  systemPrompt?: string[]
  maxConcurrent?: number
}

export interface Team {
  name: string
  pool: AgentPool
  createdAt: number
  agentIds: string[]
}

// 进程级全局单例（CLI 单会话模式使用）
let globalTeamManager: TeamManager | null = null

// 会话级 TeamManager 存储（sessionId → TeamManager）
const sessionManagers = new Map<string, TeamManager>()

export class TeamManager {
  private teams = new Map<string, Team>()
  private provider: LLMProvider
  private baseTools: ToolDef[]
  // 每个 TeamManager 持有独立的 MessageBus，多会话完全隔离
  readonly bus: MessageBus
  // 当前 TeamManager 绑定的会话 ID（Gateway 模式下有值，CLI 模式下为 undefined）
  // 用于子智能体继承正确的会话级记忆，而非全局记忆
  private sessionId: string | undefined

  constructor(provider: LLMProvider, baseTools: ToolDef[], sessionId?: string) {
    this.provider = provider
    this.baseTools = baseTools
    this.bus = new MessageBus()
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

  /** Gateway 模式：为指定会话创建独立实例，绑定 sessionId 用于记忆隔离 */
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
    // 将当前 TeamManager 的 MessageBus 传给 AgentPool，保证同一会话内共享同一总线
    const pool = new AgentPool(this.provider, this.baseTools, config.maxConcurrent ?? 5, this.bus)
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

  submitToTeam(
    teamName: string,
    agentName: string,
    description: string,
    prompt: string,
    systemPrompt?: string[],
    allowedTools?: string[],
    profile?: AgentProfile,
  ): string {
    const team = this.teams.get(teamName)
    if (!team) throw new Error(`团队 "${teamName}" 不存在`)

    const sp: string[] = systemPrompt ?? [`你是团队 "${teamName}" 中的智能体 "${agentName}"。
专注完成分配的任务，可以通过 send_message 工具与团队其他成员通信。`]

    // 传入父会话 ID，子智能体将继承父会话的记忆而非全局记忆
    const id = team.pool.submit(agentName, description, prompt, sp, allowedTools, this.sessionId, profile)
    team.agentIds.push(id)
    return id
  }

  async waitTeam(teamName: string, timeoutMs = 300000): Promise<AgentTask[]> {
    const team = this.teams.get(teamName)
    if (!team) throw new Error(`团队 "${teamName}" 不存在`)
    return team.pool.waitAll(team.agentIds, timeoutMs)
  }

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
