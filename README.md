<h1 align="center">hrids-agent</h1>

<p align="center">
  <strong>通用自主工作者 CLI</strong> — 你只做决策，它负责执行。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.1.0-blue" alt="version">
  <img src="https://img.shields.io/badge/node-%3E%3D18.0.0-green" alt="node">
  <img src="https://img.shields.io/badge/license-MIT-orange" alt="license">
  <img src="https://img.shields.io/badge/type-module-black" alt="module">
  <img src="https://img.shields.io/badge/docker-ready-blue?logo=docker&logoColor=white" alt="docker">
</p>

---

## 简介

hrids-agent 是一个 TypeScript 编写的通用自主工作者 CLI 工具。借鉴 agentic CLI 架构思想，支持多种 LLM 提供商、长期记忆、多智能体协调、定时任务和 MCP 工具扩展。

### 核心特性

- **多模型支持** — Anthropic / OpenAI / DeepSeek / Groq / 阿里云百炼 / 智谱 / Ollama 等 13+ 提供商，自动故障转移
- **20+ 内置工具** — 文件读写、网络搜索/抓取、Shell 执行、任务管理、定时调度、人机交互
- **4 种运行模式** — 交互式 TUI / 单次执行 / Server(stdin NDJSON) / Gateway(HTTP + WebSocket)
- **4 层长期记忆** — L0 身份 → L1 摘要 → L2 按需 → L3 语义搜索，支持 sqlite-vec 向量检索 + 知识图谱
- **多智能体协作** — 派生子智能体并行处理，团队管理，消息总线通信
- **MCP 协议** — 兼容 Model Context Protocol，支持 Claude Desktop 格式的 mcp.json
- **Skill 系统** — 内置 + 用户自定义技能 + SkillHub 市场集成，自动沉淀工作流
- **定时任务** — Cron 表达式调度，持久化存储，进程重启自动恢复
- **权限控制** — ask / craft / plan 三种模式，细粒度路径和内容规则
- **Gateway 服务** — 内置 Web UI，JWT 鉴权，Telegram / 微信 / Webhook 多 IM 平台接入

---

## 快速开始

### 方式一：npm 安装

```bash
git clone <repo-url> && cd hrids-agent
npm install
```

### 方式二：Docker 部署

#### 使用 Docker Compose（推荐）

```bash
# 克隆项目
git clone <repo-url> && cd hrids-agent

# 创建配置文件
cp config.example.yaml config.yaml
# 编辑 config.yaml 填入你的 API Key

# 启动服务
docker-compose up -d

# 查看日志
docker-compose logs -f

# 停止服务
docker-compose down
```

#### 使用 Docker 命令

```bash
# 构建镜像
docker build -t hrids-agent .

# 运行交互模式
docker run -it --rm \
  -v $(pwd)/config.yaml:/app/config.yaml:ro \
  -v hrids-data:/app/data \
  hrids-agent

# 运行 Gateway 模式
docker run -d \
  --name hrids-agent \
  -p 3000:3000 \
  -v $(pwd)/config.yaml:/app/config.yaml:ro \
  -v hrids-data:/app/data \
  hrids-agent --gateway
```

#### 环境变量配置

Docker 部署支持以下环境变量：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `NODE_ENV` | 运行环境 | `production` |
| `HRIDS_DATA_DIR` | 数据目录 | `/app/data` |

### 配置

首次运行自动生成 `~/.hrids-agent/config.json`，也可手动初始化：

```bash
npm run dev -- init
```

复制 `config.example.json` 到 `~/.hrids-agent/config.json` 并填入 API Key：

```json
{
  "llm": {
    "fallbacks": [
      {
        "provider": "aliyun",
        "apiKey": "sk-xxxxxxxx",
        "models": ["qwen-plus"]
      }
    ]
  }
}
```

### 启动

```bash
# 交互模式（默认 TUI，自动恢复上次会话）
npm run dev

# 单次执行
npm run dev -- -p "帮我写一个 hello world"

# Server 模式（stdin NDJSON）
npm run dev -- --server

# Gateway 模式（HTTP + WebSocket + Web UI）
npm run gateway
```

