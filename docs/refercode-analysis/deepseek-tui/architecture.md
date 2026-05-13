# DeepSeek-TUI 核心架构分析

---

## 一、Actor + 事件驱动模型

### 1.1 通道架构

Engine 作为独立的 Tokio 后台任务运行，通过 6 对独立通道与 UI 层通信：

| 通道 | 方向 | 用途 |
|------|------|------|
| `tx_op` / `rx_op` | UI → Engine | 操作指令（SendMessage, CancelRequest 等） |
| `tx_event` / `rx_event` | Engine → UI | 事件通知（流式更新、工具调用等） |
| `tx_approval` / `rx_approval` | UI → Engine | 工具调用审批决策 |
| `tx_user_input` / `rx_user_input` | UI → Engine | 用户输入响应 |
| `tx_steer` / `rx_steer` | UI → Engine | 运行中 turn 追加输入 |
| `tx_subagent_completion` / `rx_subagent_completion` | Engine → UI | 子代理完成通知 |

### 1.2 设计优势

- **UI 非阻塞**：API 调用期间 UI 保持响应
- **实时流式更新**：通过 Event 通道逐块推送内容
- **取消支持**：通过 `CancellationToken` 实现请求级取消
- **工具编排**：多步工具调用在 Engine 内部循环处理

---

## 二、核心组件关系

```
EngineConfig ──> Engine ──> EngineHandle (外部句柄)
                   |
                   ├── Session (会话状态，单一权威来源)
                   ├── DeepSeekClient (多 Provider API 客户端)
                   ├── SubAgentManager (子代理管理)
                   ├── ShellManager (Shell 执行)
                   ├── CapacityController (容量控制)
                   ├── SeamManager (分层上下文 L1/L2/L3)
                   ├── LspManager (LSP 诊断注入)
                   └── McpPool (MCP 连接池)
```

---

## 三、Turn Loop（轮次循环）

### 3.1 生命周期

一次 Turn 代表一轮完整的用户消息 + AI 响应（包括所有工具调用）：

```
用户输入
  → 构建 TurnContext（唯一 ID、步骤计数器、最大步数限制）
  → 工作区快照（pre_turn_snapshot）
  → API 调用循环：
      ├── 发送请求到 LLM
      ├── 解析响应中的工具调用
      ├── 执行工具（可能需要用户审批）
      ├── 将工具结果反馈给 LLM
      └── 重复直到 LLM 不再请求工具调用
  → 工作区后快照（post_turn_snapshot）
  → 容量检查（是否需要推进周期边界）
```

### 3.2 关键设计

- **Steer 输入**：turn 执行过程中用户可以追加指令
- **流式重试**：连接中断时自动重试最多 3 次
- **循环保护**：`LoopGuard` 防止无限工具调用循环
- **工作区快照**：每次 turn 前后创建 git 快照，支持 undo/restore

---

## 四、事件系统

### 4.1 Op 枚举（UI → Engine）

```rust
enum Op {
    SendMessage(String),           // 发送用户消息
    CancelRequest,                 // 取消当前请求
    ApproveToolCall(usize),        // 批准工具调用
    DenyToolCall(usize),           // 拒绝工具调用
    SpawnSubAgent(SubAgentRequest), // 生成子代理
    SetModel(String),              // 切换模型
    ChangeMode(Mode),              // 切换模式
    CompactContext,                // 手动压缩
    EditLastTurn(String),          // 编辑上一条
    Shutdown,                      // 关闭引擎
    // ...
}
```

### 4.2 Event 枚举（Engine → UI）

```rust
enum Event {
    // 流式事件
    MessageStarted,
    MessageDelta(String),
    MessageComplete,
    ThinkingStarted,
    ThinkingDelta(String),
    ThinkingComplete,

    // 工具事件
    ToolCallStarted { name, args },
    ToolCallProgress { name, progress },
    ToolCallComplete { name, result },

    // 轮次生命周期
    TurnStarted,
    TurnComplete,
    CycleAdvanced,

    // 系统事件
    Error(String),
    Status(String),
    ApprovalRequired { tool_call },
    SessionUpdated(Session),
    // ...
}
```

---

## 五、上下文管理

### 5.1 传统压缩（v0.6.6 后默认禁用）

通过 LLM 对历史消息进行摘要压缩。

### 5.2 检查点-重启周期（v0.7+ 默认）

当输入 token 估计值超过阈值时：
1. 生成 briefing（当前周期摘要）
2. 归档当前周期
3. 用种子消息重启新周期

**优势**：保持前缀缓存热度，比传统压缩更高效。

### 5.3 Seam Manager（分层上下文管理）

实现多级摘要（L1/L2/L3），在不删除消息的情况下追加归档上下文块：

| 级别 | 阈值 | 行为 |
|------|------|------|
| L1 | 192K tokens | 追加轻量摘要 |
| L2 | 384K tokens | 追加详细摘要 |
| L3 | 576K tokens | 追加完整归档 |
| Cycle | 768K tokens | 检查点重启 |

---

## 六、子代理系统

### 6.1 设计原则

- **非阻塞 spawn**：`agent_spawn` 立即返回 `agent_id`，父级继续工作
- **独立上下文**：子代理有独立的工具集和会话
- **生命周期管理**：spawn → 运行 → 完成/失败/取消
- **结果收集**：通过 `agent_wait` / `agent_result` 异步获取

### 6.2 核心 API

```rust
fn agent_spawn(task, subagent_type, tools_filter, model_override) -> agent_id
fn agent_wait(agent_id, timeout_ms) -> status
fn agent_result(agent_id) -> result
fn agent_cancel(agent_id) -> ok
fn agent_list() -> agents[]
fn agent_send_input(agent_id, text) -> ok
```

### 6.3 文件租约机制

避免多个子代理同时修改同一文件：

```rust
// 全局所有权表：文件路径 → 智能体 ID
static RESIDENT_LEASES: OnceLock<Mutex<HashMap<String, String>>>;
```
