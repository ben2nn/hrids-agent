# Gateway API 参考

Gateway 模式启动后提供 HTTP REST API 和 WebSocket 接口。

**启动方式：**
```bash
hrids-agent --gateway
# 默认监听 http://127.0.0.1:3282
```

---

## 目录

- [鉴权](#鉴权)
- [REST API](#rest-api)
  - [健康检查](#健康检查)
  - [登录](#登录)
  - [会话管理](#会话管理)
  - [消息与历史](#消息与历史)
  - [文件操作](#文件操作)
  - [任务（Todo）](#任务todo)
  - [配置](#配置)
  - [IM 平台](#im-平台)
- [WebSocket 协议](#websocket-协议)
  - [连接](#连接)
  - [客户端 → 服务端消息](#客户端--服务端消息)
  - [服务端 → 客户端消息](#服务端--客户端消息)

---

## 鉴权

根据 `config.json` 的 `gateway` 配置，支持三种鉴权模式：

| 模式 | 条件 | 说明 |
|------|------|------|
| 无鉴权 | 未配置 `token` 和 `users` | 所有请求直接放行 |
| Token 模式 | 配置了 `token` | 请求头携带 `Authorization: Bearer <token>` |
| 登录模式 | 配置了 `users` | POST `/api/login` 获取 JWT，有效期 7 天 |

**Token 模式请求示例：**
```http
GET /sessions HTTP/1.1
Authorization: Bearer your-secret-token
```

---

## REST API

### 健康检查

#### `GET /health`

无需鉴权。返回服务状态信息。

**响应示例：**
```json
{
  "status": "ok",
  "uptime": 3600,
  "authMode": "none",
  "sessions": {
    "total": 2,
    "busy": 1,
    "idle": 1
  },
  "memory": {
    "heapUsedMb": 128,
    "heapTotalMb": 256,
    "rssMb": 180
  }
}
```

---

### 登录

#### `POST /api/login`

无需鉴权。用户名/密码登录，返回 Token。

**请求体：**
```json
{
  "username": "admin",
  "password": "password123"
}
```

**响应：**
```json
{
  "token": "eyJhbGciOiJIUzI1NiJ9...",
  "mode": "jwt"
}
```

`mode` 取值：`"none"` | `"token"` | `"jwt"`

---

### 会话管理

#### `GET /sessions`

列出所有活跃会话（内存中）。

**响应：**
```json
[
  {
    "id": "20240101-120000-abc123",
    "status": "ready",
    "createdAt": 1704067200000,
    "lastActiveAt": 1704067800000,
    "model": "qwen-plus-2025-07-28",
    "cwd": "/home/user/.hrids-agent/work/20240101-120000-abc123",
    "title": "我的会话",
    "permissionMode": "ask"
  }
]
```

**`status` 取值：** `"ready"` | `"busy"`

---

#### `GET /sessions/history`

列出所有会话（含已停止的历史会话，从磁盘读取）。

响应格式同上，历史会话 `status` 为 `"stopped"`。

---

#### `POST /sessions`

创建新会话。

**请求体（均可选）：**
```json
{
  "title": "会话标题",
  "model": "qwen-plus-2025-07-28",
  "provider": "aliyun",
  "apiKey": "sk-xxx",
  "baseUrl": "https://...",
  "cwd": "/path/to/workspace",
  "permissionMode": "craft",
  "resume": "existing-session-id"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `title` | `string` | 会话标题 |
| `model` | `string` | 覆盖默认模型 |
| `provider` | `string` | 覆盖默认提供商 |
| `apiKey` | `string` | 覆盖 API Key |
| `baseUrl` | `string` | 覆盖 API 端点 |
| `cwd` | `string` | 指定工作目录 |
| `permissionMode` | `"ask" \| "craft" \| "plan"` | 权限模式 |
| `resume` | `string` | 恢复已有会话 ID |

**响应：** 返回 `SessionInfo` 对象（同 GET /sessions 中的单个元素）

---

#### `GET /sessions/:id`

查询单个会话状态。

---

#### `DELETE /sessions/:id`

销毁会话（同时删除磁盘数据）。

**响应：** `{ "ok": true }`

---

### 消息与历史

#### `GET /sessions/:id/messages`

获取会话历史消息（转换为前端展示格式）。

**响应：**
```json
[
  {
    "id": "u-1",
    "type": "user",
    "content": "帮我写一个 hello world",
    "timestamp": 1704067200000
  },
  {
    "id": "a-2",
    "type": "assistant",
    "content": "好的，这是一个 Python 的 hello world：\n```python\nprint('Hello, World!')\n```",
    "timestamp": 1704067201000,
    "requestId": "req-1704067200-abc"
  },
  {
    "id": "t-tool123",
    "type": "tool",
    "toolId": "tool123",
    "toolName": "file_write",
    "toolInput": { "path": "hello.py", "content": "print('Hello, World!')" },
    "toolStatus": "success",
    "toolResult": "文件已写入: hello.py",
    "timestamp": 1704067202000
  }
]
```

**消息 `type` 取值：** `"user"` | `"assistant"` | `"tool"` | `"error"`

---

#### `GET /sessions/:id/history-segments`

获取会话的压缩归档段列表（历史压缩记录）。

**响应：**
```json
[
  {
    "filename": "archive-20240101-120000.json",
    "archivedAt": "2024-01-01T12:00:00.000Z",
    "messageCount": 45,
    "summary": "## 目标\n用户要求实现..."
  }
]
```

---

#### `GET /sessions/:id/history-segments/:filename/messages`

获取指定归档段的历史消息。响应格式同 `/messages`。

---

### 文件操作

#### `GET /sessions/:id/files?path=`

列出会话工作目录下的文件。`path` 参数为相对路径，默认 `.`。

**响应：**
```json
{
  "cwd": "/home/user/.hrids-agent/work/session-abc",
  "path": ".",
  "entries": [
    { "name": "hello.py", "type": "file", "size": 28, "mtime": 1704067200000 },
    { "name": "src", "type": "dir", "mtime": 1704067100000 }
  ]
}
```

---

#### `GET /sessions/:id/file-content?path=`

读取单个文件内容（限制 2MB）。

**响应：**
```json
{
  "path": "hello.py",
  "content": "print('Hello, World!')\n",
  "size": 23,
  "mtime": 1704067200000
}
```

---

#### `PUT /sessions/:id/file-content`

保存文件内容。

**请求体：**
```json
{
  "path": "hello.py",
  "content": "print('Hello, World!')\n"
}
```

**响应：** `{ "ok": true }`

---

#### `GET /sessions/:id/file-preview?path=`

预览 Word/Excel 文件（限制 20MB）。

**响应（docx/doc）：**
```json
{
  "type": "html",
  "html": "<p>文档内容...</p>"
}
```

**响应（xlsx/xls/csv）：**
```json
{
  "type": "table",
  "sheets": [
    {
      "name": "Sheet1",
      "headers": ["姓名", "年龄"],
      "rows": [["张三", "25"], ["李四", "30"]]
    }
  ]
}
```

---

#### `GET /sessions/:id/git-file?path=`

获取文件在 git HEAD 中的原始内容（用于 diff 对比）。

**响应：**
```json
{
  "path": "hello.py",
  "content": "print('hello')\n"
}
```

---

#### `POST /sessions/:id/upload`

上传文件到会话工作目录（base64 编码，单次最多 20 个文件，单文件限 50MB）。

**请求体：**
```json
{
  "files": [
    {
      "name": "data.csv",
      "data": "base64encodedcontent..."
    }
  ]
}
```

**响应：**
```json
{
  "files": [
    { "name": "data.csv", "path": "/absolute/path/data.csv", "size": 1024 }
  ]
}
```

---

### 任务（Todo）

#### `GET /todos`

获取所有活跃会话的任务列表（聚合）。

#### `GET /sessions/:id/todos`

获取指定会话的任务列表。

**响应：**
```json
[
  {
    "id": "1",
    "content": "实现登录功能",
    "status": "in_progress",
    "priority": "high",
    "context": "需要支持 JWT 鉴权",
    "acceptance": ["单元测试通过", "集成测试通过"],
    "dependsOn": []
  }
]
```

---

### 配置

#### `GET /config`

读取 agent 全局配置。

**响应：**
```json
{
  "model": "qwen-plus-2025-07-28",
  "permissionMode": "ask",
  "maxTokens": 8096,
  "maxTurns": 50
}
```

---

#### `PUT /config`

更新 agent 全局配置（持久化到 `config.json`）。

**请求体：**
```json
{
  "model": "claude-sonnet-4-5",
  "permissionMode": "craft"
}
```

---

#### `GET /config/models`

获取可用模型列表（从 `config.json` 的 `llm.fallbacks` 读取）。

**响应：**
```json
{
  "models": [
    { "provider": "aliyun", "model": "qwen-plus-2025-07-28", "isDefault": true },
    { "provider": "anthropic", "model": "claude-sonnet-4-5", "isDefault": false }
  ],
  "defaultModel": "qwen-plus-2025-07-28"
}
```

---

### IM 平台

#### `GET /im/platforms`

获取所有 IM 平台配置和运行状态。

#### `POST /im/platforms`

更新 IM 平台配置（全量替换）。

#### `POST /im/platforms/:platform/start`

启动指定平台适配器。

#### `POST /im/platforms/:platform/stop`

停止指定平台适配器。

#### `POST /im/platforms/weixin/login`

发起微信扫码登录，返回二维码信息。

**响应：**
```json
{
  "qrcodeKey": "xxx",
  "qrcodeImgUrl": "https://..."
}
```

#### `GET /im/platforms/weixin/login/status`

查询微信扫码登录状态。

**响应：**
```json
{
  "status": "confirmed",
  "accountId": "wx_xxx",
  "botToken": "token_xxx",
  "qrcodeImgUrl": "https://..."
}
```

`status` 取值：`"pending"` | `"scaned"` | `"confirmed"` | `"expired"` | `"error"`

---

## WebSocket 协议

### 连接

```
ws://host:port/sessions/:id/stream[?token=<token>]
```

连接成功后服务端立即推送 `ready` 消息。若 agent 正在运行（busy 状态），服务端会自动回放最近 200 条事件缓冲区。

---

### 客户端 → 服务端消息

#### `message` — 发送用户消息

```json
{
  "type": "message",
  "content": "帮我写一个 hello world",
  "attachments": [
    {
      "name": "screenshot.png",
      "data": "base64encodeddata...",
      "mediaType": "image/png"
    }
  ]
}
```

`attachments` 可选，支持 `image/jpeg`、`image/png`、`image/gif`、`image/webp`、`application/pdf`。

---

#### `abort` — 中止当前任务

```json
{ "type": "abort" }
```

---

#### `resume` — 恢复中断的任务

```json
{
  "type": "resume",
  "content": "请继续执行之前未完成的任务"
}
```

---

#### `permission_reply` — 回复权限询问

```json
{
  "type": "permission_reply",
  "key": "file_write::写入文件: src/main.ts",
  "granted": true,
  "permanent": false,
  "session": true,
  "ruleContent": "src/main.ts"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `key` | `string` | 权限请求的唯一 key（来自 `permission_request` 消息） |
| `granted` | `boolean` | 是否允许 |
| `permanent` | `boolean` | 是否永久允许（持久化到规则文件） |
| `session` | `boolean` | 是否会话内允许（不持久化） |
| `ruleContent` | `string` | 规则内容（用于精确匹配，来自 `permission_request.ruleContent`） |

---

#### `user_reply` — 回复 ask_user 问题

```json
{
  "type": "user_reply",
  "answer": "使用 TypeScript"
}
```

---

#### `decision_reply` — 回复决策请求

```json
{
  "type": "decision_reply",
  "answer": "方案A"
}
```

---

#### `set_cwd` — 设置工作目录

```json
{
  "type": "set_cwd",
  "cwd": "/path/to/workspace"
}
```

---

#### `set_permission_mode` — 切换权限模式

```json
{
  "type": "set_permission_mode",
  "mode": "craft"
}
```

---

#### `clear_history` — 清空会话历史

```json
{ "type": "clear_history" }
```

---

### 服务端 → 客户端消息

所有消息均包含 `timestamp` 字段（Unix 毫秒时间戳）。

---

#### `ready` — 会话就绪

```json
{
  "type": "ready",
  "sessionId": "20240101-120000-abc123",
  "status": "ready",
  "timestamp": 1704067200000
}
```

---

#### `request_start` — 新请求开始

```json
{
  "type": "request_start",
  "requestId": "req-1704067200-abc",
  "trigger": "user",
  "timestamp": 1704067200000
}
```

`trigger` 取值：`"user"` | `"cron"`

---

#### `text_delta` — 流式文本增量

```json
{
  "type": "text_delta",
  "delta": "好的，我来帮你",
  "requestId": "req-1704067200-abc",
  "timestamp": 1704067200100
}
```

---

#### `tool_start` — 工具开始执行

```json
{
  "type": "tool_start",
  "toolId": "tool_abc123",
  "toolName": "file_write",
  "input": { "path": "hello.py", "content": "print('Hello')" },
  "description": "写入文件: hello.py",
  "requestId": "req-1704067200-abc",
  "timestamp": 1704067200200
}
```

---

#### `tool_log` — 工具执行日志

```json
{
  "type": "tool_log",
  "toolId": "tool_abc123",
  "toolName": "bash",
  "log": "[stdout] Hello, World!",
  "timestamp": 1704067200300
}
```

---

#### `tool_end` — 工具执行完成

```json
{
  "type": "tool_end",
  "toolId": "tool_abc123",
  "toolName": "file_write",
  "status": "success",
  "result": "文件已写入: hello.py",
  "requestId": "req-1704067200-abc",
  "timestamp": 1704067200400
}
```

`status` 取值：`"success"` | `"error"`

---

#### `done` — 请求完成

```json
{
  "type": "done",
  "requestId": "req-1704067200-abc",
  "timestamp": 1704067201000
}
```

---

#### `permission_request` — 权限询问

```json
{
  "type": "permission_request",
  "toolName": "file_write",
  "description": "写入文件: src/main.ts",
  "readonly": false,
  "isDestructive": false,
  "ruleContent": "src/main.ts",
  "key": "file_write::写入文件: src/main.ts",
  "timestamp": 1704067200500
}
```

---

#### `ask_user` — 询问用户

```json
{
  "type": "ask_user",
  "question": "请选择编程语言",
  "options": ["Python", "TypeScript", "Go"],
  "timestamp": 1704067200600
}
```

---

#### `decision_request` — 决策请求

```json
{
  "type": "decision_request",
  "title": "选择部署方案",
  "context": "当前有两个可选方案...",
  "options": ["方案A：Docker 部署", "方案B：直接部署"],
  "recommendation": "方案A",
  "impact": "high",
  "timestamp": 1704067200700
}
```

---

#### `todos_updated` — 任务列表更新

```json
{
  "type": "todos_updated",
  "todos": [...],
  "timestamp": 1704067200800
}
```

---

#### `usage` — Token 用量

```json
{
  "type": "usage",
  "inputTokens": 1500,
  "outputTokens": 300,
  "cost": 0.0012,
  "model": "qwen-plus-2025-07-28",
  "timestamp": 1704067201000
}
```

---

#### `error` — 错误

```json
{
  "type": "error",
  "message": "LLM 请求失败: rate limit exceeded",
  "requestId": "req-1704067200-abc",
  "timestamp": 1704067201000
}
```

---

#### `compact_done` — 上下文压缩完成

```json
{
  "type": "compact_done",
  "summary": "## 目标\n用户要求实现...",
  "timestamp": 1704067201000
}
```

---

#### `cron_trigger` — 定时任务触发

```json
{
  "type": "cron_trigger",
  "requestId": "req-xxx",
  "description": "每天早上 9 点提醒",
  "timestamp": 1704067200000
}
```

---

#### `model_switched` — 模型切换通知

```json
{
  "type": "model_switched",
  "model": "qwen-vl-max",
  "reason": "vision_content",
  "timestamp": 1704067200000
}
```

---

#### `history_cleared` — 历史已清空

```json
{
  "type": "history_cleared",
  "timestamp": 1704067200000
}
```
