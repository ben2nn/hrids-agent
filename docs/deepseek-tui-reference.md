# DeepSeek-TUI 架构参考文档

> 基于 DeepSeek-TUI v0.8.28 源码分析，提炼可借鉴到 hrids-agent 的设计模式和架构思想。

---

## 一、项目概览

DeepSeek-TUI 是一个完全运行在终端里的编程智能体，用 Rust 编写，面向 DeepSeek V4 模型构建。核心特点：

- **自包含二进制**：无运行时依赖（不需要 Node.js/Python）
- **流式优先**：所有 LLM 交互都是 SSE 流式
- **100 万 token 上下文**：智能压缩 + 前缀缓存感知
- **子智能体并行**：非阻塞 spawn，父级继续工作
- **安全纵深**：沙箱 + 执行策略 + SSRF 防护

---

## 二、架构分层

```
┌─────────────────────────────────────────────────────────┐
│  用户入口层                                              │
│  CLI (调度器)  ←→  TUI (终端界面)  ←→  App Server (HTTP) │
└───────────────────────┬─────────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────────┐
│  核心引擎层                                              │
│  Engine → Turn Loop → Tool Execution → LSP Hooks         │
│  Session, Turn, Events, Capacity Guardrails              │
└───────────────────────┬─────────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────────┐
│  工具与扩展层                                            │
│  Tools (40+)  Skills  Hooks  MCP  RLM                    │
└───────────────────────┬─────────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────────┐
│  基础设施层                                              │
│  Config  State(SQLite)  Secrets(Keyring)  Protocol       │
│  Agent(模型注册)  ExecPolicy(沙箱策略)                    │
└─────────────────────────────────────────────────────────┘
```

---

## 三、核心引擎设计

### 3.1 Turn Loop（轮次循环）

引擎的核心是一个流式 turn 循环，位于 `core/engine/turn_loop.rs`：

```
用户输入
  → 构建 MessageRequest（含系统提示、历史消息、工具定义）
  → 流式调用 LLM（SSE）
  → 解析响应：
      ├── 文本内容 → 流式渲染到 TUI
      ├── 思考 tokens → 特殊样式显示
      └── 工具调用 → 提取参数
  → 有工具调用？
      ├── 是 → 审批检查 → 并行执行 → 结果写回消息历史 → 继续循环
      └── 否 → 输出最终回复 → 结束 turn
```

**关键设计决策**：

1. **Steer 输入**：turn 执行过程中用户可以追加指令，引擎在每轮循环开始时检查 `rx_steer` 通道
2. **流式重试**：连接中断时自动重试最多 3 次（`MAX_STREAM_RETRIES`），不中断用户交互
3. **自动压缩**：上下文接近上限时自动压缩历史消息，保留关键信息
4. **循环保护**：`LoopGuard` 防止无限工具调用循环

### 3.2 容量护栏（Capacity Guardrails）

上下文接近上限时的智能干预机制：

```rust
enum CapacityDecision {
    Continue,           // 正常继续
    Compact,            // 压缩上下文
    DelegateToSubAgent, // 委托给子智能体
    Stop,               // 停止当前 turn
}
```

系统在每个工具执行后检查容量，根据风险等级（`RiskBand`）决定下一步行动。

### 3.3 事件系统

引擎通过 `mpsc` 通道与 UI 通信：

```rust
enum Event {
    Status(String),
    StreamDelta(String),
    ToolCallStart { name, args },
    ToolCallResult { name, result },
    TurnComplete,
    Error(String),
    // ...
}
```

这种设计实现了**非阻塞 UI**——API 调用期间 UI 保持响应。

---

## 四、工具系统设计

### 4.1 ToolSpec Trait

所有工具实现统一接口：

```rust
#[async_trait]
trait ToolSpec: Send + Sync {
    // 基本信息
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn parameters_schema(&self) -> Value;  // JSON Schema

    // 执行
    async fn execute(&self, ctx: &ToolContext, args: Value) -> Result<ToolResult>;

    // 能力声明
    fn capabilities(&self) -> ToolCapability;

    // 审批要求
    fn approval_requirement(&self) -> ApprovalRequirement;
}
```

