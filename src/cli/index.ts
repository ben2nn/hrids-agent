// CLI 入口 —— Commander 定义 + 懒加载子命令
import { setupSystemProxy } from '../core/proxySetup.js'
setupSystemProxy()

import { Command } from 'commander'
import { loadConfig, getConfigDir, hasMainAgentConfig } from '../core/Config.js'
import { listProfiles } from '../coordinator/ProfileLoader.js'
import { migrateOldMemoryStore } from '../memory/index.js'
import { logger } from '../shared/logger.js'

function validateStartupConfig(config: import('../core/Config.js').AgentConfig, cliApiKey?: string) {
  const isOllama = config.provider === 'ollama'
    || config.baseUrl?.includes('localhost')
    || config.baseUrl?.includes('127.0.0.1')
  if (!isOllama) {
    const hasAnyKey = !!(cliApiKey || config.apiKey || config.llm?.fallbacks?.some(g => g.apiKey))
    if (!hasAnyKey) {
      logger.warn('未检测到任何 API Key，请在 config.yaml 的 llm.fallbacks 中为各提供商配置 apiKey')
    }
  }
}

async function main() {
  const program = new Command()

  program
    .name('hrids-agent')
    .description('原创智能体 CLI，支持 Anthropic / OpenAI / DeepSeek / Groq / Ollama')
    .version('0.2.0')

  // ── init 子命令 ──────────────────────────────────────────────
  program
    .command('init')
    .description('初始化配置文件（~/.hrids/config.yaml）')
    .option('--force', '强制覆盖已有配置文件')
    .action(async (opts) => {
      const { runInitCommand } = await import('./commands/init.js')
      await runInitCommand({ force: opts.force })
    })

  // ── chat 子命令 ──────────────────────────────────────────────
  program
    .command('chat')
    .description('交互模式（默认）')
    .option('-m, --model <model>', '模型名称')
    .option('--provider <provider>', '显式指定提供商')
    .option('--api-key <key>', 'API Key')
    .option('--base-url <url>', '自定义 API 端点')
    .option('--craft', '自主执行模式')
    .option('--plan', '计划模式')
    .option('--resume <sessionId>', '恢复之前的会话')
    .option('--new-session', '强制创建新会话')
    .option('--cwd <dir>', '设置工作目录')
    .option('--profile <name>', '指定默认 agent profile')
    .action(async (opts) => {
      const { runChatCommand } = await import('./commands/chat.js')
      await runChatCommand(opts)
    })

  // ── run 子命令 ───────────────────────────────────────────────
  program
    .command('run <message>')
    .description('非交互模式：执行一条消息后退出')
    .option('-m, --model <model>', '模型名称')
    .option('--provider <provider>', '显式指定提供商')
    .option('--api-key <key>', 'API Key')
    .option('--base-url <url>', '自定义 API 端点')
    .option('--craft', '自主执行模式')
    .option('--cwd <dir>', '设置工作目录')
    .option('--max-chars <n>', '输出字符上限')
    .action(async (message, opts) => {
      const { runRunCommand } = await import('./commands/run.js')
      await runRunCommand(message, opts)
    })

  // ── gateway 子命令 ──────────────────────────────────────────
  program
    .command('gateway')
    .description('Gateway 模式：启动 HTTP + WebSocket 服务')
    .option('--port <port>', '监听端口')
    .option('--host <host>', '监听地址')
    .option('--token <token>', '鉴权 Token')
    .action(async (opts) => {
      const { runGatewayCommand } = await import('./commands/gateway.js')
      await runGatewayCommand(opts)
    })

  // ── sessions 子命令 ─────────────────────────────────────────
  program
    .command('sessions')
    .description('列出最近的历史会话')
    .option('-n, --limit <n>', '显示数量', '10')
    .action(async (opts) => {
      const { runSessionsCommand } = await import('./commands/sessions.js')
      const parsed = parseInt(opts.limit, 10)
      await runSessionsCommand({ limit: Number.isFinite(parsed) && parsed > 0 ? parsed : 10 })
    })

  // ── doctor 子命令 ───────────────────────────────────────────
  program
    .command('doctor')
    .description('健康检查')
    .action(async () => {
      const { runDoctorCommand } = await import('./commands/doctor.js')
      await runDoctorCommand()
    })

  // ── 主命令（无子命令时的默认行为）─────────────────────────────
  program
    .option('-m, --model <model>', '模型名称')
    .option('--provider <provider>', '显式指定提供商')
    .option('--api-key <key>', 'API Key')
    .option('--base-url <url>', '自定义 API 端点')
    .option('--craft', '自主执行模式')
    .option('--plan', '计划模式')
    .option('--resume <sessionId>', '恢复之前的会话')
    .option('--list-sessions', '列出最近的会话')
    .option('--new-session', '强制创建新会话')
    .option('-p, --print <message>', '非交互模式：执行一条消息后退出')
    .option('--server', 'Server 模式：持续从 stdin 读取消息（NDJSON）')
    .option('--gateway', 'Gateway 模式：启动 HTTP + WebSocket 服务')
    .option('--gateway-port <port>', 'Gateway 监听端口')
    .option('--gateway-host <host>', 'Gateway 监听地址')
    .option('--gateway-token <token>', 'Gateway 鉴权 Token')
    .option('--embedding-provider <provider>', 'Embedding 提供商')
    .option('--embedding-model <model>', 'Embedding 模型名称')
    .option('--embedding-base-url <url>', 'Embedding API 端点')
    .option('--cwd <dir>', '设置工作目录')
    .option('--max-chars <n>', '非交互模式输出字符上限')
    .option('--profile <name>', '指定默认 agent profile')
    .option('--list-profiles', '列出所有可用的 agent profiles')
    .action(async (opts) => {
      const config = loadConfig()
      logger.info(`配置目录: ${getConfigDir()}`)

      if (!hasMainAgentConfig()) {
        logger.warn('主智能体提示词未初始化，请运行: hrids-agent init')
      }

      migrateOldMemoryStore()
      validateStartupConfig(config, opts.apiKey)

      // Gateway 模式
      if (opts.gateway) {
        const { runGatewayCommand } = await import('./commands/gateway.js')
        await runGatewayCommand({
          port: opts.gatewayPort ?? String(config.gateway?.port ?? 3282),
          host: opts.gatewayHost ?? config.gateway?.host ?? '127.0.0.1',
          token: opts.gatewayToken ?? config.gateway?.token,
        })
        return
      }

      // 列出 profiles
      if (opts.listProfiles) {
        const profiles = listProfiles(config.multiAgent?.profiles)
        if (profiles.length === 0) {
          console.log('没有可用的 agent profiles。')
        } else {
          console.log('可用的 agent profiles:')
          profiles.forEach(p => {
            console.log(`  ${p.name} — ${p.description}` + (p.model ? ` (模型: ${p.model})` : ''))
          })
        }
        return
      }

      // 列出会话
      if (opts.listSessions) {
        const { runSessionsCommand } = await import('./commands/sessions.js')
        await runSessionsCommand({ limit: 10 })
        return
      }

      // 非交互模式
      if (opts.print) {
        const { runRunCommand } = await import('./commands/run.js')
        await runRunCommand(opts.print, opts)
        return
      }

      // Server 模式
      if (opts.server) {
        const { runServerCommand } = await import('./commands/server.js')
        await runServerCommand(opts)
        return
      }

      // 默认：交互模式
      const { runChatCommand } = await import('./commands/chat.js')
      await runChatCommand(opts)
    })

  await program.parseAsync()
}

main().catch(err => {
  logger.error('启动失败', { error: String(err) })
  console.error('启动失败:', err)
  process.exit(1)
})

process.on('uncaughtException', (err) => {
  logger.error('未捕获异常', { error: err.message, stack: err.stack })
  const isGateway = process.argv.includes('--gateway') || process.argv.includes('gateway')
  if (!isGateway) process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  logger.error('未处理的 Promise 拒绝', { reason: String(reason) })
})
