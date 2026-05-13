# hrids-agent 架构优化设计

> 基于 5 个参考项目的源码分析，结合 hrids-agent 现有架构，提出**务实的**优化方案。
> 核心原则：**借鉴思想，不搬架构；解决问题，不造轮子。**

---

## 一、现状与差距分析

### 1.1 hrids-agent 当前架构

```
hrids-agent（TypeScript/Node.js 终端 AI 编程助手）
├── QueryEngine         — 对话循环引擎
├── FallbackProvider    — 13 提供商 + 重试 + 故障转移
├── ToolDef + Registry  — 20+ 工具，静态注册，Zod 校验
├── ConversationStore   — 事件溯源（JSONL）+ 双投影
├── ContextBuilder      — 分层 prompt + 简单裁剪
├── PermissionManager   — 3 种模式 + 规则持久化
├── Skills              — SKILL.md 三级来源
├── MemoryStack         — SQLite + 向量搜索
├── Multi-Agent         — AgentPool + TeamManager
└── Gateway             — Express + WebSocket + IM 适配器
```

### 1.2 参考项目 vs hrids-agent 的本质差异

| 项目 | 本质定位 | 与 hrids-agent 的关系 |
|------|---------|---------------------|
| DeepSeek-TUI | Rust 终端助手，Actor 模型 | 定位相同，语言不同 |
| DeepSeek-Reasonix | DeepSeek 专用优化 | 过于专用，不可照搬 |
| Claude Code | Anthropic 官方，Bun 运行时 | 思想可借鉴，架构不可搬 |
| Hermes Agent | Python 多平台网关 | 定位完全不同 |
| OpenClaw | 22 渠道 + 60 插件的平台 | 定位完全不同 |

**结论**：hrids-agent 是**终端 AI 编程助手**，不是多渠道平台，不是插件框架。优化应聚焦于**提升编程助手的核心体验**，而非追求平台化。

### 1.3 不该做的事（过度工程化警告）

| 不该做 | 原因 |
|--------|------|
| ~~可插拔 ContextEngine~~ | 只有一个上下文策略，搞插拔是空转 |
| ~~60+ Plugin API~~ | 不需要让第三方开发插件 |
| ~~多层沙箱（Docker/SSH）~~ | 本地编程助手不需要多租户隔离 |
| ~~AgentHarness 双执行路径~~ | 不需要嵌入外部代理运行时 |
| ~~延迟加载 + BM25~~ | 20+ 工具全量加载没问题 |
| ~~Auth Profile + WHAM~~ | 已有 CostTracker，够用了 |
| ~~四层上下文压缩管线~~ | 当前 autoCompact 已能用，加一层微压缩即可 |
| ~~Tool-Call Repair 四步管道~~ | StormBreaker 已检测循环，加一步错误提取即可 |
| ~~可组合 Toolset~~ | 不需要 YAML 定义工具集 |

---

## 二、优化方案（仅 3 项，1 周完成）

只做**改动小、收益大、风险低**的优化。每一项都是独立的，失败不影响其他模块。

---

### 2.1 ProviderProfile 声明式配置

**问题**：新增提供商需要改 `registry.ts` 硬编码 + 写新 Provider 类（50-200 行）。

**参考**：Hermes Agent 的 `ProviderProfile` dataclass。

**改动**：

新增 `src/core/providers/ProviderProfile.ts`：

```typescript
export interface ProviderProfile {
  id: string                                    // 'deepseek'
  name: string                                  // 'DeepSeek'
  transport: 'openai_chat' | 'anthropic_messages'
  baseUrl: string                               // 'https://api.deepseek.com/v1'
  apiKeyEnv: string | string[]                  // 'DEEPSEEK_API_KEY'
  defaultModel: string                          // 'deepseek-chat'
  modelPrefixes: string[]                       // ['deepseek-']
  aliases?: string[]                            // ['ds']
  capabilities?: {
    tools?: boolean                             // 默认 true
    vision?: boolean                            // 默认 false
    thinking?: boolean                          // 默认 false
  }
  limits?: {
    maxTokens?: number                          // 默认 8192
    maxContext?: number                         // 默认 128000
  }
  headers?: Record<string, string>              // 自定义请求头
}
```

用户配置文件 `~/.hrids/providers/deepseek.yaml`：

```yaml
id: deepseek
name: DeepSeek
transport: openai_chat
baseUrl: https://api.deepseek.com/v1
apiKeyEnv: DEEPSEEK_API_KEY
defaultModel: deepseek-chat
modelPrefixes: [deepseek-]
aliases: [ds]
capabilities:
  tools: true
  thinking: true
limits:
  maxTokens: 8192
  maxContext: 128000
```

