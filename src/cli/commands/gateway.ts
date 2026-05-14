// gateway 子命令 —— 启动 HTTP + WebSocket 服务
import { runGatewayMode } from '../../modes/gatewayMode.js'
import { loadConfig } from '../../core/Config.js'
import { migrateOldMemoryStore } from '../../memory/index.js'

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
