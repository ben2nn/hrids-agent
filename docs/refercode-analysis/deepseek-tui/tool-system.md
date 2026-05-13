# DeepSeek-TUI 工具系统分析

---

## 一、工具注册与发现

### 1.1 核心类型

```rust
// 工具元数据
struct ToolSpec {
    name: String,
    description: String,
    input_schema: Value,      // JSON Schema
    output_schema: Value,
    supports_parallel: bool,
    timeout: Duration,
}

// 工具处理器 trait
trait ToolHandler: Send + Sync {
    fn kind(&self) -> ToolKind;           // Function 或 Mcp
    fn is_mutating(&self) -> bool;        // 是否为变更操作
    fn handle(&self, invocation) -> Result<ToolOutput>;
}

// 工具注册表
struct ToolRegistry {
    handlers: HashMap<String, Arc<dyn ToolHandler>>,
    specs: HashMap<String, ConfiguredToolSpec>,
    runtime: ToolCallRuntime,
}
```

### 1.2 工具能力枚举

```rust
enum ToolCapability {
    ReadOnly,          // 只读
    WritesFiles,       // 写文件
    ExecutesCode,      // 执行代码
    Network,           // 网络访问
    Sandboxable,       // 可沙箱化
    RequiresApproval,  // 需要审批
}
```

---

## 二、延迟加载机制（核心亮点）

### 2.1 设计理念

系统采用**延迟加载（deferred loading）**策略来管理大量工具：

- **默认只加载 ~20 个核心工具**：read_file, list_dir, grep_files, file_search 等
- **其余工具延迟加载**：标记为 `defer_loading = true`
- **按需激活**：模型可通过搜索工具发现和激活延迟工具

### 2.2 默认核心工具

```
read_file, list_dir, grep_files, file_search, diagnostics,
rlm, recall_archive, notify, multi_tool_use.parallel,
update_plan, checklist_write, todo_write, ...
```

### 2.3 内置搜索工具

系统注入三个内置工具用于发现延迟工具：

| 工具 | 功能 |
|------|------|
| `code_execution` | 本地沙箱化 Python 执行 |
| `tool_search_tool_regex` | 正则搜索延迟工具 |
| `tool_search_tool_bm25` | 自然语言 BM25 搜索 |

### 2.4 BM25 搜索实现

将工具名称、描述、schema 拼接为 haystack，对查询词逐项匹配：
- 名称匹配权重：2
- 描述匹配权重：1
- 返回 top 5 结果

### 2.5 Prefix Cache 友好排序

`active_tool_list_from_catalog` 使用两遍扫描：
1. **始终加载的工具排在前面**（保持稳定字节偏移）
2. **被激活的延迟工具追加到尾部**

这确保了 LLM 的 prefix cache 不会被破坏。

---

## 三、工具执行流程

### 3.1 执行调度

```rust
struct ToolExecutionPlan {
    index: usize,
    id: String,
    name: String,
    input: Value,
    caller: String,
    is_interactive: bool,
    needs_approval: bool,
    supports_parallel: bool,
    is_read_only: bool,
}
```

### 3.2 并行化策略

只有当批次中**所有工具**都满足以下条件时才并行执行：
- `read_only == true`
- `supports_parallel == true`
- `approval_required == false`
- `interactive == false`

### 3.3 执行锁机制

使用 `RwLock` 实现读写锁：
- `supports_parallel = true` → 获取读锁（允许多个并行）
- `supports_parallel = false` → 获取写锁（独占执行）

### 3.4 InteractiveTerminalGuard

RAII 守卫，处理交互式工具的终端状态管理：
- `engage` 时发送 `PauseEvents`
- `Drop` 时发送 `ResumeEvents`
- 确保即使工具被取消，终端状态也能恢复

---

## 四、MCP 集成

### 4.1 架构

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  TUI Engine │────▶│  MCP Pool   │────▶│  MCP Server │
│             │◀────│  (连接池)    │◀────│  (stdio/HTTP)│
└─────────────┘     └─────────────┘     └─────────────┘
```

### 4.2 工具命名空间

MCP 工具使用限定名称：`mcp__{server}__{tool}`

- `sanitize_component` 将非字母数字字符替换为下划线
- 超过 64 字符时截断并附加哈希后缀

### 4.3 JSON-RPC 方法

| 方法 | 功能 |
|------|------|
| `initialize` / `capabilities` | 返回服务器能力 |
| `tools/list` | 列出工具 |
| `tools/call` | 调用工具 |
| `resources/list` | 列出资源 |
| `resources/read` | 读取资源 |
| `server/register` | 动态注册服务器 |
| `server/start` / `server/stop` | 启停服务器 |

---

## 五、安全策略

### 5.1 三层安全屏障

```
工具级: is_mutating() + allow_mutating
  ↓
策略级: ExecPolicyEngine (deny/trust/approval)
  ↓
沙箱级: SandboxPolicy (ReadOnly/WorkspaceWrite/DangerFullAccess)
```

### 5.2 执行策略引擎

```rust
enum ExecApprovalRequirement {
    Skip,           // 直接执行
    NeedsApproval,  // 需要用户审批
    Forbidden,      // 禁止执行
}
```

**检查逻辑**：
1. **Deny 优先**：先检查 denied_prefixes，匹配即 `Forbidden`
2. **Trust 匹配**：使用 BashArityDict 进行 arity-aware 前缀匹配
3. **审批策略判断**：根据 AskForApproval 模式决定

### 5.3 Bash Arity 字典

覆盖 30+ 常用工具的命令前缀分类：

| 工具 | 子命令数 |
|------|---------|
| git | 39 |
| npm | 20 |
| cargo | 18 |
| docker | 20 |
| kubectl | 15 |
| go/python/pip | - |
| gh (GitHub CLI) | - |

**Arity 语义**：`("git status", 2)` 表示 2 个位置词（git + status），flag（`-` 开头）不计入 arity。

**匹配效果**：
- `git status` 匹配 `git status -s` 和 `git status --porcelain`
- `git status` 不匹配 `git push`

### 5.4 沙箱策略

| 模式 | 策略 | 说明 |
|------|------|------|
| Plan | `ReadOnly` | 禁止写入和网络 |
| Agent | `WorkspaceWrite` | 工作区可写、网络开启 |
| YOLO | `DangerFullAccess` | 完全无限制 |

### 5.5 钩子系统

三种事件接收器：

| Sink | 用途 |
|------|------|
| `StdoutHookSink` | 输出到标准输出（调试） |
| `JsonlHookSink` | 追加到 JSONL 文件 |
| `WebhookHookSink` | HTTP POST（含 3 次重试） |

**特性**：单个 sink 失败不影响其他 sink。

---

## 六、工具名称编解码

由于 API 对工具名称有字符限制，项目实现了双向编解码：

```rust
// 编码：将特殊字符编码为 -x{HEX}- 形式
fn to_api_tool_name(name: &str) -> String

// 解码：回原始名称
fn from_api_tool_name(encoded: &str) -> String

// 处理模型可能产生的变体编码
fn decode_bare_hex_escapes(s: &str) -> String
```