自动发现逻辑：

```typescript
// 三层发现，优先级：项目 > 用户 > 内置
async function discoverProviders(): Promise<ProviderProfile[]> {
  return [
    ...BUILTIN_PROFILES,                         // 现有 13 个
    ...await loadFromDir('~/.hrids/providers/'),  // 用户自定义
    ...await loadFromDir('.hrids/providers/'),     // 项目自定义
  ]
}
```

**改动范围**：
- 新增：`src/core/providers/ProviderProfile.ts`（约 80 行）
- 新增：`src/core/providers/ProviderProfileLoader.ts`（约 60 行）
- 修改：`src/core/providers/index.ts`（`createProvider()` 优先查 Profile）
- 不修改：`registry.ts`、现有 Provider 类

**向后兼容**：完全兼容。现有 `config.yaml` 的 `llm.fallbacks` 格式不变。

**工作量**：2-3 天

**可行性**：⭐⭐⭐⭐⭐（5/5）— 纯配置层改动，不影响核心逻辑

---

### 2.2 错误扣留机制

**问题**：可恢复错误（`prompt-too-long`、`max-output-tokens`、`rate_limited`）直接报给用户，体验差。

**参考**：Claude Code 的 `ErrorWithholder`。

**改动**：

新增 `src/core/ErrorWithholder.ts`（约 40 行）：

```typescript
export class ErrorWithholder {
  private withheld: Array<{ error: LlmError; context: string }> = []

  /** 扣留一个可恢复错误 */
  withhold(error: LlmError, context: string): void {
    this.withheld.push({ error, context })
  }

  /** 尝试恢复，成功则丢弃扣留的错误，失败则表面化 */
  async tryRecover(recoveryFn: () => Promise<boolean>): Promise<boolean> {
    try {
      if (await recoveryFn()) {
        this.withheld = []
        return true
      }
    } catch { /* 恢复失败 */ }
    this.surface()
    return false
  }

  /** 有扣留的错误需要恢复吗？ */
  hasWithheld(): boolean {
    return this.withheld.length > 0
  }

  private surface(): void {
    for (const { error, context } of this.withheld) {
      console.error(`[Recovery failed] ${context}: ${error.message}`)
    }
  }
}
```

在 `QueryEngine` 中集成：

```typescript
// QueryEngine.ts — send() 方法中的错误处理
const withholder = new ErrorWithholder()

// 遇到 prompt-too-long
if (error.code === 'prompt_too_long') {
  withholder.withhold(error, 'context overflow')
  await withholder.tryRecover(async () => {
    await this.compact()  // 压缩上下文
    return true           // 重试由上层处理
  })
}

// 遇到 max-output-tokens
if (stopReason === 'max_tokens') {
  withholder.withhold(error, 'output truncated')
  await withholder.tryRecover(async () => {
    yield { type: 'system_event', kind: 'continuation', text: '请继续。' }
    return true
  })
}

// 遇到 rate_limited
if (error.code === 'rate_limited') {
  withholder.withhold(error, 'rate limited')
  await withholder.tryRecover(async () => {
    const delay = error.retryAfter ?? 5000
    await sleep(delay)
    return true
  })
}
```

**改动范围**：
- 新增：`src/core/ErrorWithholder.ts`（约 40 行）
- 修改：`src/core/QueryEngine.ts`（错误处理分支，约 20 行改动）

**工作量**：1-2 天

**可行性**：⭐⭐⭐⭐⭐（5/5）— 新增类，改动量极小

---

### 2.3 外部内容隔离

**问题**：`WebFetchTool` 返回的网页内容、`FileReadTool` 读取的外部文件可能包含提示注入攻击。

**参考**：OpenClaw 的随机边界标记 + 注入检测 + Token 清洗。

**改动**：

新增 `src/core/ExternalContentIsolator.ts`（约 60 行）：

