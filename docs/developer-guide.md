# 开发者指南

本文档面向需要扩展 hrids-agent 的开发者，涵盖新增工具、适配新 LLM 提供商、新增 IM 平台三个主要扩展点。

---

## 目录

- [新增工具](#新增工具)
- [适配新 LLM 提供商](#适配新-llm-提供商)
- [新增 IM 平台](#新增-im-平台)
- [开发环境](#开发环境)
- [测试](#测试)

---

## 新增工具

### 1. 创建工具文件

在 `src/tools/` 下新建文件，例如 `src/tools/MyTool.ts`：

```typescript
import { z } from 'zod'
import { resolve } from 'path'
import type { ToolDef } from '../core/Tool.js'
import { getGlobalCwd } from '../core/cwd.js'
import { auditLog } from '../core/audit.js'

// 定义输入 schema
const inputSchema = z.object({
  path: z.string().describe('目标文件路径'),
  content: z.string().describe('要写入的内容'),
  encoding: z.enum(['utf-8', 'base64']).optional().default('utf-8').describe('编码格式'),
})

export const MyTool: ToolDef<typeof inputSchema> = {
  name: 'my_tool',
  description: '工具的功能描述，告诉 LLM 何时使用这个工具',
  inputSchema,
  readonly: false,       // 写操作设为 false，只读操作设为 true
  isDestructive: false,  // 不可逆操作（删除、覆盖）设为 true

  // 用户可读的操作描述（显示在权限询问和工具卡片中）
  describe(input) {
    return `操作文件: ${input.path}`
  },

  // 返回操作涉及的文件路径（用于路径级权限控制）
  getFilePath(input) {
    return resolve(getGlobalCwd(), input.path)
  },

  // 返回用于规则内容匹配的字符串（bash 工具返回命令，文件工具返回路径）
  getRuleContent(input) {
    return input.path
  },

  // 硬拦截：在询问用户之前先做安全检查（可选）
  async checkPermission(input) {
    if (input.path.includes('..')) {
      return { granted: false, reason: '不允许路径穿越' }
    }
    return { granted: true }
  },

  async execute(input) {
    // ✅ 必须用 resolve(getGlobalCwd(), input.path) 解析路径
    // ❌ 不要直接用 input.path（Node.js 会用 process.cwd() 解析，多会话时会出错）
    const filePath = resolve(getGlobalCwd(), input.path)

    try {
      // ... 实际操作
      const result = `操作完成: ${filePath}`

      // 写操作必须记录审计日志
      auditLog({
        action: 'my_tool',
        resource: filePath,
        result: 'allowed',
      })

      return { type: 'success', output: result }
    } catch (err) {
      auditLog({
        action: 'my_tool',
        resource: filePath,
        result: 'error',
        details: { error: String(err) },
      })
      return { type: 'error', message: `操作失败: ${String(err)}` }
    }
  },
}
```

### 2. 注册工具

在 `src/tools/index.ts` 中注册：

```typescript
// 1. 添加 import
import { MyTool } from './MyTool.js'

// 2. 添加具名导出
export { MyTool }

// 3. 添加到 ALL_TOOLS 数组
export const ALL_TOOLS: ToolDef[] = [
  // ... 现有工具
  MyTool,
]
```

### 3. 工具开发规范

**路径解析（最重要）：**

```typescript
// ✅ 正确：相对路径基于 persistentCwd 解析
const filePath = resolve(getGlobalCwd(), input.path)

// ❌ 错误：直接使用 input.path
writeFileSync(input.path, content)
```

**`readonly` 分类：**

| 值 | 适用场景 |
|----|---------|
| `true` | 只读操作（读文件、搜索、查询），不修改任何状态 |
| `false` | 写操作（写文件、执行命令、修改数据） |

**审计日志：**

所有 `readonly: false` 的工具必须在成功和失败时都调用 `auditLog()`。

**工具 `describe()` 方法：**

返回简洁的操作描述，显示在：
- 权限询问弹窗
- 工具执行卡片标题
- 审计日志

**`ToolContext` 日志回调：**

长时间运行的工具（如 bash 命令）应通过 `ctx?.onLog?.()` 实时推送日志：

```typescript
async execute(input, ctx) {
  ctx?.onLog?.('[my_tool] 开始处理...')
  // ... 处理过程中持续推送
  ctx?.onLog?.(`[my_tool] 进度: ${progress}%`)
}
```

---

## 适配新 LLM 提供商

### 1. 实现 `LLMProvider` 接口

在 `src/core/providers/` 下新建文件，例如 `MyProvider.ts`：

```typescript
import type { LLMProvider, ChatMessage, StreamChunk } from './types.js'
import type { ToolDef } from '../Tool.js'
import { toAnthropicTool } from '../Tool.js'

export class MyProvider implements LLMProvider {
  readonly name = 'my-provider'
  readonly model: string
  readonly modelType = 'llm' as const
  readonly toolMode = 'native' as const  // 或 'dsml'

  private apiKey: string
  private baseUrl: string

  constructor(config: { model: string; apiKey: string; baseUrl?: string }) {
    this.model = config.model
    this.apiKey = config.apiKey
    this.baseUrl = config.baseUrl ?? 'https://api.my-provider.com/v1'
  }

  async *stream(
    messages: ChatMessage[],
    tools: ToolDef[],
    systemPrompt: string[],
    maxTokens: number,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamChunk> {
    // 将消息格式转换为提供商格式
    const body = {
      model: this.model,
      messages: this.convertMessages(messages, systemPrompt),
      tools: tools.map(t => this.convertTool(t)),
      max_tokens: maxTokens,
      stream: true,
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    })

    if (!response.ok) {
      throw new Error(`API 请求失败: ${response.status} ${await response.text()}`)
    }

    // 解析 SSE 流
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') return

        try {
          const chunk = JSON.parse(data)
          const delta = chunk.choices?.[0]?.delta

          if (delta?.content) {
            yield { type: 'text_delta', delta: delta.content }
          }

          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              yield {
                type: 'tool_call',
                toolCall: {
                  id: tc.id,
                  name: tc.function.name,
                  input: JSON.parse(tc.function.arguments),
                },
              }
            }
          }

          if (chunk.usage) {
            yield {
              type: 'usage',
              usage: {
                inputTokens: chunk.usage.prompt_tokens,
                outputTokens: chunk.usage.completion_tokens,
              },
            }
          }

          const finishReason = chunk.choices?.[0]?.finish_reason
          if (finishReason) {
            yield { type: 'stop_reason', stopReason: finishReason }
          }
        } catch {
          // 忽略解析错误
        }
      }
    }
  }

  private convertMessages(messages: ChatMessage[], systemPrompt: string[]) {
    // 将 ChatMessage[] 转换为提供商格式
    // ...
  }

  private convertTool(tool: ToolDef) {
    // 将 ToolDef 转换为提供商工具格式
    // ...
  }
}
```

### 2. 注册提供商

在 `src/core/providers/registry.ts` 中注册：

```typescript
import { MyProvider } from './MyProvider.js'

// 在 createProvider 函数中添加 case
export function createProvider(config: ProviderConfig): LLMProvider {
  const provider = normalizeProvider(config.provider ?? '')

  switch (provider) {
    // ... 现有 case
    case 'my-provider':
      return new MyProvider({
        model: config.model,
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
      })
    default:
      throw new Error(`未知提供商: ${provider}`)
  }
}

// 在 normalizeProvider 中添加别名（可选）
export function normalizeProvider(provider: string): string {
  const aliases: Record<string, string> = {
    // ... 现有别名
    'myprovider': 'my-provider',
    'my_provider': 'my-provider',
  }
  return aliases[provider.toLowerCase()] ?? provider.toLowerCase()
}
```

### 3. 在 config.json 中使用

```json
{
  "llm": {
    "fallbacks": [
      {
        "provider": "my-provider",
        "models": ["my-model-v1"],
        "apiKey": "sk-xxx",
        "baseUrl": "https://api.my-provider.com/v1"
      }
    ]
  }
}
```

---

## 新增 IM 平台

### 1. 实现适配器

在 `src/gateway/im/platforms/` 下新建文件，例如 `myplatform.ts`：

```typescript
import { BasePlatformAdapter, type SendOptions } from '../BasePlatformAdapter.js'
import type { IMPlatform, PlatformConfig, SendResult } from '../types.js'

// 平台配置接口
export interface MyPlatformConfig extends PlatformConfig {
  platform: 'myplatform'
  token: string
  webhookUrl?: string
}

export class MyPlatformAdapter extends BasePlatformAdapter {
  private token: string
  private pollTimer: ReturnType<typeof setInterval> | null = null

  constructor(config: MyPlatformConfig) {
    super('myplatform' as IMPlatform, config)
    this.token = config.token
  }

  // ── 声明平台能力 ──────────────────────────────────────────

  get capabilities() {
    return {
      // 是否支持编辑已发送的消息（true → 流式推送，false → 等完整输出后发送）
      supportsMessageEdit: false,
      // 是否需要持续续发 typing 状态
      supportsKeepTyping: false,
    }
  }

  // ── 必须实现的接口 ────────────────────────────────────────

  async connect(): Promise<void> {
    this.running = true

    // 启动消息轮询（或 Webhook 监听）
    this.pollTimer = setInterval(() => {
      void this.pollMessages()
    }, 2000)
  }

  async disconnect(): Promise<void> {
    this.running = false
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  async sendText(chatId: string, text: string, options?: SendOptions): Promise<SendResult> {
    // 调用 formatOutbound 进行平台格式化
    const formatted = this.formatOutbound(text)

    try {
      const response = await fetch(`https://api.myplatform.com/send`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chat_id: chatId,
          text: formatted,
          reply_to: options?.replyToMessageId,
        }),
      })

      if (!response.ok) {
        return { success: false, error: `发送失败: ${response.status}` }
      }

      const data = await response.json() as { message_id: string }
      return { success: true, messageId: data.message_id }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  }

  // ── 可选覆盖 ──────────────────────────────────────────────

  // 如果平台支持编辑消息，覆盖此方法
  async editMessage(chatId: string, messageId: string, text: string): Promise<SendResult> {
    const formatted = this.formatOutbound(text)
    // ... 调用平台编辑 API
    return { success: true }
  }

  // 发送 typing 状态
  async sendTyping(chatId: string): Promise<void> {
    // ... 调用平台 typing API
  }

  // 平台特定的消息格式化（Markdown 转换等）
  protected formatOutbound(text: string): string {
    // 例如：将 Markdown 转为平台支持的格式
    return text
  }

  // ── 内部方法 ──────────────────────────────────────────────

  private async pollMessages(): Promise<void> {
    try {
      const response = await fetch(`https://api.myplatform.com/updates`, {
        headers: { 'Authorization': `Bearer ${this.token}` },
      })

      if (!response.ok) return

      const updates = await response.json() as Array<{
        message_id: string
        chat_id: string
        user_id: string
        text: string
      }>

      for (const update of updates) {
        // 调用基类方法触发消息处理
        await this.handleInbound({
          messageId: update.message_id,
          text: update.text,
          messageType: 'text',
          source: {
            platform: 'myplatform' as IMPlatform,
            chatId: update.chat_id,
            chatType: 'dm',
            userId: update.user_id,
          },
        })
      }
    } catch {
      // 忽略轮询错误
    }
  }
}
```

### 2. 注册平台

在 `src/gateway/im/PlatformManager.ts` 的 `startPlatform()` 方法中添加 case：

```typescript
import { MyPlatformAdapter } from './platforms/myplatform.js'
import type { MyPlatformConfig } from './platforms/myplatform.js'