### 4.2 工具注册表

```rust
struct ToolRegistry {
    tools: HashMap<String, Arc<dyn ToolSpec>>,
    context: ToolContext,
    api_cache: OnceLock<Vec<Tool>>,  // 前缀缓存感知
}
```

**前缀缓存优化**：序列化的工具目录缓存字节稳定，优化 DeepSeek 的 KV 前缀缓存命中率。这是一个重要的性能优化——工具定义在多次请求间保持字节级一致。

### 4.3 ToolContext

工具执行时的上下文信息：

```rust
struct ToolContext {
    workspace: PathBuf,              // 工作区根目录
    shell_manager: SharedShellManager,
    trust_mode: bool,
    sandbox_policy: SandboxPolicy,
    notes_path: PathBuf,
    mcp_config_path: PathBuf,
    auto_approve: bool,              // YOLO 模式
    features: Features,
    state_namespace: String,
    trusted_external_paths: Vec<PathBuf>,
    network_policy: Option<NetworkPolicyDecider>,
    runtime: RuntimeToolServices,    // 持久化服务
    cancel_token: Option<CancellationToken>,
    sandbox_backend: Option<Arc<dyn SandboxBackend>>,
    memory_path: Option<PathBuf>,
    lsp_manager: Option<Arc<LspManager>>,
}
```

### 4.4 工具分类

| 类别 | 工具 | 说明 |
|---|---|---|
| 文件操作 | `file`, `apply_patch`, `file_search`, `search` | 读写、补丁、搜索 |
| Shell | `shell` | 带沙箱隔离的命令执行 |
| Git | `git`, `git_history`, `github` | 版本控制 + gh CLI 集成 |
| Web | `web_search`, `fetch_url`, `web_run` | 网页搜索和浏览 |
| 规划 | `plan`, `todo` | 计划状态和检查清单 |
| 子智能体 | `subagent` | 并行任务分发 |
| RLM | `rlm` | 递归语言模型 Python REPL |
| 任务 | `tasks`, `automation` | 持久化任务队列和调度 |
| 其他 | `skill`, `remember`, `notify`, `review` | 技能、记忆、通知、审查 |

---

## 五、子智能体系统

### 5.1 设计理念

子智能体是 DeepSeek-TUI 的核心并行能力。设计原则：

1. **非阻塞 spawn**：`agent_spawn` 立即返回 `agent_id`，父级继续工作
2. **独立上下文**：子智能体有独立的工具集和会话
3. **生命周期管理**：spawn → 运行 → 完成/失败/取消
4. **结果收集**：通过 `agent_wait` / `agent_result` 异步获取

### 5.2 核心 API

```rust
// 模型可见的工具接口
fn agent_spawn(task, subagent_type, tools_filter, model_override) -> agent_id
fn agent_wait(agent_id, timeout_ms) -> status
fn agent_result(agent_id) -> result
fn agent_cancel(agent_id) -> ok
fn agent_list() -> agents[]
fn agent_send_input(agent_id, text) -> ok
fn agent_resume(agent_id) -> ok
fn agent_assign(agent_id, task) -> ok
```

### 5.3 子智能体类型

```rust
enum SubAgentType {
    General,      // 通用任务
    Explore,      // 只读探索
    Plan,         // 规划
    Review,       // 代码审查
    Implementer,  // 实现
    Verifier,     // 验证
    Custom,       // 自定义
}
```

### 5.4 文件租约机制

为了避免多个子智能体同时修改同一文件，引入了租约机制：

```rust
// 全局所有权表：文件路径 → 智能体 ID
static RESIDENT_LEASES: OnceLock<Mutex<HashMap<String, String>>>;

// 智能体完成时释放租约
fn release_resident_leases_for(agent_id: &str);
```

---

## 六、RLM（递归语言模型）

