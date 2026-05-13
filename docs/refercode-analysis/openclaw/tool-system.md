# OpenClaw 工具系统分析

---

## 一、ToolDescriptor 声明式定义

### 1.1 核心类型

```typescript
type ToolDescriptor = {
  readonly name: string
  readonly title?: string
  readonly description: string
  readonly inputSchema: JsonObject        // JSON Schema
  readonly outputSchema?: JsonObject
  readonly owner: ToolOwnerRef            // 谁定义的
  readonly executor?: ToolExecutorRef     // 谁执行的
  readonly availability?: ToolAvailabilityExpression  // 可用性条件
  readonly annotations?: JsonObject
  readonly sortKey?: string
}
```

### 1.2 Owner/Executor 分离

**ToolOwnerRef** — 工具定义者：
```typescript
type ToolOwnerRef =
  | { type: "core" }
  | { type: "plugin"; pluginId: string }
  | { type: "channel"; channelId: string }
  | { type: "mcp"; serverId: string }
```

**ToolExecutorRef** — 工具执行者：
```typescript
type ToolExecutorRef =
  | { type: "core"; executorId: string }
  | { type: "plugin"; pluginId: string; toolName: string }
  | { type: "channel"; channelId: string; actionId: string }
  | { type: "mcp"; serverId: string; toolName: string }
```

**设计价值**：定义者和执行者可以不同。例如 MCP 服务器定义工具，但通过 MCP 协议由远程进程执行。

---

## 二、可用性 DSL

### 2.1 声明式可用性表达式

```typescript
type ToolAvailabilityExpression =
  | { signal: "always" }
  | { signal: "auth"; provider: string }
  | { signal: "config"; path: string }
  | { signal: "env"; var: string }
  | { signal: "plugin-enabled"; pluginId: string }
  | { signal: "context"; key: string }
  | { allOf: ToolAvailabilityExpression[] }
  | { anyOf: ToolAvailabilityExpression[] }
```

### 2.2 使用示例

```typescript
// 仅在配置了 OpenAI API Key 时可用
{
  signal: "auth",
  provider: "openai"
}

// 需要同时满足两个条件
{
  allOf: [
    { signal: "config", path: "tools.browser.enabled" },
    { signal: "env", var: "CHROME_PATH" }
  ]
}

// 满足任一条件即可
{
  anyOf: [
    { signal: "auth", provider: "openai" },
    { signal: "auth", provider: "anthropic" }
  ]
}
```

### 2.3 评估引擎

```typescript
function evaluateToolAvailability(
  expression: ToolAvailabilityExpression,
  context: AvailabilityContext
): boolean {
  switch (expression.signal) {
    case "always": return true
    case "auth": return !!context.auth[expression.provider]
    case "config": return !!getNestedValue(context.config, expression.path)
    case "env": return !!process.env[expression.var]
    case "plugin-enabled": return context.plugins.has(expression.pluginId)
    case "context": return !!context.keys[expression.key]
    case "allOf": return expression.allOf.every(e => evaluate(e, context))
    case "anyOf": return expression.anyOf.some(e => evaluate(e, context))
  }
}
```

---

## 三、工具规划器

### 3.1 buildToolPlan

```typescript
function buildToolPlan(
  descriptors: ToolDescriptor[],
  context: AvailabilityContext
): ToolPlan {
  const visible: ToolDescriptor[] = []
  const hidden: ToolWithDiagnostics[] = []

  for (const desc of descriptors) {
    const available = evaluateToolAvailability(desc.availability, context)
    const hasExecutor = !!desc.executor

    if (available && hasExecutor) {
      visible.push(desc)
    } else {
      hidden.push({
        descriptor: desc,
        diagnostics: {
          unavailable: !available,
          noExecutor: !hasExecutor,
        },
      })
    }
  }

  // 唯一名称检查
  enforceUniqueNames(visible)

  // 按 sortKey 排序
  visible.sort((a, b) => (a.sortKey ?? "").localeCompare(b.sortKey ?? ""))

  return { visible, hidden }
}
```

### 3.2 设计价值

- **声明式**：工具可用性通过表达式声明，而非代码逻辑
- **可组合**：`allOf`/`anyOf` 组合器支持复杂条件
- **可诊断**：`hidden` 列表包含诊断信息，便于调试
- **排序可控**：通过 `sortKey` 控制工具在 prompt 中的顺序

---

## 四、插件工具注册

### 4.1 注册流程

```typescript
// 插件激活时
function activate(api: OpenClawPluginApi) {
  api.registerTool(
    // 工厂函数
    (context) => ({
      name: "my_tool",
      description: "My custom tool",
      inputSchema: { type: "object", properties: { ... } },
      execute: async (input) => { ... },
    }),
    // 选项
    {
      availability: { signal: "config", path: "tools.my_tool.enabled" },
    }
  )
}
```

### 4.2 运行时物化

工具在运行时通过工厂函数物化，注入插件上下文：
```typescript
const tool = factory(pluginContext)
// tool 现在包含完整的执行能力
```

---

## 五、MCP 工具集成

### 5.1 MCP 服务器注册

```typescript
// MCP 服务器通过配置注册
{
  mcp: {
    servers: [{
      id: "my-mcp-server",
      command: "npx",
      args: ["my-mcp-tool"],
    }]
  }
}
```

### 5.2 MCP 工具自动发现

MCP 服务器启动后，自动发现并注册其工具为 `ToolDescriptor`：
```typescript
{
  name: "mcp_tool_name",
  description: "...",
  owner: { type: "mcp", serverId: "my-mcp-server" },
  executor: { type: "mcp", serverId: "my-mcp-server", toolName: "mcp_tool_name" },
  availability: { signal: "always" },
}
```

---

## 六、ACP 工具集成

### 6.1 ACP Runtime 工具

外部 ACP 运行时（如 Claude Code）通过 ACP 协议暴露工具：
```typescript
// ACP 运行时启动后，工具通过 ACP 协议代理
const runtime: AcpRuntime = {
  async *runTurn(input) {
    yield { type: "tool_call", name: "Read", args: { path: "..." } }
    yield { type: "text_delta", content: "..." }
    yield { type: "done" }
  }
}
```

### 6.2 工具名称映射

Anthropic Transport 支持工具名称映射（OAuth 模式使用 Claude Code 工具名）：
```typescript
const TOOL_NAME_MAP = {
  "read_file": "Read",
  "write_file": "Write",
  "execute_command": "Bash",
  // ...
}
```

---

## 七、关键设计模式

| 模式 | 应用 | 价值 |
|------|------|------|
| 声明式描述符 | ToolDescriptor + JSON Schema | 工具定义标准化 |
| 可用性 DSL | allOf/anyOf 组合器 | 灵活的条件控制 |
| Owner/Executor 分离 | 定义者 ≠ 执行者 | 支持 MCP/ACP 远程执行 |
| 规划器 | buildToolPlan | 可见性 + 排序 + 诊断 |
| 工厂模式 | registerTool(factory) | 延迟物化 + 上下文注入 |
| 名称唯一性 | enforceUniqueNames | 防止插件工具冲突 |
| 排序控制 | sortKey | prompt 缓存稳定性 |