// 在 startPlatform() 的 switch 中添加
case 'myplatform':
  adapter = new MyPlatformAdapter(platformCfg as MyPlatformConfig)
  break
```

### 3. 添加类型定义

在 `src/gateway/im/types.ts` 中添加平台类型：

```typescript
// 在 IMPlatform 联合类型中添加
export type IMPlatform = 'telegram' | 'weixin' | 'webhook' | 'myplatform'

// 添加平台配置接口
export interface MyPlatformConfig extends PlatformConfig {
  platform: 'myplatform'
  token: string
}
```

### 4. 配置使用

在 `~/.hrids-agent/im-platforms.json` 中配置：

```json
{
  "platforms": [
    {
      "platform": "myplatform",
      "enabled": true,
      "token": "your-bot-token"
    }
  ]
}
```

---

## 开发环境

### 启动开发服务

```bash
# 安装依赖
npm install

# 启动 CLI（开发模式，tsx 热重载）
npm run dev

# 启动 Gateway（含前端构建）
npm run gateway

# 仅构建前端
npm run build:web

# 仅构建 TypeScript
npm run build:core
```

### 项目结构约定

- 所有源文件使用 `.ts` 扩展名，导入时使用 `.js`（ESM 规范）
- 工具文件放在 `src/tools/`，命名为 `XxxTool.ts`
- 提供商文件放在 `src/core/providers/`
- IM 平台适配器放在 `src/gateway/im/platforms/`

### 日志

使用项目内置的结构化日志：

```typescript
import { logger } from '../core/logger.js'

const log = logger.child({ component: 'my-component' })

log.debug('调试信息', { key: 'value' })
log.info('操作完成', { result: 'ok' })
log.warn('警告', { reason: '...' })
log.error('错误', { error: String(err) })
```

日志级别通过 `config.json` 的 `logging.level` 控制。

---

## 测试

```bash
# 运行所有测试
npm test

# 监听模式（开发时）
npm run test:watch
```

测试文件放在 `tests/unit/` 目录，使用 Vitest 框架。

```typescript
// tests/unit/my-tool.test.ts
import { describe, it, expect } from 'vitest'
import { MyTool } from '../../src/tools/MyTool.js'

describe('MyTool', () => {
  it('应该正确处理输入', async () => {
    const result = await MyTool.execute({ path: 'test.txt', content: 'hello' })
    expect(result.type).toBe('success')
  })
})
```
