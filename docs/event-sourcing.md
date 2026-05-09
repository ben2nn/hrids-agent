# Event Sourcing 设计文档

本文档描述 hrids-agent 的事件溯源对话存储架构，以及多智能体场景下的扩展预留设计。

## 架构概览

```text
eventLog (append-only, events.jsonl)
    │
    ├── projectForDisplay() ──► DisplayMessage[]   (前端气泡 + 工具卡片)
    │
    └── projectForLLM()     ──► ChatMessage[]      (LLM API 输入，含 prune/budget 优化)
```

核心原则：

- 事件是不可变的，只追加不修改。
- 所有优化（prune、budget、compact）在投影层处理，不修改原始事件。
- 不同消费者（前端、LLM、归档）从同一事件日志投影出各自需要的视图。

## 事件类型

定义在 `src/core/ConversationStore.ts`。

### UserMessageEvent

```ts
interface UserMessageEvent {
  type: 'user_message'
  id: string              // "user-{timestamp}-{seq}"
  timestamp: number
  requestId?: string      // 归组同一次请求
  trigger?: 'user' | 'cron'
  cronDescription?: string
  content: string         // 原始文本（含 @filename，不含 base64）
  images?: string[]       // 关联的图片路径列表
}
```

### AssistantMessageEvent

```ts
interface AssistantMessageEvent {
  type: 'assistant_message'
  id: string              // "asst-{timestamp}-{seq}"
  timestamp: number
  requestId?: string
  text: string            // 助手文本回复
  toolCalls?: ToolCallEvent[]
}

interface ToolCallEvent {
  id: string              // tool_use id，与 ToolResultEvent.toolCallId 对应
  name: string            // 工具名称
  input: unknown          // 工具输入参数
}
```

### ToolResultEvent

```ts
interface ToolResultEvent {
  type: 'tool_result'
  id: string              // "tres-{timestamp}-{seq}"
  timestamp: number
  requestId?: string
  toolCallId: string      // 对应的 tool_use id
  toolName: string
  content: string         // 工具输出内容
  isError: boolean
}
```

### CompactEvent

```ts
interface CompactEvent {
  type: 'compact'
  id: string              // "comp-{timestamp}-{seq}"
  timestamp: number
  requestId?: string
  summary: string         // 压缩摘要文本
}
```

### 联合类型

```ts
type ConversationEvent =
  | UserMessageEvent
  | AssistantMessageEvent
  | ToolResultEvent
  | CompactEvent
```

## 存储格式

每个会话的事件以 JSONL 格式存储在 `~/.hrids/sessions/<sessionId>/events.jsonl`，每行一个 JSON 对象。

### 完整对话示例

以下是一次典型的多轮工具调用对话的事件序列：

```jsonl
{"type":"user_message","id":"user-1778241325720-1","timestamp":1778241325720,"requestId":"req-1778241325497-tcsyozz","trigger":"user","content":"检查文件夹中的文档 @.cache/report.docx"}
{"type":"assistant_message","id":"asst-1778241331412-2","timestamp":1778241331412,"requestId":"req-1778241325497-tcsyozz","text":"","toolCalls":[{"id":"call_bad68c48aba840d8a7a7ad9d","name":"glob","input":{"pattern":".cache/report.docx"}}]}
{"type":"tool_result","id":"tres-1778241331430-3","timestamp":1778241331430,"requestId":"req-1778241325497-tcsyozz","toolCallId":"call_bad68c48aba840d8a7a7ad9d","toolName":"glob","content":".cache\\report.docx","isError":false}
{"type":"assistant_message","id":"asst-1778241334550-4","timestamp":1778241334550,"requestId":"req-1778241325497-tcsyozz","text":"","toolCalls":[{"id":"call_42503bb3bdd94777b053cfe5","name":"bash","input":{"command":"python -c \"import docx; print('ok')\" 2>&1"}}]}
{"type":"tool_result","id":"tres-1778241335084-5","timestamp":1778241335084,"requestId":"req-1778241325497-tcsyozz","toolCallId":"call_42503bb3bdd94777b053cfe5","toolName":"bash","content":"python-docx is available\r\n","isError":false}
{"type":"assistant_message","id":"asst-1778241364159-6","timestamp":1778241364159,"requestId":"req-1778241325497-tcsyozz","text":"我来分析这个文档。","toolCalls":[{"id":"call_a4213b5106514d19a0d40a3c","name":"todo_write","input":{"todos":[{"content":"提取文档内容","priority":"high"}]}}]}
{"type":"tool_result","id":"tres-1778241364200-7","timestamp":1778241364200,"requestId":"req-1778241325497-tcsyozz","toolCallId":"call_a4213b5106514d19a0d40a3c","toolName":"todo_write","content":"已创建 1 个任务","isError":false}
{"type":"assistant_message","id":"asst-1778241400000-8","timestamp":1778241400000,"requestId":"req-1778241325497-tcsyozz","text":"文档分析完成，发现以下问题..."}
```

