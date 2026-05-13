// 斜杠命令注册系统
import type { SkillRegistry } from '../skills/registry.js'

export interface SlashCommand {
  name: string
  description: string
  argumentHint?: string
  execute(args: string, ctx: CommandContext): Promise<CommandResult>
}

export interface CommandContext {
  clearHistory(): void
  compactHistory(summary: string): Promise<void>
  generateCompactSummary(): Promise<string>  // 调用 LLM 生成摘要
  getHistoryLength(): number
  getEstimatedTokens(): number               // 估算当前 token 数
  getCostSummary(): string
  getBudgetInfo(): { spent: number; limit?: number } // 成本预算信息
  setModel(model: string): void
  getModel(): string
  setMode(mode: string): void
  getMode(): string
  sessionId: string
  // 会话管理
  listSessions(): import('../core/SessionStore.js').SessionMeta[]
  listArchives(): import('../core/SessionStore.js').CompactArchive[]  // 当前会话的归档段列表
  newSession(): void        // 强制创建新会话
  switchSession(id: string): boolean  // 切换到指定会话，返回是否成功
}

export type CommandResult =
  | { type: 'message'; text: string }
  | { type: 'inject'; prompt: string; allowedTools?: string[] }  // allowedTools 限制 skill 执行时可用的工具集
  | { type: 'exit' }
  | { type: 'noop' }

export class CommandRegistry {
  private commands = new Map<string, SlashCommand>()

  register(cmd: SlashCommand) {
    this.commands.set(cmd.name, cmd)
  }

  find(name: string): SlashCommand | undefined {
    return this.commands.get(name)
  }

  // 解析输入，返回命令名和参数（支持引号包裹的参数）
  parse(input: string): { name: string; args: string } | null {
    if (!input.startsWith('/')) return null
    const trimmed = input.slice(1).trim()
    // 找到第一个空格分隔命令名和参数
    const spaceIdx = trimmed.indexOf(' ')
    if (spaceIdx === -1) return { name: trimmed.toLowerCase(), args: '' }
    return { name: trimmed.slice(0, spaceIdx).toLowerCase(), args: trimmed.slice(spaceIdx + 1).trim() }
  }

  getAll(): SlashCommand[] {
    return Array.from(this.commands.values())
  }

  /**
   * 从 SkillRegistry 批量注册 skills 为斜杠命令。
   * 每个 skill 对应 /<name> 命令，执行时返回 inject 类型，
   * 由 UI 层将 skill prompt 注入到 LLM 对话。
   * allowedTools 字段会随 inject 一起传递，供 UI 层限制工具集。
   */
  registerSkills(skillRegistry: SkillRegistry): void {
    for (const skill of skillRegistry.getAll()) {
      this.register({
        name: skill.name,
        description: skill.description + (skill.whenToUse ? `（${skill.whenToUse}）` : ''),
        argumentHint: skill.argumentHint,
        async execute(args) {
          const prompt = await skill.getPrompt(args)
          return {
            type: 'inject',
            prompt,
            allowedTools: skill.allowedTools?.length ? skill.allowedTools : undefined,
          }
        },
      })
    }
  }
}

