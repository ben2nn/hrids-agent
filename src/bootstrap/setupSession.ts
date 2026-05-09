// 会话初始化 —— 恢复旧会话或新建会话，初始化工作目录
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { generateSessionId, loadSessionEvents, loadSessionMeta, getLastSessionId } from '../core/SessionStore.js'
import { getConfigDir } from '../core/Config.js'
import { getSessionWorkDir } from '../core/ContextBuilder.js'
import { setGlobalCwd } from '../core/cwd.js'
import { ConversationStore, JsonlEventStorage } from '../core/ConversationStore.js'

export interface SessionSetupResult {
  sessionId: string
  store: ConversationStore
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

  if (opts.resume) {
    sessionId = opts.resume
  } else if (opts.newSession) {
    sessionId = generateSessionId()
  } else {
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
        console.log('已恢复会话\n')
      } else {
        sessionId = generateSessionId()
        console.log('已创建新会话\n')
      }
    } else {
      sessionId = generateSessionId()
    }
  }

  // 加载或创建事件存储
  const sessionDir = join(getConfigDir(), 'sessions', sessionId)
  const eventStorage = new JsonlEventStorage(sessionDir)
  const store = new ConversationStore(eventStorage)
  const events = loadSessionEvents(sessionId)
  if (events && events.length > 0) {
    store.appendEventsNoSave(...events)
  }

  // 初始化工作目录
  const existingWorkDir = loadSessionMeta(sessionId)?.workDir
  const initialCwd = opts.cwd
    ?? opts.agentCwd
    ?? existingWorkDir
    ?? getSessionWorkDir(sessionId)

  if (!existsSync(initialCwd)) {
    mkdirSync(initialCwd, { recursive: true })
  }
  setGlobalCwd(initialCwd)

  return { sessionId, store, initialCwd }
}
