// 会话初始化 —— 恢复旧会话或新建会话，初始化工作目录
import { existsSync, mkdirSync } from 'fs'
import { generateSessionId, loadSession, loadSessionMeta, getLastSessionId } from '../core/SessionStore.js'
import { getSessionWorkDir } from '../core/ContextBuilder.js'
import { setGlobalCwd } from '../core/cwd.js'
import type { Message } from '../core/QueryEngine.js'

export interface SessionSetupResult {
  sessionId: string
  initialMessages: Message[]
  initialCwd: string
}

export interface SessionSetupOpts {
  resume?: string
  newSession?: boolean
  cwd?: string
  agentCwd?: string
}

export async function setupSession(opts: SessionSetupOpts): Promise<SessionSetupResult> {
  let sessionId: string
  let initialMessages: Message[]

  if (opts.resume) {
    // 明确指定 --resume，直接恢复
    sessionId = opts.resume
    initialMessages = loadSession(sessionId) ?? []
  } else if (opts.newSession) {
    // 明确指定 --new-session，强制新建
    sessionId = generateSessionId()
    initialMessages = []
  } else {
    // 默认行为：检测是否有上次会话，有则询问用户
    const lastSessionId = getLastSessionId()
    if (lastSessionId) {
      const lastMeta = loadSessionMeta(lastSessionId)
      const lastTitle = lastMeta?.title ?? '未知'
      const lastTime = lastMeta?.updatedAt
        ? new Date(lastMeta.updatedAt).toLocaleString('zh-CN')
        : '未知时间'
      const msgCount = lastMeta?.messageCount ?? 0

      process.stdout.write(`\n上次会话：「${lastTitle}」\n`)
      process.stdout.write(`  时间：${lastTime}，共 ${msgCount} 条消息\n`)
      process.stdout.write(`恢复上次会话？[Y/n] `)

      const answer = await new Promise<string>(resolve => {
        if (process.stdin.isPaused()) process.stdin.resume()
        process.stdin.setEncoding('utf-8')
        const handler = (data: string) => {
          process.stdin.removeListener('data', handler)
          process.stdin.pause()
          resolve(data.toString().trim().toLowerCase())
        }
        process.stdin.once('data', handler)
      })

      if (answer === '' || answer === 'y') {
        sessionId = lastSessionId
        initialMessages = loadSession(sessionId) ?? []
        console.log(`已恢复会话（${initialMessages.length} 条消息）\n`)
      } else {
        sessionId = generateSessionId()
        initialMessages = []
        console.log('已创建新会话\n')
      }
    } else {
      sessionId = generateSessionId()
      initialMessages = []
    }
  }

  // 初始化工作目录（优先级：--cwd > config.agentCwd > 旧会话目录 > 新建会话独立目录）
  const existingWorkDir = loadSessionMeta(sessionId)?.workDir
  const initialCwd = opts.cwd
    ?? opts.agentCwd
    ?? existingWorkDir
    ?? getSessionWorkDir(sessionId)

  if (!existsSync(initialCwd)) {
    mkdirSync(initialCwd, { recursive: true })
  }
  setGlobalCwd(initialCwd)
  // 注意：不调用 process.chdir，避免修改进程级工作目录影响 Gateway 多会话场景
  // cwd 通过 AsyncLocalStorage（runWithCwd）在每次消息处理时注入

  return { sessionId, initialMessages, initialCwd }
}