---

## 使用示例

### 交互模式

```
$ npm run dev

你：帮我统计 src/ 目录下所有 TypeScript 文件的代码行数

▸ 正在扫描 src/ 目录...
  找到 42 个 .ts 文件

▸ 执行统计...
  总行数：8,523 行
  总字符数：234,567
  平均每文件：203 行

已完成统计。
```

### 单次执行

```bash
npm run dev -- -p "用 Python 写一个简单的 HTTP 服务器" --craft
```

### Gateway 模式

```bash
npm run gateway
# 打开浏览器访问 http://127.0.0.1:3282
```

---

## 启动模式对比

| 特性 | 交互模式 | 单次执行 `-p` | Server `--server` | Gateway `--gateway` |
|------|:---:|:---:|:---:|:---:|
| 多轮对话 | ✓ | ✗ | ✓ | ✓ |
| 流式输出 | Ink TUI | stdout | NDJSON | WebSocket JSON |
| 会话持久化 | ✓ | ✓ | ✓ | ✓ |
| 多会话并发 | ✗ | ✗ | ✗ | ✓ |
| Web UI | ✗ | ✗ | ✗ | ✓ |
| IM 接入 | ✗ | ✗ | ✗ | ✓ |
| 历史恢复 | 自动 | — | 手动 | 手动 |

---

## 命令行参数

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `-m, --model` | 模型名称 | `qwen-plus-2025-07-28` |
| `--provider` | 显式指定提供商 | 自动识别 |
| `--api-key` | API Key | 配置文件 |
| `--craft` | 自主执行模式，无需确认 | — |
| `--plan` | 计划模式，只读 | — |
| `-p, --print` | 非交互模式，执行后退出 | — |
| `--server` | Server 模式（NDJSON stdin） | — |
| `--gateway` | Gateway 模式（HTTP + WS） | — |
| `--gateway-port` | Gateway 端口 | `3282` |
| `--resume` | 恢复指定会话 | 自动恢复 |
| `--new-session` | 强制创建新会话 | — |
| `--list-sessions` | 列出历史会话 | — |
| `--cwd` | 设置工作目录 | `~/.hrids-agent/work/` |

---

## 多提供商故障转移

同平台内按 models 顺序重试，全部失败后自动切换下一平台：

```json
{
  "llm": {
    "fallbacks": [
      {
        "provider": "aliyun",
        "apiKey": "sk-xxx",
        "models": ["qwen3.5-flash", "qwen3.5-plus"]
      },
      {
        "provider": "deepseek",
        "apiKey": "sk-xxx",
        "models": ["deepseek-chat"]
      },
      {
        "provider": "anthropic",
        "apiKey": "sk-ant-xxx",
        "models": ["claude-3-5-haiku-20241022"]
      }
    ]
  }
}
```

---

## 斜杠命令

### 系统命令

| 命令 | 说明 |
|------|------|
| `/help` | 显示所有可用命令 |
| `/clear` | 清空对话历史 |
| `/compact` | 压缩对话历史为摘要 |
| `/cost` | 查看 token 用量和费用 |
| `/model [名称]` | 查看或切换模型 |
| `/plan` | 切换计划模式 |
| `/session` | 显示当前会话 ID |
| `/sessions` | 列出历史会话 |
| `/resume <id>` | 切换到指定会话 |
| `/history [序号]` | 查看压缩归档历史 |
| `/exit` | 退出程序 |

### 代码开发

| 命令 | 说明 |
|------|------|
| `/commit` | 分析 git diff 生成规范 commit 并提交 |
| `/review` | 对 git diff 进行代码审查 |
| `/fix [错误]` | 分析并修复 bug |
| `/scaffold <描述>` | 生成项目骨架代码 |
| `/refactor <文件>` | 重构代码 |
| `/test <文件>` | 生成单元测试 |
| `/docs <文件>` | 生成文档注释 |

