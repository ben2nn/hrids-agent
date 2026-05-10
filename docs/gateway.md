# Gateway 文档

Gateway 是 hrids-agent 的 HTTP + WebSocket 服务模式，用于承载 Web UI、远程会话控制、文件管理、定时任务、MCP、Skill 和 IM 平台接入。它把本地 Agent 能力包装成一个长期运行的服务：REST 负责管理和读取状态，WebSocket 负责实时对话流和交互控制。

## 启动方式

```bash
npm run gateway
```

默认地址：

- Web UI: `http://127.0.0.1:3282`
- REST API: `http://127.0.0.1:3282`
- WebSocket: `ws://127.0.0.1:3282/sessions/:id/stream`

常用命令行参数：

| 参数 | 说明 | 默认值 |
| --- | --- | --- |
| `--gateway` | 启动 Gateway 模式 | - |
| `--gateway-host` | HTTP/WS 监听地址 | `127.0.0.1` |
| `--gateway-port` | HTTP/WS 监听端口 | `3282` |
| `--gateway-token` | 静态 Bearer Token | 未启用 |

Gateway 启动后会同时恢复定时任务，并启动已启用的 IM 平台适配器。

## 配置

Gateway 配置来自命令行参数和全局配置。会话创建时还会读取 `config.yaml` 中的模型、权限、MCP、预算和上下文相关配置。

### 鉴权模式

| 模式 | 启用条件 | 行为 |
| --- | --- | --- |
| 无鉴权 | 未配置 `users` 和 `authToken` | API 和 WS 直接放行，适合本地开发 |
| 静态 Token | 配置 `authToken` | REST 使用 `Authorization: Bearer <token>`，WS 使用 `?token=<token>` 或 `Sec-WebSocket-Protocol` |
| 登录/JWT | 配置 `users` 且未配置静态 Token | `POST /api/login` 校验用户名密码后签发 7 天有效 JWT |
| 登录后返回静态 Token | 同时配置 `users` 和 `authToken` | 登录成功后返回静态 Token |

`/health` 和 `/api/login` 不需要鉴权。前端静态资源也不需要鉴权，API、会话、配置、MCP、Skill、Cron、IM 等路径会受鉴权保护。

### 会话参数

创建会话时可传入：

```json
{
  "model": "qwen-plus",
  "provider": "aliyun",
  "apiKey": "sk-...",
  "baseUrl": "https://...",
  "permissionMode": "ask",
  "cwd": "D:/workspace/project",
  "resume": "session-id",
  "title": "项目会话"
}
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `model` / `provider` / `apiKey` / `baseUrl` | 显式指定本会话使用的模型连接信息 |
| `permissionMode` | `ask`、`craft`、`plan`，优先级高于旧的 `autoMode` |
| `cwd` | 会话工作目录 |
| `resume` | 恢复已有会话 ID |
| `title` | 会话标题 |

未显式指定模型时，Gateway 使用全局 LLM fallback 配置创建 provider。

## 当前架构

```text
Web UI / Remote Client
        |
        | REST: 状态、历史、文件、配置、任务管理
        | WS: 对话流、工具流、权限/决策交互
        v
src/gateway/server.ts
        |
        v
src/gateway/SessionManager.ts
        |
        v
QueryEngine + ConversationStore + Tool/MCP/Memory/Permission
        |
        v
