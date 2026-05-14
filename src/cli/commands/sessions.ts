// sessions 子命令 —— 列出历史会话
import { listSessions } from '../../core/SessionStore.js'

export interface SessionsCommandOpts {
  limit: number
}

export async function runSessionsCommand(opts: SessionsCommandOpts): Promise<void> {
  const sessions = listSessions()
  if (sessions.length === 0) {
    console.log('没有保存的会话。')
    return
  }
  console.log('最近的会话:')
  sessions.slice(0, opts.limit).forEach(s => {
    console.log(`  ${s.id}  ${s.updatedAt.slice(0, 16)}  ${s.title}`)
  })
}