### 通用技能

| 命令 | 说明 |
|------|------|
| `/research <主题>` | 深度调研，输出结构化报告 |
| `/plan <目标>` | 为复杂目标制定执行计划 |
| `/report [主题]` | 整理工作成果为报告文档 |
| `/summarize <内容>` | 对长文本进行摘要提炼 |

---

## 工具列表

### 信息获取
`web_search` · `web_fetch` · `file_read` · `grep` · `glob`

### 文件操作
`file_write` · `file_edit`

### 执行命令
`bash` (Linux/macOS) / `powershell` (Windows)

### 任务管理
`todo_write` · `todo_update` · `todo_append` · `todo_reset` · `todo_read`

### 人机交互
`ask_user` · `request_decision`

### 协作
`agent` · `team_create` · `agent_spawn` · `team_status` · `team_wait` · `send_message`

### 定时调度
`schedule_cron` (create / list / delete / toggle)

### 技能管理
`skill` · `skill_list` · `skill_save` · `skillhub_search` · `skillhub_install`

### 长期记忆
`memory_add` · `memory_search` · `memory_recall` · `memory_fact` · `memory_status`

### MCP 扩展
`mcp__<server>__<tool>` （动态加载）

---

## 权限控制

| 模式 | CLI 标志 | 行为 |
|------|---------|------|
| `ask` | 默认 | 写操作前询问用户 |
| `craft` | `--craft` | 自主执行，无需确认，无轮次上限 |
| `plan` | `--plan` | 只读模式，写操作一律拒绝 |

权限规则持久化在 `~/.hrids-agent/permission-rules.json`，支持细粒度控制：

```json
{
  "alwaysAllow": ["bash(git *)", "bash(npm test)"],
  "alwaysDeny": ["bash(rm *)"],
  "alwaysAsk": ["file_write"],
  "allowedPaths": ["/home/user/projects/myapp/src"],
  "deniedPaths": [".env", "secrets/"]
}
```

---

## 长期记忆系统

4 层架构，跨会话积累知识：

```
L0 身份层  (~100 tokens)       固定身份 → 每次注入 system prompt
L1 摘要层  (~500-800 tokens)   按重要性排序 → 每次注入
L2 按需层  (~200-500 tokens)   按分类过滤 → 工具调用触发
L3 搜索层  (按需)              sqlite-vec 向量 / TF-IDF 降级 → 语义搜索
```

记忆类型：`decision` / `preference` / `milestone` / `problem` / `fact` / `emotional`

知识图谱：`subject → [predicate] → object`，带时间戳和置信度。

### Embedding 配置

```bash
# OpenAI Embedding
npm run dev -- --embedding-provider openai --embedding-model text-embedding-3-small

# Ollama 本地
npm run dev -- --embedding-provider ollama --embedding-model nomic-embed-text

# TF-IDF（默认，无需配置）
```

---

## Skill 系统

### 自定义 Skill

创建 `SKILL.md` 文件：

```markdown
---
description: 代码审查专家
when-to-use: 需要 review 代码时
argument-hint: <文件路径>
allowed-tools: [file_read, bash]
---

# 代码审查 Skill

你是一个资深代码审查者。请检查以下代码...

## 用户输入
{{args}}
```

存放位置（优先级从高到低）：

```
{项目}/.agent/skills/<name>/SKILL.md    # 项目级
~/.hrids-agent/skills/<name>/SKILL.md   # 用户级
src/skills/bundled/                      # 内置
```

### 自动沉淀

会话结束后，工具调用 ≥ 5 次时自动判断是否值得沉淀为可复用 Skill。

---

## MCP 工具扩展

支持两种配置方式：

**方式一：config.json**

```json
{
  "mcpServers": [
    {
      "name": "filesystem",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    }
  ]
}
```