~/.hrids-agent/sessions/<sessionId>/events.jsonl
```

核心职责：

| 模块 | 职责 |
| --- | --- |
| `src/modes/gatewayMode.ts` | 创建 Gateway、注册定时任务回调、处理进程信号和优雅关闭 |
| `src/gateway/server.ts` | Express REST API、WebSocket 服务、鉴权、静态 Web UI、文件/配置/Skill/MCP/IM 端点 |
| `src/gateway/SessionManager.ts` | 会话生命周期、QueryEngine 运行、WebSocket 广播、权限询问、断线回放、空闲回收 |
| `src/core/ConversationStore.ts` | 会话事件存储和读取 |
| `src/core/projections.ts` | 将事件投影为前端显示消息和 LLM 输入消息 |
| `web/src/lib/gateway.ts` | 前端 REST 客户端 |
| `web/src/lib/wsClient.ts` | 前端 WebSocket 客户端、重连和发送队列 |

## 会话模型

每个 Gateway 会话包含：

- `SessionInfo`: 会话 ID、状态、模型、工作目录、标题、权限模式和活跃时间。
- `QueryEngine`: 执行 LLM 调用、工具调用、上下文构建和流式事件输出。
- `ConversationStore`: 以事件日志保存会话上下文。
- `PermissionManager`: 管理 ask/craft/plan 权限策略。
- WebSocket 订阅者集合。
- 运行中事件回放缓冲区。
- 待处理权限请求集合。

会话状态：

| 状态 | 含义 |
| --- | --- |
| `ready` | 可接收新消息 |
| `busy` | 正在执行一次用户请求或定时任务 |
| `stopped` | 磁盘历史会话，不在内存中运行 |

会话默认空闲 30 分钟后释放。释放时会中止执行、拒绝未完成权限请求、断开订阅、释放 MCP、Team、Memory 等资源。

## 数据持久化

当前会话以 append-only 事件日志为主：

```text
~/.hrids-agent/
  sessions/
    <sessionId>/
      events.jsonl
      meta.json
      archives/
```

运行时写入和读取原则：

- 新消息和工具事件追加到 `events.jsonl`。
- REST 历史消息通过 `projectForDisplay(events)` 投影为前端可渲染格式。
- LLM 请求通过 `projectForLLM(events)` 投影为模型输入。
- 压缩不会删除原始事件，而是写入压缩/归档相关事件和归档文件。
- Gateway 内存会话优先返回最新的 `engine.getDisplayMessages()`；非活跃会话从磁盘事件加载并投影。

## 消息结构定义

本节定义 Gateway 对外暴露的主要消息结构。REST 接口主要返回资源对象和 `DisplayMessage[]`；WebSocket 使用 `ClientMessage` 和 `ServerMessage` 做实时双向通信。

### 通用结构

```ts
type PermissionMode = 'ask' | 'craft' | 'plan'

interface SessionInfo {
  id: string
  status: 'ready' | 'busy' | 'stopped'
  model?: string
  cwd?: string
  createdAt: number
  title?: string
  lastUserMessage?: string
  permissionMode?: PermissionMode
}

interface CreateSessionRequest {
  model?: string
  provider?: string
  apiKey?: string
  baseUrl?: string
  cwd?: string
  autoMode?: boolean
  permissionMode?: PermissionMode
  resume?: string
  title?: string
}

interface CostInfo {
  inputTokens: number
  outputTokens: number
  cost: number
  model: string
}
```

### REST 历史消息

`GET /sessions/:id/messages` 返回 `DisplayMessage[]`。这是前端消息列表的渲染结构，不是 LLM 原始上下文。

```ts
type DisplayMessage =
  | {
      id: string
      type: 'user'
      content: string
      timestamp: number
      images?: string[]
    }
  | {
      id: string
      type: 'request_start'
      requestId: string
      trigger: 'user' | 'cron'
      description?: string
      timestamp: number
    }
  | {
      id: string
      type: 'cron_trigger'
      requestId: string
      description: string
      timestamp: number
    }
  | {
      id: string
      type: 'assistant'
      requestId: string
      content: string
      timestamp: number
      usage?: CostInfo
      isCron?: boolean
      cronDescription?: string
    }
  | {
      id: string
      type: 'tool'
      requestId: string
      toolId: string
      toolName: string
      timestamp: number
      toolInput?: unknown
      toolStatus?: 'success' | 'error'
      toolResult?: unknown
      isCron?: boolean
    }
  | {
      id: string
      type: 'system'
      content: string
      timestamp: number
    }
  | {
      id: string
      type: 'error'
      requestId?: string
      content: string
      timestamp: number
    }
  | {
      id: string
      type: 'compact'
      archivedAt: string
      messageCount: number
      summary: string
      expanded?: boolean
      filename?: string
      timestamp: number
    }
```

工具消息在历史接口里已经从事件投影成独立卡片。运行中的工具状态则通过 WebSocket 的 `tool_start`、`tool_log`、`tool_end` 增量更新。

### WebSocket 客户端消息

客户端发送给 Gateway 的消息结构：

```ts
interface MessageAttachment {
  name: string
  data: string
  mediaType: string
}