关键观察：

- **tool_call ↔ tool_result 关联**：通过 `toolCallId` 字段关联。`assistant_message.toolCalls[].id` 与后续 `tool_result.toolCallId` 一一对应。
- **多工具串行**：LLM 可在一个 `assistant_message` 中返回多个 `toolCalls`，引擎逐个执行并生成对应的 `tool_result` 事件。
- **混合内容**：`assistant_message` 可同时包含 `text` 和 `toolCalls`（如上面的 todo_write 例子）。
- **空文本**：当 LLM 只调用工具不输出文本时，`text` 为空字符串 `""`。

### 系统注入事件

除了用户和 LLM 产生的事件外，系统也会注入事件：

**错误恢复注入**（`QueryEngine`）—— LLM 请求失败或达到轮次限制时，以 `user_message` 注入系统提示：

```jsonl
{"type":"user_message","id":"user-...","timestamp":...,"requestId":"req-...","trigger":"user","content":"[系统提示] 上次执行因错误中断: Connection timeout。请从中断处继续完成任务。"}
{"type":"user_message","id":"user-...","timestamp":...,"requestId":"req-...","trigger":"user","content":"[系统提示] 任务因达到最大轮次限制（20 轮）而中断，尚未完成。请继续执行剩余工作。"}
{"type":"user_message","id":"user-...","timestamp":...,"requestId":"req-...","trigger":"user","content":"[系统提示] 任务被用户中止。如需继续，请发送指令。"}
```

**定时任务注入**（`SessionManager`）—— cron 触发时以 `assistant_message` 注入：

```jsonl
{"type":"assistant_message","id":"asst-...","timestamp":...,"requestId":"req-...","text":"[定时任务触发: 每日站会提醒]\n请总结昨天的工作进展..."}
```

**视觉模型注入**（`SessionManager`）—— 图片识别结果以 `user_message` + `assistant_message` 对注入：

```jsonl
{"type":"user_message","id":"user-...","timestamp":...,"requestId":"req-...","content":"[图片内容: screenshot.png] 用户上传的截图"}
{"type":"assistant_message","id":"asst-...","timestamp":...,"requestId":"req-...","text":"截图显示了一个登录页面，包含用户名和密码输入框..."}
```

### 常见工具名称

实际会话中出现的 `toolName` 值：

| 工具名 | 用途 |
| --- | --- |
| `bash` | 执行 shell 命令 |
| `file_read` | 读取文件内容 |
| `file_edit` | 编辑文件 |
| `file_write` | 写入文件 |
| `glob` | 文件模式匹配 |
| `grep` | 内容搜索 |
| `todo_write` | 创建任务列表 |
| `todo_update` | 更新任务状态 |
| `todo_read` | 读取任务列表 |
| `agent` | 调用子智能体 |
| `web_search` | 网络搜索 |
| `web_fetch` | 抓取网页内容 |
| `mcp_*` | MCP 工具（动态名称） |

### 会话目录结构

```text
~/.hrids/sessions/
  <sessionId>/
    events.jsonl          # 事件日志（append-only）
    meta.json             # 会话元数据
    archives.json         # 归档段元数据（compact 时生成）
```

### SessionMeta

```ts
interface SessionMeta {
  id: string
  createdAt: string
  updatedAt: string
  messageCount: number
  model: string
  title: string
  lastUserMessage?: string
  workDir?: string
  savedMessageCount?: number
  agent?: string          // 所属智能体名称，如 'main'
}
```

## 投影层

定义在 `src/core/projections.ts`。

### projectForDisplay

将事件日志投影为前端可渲染的 `DisplayMessage[]`：

