# OpenClaw 架构设计分析

---

## 一、整体架构

### 1.1 Gateway 中心化守护进程

OpenClaw 的核心是一个长期运行的 **Gateway 守护进程**（`src/gateway/server.ts`），它：
- 拥有所有消息渠道连接（WhatsApp、Telegram、Slack 等）
- 暴露 WebSocket API 供客户端（CLI、macOS App、Web UI）连接
- 管理会话生命周期、代理路由、定时任务、MCP/ACP 集成

```
消息渠道（22+）
    ↓
Gateway 守护进程
    ├── 渠道管理器（Channel Manager）
    ├── 会话管理器（Session Manager）
    ├── 代理路由器（Agent Router）
    ├── WebSocket API
    ├── HTTP 端点
    ├── 定时任务（Cron）
    └── MCP/ACP 服务器
    ↓
客户端（CLI / macOS / iOS / Web UI）
```

### 1.2 双执行路径

OpenClaw 支持两种代理执行方式：

**路径 1：内置 PI Runner**
```
agentCommand → selectAgentHarness("pi") → runEmbeddedAttempt
    ↓
PI Coding Agent (@earendil-works/pi-coding-agent)
    ↓
Anthropic/OpenAI Transport → LLM API
```

**路径 2：外部 ACP Runtime**
```
agentCommand → selectAgentHarness("claude-code") → AcpSessionManager
    ↓
AcpRuntime.ensureSession() → 启动外部进程
    ↓
AcpRuntime.runTurn() → AsyncIterable<AcpRuntimeEvent>
    ↓
外部代理（Claude Code / Codex / 自定义）
```

---

## 二、AgentHarness 接口

### 2.1 核心类型

```typescript
type AgentHarness = {
  id: string
  label: string
  pluginId?: string

  // 能力检查
  supports(ctx: AgentHarnessSupportContext): AgentHarnessSupport

  // 执行一轮
  runAttempt(params: AgentHarnessAttemptParams): Promise<AgentHarnessAttemptResult>

  // 可选方法
  runSideQuestion?(params): Promise<AgentHarnessSideQuestionResult>
  classify?(result, ctx): AgentHarnessResultClassification | undefined
  compact?(params): Promise<AgentHarnessCompactResult | undefined>
  reset?(params): Promise<void> | void
  dispose?(): Promise<void> | void
}
```

### 2.2 Harness 选择策略

```typescript
function selectAgentHarness(config): AgentHarness {
  switch (config.agentHarness) {
    case "pi":
      return createPiAgentHarness()       // 内置 PI Runner
    case "auto":
      return tryPluginHarnessesByPriority() // 尝试插件，回退 PI
    default:
      return getPluginHarness(config.agentHarness) // 指定插件
  }
}
```

### 2.3 内置 PI Harness

```typescript
function createPiAgentHarness(): AgentHarness {
  return {
    id: "pi",
    label: "PI embedded agent",
    supports: () => ({ supported: true, priority: 0 }),
    runAttempt: runEmbeddedAttempt,
  }
}
```

---

## 三、LLM Transport 层

### 3.1 Anthropic Transport

`createAnthropicMessagesTransportStreamFn`（`src/agents/anthropic-transport-stream.ts`）是主要的 Anthropic 传输层：

```typescript
async function* streamFn(messages, options): AsyncGenerator<TransportEvent> {
  // 1. 解析 API Key（直连 / OAuth / GitHub Copilot）
  const apiKey = resolveApiKey(profile)

  // 2. 转换消息格式
  const anthropicMessages = convertAnthropicMessages(messages)

  // 3. 发送 SSE 请求
  const response = await fetch(url, { body, headers })

  // 4. 解析 SSE 流
  for await (const event of parseAnthropicSseBody(response.body)) {
    switch (event.type) {
      case "content_block_start":
        yield { type: "text_start" | "toolcall_start" | "thinking_start" }
        break
      case "content_block_delta":
        yield { type: "text_delta" | "toolcall_delta" | "thinking_delta" }
        break
      case "message_stop":
        yield { type: "done" }
        break
    }
  }
}
```

### 3.2 认证模式

| 模式 | Token 格式 | 工具名映射 |
|------|-----------|-----------|
| API Key | `sk-ant-api03-...` | 原始工具名 |
| OAuth | `sk-ant-oat-...` | Claude Code 工具名（Read/Write/Bash） |
| GitHub Copilot | `ghu_...` | Claude Code 工具名 |

### 3.3 自适应思考预算

对 Opus 4.6/4.7 等新模型支持自适应思考预算：
```typescript
if (supportsAdaptiveThinking(model)) {
  requestParams.thinking = {
    type: "enabled",
    budget_tokens: thinkingBudget,
  }
}
```

---

## 四、ContextEngine 接口

### 4.1 核心类型