type ClientMessage =
  | {
      type: 'message'
      content: string
      attachments?: MessageAttachment[]
    }
  | {
      type: 'resume'
      content?: string
    }
  | {
      type: 'abort'
    }
  | {
      type: 'user_reply'
      answer: string
    }
  | {
      type: 'decision_reply'
      answer: string
    }
  | {
      type: 'todo_reset_reply'
      answer: string
    }
  | {
      type: 'permission_reply'
      key: string
      granted: boolean
      permanent?: boolean
      session?: boolean
      ruleContent?: string
    }
  | {
      type: 'set_cwd'
      cwd: string
    }
  | {
      type: 'set_permission_mode'
      mode: PermissionMode
    }
  | {
      type: 'clear_history'
    }
```

附件说明：

| 字段 | 说明 |
| --- | --- |
| `name` | 原始文件名 |
| `data` | 文件内容的 base64 字符串 |
| `mediaType` | MIME 类型，例如 `image/png`、`image/jpeg`、`application/pdf` |

### WebSocket 服务端消息

Gateway 推送给客户端的实时消息结构：

```ts
type ServerMessage =
  | {
      type: 'ready'
      requestId?: string
      sessionId: string
      timestamp: number
    }
  | {
      type: 'request_start'
      requestId: string
      trigger: 'user' | 'cron'
      description?: string
      timestamp: number
    }
  | {
      type: 'cron_trigger'
      requestId: string
      description: string
      timestamp: number
    }
  | {
      type: 'text_delta'
      requestId: string
      delta: string
      timestamp: number
    }
  | {
      type: 'tool_start'
      requestId: string
      toolId: string
      toolName: string
      input: unknown
      timestamp: number
    }
  | {
      type: 'tool_log'
      requestId: string
      toolId: string
      log: string
      timestamp: number
    }
  | {
      type: 'tool_end'
      requestId: string
      toolId: string
      toolName?: string
      status: 'success' | 'error' | 'denied'
      result?: unknown
      timestamp: number
    }
  | {
      type: 'todos_updated'
      requestId?: string
      todos: Todo[]
      timestamp: number
    }
  | {
      type: 'permission_request'
      requestId?: string
      key: string
      toolName: string
      description: string
      readonly: boolean
      isDestructive?: boolean
      ruleContent?: string
      timestamp: number
    }
  | {
      type: 'ask_user'
      requestId?: string
      question: string
      options?: string[]
      timestamp: number
    }
  | {
      type: 'decision_request'
      requestId?: string
      title: string
      context: string
      options: Array<{
        label: string
        description: string
        risk?: 'low' | 'medium' | 'high'
      }>
      recommendation?: string
      deadline?: string
      impact?: string
      timestamp: number
    }
  | {
      type: 'usage'
      requestId: string
      inputTokens: number
      outputTokens: number
      cost: number
      model: string
      timestamp: number
    }
  | {
      type: 'cwd_changed'
      requestId?: string
      cwd: string
      timestamp: number
    }
  | {
      type: 'permission_mode_changed'
      requestId?: string
      mode: PermissionMode
      timestamp: number
    }
  | {
      type: 'continuation_needed'
      requestId: string
      timestamp: number
    }
  | {
      type: 'compact_done'
      requestId?: string
      summary: string
      timestamp: number
    }
  | {
      type: 'model_switched'
      requestId?: string
      model: string
      reason: string
      timestamp: number
    }
  | {
      type: 'done'
      requestId: string
      timestamp: number
    }
  | {
      type: 'error'
      requestId?: string
      message: string
      timestamp: number
    }
  | {
      type: 'budget_exceeded'
      requestId?: string
      message: string
      timestamp: number
    }
  | {
      type: 'history_cleared'
      requestId?: string
      timestamp: number
    }
  | {
      type: 'im_user_message'
      requestId?: string
      text: string
      images?: string[]
      platform: string
      timestamp: number
    }
```

`requestId` 用于把同一次请求内的 `text_delta`、工具事件、用量和完成事件归组。`timestamp` 由服务端广播时统一追加。

### 任务、文件和归档结构

```ts
interface Todo {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  priority: 'high' | 'medium' | 'low'
  acceptance?: string[]
  dependsOn?: string[]
  context?: string
  createdAt: number
}

