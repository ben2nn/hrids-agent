// doctor 子命令 —— 健康检查
import { existsSync } from 'fs'
import { loadConfig, getConfigDir, hasMainAgentConfig } from '../../core/Config.js'

export async function runDoctorCommand(): Promise<void> {
  console.log('hrids-agent 健康检查\n')

  const config = loadConfig()
  const configDir = getConfigDir()
  let issues = 0

  console.log(`[配置] 目录: ${configDir}`)
  if (existsSync(configDir)) {
    console.log('  ✓ 配置目录存在')
  } else {
    console.log('  ✗ 配置目录不存在（运行 hrids-agent init 初始化）')
    issues++
  }

  if (hasMainAgentConfig()) {
    console.log('  ✓ 主智能体配置已初始化')
  } else {
    console.log('  ✗ 主智能体提示词未初始化（运行 hrids-agent init）')
    issues++
  }

  const isOllama = config.provider === 'ollama'
    || config.baseUrl?.includes('localhost')
    || config.baseUrl?.includes('127.0.0.1')
  if (isOllama) {
    console.log('\n[API] Ollama 本地模式，无需 API Key')
  } else {
    const hasKey = !!(config.apiKey || config.llm?.fallbacks?.some(g => g.apiKey))
    if (hasKey) {
      console.log('\n[API] ✓ 已配置 API Key')
    } else {
      console.log('\n[API] ✗ 未检测到 API Key')
      issues++
    }
  }

  console.log(`\n[模型] 默认模型: ${config.model ?? '未配置'}`)
  console.log(`\n[MCP] 已配置 ${config.mcpServers.length} 个 MCP 服务器`)
  console.log(`\n[权限] 模式: ${config.agent?.permissionMode ?? 'ask'}`)

  console.log('\n' + '─'.repeat(40))
  if (issues === 0) {
    console.log('✓ 所有检查通过')
  } else {
    console.log(`✗ 发现 ${issues} 个问题`)
    process.exit(1)
  }
}
