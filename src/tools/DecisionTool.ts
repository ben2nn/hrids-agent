// 结构化决策上报工具 —— 工作者遇到需要人类决策的节点时暂停并上报
// 与 ask_user 的区别：ask_user 是简单问答，DecisionTool 是带完整上下文的决策框架
import { z } from 'zod'
import * as readline from 'readline'
import type { ToolDef } from '../core/Tool.js'
import { getCurrentSessionId } from '../core/sessionContext.js'

const OptionSchema = z.object({
  label: z.string().describe('选项标签，简短'),
  description: z.string().describe('选项的详细说明，包括优缺点'),
  risk: z.enum(['low', 'medium', 'high']).optional().describe('风险等级'),
})

const inputSchema = z.object({
  title: z.string().describe('决策标题，一句话概括需要决策的事项'),
  context: z.string().describe('决策背景：当前状态、已完成的工作、为什么需要这个决策'),
  options: z.array(OptionSchema).min(2).describe('可选方案列表（至少2个）'),
  recommendation: z.string().optional().describe('工作者的推荐选项及理由（可选）'),
  deadline: z.string().optional().describe('决策截止时间或紧迫性说明（可选）'),
  impact: z.string().optional().describe('此决策的影响范围（可选）'),
})

// ── CLI / Server 模式（单会话）全局 pending resolve ──────────────────────────
let pendingDecisionResolve: ((answer: string) => void) | null = null

// ── Gateway 模式（多会话）会话级 pending resolve 表 ──────────────────────────
const sessionDecisionResolves = new Map<string, (answer: string) => void>()

// ── Gateway 模式（多会话）会话级推送回调表 ───────────────────────────────────
const gatewayDecisionCallbacks = new Map<string, (payload: object) => void>()

/** 注册 Gateway 模式下指定会话的 decision_request 推送回调 */
export function setGatewayDecisionCallback(
  cb: ((payload: object) => void) | null,
  sessionId?: string,
): void {
  const key = sessionId ?? '__global__'
  if (cb) gatewayDecisionCallbacks.set(key, cb)
  else gatewayDecisionCallbacks.delete(key)
}

/**
 * 将用户的决策回答注入等待中的 request_decision。
 * Gateway 模式传入 sessionId 精确路由；CLI/Server 模式不传。
 */
export function resolveDecision(answer: string, sessionId?: string): boolean {
  if (sessionId) {
    const resolve = sessionDecisionResolves.get(sessionId)
    if (!resolve) return false
    sessionDecisionResolves.delete(sessionId)
    resolve(answer)
    return true
  }
  if (!pendingDecisionResolve) return false
  const resolve = pendingDecisionResolve
  pendingDecisionResolve = null
  resolve(answer)
  return true
}

export const DecisionTool: ToolDef<typeof inputSchema> = {
  name: 'request_decision',
  description: `当工作者遇到需要人类决策的关键节点时使用此工具暂停并上报。
适用场景：
- 多个方案各有权衡，无法自主选择
- 操作不可逆（删除数据、发布上线、大规模变更）
- 超出授权范围（涉及费用、外部系统、敏感数据）
- 需求不明确，继续执行可能方向错误
- 发现意外情况，原计划需要调整

不适用场景：
- 有明确最优解的技术选择
- 可以通过 ask_user 解决的简单信息收集`,
  inputSchema,
  readonly: true,

  describe(input) {
    return `请求决策: ${input.title}`
  },

  async execute(input) {
    const optionLines = input.options.map((o, i) => {
      const riskTag = o.risk ? ` [风险: ${{ low: '低', medium: '中', high: '高' }[o.risk]}]` : ''
      return `  ${i + 1}. ${o.label}${riskTag}\n     ${o.description}`
    }).join('\n')

    const sections: string[] = [
      `\n${'═'.repeat(60)}`,
      `⚡ 需要您的决策`,
      `${'═'.repeat(60)}`,
      `\n📋 ${input.title}`,
    ]

    if (input.impact) sections.push(`\n🎯 影响范围: ${input.impact}`)
    if (input.deadline) sections.push(`⏰ 紧迫性: ${input.deadline}`)

    sections.push(`\n📖 背景\n${input.context}`)
    sections.push(`\n🔀 可选方案\n${optionLines}`)

    if (input.recommendation) {
      sections.push(`\n💡 工作者建议: ${input.recommendation}`)
    }

    const prompt = sections.join('\n') + '\n\n请输入选项编号（1-' + input.options.length + '）或直接输入您的指示: '

    const sessionId = getCurrentSessionId()

    // server 模式：通过 NDJSON 协议发送决策请求
    if (process.env.AGENT_SERVER_MODE === '1') {
      return new Promise(resolve => {
        pendingDecisionResolve = (answer: string) => {
          resolve({ type: 'success', output: parseDecisionAnswer(answer, input.options) })
        }
        process.stdout.write(JSON.stringify({
          type: 'decision_request',
          title: input.title,
          context: input.context,
          options: input.options,
          recommendation: input.recommendation,
          deadline: input.deadline,
          impact: input.impact,
        }) + '\n')
      })
    }

    // Gateway 多会话模式：按 sessionId 隔离 pending resolve 和推送回调
    if (sessionId && gatewayDecisionCallbacks.has(sessionId)) {
      const payload = {
        type: 'decision_request',
        title: input.title,
        context: input.context,
        options: input.options,
        recommendation: input.recommendation,
        deadline: input.deadline,
        impact: input.impact,
      }
      return new Promise(resolve => {
        sessionDecisionResolves.set(sessionId, (answer: string) => {
          resolve({ type: 'success', output: parseDecisionAnswer(answer, input.options) })
        })
        gatewayDecisionCallbacks.get(sessionId)!(payload)
      })
    }

    // 交互模式：直接打印并等待输入
    process.stdout.write(prompt)

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    })

    return new Promise(resolve => {
      rl.once('line', answer => {
        rl.close()
        resolve({ type: 'success', output: parseDecisionAnswer(answer.trim(), input.options) })
      })
    })
  },
}

function parseDecisionAnswer(answer: string, options: z.infer<typeof OptionSchema>[]): string {
  // 数字选项
  if (/^\d+$/.test(answer)) {
    const idx = parseInt(answer) - 1
    if (idx >= 0 && idx < options.length) {
      return `用户选择了方案 ${idx + 1}: ${options[idx]!.label}`
    }
  }
  // 自由文本
  return answer.trim() || '用户未作出明确选择，请继续等待或重新询问'
}
