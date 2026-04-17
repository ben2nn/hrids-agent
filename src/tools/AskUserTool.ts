// 向用户提问工具 —— 智能体主动向用户询问信息
import { z } from 'zod'
import type { ToolDef } from '../core/Tool.js'

const inputSchema = z.object({
  question: z.string().describe('要向用户提问的问题'),
  options: z.array(z.string()).optional().describe('可选的预设选项列表'),
})

// 统一的 pending resolve —— 交互模式和 server 模式共用
let pendingResolve: ((answer: string) => void) | null = null
// 当前待回答的问题（供 UI 层展示）
let pendingQuestion: { question: string; options?: string[] } | null = null

// Gateway 模式下的问题推送回调（由 SessionManager 注册）
let gatewayAskCallback: ((question: string, options?: string[]) => void) | null = null

/** 注册 Gateway 模式下的 ask_user 推送回调 */
export function setGatewayAskCallback(cb: ((question: string, options?: string[]) => void) | null): void {
  gatewayAskCallback = cb
}

/** 由 server 模式的消息循环或 Ink UI 层调用，将用户回答注入等待中的 ask_user */
export function resolveAskUser(answer: string): boolean {
  if (!pendingResolve) return false
  const resolve = pendingResolve
  pendingResolve = null
  pendingQuestion = null
  resolve(answer)
  return true
}

/** 获取当前待回答的问题（UI 层用于判断是否处于 ask_user 等待状态） */
export function getPendingAskUser(): { question: string; options?: string[] } | null {
  return pendingQuestion
}

export const AskUserTool: ToolDef<typeof inputSchema> = {
  name: 'ask_user',
  description: '当需要用户提供信息、做出选择或确认操作时，向用户提问。只在真正需要用户输入时使用。',
  inputSchema,
  readonly: true,

  describe(input) {
    return `询问用户: ${input.question.slice(0, 50)}`
  },

  async execute(input) {
    // server 模式：通过 NDJSON 协议发送问题，等待前端回复
    if (process.env.AGENT_SERVER_MODE === '1') {
      return new Promise(resolve => {
        pendingQuestion = { question: input.question, options: input.options }
        pendingResolve = (answer: string) => {
          if (input.options && /^\d+$/.test(answer.trim())) {
            const idx = parseInt(answer.trim()) - 1
            if (idx >= 0 && idx < (input.options?.length ?? 0)) {
              resolve({ type: 'success', output: input.options![idx] })
              return
            }
          }
          resolve({ type: 'success', output: answer.trim() || '（用户未输入）' })
        }
        // 通过 stdout 发送结构化事件（server 模式下 stdout 是 NDJSON 通道）
        process.stdout.write(JSON.stringify({
          type: 'ask_user',
          question: input.question,
          options: input.options ?? [],
        }) + '\n')
      })
    }

    // 交互模式（Ink UI）：通过回调等待，由 App.tsx 的 handleSubmit 调用 resolveAskUser
    return new Promise(resolve => {
      pendingQuestion = { question: input.question, options: input.options }
      pendingResolve = (answer: string) => {
        if (input.options && /^\d+$/.test(answer.trim())) {
          const idx = parseInt(answer.trim()) - 1
          if (idx >= 0 && idx < (input.options?.length ?? 0)) {
            resolve({ type: 'success', output: input.options![idx] })
            return
          }
        }
        resolve({ type: 'success', output: answer.trim() || '（用户未输入）' })
      }

      // Gateway 模式：通过回调通知 SessionManager 广播给前端
      if (gatewayAskCallback) {
        gatewayAskCallback(input.question, input.options)
      }
    })
  },
}
