// gateway 子命令 —— 启动 HTTP + WebSocket 服务
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { createGateway } from '../../gateway/server.js'
import { loadConfig, getConfigDir } from '../../core/Config.js'
import { migrateOldMemoryStore } from '../../memory/index.js'
import { restoreScheduledJobs, setCronTriggerCallback } from '../../tools/ScheduleCronTool.js'
import { logger } from '../../shared/logger.js'

export interface GatewayCommandOpts {
  port?: string
  host?: string
  token?: string
}

export async function runGatewayCommand(opts: GatewayCommandOpts): Promise<void> {
  const config = loadConfig()
  migrateOldMemoryStore()

  await runGatewayMode({
    gatewayPort: opts.port ?? String(config.gateway?.port ?? 3282),
    gatewayHost: opts.host ?? config.gateway?.host ?? '127.0.0.1',
    gatewayToken: opts.token ?? config.gateway?.token,
    gatewayUsers: config.gateway?.users,
  })
}

// ─── Gateway 模式实现 ──────────────────────────────────────────────────────

export interface GatewayModeOpts {
  gatewayPort: string
  gatewayHost: string
  gatewayToken?: string
  gatewayUsers?: Array<{ username: string; password: string }>
}

export async function runGatewayMode(opts: GatewayModeOpts): Promise<void> {
  // 注册全局异常处理器，避免 Gateway 因单次异常退出
  // 使用 prependListener 插到队首，不移除已有的处理器（避免吞掉其他模块注册的处理器）
  process.prependListener('uncaughtException', (err) => {
    logger.error('未捕获异常（Gateway 继续运行）', { error: err.message, stack: err.stack })
  })
  process.prependListener('unhandledRejection', (reason) => {
    logger.error('未处理的 Promise 拒绝（Gateway 继续运行）', { reason: String(reason) })
  })

  const gateway = createGateway({
    port: parseInt(opts.gatewayPort, 10),
    host: opts.gatewayHost,
    authToken: opts.gatewayToken,
    users: opts.gatewayUsers,
  })
  await gateway.start()

  const webUrl = `http://${opts.gatewayHost}:${opts.gatewayPort}`

  // 注册 cron 触发回调：优先按 job.sessionId 路由，无归属时降级到知了会话
  setCronTriggerCallback((job) => {
    void (async () => {
      try {
        // 优先使用 job 自身的 sessionId 归属
        let targetSessionId: string | undefined = job.sessionId

        // 降级：无归属时回退到知了会话
        if (!targetSessionId) {
          const zhileFile = join(getConfigDir(), 'zhile-session.json')
          if (!existsSync(zhileFile)) {
            logger.warn('[cron] 任务无 sessionId 归属且知了会话文件不存在，跳过触发', { jobId: job.id })
            return
          }
          const parsed = JSON.parse(readFileSync(zhileFile, 'utf-8')) as { sessionId?: string }
          targetSessionId = parsed.sessionId
        }

        if (!targetSessionId) {
          logger.warn('[cron] 无法确定目标会话，跳过触发', { jobId: job.id })
          return
        }

        let session = gateway.manager.getSession(targetSessionId)
        if (!session) {
          logger.warn('[cron] 目标会话不在内存中，尝试恢复', { jobId: job.id, sessionId: targetSessionId })
          try {
            await gateway.manager.createSession({ resume: targetSessionId })
            session = gateway.manager.getSession(targetSessionId)
          } catch (err) {
            logger.error('[cron] 恢复目标会话失败', { error: String(err) })
            return
          }
        }
        if (!session) {
          logger.error('[cron] 目标会话恢复后仍不存在', { jobId: job.id, sessionId: targetSessionId })
          return
        }
        logger.info('[cron] 触发定时任务，发送到目标会话让 LLM 处理', {
          jobId: job.id,
          sessionId: targetSessionId,
          task: job.task.slice(0, 80),
        })
        // 将 task 作为用户消息发送给 LLM 处理（而不是直接发送提醒）
        await gateway.manager.runMessage(targetSessionId, job.task, undefined, {
          id: job.id,
          description: job.description,
        })
      } catch (err) {
        logger.error('[cron] 触发定时任务失败', { jobId: job.id, error: String(err) })
      }
    })()
  })
  restoreScheduledJobs()

  console.log(``)
  console.log(`  hrids-agent Gateway 已就绪`)
  console.log(``)
  console.log(`  Web UI     ${webUrl}`)
  console.log(`  REST API   ${webUrl}/sessions`)
  console.log(`  WebSocket  ws://${opts.gatewayHost}:${opts.gatewayPort}/sessions/:id/stream`)
  if (opts.gatewayToken) {
    console.log(`  Token      ${opts.gatewayToken}`)
  }
  console.log(``)
  console.log(`  提示：在浏览器中打开 ${webUrl} 开始使用`)
  console.log(`  按 Ctrl+C 停止服务`)
  console.log(``)

  const shutdown = async (signal: string) => {
    logger.info(`收到 ${signal}，开始优雅关闭..`)
    process.stdout.write(`\n[gateway] 正在关闭（${signal}）..\n`)
    try {
      await gateway.stop(15000)
    } catch (err) {
      logger.error('关闭失败', { error: String(err) })
    }
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}