interface FileEntry {
  name: string
  type: 'file' | 'dir'
  size?: number
  mtime?: number
}

interface FileListResponse {
  cwd: string
  path: string
  entries: FileEntry[]
}

interface UploadedFile {
  name: string
  path: string
  size: number
  isImage?: boolean
}

interface UploadResponse {
  files: UploadedFile[]
}

interface CronJob {
  id: string
  expression: string
  description: string
  task: string
  createdAt: number
  lastRunAt?: number
  nextRunAt?: number
  enabled: boolean
  once?: boolean
  startDate?: string
  endDate?: string
}

interface CompactArchive {
  filename: string
  archivedAt: string
  messageCount: number
  summary: string
}
```

## REST API

### 基础接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/login` | 登录，返回 token |
| `GET` | `/health` | 健康检查、鉴权模式、会话和内存状态 |
| `GET` | `/api/logs` | 读取最近日志 |
| `GET` | `/api/usage` | 从日志聚合模型用量 |
| `GET` | `/api/config-file` | 读取原始 `config.yaml` |
| `PUT` | `/api/config-file` | 保存并校验 `config.yaml` |

### 会话接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/sessions` | 当前内存会话列表 |
| `GET` | `/sessions/history` | 内存会话 + 磁盘历史会话 |
| `POST` | `/sessions` | 创建或恢复会话 |
| `GET` | `/sessions/:id` | 查询单个内存会话状态 |
| `DELETE` | `/sessions/:id` | 销毁会话并删除磁盘数据 |
| `GET` | `/sessions/:id/messages` | 读取前端显示消息 |
| `GET` | `/sessions/:id/history-segments` | 读取压缩归档段 |
| `GET` | `/sessions/:id/history-segments/:filename/messages` | 读取归档段消息 |

### 会话文件接口

所有路径都以会话 `cwd` 为根目录，禁止访问 `cwd` 外部路径。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/sessions/:id/files?path=` | 列出目录 |
| `GET` | `/sessions/:id/file-content?path=` | 读取文本文件 |
| `PUT` | `/sessions/:id/file-content` | 写入文本文件 |
| `GET` | `/sessions/:id/file-preview?path=` | 预览 Word/Excel |
| `GET` | `/sessions/:id/git-file?path=` | 读取 git HEAD 中的文件内容 |
| `POST` | `/sessions/:id/upload` | 上传文件到会话工作目录 |
| `GET` | `/sessions/:id/image?path=` | 读取图片二进制 |

上传请求格式：

```json
{
  "files": [
    { "name": "image.png", "data": "base64..." }
  ]
}
```

### 配置和任务接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/config` | 读取模型、权限、token 限制等摘要配置 |
| `PUT` | `/config` | 更新模型或权限模式 |
| `GET` | `/config/models` | 读取可用模型列表 |
| `GET` | `/config/zhile-session` | 读取知了专属会话 ID |
| `PUT` | `/config/zhile-session` | 保存知了专属会话 ID |
| `GET` | `/todos` | 聚合活跃会话任务 |
| `GET` | `/sessions/:id/todos` | 读取单会话任务 |

### Cron 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/crons` | 列出定时任务 |
| `POST` | `/crons` | 创建定时任务 |
| `PUT` | `/crons/:id/toggle` | 启用或禁用任务 |
| `DELETE` | `/crons/:id` | 删除任务 |

Cron 触发时会优先路由到任务绑定的 `sessionId`。如果任务没有归属会话，会降级使用知了专属会话配置。

### MCP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/mcp` | 读取 MCP 配置 |
| `PUT` | `/mcp` | 覆盖保存 MCP 配置 |
| `POST` | `/mcp/:name` | 添加或更新单个 MCP server |
| `DELETE` | `/mcp/:name` | 删除单个 MCP server |
| `GET` | `/mcp/config-path` | 返回 MCP 配置文件路径 |

### Skill 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/skills` | 读取已安装技能 |
| `PUT` | `/skills/:name/toggle` | 启用或禁用技能 |
| `GET` | `/skills/market/search` | 搜索 SkillHub 市场 |
| `POST` | `/skills/market/install` | 安装市场技能 |
| `DELETE` | `/skills/market/uninstall/:slug` | 卸载市场技能 |