**方式二：mcp.json（兼容 Claude Desktop）**

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    }
  }
}
```

工具自动以 `mcp__<server>__<tool>` 命名注册。

---

## Gateway 服务

### 启动

```bash
npm run gateway
# → HTTP  http://127.0.0.1:3282
# → WS    ws://127.0.0.1:3282/sessions/:id/stream
```

### 鉴权模式

| 模式 | 配置 | 说明 |
|------|------|------|
| 无鉴权 | 不配置 users 和 token | 适合本地 |
| Token | `gateway.token: "xxx"` | Bearer Token |
| 登录 | `gateway.users: [{...}]` | 用户名/密码 → JWT |

### 主要 API

| 端点 | 说明 |
|------|------|
| `POST /api/login` | 登录获取 Token |
| `GET /health` | 健康检查 |
| `GET/POST /sessions` | 会话列表 / 创建 |
| `GET/DELETE /sessions/:id` | 会话状态 / 销毁 |
| `GET /sessions/:id/messages` | 历史消息 |
| `WS /sessions/:id/stream` | 实时流式通道 |
| `GET/POST /crons` | 定时任务管理 |
| `GET/PUT /mcp` | MCP 配置 |
| `GET /skills` | 技能列表 |
| `GET/PUT /im/platforms/config` | IM 平台管理 |

### 内嵌 Web UI

Gateway 模式自动托管前端（React + Vite），浏览器打开 `http://127.0.0.1:3282` 即可使用。

---

## 项目记忆文件

在项目根目录创建 `AGENT.md`，智能体启动时自动读取：

```markdown
# 项目说明

这是一个 React + TypeScript 项目，使用 Vite 构建。

## 约定
- 组件文件使用 PascalCase
- 所有注释使用中文
- 提交信息遵循 Conventional Commits
```

支持三个位置：`{cwd}/AGENT.md` > `{cwd}/.hrids/AGENT.md` > `~/.hrids-agent/AGENT.md`

---

## 数据目录

```
~/.hrids-agent/
├── config.json            # 全局配置
├── mcp.json               # MCP 服务器配置
├── permission-rules.json  # 权限规则
├── crons.json             # 定时任务
├── skills-disabled.json   # 禁用技能
├── sessions/              # 会话历史
├── memory/                # 长期记忆（SQLite）
├── skills/                # 用户级自定义 Skills
├── logs/                  # 日志
└── work/                  # 默认工作目录
```

---

## 开发

```bash
# 安装依赖
npm install

# 开发模式
npm run dev

# 运行测试
npm test

# 构建
npm run build

# Lint
npm run lint
```

### 技术栈

| 分类 | 技术 |
|------|------|
| 语言 | TypeScript 5.7 (ESM) |
| CLI | Commander + Ink (React TUI) |
| 服务端 | Express v5 + ws |
| AI SDK | @anthropic-ai/sdk |
| MCP | @modelcontextprotocol/sdk |
| 数据库 | better-sqlite3 + sqlite-vec |
| 校验 | Zod |
| 测试 | Vitest + fast-check |
| 前端 | React 18 + Vite |

---

## 项目结构

```
src/
├── main.ts               # 入口，CLI 定义
├── core/                  # 核心引擎
│   ├── QueryEngine.ts     # 执行循环（LLM → 工具 → 循环）
│   ├── Config.ts          # 配置加载/规范化
│   ├── Tool.ts            # 工具抽象接口
│   ├── CommandRegistry.ts # 斜杠命令系统
│   ├── ContextBuilder.ts  # 系统上下文构建
│   ├── PermissionManager.ts # 权限管理
│   ├── SessionStore.ts    # 会话持久化
│   ├── CostTracker.ts     # Token 费用追踪
│   ├── coordinator/       # 多智能体协调
│   └── providers/         # LLM 提供商适配器
├── tools/                 # 20+ 内置工具
├── gateway/               # HTTP + WebSocket 服务
│   └── im/                # Telegram / 微信 / Webhook
├── memory/                # 4 层长期记忆系统
├── skills/                # Skill 系统
├── modes/                 # 运行模式
├── tui/                   # Ink React TUI
└── web/                   # Gateway 前端
```

详细架构文档见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

---

## 许可证

MIT
