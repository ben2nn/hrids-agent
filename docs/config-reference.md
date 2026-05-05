# 配置参考

配置文件路径：`~/.hrids-agent/config.json`

---

## 完整配置结构

```json
{
  "llm": {
    "fallbacks": [
      {
        "provider": "aliyun",
        "models": ["qwen-plus-2025-07-28", "qwen-max"],
        "apiKey": "sk-xxxxxxxx",
        "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "toolMode": "native"
      },
      {
        "provider": "anthropic",
        "models": ["claude-sonnet-4-5"],
        "apiKey": "sk-ant-xxxxxxxx"
      }
    ]
  },

  "vision": {
    "fallbacks": [
      {
        "provider": "aliyun",
        "models": ["qwen-vl-max"],
        "apiKey": "sk-xxxxxxxx"
      }
    ]
  },

  "embedding": {
    "provider": "aliyun",
    "model": "text-embedding-v3",
    "apiKey": "sk-xxxxxxxx",
    "dimensions": 1024
  },

  "agent": {
    "permissionMode": "ask",
    "maxTokens": 8096,
    "maxTurns": 50,
    "maxBudgetUsd": 1.0,
    "cwd": "/path/to/workspace",
    "memoryCondense": true,
    "autoDistillSkill": false,
    "autoPruneSessions": true,
    "pruneKeepCount": 50,
    "pruneMaxAgeDays": 90
  },

  "gateway": {
    "port": 3282,
    "host": "127.0.0.1",
    "token": "your-secret-token",
    "users": [
      { "username": "admin", "password": "password123" }
    ]
  },

  "logging": {
    "level": "info",
    "theme": "default"
  },

  "vectorStore": {
    "backend": "sqlite"
  },

  "skillHub": {
    "url": "https://skillhub.cn",
    "apiBase": "https://api.skillhub.cn"
  },

  "mcpServers": [],

  "customProviders": []
}
```

---

## 字段说明

### `llm` — 大语言模型配置

主对话引擎，支持多平台 Fallback 链。

| 字段 | 类型 | 说明 |
|------|------|------|
| `fallbacks` | `ModelFallbackGroup[]` | 多平台 Fallback 链，按顺序尝试 |

**`ModelFallbackGroup` 字段：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `provider` | `string` | ✅ | 提供商 ID（见下方提供商列表） |
| `models` | `string[]` | ✅ | 模型列表，按优先级排序 |
| `apiKey` | `string` | — | 该平台的 API Key |
| `baseUrl` | `string` | — | 自定义 API 端点 |
| `toolMode` | `"native" \| "dsml"` | — | 工具调用模式，默认 `native` |

**支持的 `provider` 值：**

| provider | 说明 |
|----------|------|
| `anthropic` | Anthropic Claude |
| `openai` | OpenAI GPT |
| `deepseek` | DeepSeek |
| `aliyun` | 阿里云 DashScope（Qwen） |
| `zhipu` | 智谱 AI（GLM） |
| `kimi` | Moonshot AI |
| `minimax` | MiniMax |
| `google` | Google Gemini |
| `openrouter` | OpenRouter 聚合 |
| `ollama` | 本地 Ollama（无需 API Key） |
| `custom` | 自定义 OpenAI 兼容端点 |

---

### `vision` — 视觉模型配置（可选）

处理图片和 PDF 的视觉模型。结构与 `llm` 相同。未配置时，图片/PDF 请求使用 `llm` 中的模型。

---

### `embedding` — Embedding 模型配置（可选）

用于记忆检索的向量模型。未配置时降级使用 TF-IDF。

| 字段 | 类型 | 说明 |
|------|------|------|
| `provider` | `string` | 提供商（`openai` / `aliyun` / `ollama`） |
| `model` | `string` | 模型名称 |
| `apiKey` | `string` | API Key |
| `baseUrl` | `string` | 自定义端点（Ollama 用） |
| `dimensions` | `number` | 向量维度（OpenAI 支持降维） |

---