### IM 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/im/platforms` | 读取脱敏后的平台配置和状态 |
| `GET` | `/im/platforms/config` | 读取完整 IM 配置 |
| `PUT` | `/im/platforms/config` | 覆盖保存 IM 配置 |
| `POST` | `/im/platforms/:platform` | 添加或更新平台配置 |
| `DELETE` | `/im/platforms/:platform` | 删除平台配置 |
| `POST` | `/im/platforms/:platform/restart` | 重启平台适配器 |
| `GET` | `/im/status` | 获取平台运行状态 |
| `POST` | `/im/platforms/weixin/login` | 发起微信扫码登录 |
| `GET` | `/im/platforms/weixin/login/status` | 轮询微信扫码状态 |

## WebSocket 协议

连接地址：

```text
ws://<host>:<port>/sessions/<sessionId>/stream?token=<token>
```

连接流程：

1. 客户端先通过 REST 创建或恢复会话。
2. 客户端连接 `/sessions/:id/stream`。
3. 服务端校验路径、token 和会话是否存在。
4. 服务端发送 `ready`。
5. 客户端发送 `message`、`abort`、权限回复等控制消息。
6. 服务端广播流式响应、工具状态、权限请求、用量和完成事件。

断线重连：

- 前端使用指数退避重连：1s、2s、4s、8s、16s。
- 断线期间发送的客户端消息会进入本地队列，连接恢复后按顺序发送。
- 服务端只在会话 `busy` 时回放最近事件缓冲；空闲会话历史通过 REST `/messages` 加载。

### ClientMessage

| 类型 | 字段 | 说明 |
| --- | --- | --- |
| `message` | `content`, `attachments?` | 发送用户消息，可携带图片/PDF base64 附件 |
| `resume` | `content?` | 要求继续中断前的任务 |
| `abort` | - | 中止当前执行 |
| `user_reply` | `answer` | 回复 `ask_user` |
| `decision_reply` | `answer` | 回复 `decision_request` |
| `todo_reset_reply` | `answer` | 回复 todo reset 决策 |
| `permission_reply` | `key`, `granted`, `session?`, `permanent?`, `ruleContent?` | 回复权限请求 |
| `set_cwd` | `cwd` | 修改当前会话工作目录 |
| `set_permission_mode` | `mode` | 修改当前会话权限模式 |
| `clear_history` | - | 清空当前会话历史 |

附件格式：

```json
{
  "type": "message",
  "content": "分析这个文件",
  "attachments": [
    {
      "name": "report.pdf",
      "data": "base64...",
      "mediaType": "application/pdf"
    }
  ]
}
```

### ServerMessage

| 类型 | 说明 |
| --- | --- |
| `ready` | WebSocket 已连接 |
| `request_start` | 一次用户请求或 cron 请求开始 |
| `cron_trigger` | 定时任务触发标记 |
| `text_delta` | Assistant 文本增量 |
| `tool_start` | 工具开始执行 |
| `tool_log` | 工具运行日志 |
| `tool_end` | 工具结束，状态为 `success`、`error` 或 `denied` |
| `todos_updated` | 当前会话任务列表更新 |
| `permission_request` | ask 模式下请求用户授权 |
| `ask_user` | Agent 主动向用户提问 |
| `decision_request` | Agent 请求用户做结构化决策 |
| `usage` | 本次模型 token 和费用 |
| `cwd_changed` | 会话工作目录已改变 |
| `permission_mode_changed` | 权限模式已改变 |
| `continuation_needed` | Agent 请求继续执行 |
| `compact_done` | 会话压缩完成 |
| `model_switched` | 模型切换通知 |
| `done` | 本次请求完成 |
| `error` | 错误或中断 |
| `budget_exceeded` | 预算超限 |
| `history_cleared` | 历史已清空 |
| `im_user_message` | IM 平台收到用户消息并同步到 Web UI |

除初始 `ready` 外，服务端广播消息会附加 `timestamp`。多数请求相关事件还会携带 `requestId`，前端用它把文本、工具卡片和完成事件归到同一次请求。

## 运行流程

### 用户消息

