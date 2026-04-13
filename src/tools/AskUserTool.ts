// 向用户提问工具 —— 智能体主动向用户询问信息
import { z } from 'zod'
import * as readline from 'readline'
import type { ToolDef } from '../core/Tool.js'

const inputSchema = z.object({
  question: z.string().describe('要向用户提问的问题'),
  options: z.array(z.string()).optional().describe('可选的预设选项列表'),
})

// server 模式下，通过 NDJSON 协议与前端交互
// 发送 ask_user 事件 → 等待前端通过 stdin 发回 { type: "user_reply", answer: "..." }
let pendingResolve: ((answer: string) => void) | null = null

/** 由 server 模式的消息循环调用，将用户回答注入等待中的 ask_user */
export function resolveAskUser(answer: string): boolean {
  if (!pendingResolve) return false
  const resolve = pendingResolve
  pendingResolve = null
  resolve(answer)
  return true
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

    // 交互模式：直接用 readline
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    })

    return new Promise(resolve => {
      let prompt = `\n❓ ${input.question}`
      if (input.options && input.options.length > 0) {
        prompt += '\n选项:\n' + input.options.map((o, i) => `  ${i + 1}. ${o}`).join('\n')
        prompt += '\n请输入选项编号或直接回答: '
      } else {
        prompt += '\n你的回答: '
      }

      rl.question(prompt, answer => {
        rl.close()
        if (input.options && /^\d+$/.test(answer.trim())) {
          const idx = parseInt(answer.trim()) - 1
          if (idx >= 0 && idx < input.options.length) {
            resolve({ type: 'success', output: input.options[idx] })
            return
          }
        }
        resolve({ type: 'success', output: answer.trim() || '（用户未输入）' })
      })
    })
  },
}