### 6.1 论文依据

实现 *Zhang, Kraska & Khattab (arXiv:2512.24601)* 的 Algorithm 1：

```
state ← InitREPL(prompt=P)
state ← AddFunction(state, sub_RLM)
hist ← [Metadata(state)]
while True:
    code ← LLM(hist)
    (state, stdout) ← REPL(state, code)
    hist ← hist ∥ code ∥ Metadata(stdout)
    if state[Final] is set:
        return state[Final]
```

### 6.2 实现特点

- **沙箱化 Python REPL**：`python3 -u` 子进程，通过 stdin/stdout 通信
- **内置辅助函数**：`llm_query()`, `llm_query_batched()`, `rlm_query()`, `rlm_query_batched()`
- **并行调度**：可同时运行 1-16 个低成本子任务
- **用途**：批量分析、并行推理、复杂数据处理

---

## 七、安全机制

### 7.1 沙箱系统

| 平台 | 机制 | 说明 |
|---|---|---|
| macOS | Seatbelt | `sandbox-exec` 强制访问控制 |
| Linux | Landlock | 内核 5.13+ 文件系统访问控制 |
| Windows | Job Object | 进程树隔离（计划中） |

### 7.2 执行策略引擎

`execpolicy` crate 提供细粒度的命令执行策略：

```rust
enum Decision {
    Allow,
    Deny(String),
    RequireApproval(String),
}
```

### 7.3 安全检查清单

1. **SSRF 防护**：`fetch_url` 限制可访问的 URL
2. **网络策略**：`NetworkPolicyDecider` 按域名控制网络访问
3. **命令安全分析**：`command_safety.rs` 检测危险命令
4. **路径遍历防护**：MCP 配置路径拒绝 `..` 组件
5. **密钥遮蔽**：错误信息中遮蔽 URL 中的密码和 token
6. **工作区信任**：`workspace_trust.rs` 管理可信路径

---

## 八、MCP 集成

### 8.1 架构

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  TUI Engine │────▶│  MCP Pool   │────▶│  MCP Server │
│             │◀────│  (连接池)    │◀────│  (stdio/HTTP)│
└─────────────┘     └─────────────┘     └─────────────┘
```

### 8.2 关键特性

- **连接池复用**：避免重复启动 MCP 服务器
- **自动工具发现**：`tools/list` 请求获取服务器提供的工具
- **超时控制**：per-server 和全局超时配置
- **自动重载**：`mcp.json` 变化时自动重载（mtime + 内容哈希检查）
- **安全**：路径遍历防护、URL 密钥遮蔽

---

## 九、LLM 客户端设计

### 9.1 统一接口

```rust
trait LlmClient: Send + Sync {
    fn provider_name(&self) -> &'static str;
    fn model(&self) -> &str;
    async fn create_message(&self, request: MessageRequest) -> Result<MessageResponse>;
    async fn create_message_stream(&self, request: MessageRequest) -> Result<StreamEventBox>;
    async fn health_check(&self) -> Result<bool>;
}
```

### 9.2 错误分类

```rust
enum LlmError {
    RateLimited { message, retry_after },  // 429 → 可重试
    ServerError { status, message },        // 5xx → 可重试
    NetworkError(String),                   // 网络 → 可重试
    Timeout(Duration),                      // 超时 → 可重试
    AuthenticationError(String),            // 401/403 → 不可重试
    InvalidRequest { status, message },     // 400 → 不可重试
    ModelError(String),                     // 模型错误 → 不可重试
    ContentPolicyError(String),             // 内容策略 → 不可重试
}
```

### 9.3 重试机制

```rust
struct RetryConfig {
    max_retries: u32,
    base_delay: Duration,
    max_delay: Duration,
    backoff_multiplier: f64,
    jitter: bool,
}
```

指数退避 + 抖动，避免雷群效应。

---

## 十、对 hrids-agent 的借鉴建议

### 10.1 工具系统改进

**当前 hrids-agent**：
```typescript
interface ToolDef<TInput> {
  name: string
  description: string
  inputSchema: TInput  // Zod schema
  readonly: boolean
  execute(input, ctx?): Promise<ToolResult>
  checkPermission?(input): Promise<PermissionResult>
}
```

**建议增强**：

1. **添加能力声明**：
```typescript
interface ToolDef<TInput> {
  // ... 现有字段
  capabilities: {
    requiresNetwork: boolean
    requiresShell: boolean
    isInteractive: boolean
    maxExecutionTime?: number  // ms
  }
}
```

2. **添加审批要求**：
```typescript
type ApprovalRequirement =
  | { type: 'always' }           // 总是需要审批
  | { type: 'destructive' }      // 破坏性操作需要审批
  | { type: 'first_time' }       // 首次使用需要审批
  | { type: 'never' }            // 永不需要审批（只读工具）
