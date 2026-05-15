// 会话初始化 —— 恢复旧会话或新建会话，初始化工作目录
import { join } from 'path'
import { generateSessionId } from '../core/SessionStore.js'
import { getConfigDir } from '../core/Config.js'
import { getSessionWorkDirPath } from '../core/ContextBuilder.js'
import { setGlobalCwd } from '../core/cwd.js'
import { ConversationStore, JsonlEventStorage } from '../core/ConversationStore.js'
import type { QueryEngine } from '../core/QueryEngine.js'

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
    sessionId = generateSessionId()
  }

  // 询问是否使用当前目录作为工作目录
  const cwd = process.cwd()
  process.stdout.write(`\n当前目录：${cwd}\n`)
  process.stdout.write(`使用当前目录作为工作目录？[Y/n] `)

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

  // 加载或创建事件存储
  const sessionDir = join(getConfigDir(), 'sessions', sessionId)
  const eventStorage = new JsonlEventStorage(sessionDir)
  const store = new ConversationStore(eventStorage)

  // 确定工作目录
  let initialCwd: string
  if (answer === '' || answer === 'y') {
    initialCwd = cwd
    console.log(`工作目录：${initialCwd}\n`)
  } else {
    initialCwd = opts.agentCwd
      ?? getSessionWorkDirPath(sessionId)
    console.log(`工作目录：${initialCwd}\n`)
  }

  setGlobalCwd(initialCwd)

  return { sessionId, store, initialCwd }
}

// ── 延迟会话创建 ──────────────────────────────────────────────────
// 启动时不创建会话存储，第一次提问时才初始化

export function prepareSession(opts: SessionSetupOpts): { sessionId: string; initialCwd: string } {
  const sessionId = opts.resume ?? generateSessionId()
  const initialCwd = opts.cwd ?? opts.agentCwd ?? process.cwd()
  setGlobalCwd(initialCwd)
  return { sessionId, initialCwd }
}

export function initSessionStorage(engine: QueryEngine, sessionId: string): void {
  const sessionDir = join(getConfigDir(), 'sessions', sessionId)
  engine.store.switchStorage(sessionDir)
}