```ts
interface DisplayMessage {
  role: 'user' | 'assistant'
  content: string
  images?: string[]
  isCron?: boolean
  cronDescription?: string
  requestId?: string
  timestamp: number
  toolCards?: DisplayToolCard[]
}
```

规则：

- `user_message` → `role: 'user'` 气泡（包括 `[系统提示]` 注入的消息，前端可按前缀过滤）
- `assistant_message` → `role: 'assistant'` 气泡，附带 `toolCards`
- `tool_result` → 合并到对应 `assistant_message` 的 `toolCards` 中（通过 `toolCallId` 匹配）
- `compact` → 展示为 `[上下文压缩]` 分隔气泡对（user + assistant 固定回复）

### projectForLLM

将事件日志投影为 LLM API 输入的 `ChatMessage[]`：

```ts
type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ContentBlock[] }
  | { role: 'assistant'; content: string; tool_use?: ToolUseBlock[] }
  | { role: 'user'; content: ToolResultBlock[] }  // tool_result 按 API 规范归为 user
```

规则：

- 只投影最后一个 `compact` 事件之后的事件（避免压缩摘要与原文重复）
- 若存在 `compact` 事件，先注入 `[上下文压缩]` 摘要作为 user + assistant 消息对
- `user_message` → `role: user` 消息；最新一条使用预处理版本（含 image block，用于图片/PDF 上传）
- `assistant_message` → `role: assistant` 消息，`text` 转为 text block，`toolCalls` 转为 tool_use block
- `tool_result` 按 Anthropic API 规范包装为 `role: user` 消息（content 为 `tool_result` block 数组）
- 被 prune 的 toolCallId 对应的 `tool_use` block 会被跳过
- 应用 prune/budget 优化：裁剪过大的 tool_result、移除过旧的图片 block

### 优化函数

| 函数 | 作用 |
| --- | --- |
| `pruneOldToolResults()` | 裁剪超过 `MAX_TOOL_RESULT_CHARS` 的工具输出 |
| `applyToolResultBudget()` | 总 tool_result 字符数不超过 `TOTAL_RESULT_BUDGET` |
| `pruneOldImageBlocks()` | 移除较旧的 base64 图片 block，保留最新的 |
| `estimateEventTokens()` | 估算事件日志的 token 数，只计算 `compact` 之后的事件 |

## 多智能体架构

### 当前设计：会话级隔离

多智能体通过**独立会话**实现隔离，事件格式中不包含智能体标识：

```text
主会话 (sessionId: "1778233069240-abc123")
  events.jsonl → 主智能体的完整对话
  │
  ├─ AgentTool 调用
  │    └─ 子会话 (sessionId: "ephemeral-sub-1778233070000-x7k9m")
  │         events.jsonl → 子智能体的内部对话（独立存储）
  │         结果作为 tool_result 写回主会话
  │
  └─ AgentPool 协调
       └─ 多个子会话 (sessionId: "ephemeral-{taskId}")
            各自独立的 events.jsonl
            结果通过 MessageBus 汇总
```

| 维度 | 主智能体 | 子智能体 (AgentTool) | 子智能体 (AgentPool) |
| --- | --- | --- | --- |
| sessionId | 正常 ID | `ephemeral-{profile}-{ts}-{rand}` | `ephemeral-{taskId}` |
| events.jsonl | 主会话目录 | 独立临时目录 | 独立临时目录 |
| 生命周期 | 持久 | 任务完成即弃 | 任务完成即弃 |
| 结果传递 | — | tool_result | MessageBus |
| 清理策略 | 手动/过期 | 启动时自动清理 | 启动时自动清理 |

### 扩展预留：agentId 字段

当需要在同一事件日志中区分多个智能体的贡献时（如共享上下文的协作模式），可在事件中增加可选的 `agentId` 字段：

```ts
interface UserMessageEvent {
  // ... 现有字段 ...
  agentId?: string        // 'main' | 'researcher' | 'coder' | 自定义名称
}

interface AssistantMessageEvent {
  // ... 现有字段 ...
  agentId?: string
}

interface ToolResultEvent {
  // ... 现有字段 ...
  agentId?: string
}
```

#### 使用场景

**场景 1：主会话内嵌套子智能体事件**

当前子智能体的内部过程对主会话完全透明（只看到 tool_result）。如果需要在主会话中展示子智能体的执行过程：

