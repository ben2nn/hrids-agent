# OpenClaw 参考价值评估

---

## 一、高参考价值（可直接借鉴）

### 1.1 AgentHarness 双执行路径

**价值**：极高

**适用场景**：支持多种代理运行时

**核心思想**：
- 定义统一的 `AgentHarness` 接口
- 内置 PI Runner 处理简单场景
- 外部 ACP Runtime 处理复杂场景
- 策略模式选择执行路径

**借鉴要点**：
```typescript
type AgentHarness = {
  id: string
  supports(ctx): AgentHarnessSupport
  runAttempt(params): Promise<AgentHarnessAttemptResult>
  compact?(params): Promise<AgentHarnessCompactResult>
  reset?(params): Promise<void>
  dispose?(): Promise<void>
}

// 选择策略
function selectAgentHarness(config): AgentHarness {
  switch (config.harness) {
    case "builtin": return createBuiltinHarness()
    case "auto": return tryByPriority() || createBuiltinHarness()
    default: return getPluginHarness(config.harness)
  }
}
```

### 1.2 可插拔 ContextEngine 接口

**价值**：极高

**适用场景**：上下文管理策略可切换

**核心思想**：
- 定义统一的 `ContextEngine` 接口
- `assemble` 组装上下文，`compact` 压缩上下文
- 注册表 + Slot 配置选择引擎
- 失败时静默回退到默认引擎

**借鉴要点**：
```typescript
interface ContextEngine {
  assemble(params): Promise<AssembleResult>
  compact(params): Promise<CompactResult>
  ingest(params): Promise<IngestResult>
  afterTurn?(params): Promise<void>
}

// 注册表
registerContextEngine("legacy", legacyEngine, "core")
registerContextEngine("lancedb", lancedbEngine, "plugin:lancedb")

// 解析：配置 > 默认 > 回退
const engine = resolveContextEngine(config) ?? defaultEngine
```

### 1.3 声明式工具可用性 DSL

**价值**：高

**适用场景**：工具可用性条件控制

**核心思想**：
- 通过声明式表达式定义工具可用性
- 支持 `allOf`/`anyOf` 组合器
- 信号类型：`auth`、`config`、`env`、`plugin-enabled`、`context`

**借鉴要点**：
```typescript
type AvailabilityExpression =
  | { signal: "always" }
  | { signal: "auth"; provider: string }
  | { signal: "config"; path: string }
  | { signal: "env"; var: string }
  | { allOf: AvailabilityExpression[] }
  | { anyOf: AvailabilityExpression[] }

// 使用
{
  allOf: [
    { signal: "auth", provider: "openai" },
    { signal: "config", path: "tools.browser.enabled" },
  ]
}
```

### 1.4 外部内容隔离

**价值**：高

**适用场景**：防止提示注入攻击

**核心思想**：
- 随机边界标记防止伪造
- 提示注入模式检测
- LLM 特殊 Token 清洗
- Unicode 同形字折叠
- 零宽字符移除

**借鉴要点**：
```typescript
function isolateExternalContent(content: string, source: string): string {
  // 1. 清洗 LLM Token
  content = sanitizeLlmTokens(content)

  // 2. 折叠同形字
  content = foldHomoglyphs(content)

  // 3. 移除零宽字符
  content = removeZeroWidthChars(content)

  // 4. 检测注入
  if (detectInjection(content)) {
    content = `[WARNING: Potential injection detected]\n${content}`
  }

  // 5. 包裹随机边界
  const boundary = randomBytes(8).toString("hex")
  return `<<<EXTERNAL_${boundary} source="${source}>>>\n${content}\n<<<END_${boundary}>>>`
}
```

### 1.5 Auth Profile 使用量追踪与冷却

**价值**：高

**适用场景**：多提供商使用量管理

**核心思想**：
- 失败原因优先级排序
- 阶梯冷却回退（30s → 1min → 5min）
- Billing/Auth 永久失败单独队列
- 模型级冷却（不扩散到其他模型）
- WHAM API 集成获取实际使用量

**借鉴要点**：
```typescript
class AuthProfileUsageTracker {
  private cooldowns: Map<string, number> = new Map()

  onRateLimit(model: string) {
    const current = this.cooldowns.get(model) ?? 0
    const next = Math.min(current * 2 || 30_000, 300_000)
    this.cooldowns.set(model, next)
  }