```typescript
interface ContextEngine {
  readonly info: ContextEngineInfo

  // 生命周期
  bootstrap?(params): Promise<BootstrapResult>
  maintain?(params): Promise<ContextEngineMaintenanceResult>
  dispose?(): Promise<void>

  // 消息摄入
  ingest(params): Promise<IngestResult>
  ingestBatch?(params): Promise<IngestBatchResult>

  // 上下文组装（核心）
  assemble(params): Promise<AssembleResult>

  // 上下文压缩
  compact(params): Promise<CompactResult>

  // 后置钩子
  afterTurn?(params): Promise<void>

  // 子代理支持
  prepareSubagentSpawn?(params): Promise<SubagentSpawnPreparation | undefined>
  onSubagentEnded?(params): Promise<void>
}
```

### 4.2 ContextEngine 注册表

```typescript
// 全局单例注册表
registerContextEngine(id, engine, owner)

// 解析顺序：
// 1. 显式 slot 配置（config.plugins.slots.contextEngine）
// 2. 默认 "legacy" 引擎
// 3. 非默认引擎失败时静默回退到默认
```

### 4.3 压缩委托

```typescript
// 第三方引擎可委托压缩给内置 PI Runner
delegateCompactionToRuntime(params) → PI Runner 执行压缩
```

---

## 五、会话管理

### 5.1 SessionEntry 结构

```typescript
type SessionEntry = {
  sessionId: string
  sessionKey: string
  modelOverride?: string
  providerOverride?: string
  thinkingLevel?: string
  authProfileOverride?: string
  skillsSnapshot?: SkillsSnapshot
  acp?: AcpMetadata
  spawnedBy?: string
  deliveryContext?: DeliveryContext
  pendingFinalDelivery?: PendingDelivery  // 崩溃恢复
}
```

### 5.2 崩溃恢复

`pendingFinalDelivery` 字段在进程重启后保留，Gateway 重启时自动恢复未完成的消息投递。

### 5.3 轨迹记录

```typescript
createTrajectoryRuntimeRecorder({
  traceSchema: "openclaw/trajectory/v1",
  traceId: randomUUID(),
  sessionId,
  provider,
  modelId,
  maxBytes: TRAJECTORY_RUNTIME_CAPTURE_MAX_BYTES,
})
// 输出：JSONL 格式轨迹文件
```

---

## 六、Plugin 系统

### 6.1 Plugin API（60+ 注册方法）

```typescript
type OpenClawPluginApi = {
  // 代理扩展
  registerTool(factory, options)
  registerAgentHarness(harness)
  registerContextEngine(engine)
  registerCompactionProvider(provider)

  // 渠道扩展
  registerChannel(adapter)
  registerProvider(profile)

  // 记忆扩展
  registerMemoryRuntime(runtime)
  registerMemoryCapability(capability)
  registerMemoryEmbeddingProvider(provider)

  // CLI 扩展
  registerCommand(command)
  registerCli(cli)

  // 网关扩展
  registerHttpRoute(route)
  registerGatewayMethod(method)

  // 会话自动化
  registerSessionSchedulerJob(job)
  registerSessionAction(action)

  // 中间件
  registerAgentToolResultMiddleware(middleware)
  registerTextTransforms(transforms)

  // 事件
  on(event, handler)
}
```

### 6.2 插件激活规划

```typescript
resolveManifestActivationPlan(manifest, triggers)
// 触发器：command, provider, agentHarness, channel, route, capability
// 匹配 manifest 声明 + 实际注册
```

### 6.3 多格式 Bundle 支持

| 格式 | 目录 | 来源 |
|------|------|------|
| `codex` | `.codex-plugin/plugin.json` | Codex 插件 |
| `cursor` | `.cursor-plugin/plugin.json` | Cursor 插件 |
| `claude` | `.claude-plugin/plugin.json` | Claude 插件 |

---

## 七、架构总结

```
用户设备
    │
    ├── Gateway 守护进程
    │   ├── 渠道管理器（22+ 渠道）
    │   ├── 会话管理器（崩溃恢复）
    │   ├── 代理路由器
    │   │   ├── PI Runner（内置）
    │   │   └── ACP Runtime（外部：Claude Code / Codex）
    │   ├── ContextEngine（可插拔）
    │   ├── Plugin 系统（60+ 注册方法）
    │   ├── 安全层（沙箱 + 内容隔离）
    │   └── 配置系统（Zod + 观察-恢复）
    │
    ├── CLI / TUI
    ├── Web UI（Vite）
    └── 伴侣应用（macOS / iOS / Android）
```

### 关键设计特点

1. **Gateway 中心化** — 单进程守护，所有渠道/会话/代理的控制平面
2. **双执行路径** — 内置 PI Runner + 外部 ACP Runtime，策略模式切换
3. **可插拔一切** — ContextEngine、Provider、Channel、Tool、Memory 全部可插拔
4. **60+ Plugin API** — 统一注册接口，覆盖代理/渠道/CLI/网关/记忆/中间件
5. **崩溃恢复** — `pendingFinalDelivery` 字段保证消息不丢失
6. **本地优先** — Gateway 运行在用户设备，远程访问通过 Tailscale/VPN