```jsonl
{"type":"user_message","id":"user-1","content":"帮我分析这个项目","agentId":"main"}
{"type":"assistant_message","id":"asst-1","text":"我来调用研究智能体","agentId":"main","toolCalls":[{"id":"tc-1","name":"agent","input":{"profile":"researcher"}}]}
{"type":"assistant_message","id":"asst-2","text":"正在分析项目结构...","agentId":"researcher"}
{"type":"tool_result","id":"tres-1","toolCallId":"tc-1","toolName":"agent","content":"分析结果...","agentId":"researcher"}
{"type":"assistant_message","id":"asst-3","text":"分析完成，总结如下...","agentId":"main"}
```

**场景 2：协作模式（多个智能体共享同一会话）**

多个智能体在同一个会话中协作，各自负责不同任务：

```jsonl
{"type":"user_message","id":"user-1","content":"开发一个 REST API","agentId":"main"}
{"type":"assistant_message","id":"asst-1","text":"我来拆分任务","agentId":"main"}
{"type":"assistant_message","id":"asst-2","text":"正在编写路由代码","agentId":"coder"}
{"type":"assistant_message","id":"asst-3","text":"正在编写测试用例","agentId":"tester"}
```

#### 投影层适配

`projectForDisplay()` 按 `agentId` 分组展示：

```ts
// 可选：按智能体分组
function groupByAgent(messages: DisplayMessage[]): Map<string, DisplayMessage[]>
```

`projectForLLM()` 可选择性过滤或合并：

```ts
// 可选：只投影特定智能体的事件
function projectForLLM(events: ConversationEvent[], filterAgent?: string): ChatMessage[]
```

#### 迁移策略

`agentId` 为可选字段，无该字段的事件默认归属 `'main'`。新旧格式完全兼容，无需数据迁移：

```ts
const agentId = event.agentId ?? 'main'
```

### 扩展预留：跨智能体事件引用

当需要在事件之间建立跨智能体引用关系时（如子智能体的 tool_result 关联到主智能体的 tool_call），可增加 `parentRequestId` 字段：

```ts
interface AssistantMessageEvent {
  // ... 现有字段 ...
  parentRequestId?: string  // 引用父智能体的 requestId
}
```

这允许投影层重建完整的调用链：

```text
主智能体 requestId: req-1
  └─ 子智能体 parentRequestId: req-1
       ├─ tool_start → tool_end
       └─ 最终结果 → tool_result (写回主智能体)
```

## Gateway API 映射

事件到 REST API 的转换链：

```text
events.jsonl
  → loadSessionEvents()               // 加载原始事件
  → projectForDisplay()               // 投影为 ConversationStore.DisplayMessage
  → convertToServerDisplayMessages()  // 转为 Gateway API DisplayMessage
  → REST /sessions/:id/messages       // 返回给前端
```

Gateway API 的 `DisplayMessage` 类型定义在 `docs/gateway.md`，与内部投影类型不同：

| 内部 (ConversationStore) | API (Gateway) | 差异 |
| --- | --- | --- |
| `role: 'user'` | `type: 'user'` | 字段名不同 |
| `role: 'assistant'` + `toolCards[]` | `type: 'assistant'` + `type: 'tool'` | 工具卡片拆分为独立消息 |
| — | `type: 'system'` / `type: 'error'` | API 独有类型 |
| — | `type: 'compact'` | API 独有，用于前端展示压缩段 |

## 改进计划

当前设计存在 JSONL 读取容错、schema 版本、系统事件混用等问题。详见 [event-sourcing-v2.md](event-sourcing-v2.md)。

## 参考文件

| 文件 | 职责 |
| --- | --- |
| `src/core/ConversationStore.ts` | 事件类型定义、存储类、JSONL 读写 |
| `src/core/projections.ts` | 投影函数、优化函数、token 估算 |
| `src/core/QueryEngine.ts` | 引擎主循环，使用 store + projections |
| `src/core/SessionStore.ts` | 会话元数据、归档管理 |
| `src/gateway/server.ts` | REST API，事件到 DisplayMessage 转换 |
| `src/gateway/SessionManager.ts` | 会话生命周期，事件注入 |
| `src/tools/AgentTool.ts` | 子智能体工具，ephemeral 会话 |
| `src/core/coordinator/AgentPool.ts` | 多智能体协调，任务池 |