```

3. **工具注册表缓存**：
```typescript
class ToolRegistry {
  private tools: Map<string, ToolDef>
  private apiCache: object[] | null = null  // 缓存序列化的工具定义

  toApiTools(): object[] {
    if (!this.apiCache) {
      this.apiCache = Array.from(this.tools.values()).map(toAnthropicTool)
    }
    return this.apiCache
  }

  invalidateCache() {
    this.apiCache = null
  }
}
```

### 10.2 引擎 Turn Loop 改进

**建议添加流式重试机制**：

```typescript
class Engine {
  private async handleTurn(messages: Message[]): Promise<TurnResult> {
    const MAX_STREAM_RETRIES = 3
    let retryCount = 0

    while (true) {
      try {
        const stream = await this.client.createMessageStream(messages)
        // ... 处理流式响应
        break
      } catch (error) {
        if (isRetryable(error) && retryCount < MAX_STREAM_RETRIES) {
          retryCount++
          continue
        }
        throw error
      }
    }
  }
}
```

**建议添加 Steer 输入**：

```typescript
class Engine {
  private steerQueue: string[] = []

  // 用户在 turn 执行中追加的指令
  addSteer(text: string) {
    this.steerQueue.push(text)
  }

  private async processSteers() {
    while (this.steerQueue.length > 0) {
      const steer = this.steerQueue.shift()
      if (steer) {
        this.session.addMessage({ role: 'user', content: steer })
      }
    }
  }
}
```

### 10.3 子智能体系统

**当前 hrids-agent** 已有 `AgentTool`，建议增强：

1. **非阻塞 spawn**：
```typescript
// 立即返回 ID，不等待完成
const agentId = await agentPool.spawn({
  task: '分析这个文件',
  type: 'explore',
  tools: ['FileReadTool', 'GrepTool'],
})

// 稍后获取结果
const result = await agentPool.wait(agentId, { timeout: 30000 })
```

2. **文件租约**：
```typescript
class AgentPool {
  private fileLeases = new Map<string, string>()  // filePath → agentId

  async acquireLease(agentId: string, filePath: string): Promise<boolean> {
    const existing = this.fileLeases.get(filePath)
    if (existing && existing !== agentId) {
      return false  // 其他智能体持有租约
    }
    this.fileLeases.set(filePath, agentId)
    return true
  }

  releaseLeases(agentId: string) {
    for (const [path, owner] of this.fileLeases) {
      if (owner === agentId) {
        this.fileLeases.delete(path)
      }
    }
  }
}
```

3. **Mailbox 通信**：
```typescript
interface MailboxMessage {
  from: string
  to: string
  type: 'info' | 'request' | 'response'
  content: string
  timestamp: number
}

class MessageBus {
  private mailboxes = new Map<string, MailboxMessage[]>()

  send(to: string, message: MailboxMessage) {
    const mailbox = this.mailboxes.get(to) || []
    mailbox.push(message)
    this.mailboxes.set(to, mailbox)
  }