```typescript
import crypto from 'crypto'

export class ExternalContentIsolator {
  private injectionPatterns = [
    /ignore\s+(all\s+)?previous\s+instructions/i,
    /you\s+are\s+now\s+(a|an)\s+/i,
    /system:\s*/i,
    /\[INST\]/i,
    /<<SYS>>/i,
    /forget\s+everything/i,
    /new\s+instructions?:/i,
  ]

  private zeroWidthChars = /[​‌‍⁠﻿­]/g

  isolate(content: string, source: string): string {
    // 1. 移除零宽字符（防止隐藏边界标记）
    content = content.replace(this.zeroWidthChars, '')

    // 2. 清洗 LLM 特殊 Token
    content = content
      .replace(/<\|im_start\|>/g, '')
      .replace(/<\|im_end\|>/g, '')
      .replace(/<s>|<\/s>/g, '')
      .replace(/\[INST\]|\[\/INST\]/g, '')

    // 3. 检测提示注入
    const hasInjection = this.injectionPatterns.some(p => p.test(content))
    const warning = hasInjection
      ? '\n[WARNING: This external content may contain prompt injection attempts]\n'
      : ''

    // 4. 包裹随机边界
    const boundary = crypto.randomBytes(8).toString('hex')
    return `${warning}<<<EXTERNAL_${boundary} source="${source}">>>\n${content}\n<<<END_${boundary}>>>`
  }
}
```

集成点（改动现有工具的 `execute` 方法）：

```typescript
// WebFetchTool.ts
const isolator = new ExternalContentIsolator()
const raw = await fetch(url).then(r => r.text())
const safe = isolator.isolate(raw, `web:${url}`)
return { type: 'success', output: safe }

// FileReadTool.ts — 仅对外部来源的文件隔离
// （用户项目内的文件不需要隔离）
```

**改动范围**：
- 新增：`src/core/ExternalContentIsolator.ts`（约 60 行）
- 修改：`src/tools/WebFetchTool.ts`（加 2 行调用）
- 不修改：其他工具（仅对外部内容隔离）

**工作量**：1-2 天

**可行性**：⭐⭐⭐⭐⭐（5/5）— 独立模块，改动量极小，仅标记不阻断

---

## 三、不实施但值得了解的模式

以下模式**当前不需要**，但未来如果遇到对应问题，可以参考：

| 模式 | 来源 | 何时需要 |
|------|------|---------|
| 四层上下文压缩 | Claude Code | 长会话频繁触发 autoCompact 且 token 浪费明显时 |
| Tool-Call Repair | DeepSeek-Reasonix | 工具调用失败率高且 LLM 频繁重复错误时 |
| 可插拔 ContextEngine | OpenClaw | 需要同时支持多种上下文策略（如 RAG 模式）时 |
| 多层沙箱 | OpenClaw | 需要在隔离环境中执行不可信代码时 |
| 延迟加载工具目录 | DeepSeek-TUI | 工具数量增长到 100+ 且启动变慢时 |
| Auth Profile 追踪 | OpenClaw | 多提供商成本管理变得复杂时 |

---

## 四、风险评估

| 优化项 | 风险 | 缓解措施 |
|--------|------|---------|
| ProviderProfile | YAML 格式错误导致启动失败 | 校验 + 友好错误提示 + 回退到硬编码 |
| 错误扣留 | 恢复失败时用户体验更差（延迟后才报错） | 设置恢复超时（5s），超时立即表面化 |
| 外部内容隔离 | 注入检测误报（正常内容被标记） | 仅标记 WARNING，不阻断，LLM 自行判断 |

**最大风险不是这 3 项优化本身，而是做了不该做的事。** 上面列出的"不该做的事"任何一项都可能让项目变成四不像。

---

## 五、实施计划

```
Day 1-2: ProviderProfile
  - 新增 ProviderProfile.ts + ProviderProfileLoader.ts
  - 修改 createProvider() 支持 Profile 查找
  - 将 deepseek 作为第一个 Profile 验证

Day 3-4: 错误扣留
  - 新增 ErrorWithholder.ts
  - 在 QueryEngine 中集成 prompt-too-long / max-output-tokens / rate_limited 处理

Day 5-6: 外部内容隔离
  - 新增 ExternalContentIsolator.ts
  - 在 WebFetchTool 中集成
  - 测试提示注入检测效果

Day 7: 集成测试 + 文档更新
```

---

## 六、总结

**做 3 件事，1 周完成，风险可控**：

| 优化项 | 参考来源 | 核心收益 | 改动量 |
|--------|---------|---------|--------|
| ProviderProfile | Hermes Agent | 新增提供商 90%+ 代码减少 | ~140 行新增 |
| 错误扣留 | Claude Code | 可恢复错误自动处理 | ~40 行新增 |
| 外部内容隔离 | OpenClaw | 防提示注入攻击 | ~60 行新增 |

**不做 9 件事，避免项目崩溃**：

可插拔 ContextEngine、60+ Plugin API、多层沙箱、AgentHarness、延迟加载 + BM25、Auth Profile + WHAM、四层压缩管线、Tool-Call Repair 管道、可组合 Toolset。

**核心原则**：项目架构是**长出来的**，不是**设计出来的**。先解决眼前的问题，等真正遇到新问题时再引入新模式。