### `agent` — Agent 行为配置

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `permissionMode` | `"ask" \| "craft" \| "plan"` | `"ask"` | 权限模式 |
| `maxTokens` | `number` | `8096` | 单次回复最大 token 数 |
| `maxTurns` | `number` | `50` | 单次任务最大对话轮数 |
| `maxBudgetUsd` | `number` | `0`（不限） | 单次任务最大费用上限（USD） |
| `cwd` | `string` | `~/.hrids-agent/work` | 默认工作目录 |
| `memoryCondense` | `boolean` | `true` | 会话结束后用 LLM 提炼记忆 |
| `autoDistillSkill` | `boolean` | `false` | 自动将成功任务提炼为可复用技能 |
| `autoPruneSessions` | `boolean` | `true` | 启动时自动清理过期会话 |
| `pruneKeepCount` | `number` | `50` | 自动清理时至少保留的最近会话数 |
| `pruneMaxAgeDays` | `number` | `90` | 自动清理时保留的最大天数 |

---

### `gateway` — Gateway 服务配置

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `port` | `number` | `3282` | 监听端口 |
| `host` | `string` | `"127.0.0.1"` | 监听地址（`0.0.0.0` 对外开放） |
| `token` | `string` | — | 静态鉴权 Token（留空则不鉴权） |
| `users` | `GatewayUser[]` | — | 用户列表（配置后启用用户名/密码登录） |

**`GatewayUser` 字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `username` | `string` | 用户名 |
| `password` | `string` | 密码（明文，建议仅用于本地/内网） |

**鉴权模式说明：**
- 未配置 `token` 和 `users`：无鉴权，所有请求直接放行
- 仅配置 `token`：静态 Token 模式，请求需携带 `Authorization: Bearer <token>`
- 配置 `users`：登录模式，POST `/api/login` 获取 JWT，有效期 7 天

---

### `logging` — 日志配置

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `level` | `"debug" \| "info" \| "warn" \| "error"` | `"info"` | 日志级别 |
| `theme` | `"default" \| "minimal"` | `"default"` | UI 主题 |

---

### `vectorStore` — 向量存储配置

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `backend` | `"sqlite"` | `"sqlite"` | 存储后端（目前仅支持 sqlite） |

---

### `mcpServers` — MCP 服务器配置

支持两种格式，也可单独放在 `~/.hrids-agent/mcp.json`。

**数组格式（与 config.json 一致）：**
```json
{
  "mcpServers": [
    {
      "name": "my-server",
      "command": "uvx",
      "args": ["my-mcp-server@latest"],
      "env": { "API_KEY": "xxx" }
    }
  ]
}
```

**对象格式（兼容 Claude Desktop）：**
```json
{
  "mcpServers": {
    "my-server": {
      "command": "uvx",
      "args": ["my-mcp-server@latest"]
    }
  }
}
```

---

### `customProviders` — 自定义提供商

```json
{
  "customProviders": [
    {
      "name": "my-provider",
      "baseUrl": "http://localhost:8080/v1",
      "apiKey": "token"
    }
  ]
}
```

---

## 权限规则文件

权限规则持久化在 `~/.hrids-agent/permission-rules.json`，可手动编辑：

```json
{
  "alwaysAllow": [
    "bash(git *)",
    "bash(npm run *)",
    "file_write"
  ],
  "alwaysDeny": [
    "bash(rm -rf *)"
  ],
  "alwaysAsk": [],
  "allowedPaths": [
    "/home/user/projects/myapp/src"
  ],
  "deniedPaths": [
    ".env",
    "secrets/"
  ]
}
```

**规则格式：**

| 格式 | 示例 | 说明 |
|------|------|------|
| 工具名 | `"file_write"` | 匹配该工具的所有调用 |
| 工具名(内容) | `"bash(git *)"` | 匹配 bash 中以 git 开头的命令 |
| 工具名(精确) | `"bash(npm run test)"` | 精确匹配命令内容 |

---

## 记忆文件（AGENT.md）

在以下位置放置 `AGENT.md` 文件，agent 每次启动时会自动读取并注入 system prompt：

| 路径 | 作用域 |
|------|--------|
| `{cwd}/AGENT.md` | 项目级记忆 |
| `{cwd}/.hrids/AGENT.md` | 项目级记忆（隐藏目录） |
| `~/.hrids-agent/AGENT.md` | 用户级全局记忆 |

示例内容：
```markdown
# 项目规范

- 使用 TypeScript，严格模式
- 测试框架：Vitest
- 代码风格：2 空格缩进，单引号
- 提交前必须运行 npm test
```