```text
Web UI
  -> POST /sessions 创建或恢复会话
  -> WS /sessions/:id/stream 建立实时通道
  -> ClientMessage: message
  -> SessionManager.runMessage()
  -> QueryEngine.send()
  -> StreamEvent
  -> toClientMessage()
  -> ServerMessage 广播
  -> ConversationStore 持久化事件
```

执行中会在工具结束和请求完成时增量保存，降低进程崩溃导致的数据丢失。

### 权限请求

ask 模式下，写操作或敏感操作会触发：

```text
PermissionManager
  -> permission_request 广播
  -> 前端展示授权 UI
  -> permission_reply
  -> 继续或拒绝工具执行
```

`permission_reply` 支持：

- `granted: false`: 拒绝本次操作。
- `granted: true`: 允许本次操作。
- `session: true`: 当前会话内批准。
- `permanent: true`: 写入持久规则。
- `ruleContent`: 细化到命令内容或文件路径的规则内容。

权限请求最长等待 5 分钟，超时默认拒绝。

### 定时任务

Gateway 启动时恢复 cron。任务触发后：

1. 根据 `job.sessionId` 找到目标会话。
2. 如果目标会话不在内存中，尝试恢复该会话。
3. 发送 `request_start` 和 `cron_trigger`。
4. 将提醒文本写入会话并广播给 Web UI。
5. 如果绑定了 IM 会话，通过 PlatformManager 推送到对应 IM 平台。

### 文件访问

文件 API 始终基于会话 `cwd` 解析相对路径。服务端会检查解析后的绝对路径必须仍位于 `cwd` 内，避免目录穿越。

图片接口只允许常见图片扩展名，并限制最大 20MB。Word/Excel 预览由后端转换为 HTML 或表格结构后返回。

## 前端接入

REST 客户端位于 `web/src/lib/gateway.ts`：

- `setGatewayConfig(url, token)` 设置服务地址和 token。
- `createSession()` 创建会话。
- `getSessionMessages()` 加载历史。
- `uploadFiles()` 上传附件。
- `getAgentConfig()`、`updateAgentConfig()` 管理配置。
- `getMcpConfig()`、`saveMcpConfig()` 管理 MCP。
- `getSkills()`、`searchMarketSkills()` 管理 Skill。

WebSocket 客户端位于 `web/src/lib/wsClient.ts`：

- 自动附加 `?token=...`。
- 自动重连。
- 断线期间缓存待发送消息。
- 连接被 1008 拒绝时触发未授权回调。

典型前端流程：

```ts
setGatewayConfig('http://127.0.0.1:3282', token)

const session = await createSession({
  cwd: 'D:/workspace/project',
  permissionMode: 'ask',
})

const messages = await getSessionMessages(session.id)

const ws = new WsClient(
  `ws://127.0.0.1:3282/sessions/${session.id}/stream`,
  token,
  handleServerMessage,
)

ws.send({ type: 'message', content: '帮我检查这个项目' })
```

## 运维注意事项

- 默认速率限制为每 IP 每分钟 10 次创建会话请求。
- 默认最大内存会话数为 20。
- 默认空闲会话 30 分钟后释放。
- 关闭 Gateway 时会先停止 IM 平台，再等待进行中的会话完成；超时后中止。
- WebSocket 长连接会在关闭阶段主动终止，避免进程无法退出。
- `config.yaml` 通过 Web API 保存前会先做 YAML 解析校验。
- `/sessions/:id/delete` 会同时销毁内存会话、删除磁盘会话数据和会话工作目录。
- 公开部署时必须启用 token 或登录鉴权，并限制 CORS 来源。

## 排查

| 现象 | 检查点 |
| --- | --- |
| Web UI 打开但 API 401 | token 是否为空、过期或和 Gateway 启动配置不一致 |
| WebSocket 1008 关闭 | session ID 不存在、token 无效或路径不匹配 |
| 历史消息为空 | 检查 `~/.hrids-agent/sessions/<id>/events.jsonl` 是否存在 |
| 文件无法读取 | 检查会话 `cwd`、相对路径和文件大小限制 |
| Cron 未触发到会话 | 检查任务是否有 `sessionId`，或知了专属会话是否配置 |
| MCP 工具不可用 | 检查 `/mcp` 配置、server 命令是否可执行、会话是否重新创建 |
| IM 未推送 | 检查 `/im/status`、平台配置是否启用、适配器日志 |
