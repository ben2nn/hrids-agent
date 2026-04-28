// 向用户提问工具 —— 智能体主动向用户询问信息
import { z } from 'zod'
import type { ToolDef, ToolResult } from '../core/Tool.js'
import { getCurrentSessionId } from '../core/sessionContext.js'

const inputSchema = z.object({
  question: z.string().describe('要向用户提问的问题'),
  options: z.array(z.string()).optional().describe('可选的预设选项列表'),
})

// ── CLI / Server 模式（单会话）全局状态 ──────────────────────────────────────
// 交互模式和 server 模式只有一个会话，用全局变量即可
let pendingResolve: ((answer: string) => void) | null = null
let pendingQuestion: { question: string; options?: string[] } | null = null

// ── Gateway 模式（多会话）会话级回调表 ───────────────────────────────────────
// key: sessionId，value: 推送问题给前端的回调
// 每个会话独立注册，互不干扰
const gatewayCallbacks = new Map<string, (question: string, options?: string[]) => void>()

// ── Gateway 模式（多会话）会话级 pending resolve 表 ──────────────────────────
// key: sessionId，value: 等待用户回答的 resolve 函数
// 避免多会话并发时 pendingResolve 全局变量被覆盖
const sessionPendingResolves = new Map<string, (answer: string) => void>()

/** 注册 Gateway 模式下指定会话的 ask_user 推送回调 */
export function setGatewayAskCallback(
  cb: ((question: string, options?: string[]) => void) | null,
  sessionId?: string,
): void {
  if (!sessionId) {
    // 兼容旧调用方式（CLI/Server 模式，无 sessionId）
    if (cb) gatewayCallbacks.set('__global__', cb)
    else gatewayCallbacks.delete('__global__')
    return
  }
  if (cb) gatewayCallbacks.set(sessionId, cb)
  else gatewayCallbacks.delete(sessionId)
}

/** 由 server 模式的消息循环或 Ink UI 层调用，将用户回答注入等待中的 ask_user */
export function resolveAskUser(answer: string, sessionId?: string): boolean {
  // Gateway 多会话模式：优先按 sessionId 路由
  if (sessionId) {
    const resolve = sessionPendingResolves.get(sessionId)
    if (!resolve) return false
    sessionPendingResolves.delete(sessionId)
    resolve(answer)
    return true
  }
  // CLI / Server 模式：使用全局 pendingResolve
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

function makeAnswerResolver(
  options: string[] | undefined,
  resolve: (result: { type: 'success'; output: string }) => void,
): (answer: string) => void {
  return (answer: string) => {
    if (options && /^\d+$/.test(answer.trim())) {
      const idx = parseInt(answer.trim()) - 1
      if (idx >= 0 && idx < options.length) {
        resolve({ type: 'success', output: options[idx] })
        return
      }
    }
    resolve({ type: 'success', output: answer.trim() || '（用户未输入）' })
  }
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
    const sessionId = getCurrentSessionId()

    // server 模式：通过 NDJSON 协议发送问题，等待前端回复
    if (process.env.AGENT_SERVER_MODE === '1') {
      return new Promise<ToolResult>(resolve => {
        pendingQuestion = { question: input.question, options: input.options }
        pendingResolve = makeAnswerResolver(input.options, resolve)
        process.stdout.write(JSON.stringify({
          type: 'ask_user',
          question: input.question,
          options: input.options ?? [],
        }) + '\n')
      })
    }

    // Gateway 多会话模式：按 sessionId 隔离 pending resolve 和回调
    if (sessionId && gatewayCallbacks.has(sessionId)) {
      return new Promise<ToolResult>(resolve => {
        sessionPendingResolves.set(sessionId, makeAnswerResolver(input.options, resolve))
        gatewayCallbacks.get(sessionId)!(input.question, input.options)
      })
    }

    // 交互模式（Ink UI）：通过全局回调等待，由 App.tsx 的 handleSubmit 调用 resolveAskUser
    return new Promise<ToolResult>(resolve => {
      pendingQuestion = { question: input.question, options: input.options }
      pendingResolve = makeAnswerResolver(input.options, resolve)

      // 兼容旧的全局 Gateway 回调（__global__ key）
      const globalCb = gatewayCallbacks.get('__global__')
      if (globalCb) globalCb(input.question, input.options)
    })
  },
}
