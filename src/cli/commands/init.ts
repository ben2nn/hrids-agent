import { existsSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { getConfigDir } from '../../core/Config.js'
import { saveYamlFile, loadYamlFile } from '../../shared/YamlLoader.js'
import { DEFAULT_MAIN_AGENT_FILES } from '../../coordinator/coordinatorPrompt.js'
import { ensureUserProvidersDir } from '../../core/providers/ProviderProfileLoader.js'
import { BUILTIN_PROVIDERS } from '../../core/providers/registry.js'

const CONFIG_DIR = getConfigDir()
const CONFIG_YAML_FILE = join(CONFIG_DIR, 'config.yaml')

interface InitOptions {
  force?: boolean
}

/** 解析 config.example.yaml 的路径（兼容 dist/ 运行和 bin/ 运行） */
function findExampleConfig(): string {
  const candidates = [
    new URL('../../config.example.yaml', import.meta.url),
    new URL('../../../config.example.yaml', import.meta.url),
  ]
  for (const u of candidates) {
    const p = u.pathname.replace(/^\/([A-Za-z]:)/, '$1')
    if (existsSync(p)) return p
  }
  return ''
}

const MINIMAL_CONFIG = {
  model: 'qwen-plus-2025-07-28',
  timeZone: 'Asia/Shanghai',
  llm: {
    fallbacks: [
      {
        provider: 'aliyun',
        apiKey: 'sk-xxxxxxxx',
        models: ['qwen3.5-35b-a3b', 'qwen3.5-plus-2026-04-20'],
      },
      {
        provider: 'anthropic',
        apiKey: 'sk-ant-xxxxxxxx',
        models: ['claude-3-5-haiku-20241022', 'claude-3-5-sonnet-20241022'],
      },
    ],
  },
  agent: {
    permissionMode: 'ask',
    maxTokens: 8096,
    maxTurns: 50,
    memoryCondense: true,
    autoDistillSkill: false,
  },
  gateway: { port: 3282, host: '127.0.0.1', token: '' },
  logging: { level: 'info', theme: 'default' },
  skillHub: { url: 'https://skillhub.cn', apiBase: 'https://api.skillhub.cn' },
  mcpServers: [],
  multiAgent: {
    globalMaxConcurrent: 10,
    defaultMaxTurns: 30,
    defaultTimeoutMs: 300000,
    autoSelectProfiles: true,
    allowRecursiveAgent: false,
    profileDirs: [],
  },
  toolPermissions: {
    defaultDenyList: ['todo_write', 'todo_update', 'todo_append', 'todo_reset'],
    allowMcpTools: false,
  },
  webSearch: {
    engine: 'searxng',
    endpoint: 'https://xng.hrids.com',
  },
}

const AGENT_YAML_TEMPLATE = `# agents/main/agent.yaml
# 所有字段均可选 —— 默认值来自 config.yaml + 代码内置值

# 覆盖全局 LLM 设置（取消注释即可使用）
# model: claude-3-5-sonnet-20241022
# provider: anthropic

# 覆盖智能体行为（取消注释即可使用）
# maxTurns: 50
# maxBudgetUsd: 10.0

# 覆盖权限默认值（取消注释即可使用）
# permission:
#   mode: ask
#   denied_paths: [.env, secrets/]
#   always_deny: ["bash(rm *)", "bash(shutdown)"]

# 限制工具（空 = 全部允许，排除 deny list）
# allowed_tools: []
`


export async function runInitCommand(opts: InitOptions = {}) {
  console.log('\n🚀 hrids-agent 初始化向导\n')

  // config.yaml 已存在且非 --force 时跳过（目录创建仍会执行）
  const configExists = existsSync(CONFIG_YAML_FILE)

  // 确保配置目录存在
  mkdirSync(CONFIG_DIR, { recursive: true })

  // ── agents/main/：8 个 .md 文件 + agent.yaml ──────────────
  const mainAgentDir = join(CONFIG_DIR, 'agents', 'main')
  mkdirSync(mainAgentDir, { recursive: true })

  const agentYamlPath = join(mainAgentDir, 'agent.yaml')
  if (!existsSync(agentYamlPath) || opts.force) {
    writeFileSync(agentYamlPath, AGENT_YAML_TEMPLATE, 'utf-8')
    console.log(`✓ 已创建: ${agentYamlPath}`)
  }

  for (const [name, content] of Object.entries(DEFAULT_MAIN_AGENT_FILES)) {
    const mdPath = join(mainAgentDir, `${name}.md`)
    if (!existsSync(mdPath) || opts.force) {
      writeFileSync(mdPath, content + '\n', 'utf-8')
    }
  }
  console.log(`✓ 已创建主智能体提示词: ${mainAgentDir}/（${Object.keys(DEFAULT_MAIN_AGENT_FILES).length} 个 .md 文件）`)

  // ── agents/main/memory/ ──────────────────────────────────
  const memoryDir = join(mainAgentDir, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  console.log(`✓ 已创建记忆目录: ${memoryDir}/`)

  // ── sessions/ ────────────────────────────────────────────
  const sessionsDir = join(CONFIG_DIR, 'sessions')
  mkdirSync(sessionsDir, { recursive: true })
  console.log(`✓ 已创建会话目录: ${sessionsDir}/`)

  // ── roles/：自定义专家目录 ──────────────────────────────
  // 内置专家（explore、code-reviewer 等）已定义在代码中，始终可用。
  // 用户可在此目录放置 .yaml 或 .md 文件定义自定义专家（同名覆盖内置）。
  const rolesDir = join(CONFIG_DIR, 'roles')
  mkdirSync(rolesDir, { recursive: true })
  console.log(`✓ 已创建角色目录: ${rolesDir}/（内置专家已内置，可在此添加自定义专家）`)

  // ── providers/：自定义提供商目录 ─────────────────────────
  const providersDir = ensureUserProvidersDir()

  // 初始化内置提供商 YAML 文件
  let providerCount = 0
  for (const def of BUILTIN_PROVIDERS) {
    const providerPath = join(providersDir, `${def.id}.yaml`)
    if (!existsSync(providerPath) || opts.force) {
      const yaml = `# ${def.name}
name: ${def.name}
transport: ${def.transport}
apiKeyEnvVars: [${def.apiKeyEnvVars.join(', ')}]
${def.defaultBaseUrl ? `defaultBaseUrl: ${def.defaultBaseUrl}` : '# defaultBaseUrl: https://api.example.com/v1'}
${def.baseUrlEnvVar ? `baseUrlEnvVar: ${def.baseUrlEnvVar}` : '# baseUrlEnvVar: MY_API_BASE_URL'}
${def.modelPrefixes?.length ? `modelPrefixes: [${def.modelPrefixes.join(', ')}]` : '# modelPrefixes: [model-prefix-]'}
`
      writeFileSync(providerPath, yaml, 'utf-8')
      providerCount++
    }
  }

  // 创建自定义提供商示例
  const exampleProviderPath = join(providersDir, '_example.yaml')
  if (!existsSync(exampleProviderPath)) {
    const exampleProvider = `# 自定义提供商示例
# 文件名即提供商 ID（去掉 .yaml 后缀），也可通过 name 字段覆盖
# 将此文件复制为 your-provider.yaml 并修改配置

name: MyCustomLLM
baseUrl: https://api.example.com/v1
# 传输协议：openai_chat（默认）| anthropic_messages
transport: openai_chat
# API Key 环境变量名（推荐）或直接内联
apiKeyEnvVar: MY_API_KEY
# apiKey: sk-xxxxxxxx
# 是否支持原生联网搜索
nativeWebSearch: false
`
    writeFileSync(exampleProviderPath, exampleProvider, 'utf-8')
  }
  console.log(`✓ 已创建自定义提供商目录: ${providersDir}/（${providerCount} 个内置提供商）`)

  // ── config.yaml：最后生成（目录创建不受 config.yaml 是否存在影响）──
  if (!configExists || opts.force) {
    const examplePath = findExampleConfig()
    if (examplePath) {
      const exampleConfig = loadYamlFile(examplePath)
      saveYamlFile(CONFIG_YAML_FILE, exampleConfig)
    } else {
      saveYamlFile(CONFIG_YAML_FILE, MINIMAL_CONFIG)
    }
    console.log(`✓ 已生成配置文件: ${CONFIG_YAML_FILE}`)
  } else {
    console.log(`✓ 配置文件已存在: ${CONFIG_YAML_FILE}`)
  }

  console.log('\n📝 下一步：')
  console.log('  1. 编辑配置文件，填入你的 API Key：')
  console.log(`     ${CONFIG_YAML_FILE}`)
  console.log('  2. （可选）编辑主智能体提示词：')
  console.log(`     ${mainAgentDir}/IDENTITY.md`)
  console.log('  3. （可选）添加自定义提供商：')
  console.log(`     ${providersDir}/`)
  console.log('  4. 运行: hrids-agent\n')
  console.log('💡 支持的提供商及对应 API Key 环境变量：')
  console.log('   阿里云百炼  DASHSCOPE_API_KEY   qwen-max / qwen-plus')
  console.log('   Anthropic   ANTHROPIC_API_KEY   claude-3-5-sonnet-20241022')
  console.log('   OpenAI      OPENAI_API_KEY      gpt-4o')
  console.log('   DeepSeek    DEEPSEEK_API_KEY    deepseek-chat')
  console.log('   Groq        GROQ_API_KEY        llama-3.3-70b-versatile')
  console.log('   Ollama      （无需 Key）         --provider ollama -m qwen2.5-coder:7b\n')
}