  isAvailable(model: string): boolean {
    const cooldown = this.cooldowns.get(model)
    return !cooldown || Date.now() > cooldown
  }
}
```

### 1.6 Config 观察-恢复系统

**价值**：高

**适用场景**：配置文件损坏检测与恢复

**核心思想**：
- SHA-256 + 文件元数据指纹
- "last known good" 指纹追踪
- 可疑变更检测（文件突然变小、元数据丢失）
- 自动从备份恢复
- 审计日志

---

## 二、中等参考价值（理念可借鉴）

### 2.1 60+ Plugin API

**价值**：中高

**说明**：统一的插件注册接口覆盖代理/渠道/CLI/网关/记忆/中间件，每个方法有 noop 默认值。

### 2.2 Owner/Executor 分离

**价值**：中高

**说明**：工具定义者和执行者可以不同，支持 MCP/ACP 远程执行场景。

### 2.3 多格式 Bundle 支持

**价值**：中

**说明**：支持 Codex、Cursor、Claude 三种插件 Bundle 格式，便于跨平台兼容。

### 2.4 DM 配对策略

**价值**：中

**说明**：消息渠道中未知发送者收到配对码，防止未授权访问。

### 2.5 压缩委托机制

**价值**：中

**说明**：第三方 ContextEngine 可委托压缩给内置 Runner，无需重新实现算法。

### 2.6 Bootstrap 预算分析

**价值**：中

**说明**：追踪 AGENTS.md/SOUL.md/TOOLS.md 等引导文件占用的上下文比例，截断时发出警告。

---

## 三、低参考价值（差异较大）

| 模块 | 说明 |
|------|------|
| 22+ 消息渠道 | 特定于多平台集成，hrids-agent 可能不需要 |
| 原生伴侣应用 | macOS/iOS/Android 原生应用，实现成本高 |
| 语音唤醒 | 特定于语音交互场景 |
| Live Canvas | A2UI 渲染，特定于可视化交互 |
| Gmail Pub/Sub | 特定于邮件集成 |
| 20+ CodeQL 查询 | 生产级安全审计，需要 GitHub 集成 |

---

## 四、与其他参考项目的对比

| 维度 | OpenClaw | Hermes Agent | Claude Code | DeepSeek-TUI | DeepSeek-Reasonix |
|------|----------|-------------|-------------|-------------|-------------------|
| 语言 | TypeScript | Python | TypeScript | Rust | TypeScript |
| 运行时 | Node.js | Python | Bun | Tokio | Node.js |
| 架构模式 | Gateway 中心化 | 插件驱动 | AsyncGenerator 管道 | Actor + 事件驱动 | Cache-First Loop |
| 执行路径 | 双路径（PI + ACP） | 单一 | 单一 | 单一 | 单一 |
| 提供商支持 | 20+ 插件 | 28+ 声明式 | 单一 | 9 配置式 | 单一 |
| 渠道支持 | 22+ 渠道 | 20+ 网关 | 终端/IDE | 终端 | 终端 |
| 上下文管理 | 可插拔 ContextEngine | 轨迹压缩 | 四层压缩 | Seam Manager | 多级阈值折叠 |
| 工具系统 | 声明式 + 可用性 DSL | AST 自动发现 | buildTool 工厂 | 延迟加载 + BM25 | 静态注册 |
| 安全体系 | 多层沙箱 + 内容隔离 | Skills 扫描 | 分层权限 | 三层安全屏障 | 白名单 |
| 配置系统 | Zod + 观察-恢复 | YAML | JSON | TOML | JSON |
| 状态管理 | JSON + SQLite | SQLite + FTS5 | JSONL | SQLite | JSONL |
| 原生应用 | macOS/iOS/Android | 无 | 无 | 无 | 无 |

---

## 五、借鉴优先级建议

### P0（立即引入）

1. **AgentHarness 双执行路径** — 支持多种代理运行时的统一接口
2. **可插拔 ContextEngine** — 上下文管理策略可切换
3. **声明式工具可用性 DSL** — 灵活的工具可用性控制

### P1（近期引入）

4. **外部内容隔离** — 防止提示注入攻击
5. **Auth Profile 使用量追踪** — 多提供商使用量管理
6. **Config 观察-恢复** — 配置文件损坏检测与恢复

### P2（中期引入）

7. **60+ Plugin API** — 统一插件注册接口
8. **Owner/Executor 分离** — 支持远程工具执行
9. **DM 配对策略** — 消息渠道安全
10. **压缩委托机制** — 第三方引擎压缩能力复用