  receive(agentId: string): MailboxMessage[] {
    const messages = this.mailboxes.get(agentId) || []
    this.mailboxes.set(agentId, [])
    return messages
  }
}
```

### 10.4 容量管理

**建议添加上下文压缩**：

```typescript
interface CompactionConfig {
  enabled: boolean
  maxTokens: number
  preserveRecent: number  // 保留最近 N 条消息
  summarizeOld: boolean   // 是否用摘要替换旧消息
}

class ContextManager {
  shouldCompact(messages: Message[]): boolean {
    const totalTokens = this.estimateTokens(messages)
    return totalTokens > this.config.maxTokens * 0.8
  }

  async compact(messages: Message[]): Promise<Message[]> {
    // 1. 保留系统提示
    // 2. 保留最近 N 条消息
    // 3. 用摘要替换中间消息
    return compacted
  }
}
```

### 10.5 安全增强

1. **命令安全分析**：
```typescript
function analyzeCommandSafety(command: string): {
  safe: boolean
  warnings: string[]
} {
  const warnings: string[] = []

  // 检测危险模式
  if (/\brm\s+-rf\b/.test(command)) {
    warnings.push('递归删除操作')
  }
  if (/\bcurl\b.*\|\s*bash/.test(command)) {
    warnings.push('管道到 shell 执行')
  }
  // ...

  return { safe: warnings.length === 0, warnings }
}
```

2. **网络策略**：
```typescript
interface NetworkPolicy {
  allowedDomains: string[]
  blockedDomains: string[]
  defaultAction: 'allow' | 'deny'
}

class NetworkPolicyDecider {
  decide(url: string): 'allow' | 'deny' {
    const domain = new URL(url).hostname
    // ...
  }
}
```

### 10.6 LLM 客户端改进

**建议添加统一的错误分类**：

```typescript
class LlmError extends Error {
  constructor(
    public code: 'rate_limited' | 'server_error' | 'network_error' |
                'timeout' | 'auth_error' | 'invalid_request' |
                'model_error' | 'content_policy',
    message: string,
    public retryable: boolean,
    public retryAfter?: number
  ) {
    super(message)
  }
}
```

**建议添加重试包装器**：

```typescript
async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig
): Promise<T> {
  let lastError: Error | undefined

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error as Error

      if (!isRetryable(error) || attempt === config.maxRetries) {
        throw error
      }

      const delay = Math.min(
        config.baseDelay * Math.pow(config.backoffMultiplier, attempt),
        config.maxDelay
      )

      // 添加抖动
      const jitter = config.jitter ? delay * 0.1 * Math.random() : 0
      await sleep(delay + jitter)
    }
  }

  throw lastError
}
```

---

## 十一、关键设计模式总结

### 11.1 事件驱动架构

- 引擎通过 `Event` 通道与 UI 通信
- 实现非阻塞 UI 和实时流式更新
- 便于添加新的 UI 组件（TUI、Web、API）

### 11.2 工具注册表模式

- 统一的工具接口（`ToolSpec` / `ToolDef`）
- 动态注册和查找
- 缓存序列化结果以优化性能

### 11.3 策略模式

- 沙箱策略（`SandboxPolicy`）
- 执行策略（`ExecPolicy`）
- 网络策略（`NetworkPolicy`）
- 审批策略（`ApprovalRequirement`）

### 11.4 守卫模式（RAII）

- `InteractiveTerminalGuard`：确保交互式工具后终端状态恢复
- 文件租约守卫：确保子智能体完成后释放文件锁

### 11.5 观察者模式

- LSP 诊断注入
- Hook 系统（pre/post tool execution）
- 事件广播

---

## 十二、参考资源

- DeepSeek-TUI 仓库：`https://github.com/Hmbown/DeepSeek-TUI`
- 架构文档：`docs/ARCHITECTURE.md`
- 子智能体文档：`docs/SUBAGENTS.md`
- MCP 文档：`docs/MCP.md`
- RLM 论文：`arXiv:2512.24601`

---

*文档生成时间：2026-05-11*
*基于 DeepSeek-TUI v0.8.28 源码分析*
