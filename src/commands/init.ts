import { existsSync, writeFileSync, copyFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { getConfigDir } from '../core/Config.js'

const CONFIG_DIR = getConfigDir()
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

interface InitOptions {
  force?: boolean
}

/** 解析 config.example.json 的路径（兼容 dist/ 运行和 bin/ 运行） */
function findExampleConfig(): string {
  const candidates = [
    new URL('../../config.example.json', import.meta.url),   // dist/commands/ → 根目录
    new URL('../../../config.example.json', import.meta.url), // bin/ → 根目录
  ]
  for (const u of candidates) {
    // Windows 路径修正：/C:/... → C:/...
    const p = u.pathname.replace(/^\/([A-Za-z]:)/, '$1')
    if (existsSync(p)) return p
  }
  return ''
}

const MINIMAL_CONFIG = {
  model: 'qwen-plus-2025-07-28',
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
}

export async function runInitCommand(opts: InitOptions = {}) {
  console.log('\n🚀 hrids-agent 初始化向导\n')

  if (existsSync(CONFIG_FILE) && !opts.force) {
    console.log(`✓ 配置文件已存在: ${CONFIG_FILE}`)
    console.log('  如需重新初始化，请运行: hrids-agent init --force\n')
    return
  }

  // 确保配置目录存在
  mkdirSync(CONFIG_DIR, { recursive: true })

  // 优先复制 config.example.json，否则写入最小配置
  const examplePath = findExampleConfig()
  if (examplePath) {
    copyFileSync(examplePath, CONFIG_FILE)
  } else {
    writeFileSync(CONFIG_FILE, JSON.stringify(MINIMAL_CONFIG, null, 2), 'utf-8')
  }

  console.log(`✓ 已生成配置文件: ${CONFIG_FILE}`)
  console.log('\n📝 下一步：')
  console.log(`  1. 编辑配置文件，填入你的 API Key：`)
  console.log(`     ${CONFIG_FILE}`)
  console.log('  2. 运行: hrids-agent\n')
  console.log('💡 支持的提供商及对应 API Key 环境变量：')
  console.log('   阿里云百炼  DASHSCOPE_API_KEY   qwen-max / qwen-plus')
  console.log('   Anthropic   ANTHROPIC_API_KEY   claude-3-5-sonnet-20241022')
  console.log('   OpenAI      OPENAI_API_KEY      gpt-4o')
  console.log('   DeepSeek    DEEPSEEK_API_KEY    deepseek-chat')
  console.log('   Groq        GROQ_API_KEY        llama-3.3-70b-versatile')
  console.log('   Ollama      （无需 Key）         --provider ollama -m qwen2.5-coder:7b\n')
}