// 创建内置命令集
export function createBuiltinCommands(_apiKey: string, _model: string): SlashCommand[] {
  return [
    {
      name: 'clear',
      description: '清空对话历史',
      async execute(_, ctx) {
        ctx.clearHistory()
        return { type: 'message', text: '对话历史已清空。' }
      },
    },
    {
      name: 'compact',
      description: '压缩对话历史为摘要，释放上下文空间',
      argumentHint: '[自定义摘要指令]',
      async execute(args, ctx) {
        if (ctx.getHistoryLength() === 0) {
          return { type: 'message', text: '没有可压缩的历史记录。' }
        }
        // 调用 LLM 生成摘要（而不是空操作）
        const summary = await ctx.generateCompactSummary()
        await ctx.compactHistory(summary)
        const tokens = ctx.getEstimatedTokens()
        return { type: 'message', text: `对话历史已压缩为摘要（当前约 ${tokens.toLocaleString()} tokens）。` }
      },
    },
    {
      name: 'cost',
      description: '查看当前会话的 token 用量和费用',
      async execute(_, ctx) {
        const { spent, limit } = ctx.getBudgetInfo()
        const tokens = ctx.getEstimatedTokens()
        let text = ctx.getCostSummary()
        text += `\n上下文估算: 约 ${tokens.toLocaleString()} tokens`
        if (limit !== undefined) {
          const pct = ((spent / limit) * 100).toFixed(1)
          text += `\n预算使用: $${spent.toFixed(4)} / $${limit.toFixed(2)} (${pct}%)`
        }
        return { type: 'message', text }
      },
    },
    {
      name: 'model',
      description: '查看或切换模型',
      argumentHint: '[模型名称]',
      async execute(args, ctx) {
        if (!args) {
          return { type: 'message', text: `当前模型: ${ctx.getModel()}` }
        }
        ctx.setModel(args.trim())
        return { type: 'message', text: `已切换到模型: ${args.trim()}` }
      },
    },
    {
      name: 'session',
      description: '显示当前会话 ID',
      async execute(_, ctx) {
        return { type: 'message', text: `会话 ID: ${ctx.sessionId}` }
      },
    },
    {
      name: 'help',
      description: '显示所有可用命令',
      async execute() {
        return { type: 'noop' } // UI 层处理
      },
    },
    {
      name: 'plan',
      description: '切换计划模式（只读，写操作需确认）',
      async execute(_, ctx) {
        const current = ctx.getMode()
        if (current === 'plan') {
          ctx.setMode('ask')
          return { type: 'message', text: '已退出计划模式，恢复正常模式。' }
        }
        ctx.setMode('plan')
        return { type: 'message', text: '已进入计划模式。智能体只能读取文件，写操作需要你手动确认。' }
      },
    },
    {
      name: 'commit',
      description: '生成 git commit 信息并提交',
      async execute() {
        return {
          type: 'inject' as const,
          prompt: '请分析当前 git diff，生成符合 Conventional Commits 规范的提交信息，然后执行 git commit。',
        }
      },
    },
    {
      name: 'review',
      description: '对当前 git diff 进行代码审查',
      async execute() {
        return {
          type: 'inject' as const,
          prompt: '请对当前 git diff 进行代码审查，指出潜在问题、改进建议和安全隐患。',
        }
      },
    },
    {
      name: 'exit',
      description: '退出程序',
      async execute() {
        return { type: 'exit' }
      },
    },
    // ── 历史归档命令 ──────────────────────────────────────────
    {
      name: 'history',
      description: '查看当前会话的压缩归档历史',
      argumentHint: '[段序号]',
      async execute(args, ctx) {
        const archives = ctx.listArchives()
        if (archives.length === 0) {
          return { type: 'message', text: '当前会话尚未进行过上下文压缩，没有归档历史。' }
        }

        const idx = parseInt(args.trim())
        if (!isNaN(idx) && idx >= 1 && idx <= archives.length) {
          // 显示指定段的摘要详情
          const arc = archives[idx - 1]
          const time = new Date(arc.archivedAt).toLocaleString('zh-CN')
          return {
            type: 'message',
            text: `归档段 ${idx}（${time}，共 ${arc.messageCount} 条消息）:\n\n${arc.summary}`,
          }
        }

        // 列出所有归档段
        const lines = archives.map((arc, i) => {
          const time = new Date(arc.archivedAt).toLocaleString('zh-CN')
          const preview = arc.summary.split('\n').find(l => l.trim())?.slice(0, 60) ?? ''
          return `  ${i + 1}. [${time}] ${arc.messageCount} 条消息 — ${preview}...`
        })
        return {
          type: 'message',
          text: `压缩归档历史（共 ${archives.length} 段）:\n${lines.join('\n')}\n\n输入 /history <序号> 查看某段摘要详情`,
        }
      },
    },
    // ── 会话管理命令 ──────────────────────────────────────────
    {
      name: 'new-session',
      description: '强制创建新会话，清空当前对话历史并重置工作目录',
      async execute(_, ctx) {
        ctx.newSession()
        return { type: 'message', text: `已创建新会话（ID: ${ctx.sessionId}）` }
      },
    },
    {
      name: 'new',
      description: '/new-session 的简写：创建新会话，清空历史并重置工作目录',
      async execute(_, ctx) {
        ctx.newSession()
        return { type: 'message', text: `已创建新会话（ID: ${ctx.sessionId}）` }
      },
    },
    {
      name: 'sessions',
      description: '列出最近的历史会话',
      argumentHint: '[数量，默认 10]',
      async execute(args, ctx) {
        const limit = parseInt(args.trim()) || 10
        const list = ctx.listSessions().slice(0, limit)
        if (list.length === 0) return { type: 'message', text: '没有历史会话。' }
        const lines = list.map((s, i) => {
          const active = s.id === ctx.sessionId ? ' ◀ 当前' : ''
          return `  ${i + 1}. [${s.updatedAt.slice(0, 16)}] ${s.title.slice(0, 40)}${active}\n     ID: ${s.id}  消息数: ${s.messageCount}  模型: ${s.model}`
        })
        return { type: 'message', text: `历史会话（共 ${list.length} 条）:\n${lines.join('\n')}` }
      },
    },
    {
      name: 'resume',
      description: '切换到指定历史会话',
      argumentHint: '<会话ID 或 序号>',
      async execute(args, ctx) {
        const input = args.trim()
        if (!input) return { type: 'message', text: '用法: /resume <会话ID 或 序号>\n输入 /sessions 查看历史会话列表' }

        // 支持序号（如 /resume 2）
        let targetId = input
        const idx = parseInt(input)
        if (!isNaN(idx) && idx > 0) {
          const list = ctx.listSessions()
          const target = list[idx - 1]
          if (!target) return { type: 'message', text: `序号 ${idx} 超出范围，共 ${list.length} 条会话` }
          targetId = target.id
        }

        const ok = ctx.switchSession(targetId)
        if (!ok) return { type: 'message', text: `未找到会话: ${targetId}` }
        return { type: 'message', text: `已切换到会话 ${targetId}` }
      },
    },
  ]
}
