# hrids-agent

> 通用自主工作者 CLI —— 你只做决策，它负责执行。

基于 Agentic CLI 架构思想构建，支持多 LLM 提供商、长期记忆、多智能体协调、定时任务、MCP 工具扩展。

---

## 快速开始

```bash
# 安装依赖
npm install

# 设置 API Key（以阿里云百炼为例）
export DASHSCOPE_API_KEY=sk-...

# 启动交互模式
npm run dev
```

---

## 启动模式

### 交互模式（默认）

```bash
npm run dev
```

进入 TUI 界面，支持多轮对话、斜杠命令、实时流式输出。默认自动恢复上次会话。

### 单次执行模式

```bash
npm run dev -- -p "帮我调研一下 Rust 和 Go 在高并发场景下的性能对比"
```

执行完一条指令后自动退出，适合脚本调用。可用 `--max-chars <n>` 限制输出长度。

### Server 模式（NDJSON）

```bash
npm run dev -- --server
```

从 stdin 持续读取 NDJSON 消息，保持会话历史，供前端或外部程序调用。

消息格式：

```json
{ "message": "你的指令" }
```

特殊消息类型：

```json
{ "type": "abort" }                           // 中止当前任务
{ "type": "user_reply", "answer": "..." }     // 回复 ask_user 问题
{ "type": "decision_reply", "answer": "1" }  // 回复 request_decision 决策
{ "type": "set_cwd", "cwd": "/path/to/dir" } // 切换工作目录
```

### Gateway 模式（HTTP + WebSocket）

```bash
npm run dev -- --gateway --gateway-port 3282 --gateway-token my-secret
```

启动 HTTP REST + WebSocket 服务，支持多会话并发，供前端或远程客户端连接。

```
REST  http://127.0.0.1:3282/sessions
WS    ws://127.0.0.1:3282/sessions/:id/stream
```

---

## 命令行参数

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `-m, --model <model>` | 模型名称（自动识别提供商） | `claude-sonnet-4-5` |
| `--provider <name>` | 显式指定提供商 | 自动识别 |
| `--api-key <key>` | API Key | 读取环境变量 |
| `--base-url <url>` | 自定义 API 端点 | — |
| `--auto` | 自动模式，无需确认写操作 | — |
| `--readonly` | 只读模式，禁止所有写操作 | — |
| `--plan` | 计划模式，写操作需手动确认 | — |
| `--resume <sessionId>` | 恢复指定会话 | — |
| `--new-session` | 强制创建新会话 | — |
| `--list-sessions` | 列出最近的会话 | — |
| `--cwd <dir>` | 设置工作目录 | `~/.hrids-agent/work/` |
| `-p, --print <msg>` | 非交互模式，执行后退出 | — |
| `--max-chars <n>` | 非交互模式输出字符上限 | 不限 |
| `--server` | Server 模式（NDJSON stdin） | — |
| `--gateway` | Gateway 模式（HTTP + WS） | — |
| `--gateway-port <port>` | Gateway 监听端口 | `3282` |
| `--gateway-host <host>` | Gateway 监听地址 | `127.0.0.1` |
| `--gateway-token <token>` | Gateway 鉴权 Token | — |
| `--embedding-provider <p>` | Embedding 提供商：openai / ollama / tfidf | `tfidf` |
| `--embedding-model <model>` | Embedding 模型名称 | — |
| `--embedding-base-url <url>` | Embedding API 端点 | — |

---

## 多提供商支持

| 提供商 | 环境变量 | 模型前缀示例 |
|--------|---------|------------|
| Anthropic | `ANTHROPIC_API_KEY` | `claude-sonnet-4-5` |
| OpenAI | `OPENAI_API_KEY` | `gpt-4o`, `o3` |
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek-chat` |
| Groq | `GROQ_API_KEY` | `llama-3.3-70b-versatile` |
| 阿里云百炼 | `DASHSCOPE_API_KEY` | `qwen-max`, `qwen-plus` |
| 智谱 AI | `ZHIPU_API_KEY` | `glm-4` |
| NVIDIA | `NVIDIA_API_KEY` | `--provider nvidia` |
| Ollama（本地） | 无需 Key | `--provider ollama -m qwen2.5-coder:7b` |
| 自定义端点 | `CUSTOM_API_KEY` | `--provider custom --base-url <url>` |

### 多模型故障转移

在 `.env` 中配置多平台故障转移，按优先级依次 fallback：

```env
# 格式: provider:平台名,models:模型1,模型2,...
LLM_FALLBACK_1=provider:aliyun,models:qwen3.5-flash,qwen3.5-plus
LLM_FALLBACK_2=provider:deepseek,models:deepseek-chat
LLM_FALLBACK_3=provider:anthropic,models:claude-3-5-haiku-20241022
```

---

## 斜杠命令

在交互模式下，输入 `/` 开头的命令：

### 系统命令

| 命令 | 说明 |
|------|------|
| `/help` | 显示所有可用命令 |
| `/clear` | 清空对话历史 |
| `/compact` | 压缩对话历史为摘要，释放上下文空间 |
| `/cost` | 查看当前会话的 token 用量和费用 |
| `/model [名称]` | 查看或切换模型 |
| `/plan` | 切换计划模式（写操作需手动确认） |
| `/session` | 显示当前会话 ID |
| `/exit` | 退出程序 |

### 通用工作者 Skills

| 命令 | 说明 |
|------|------|
| `/research <主题>` | 对指定主题进行深度调研，输出结构化报告 |
| `/plan <目标>` | 为复杂目标制定详细的执行计划 |
| `/report [主题]` | 将工作成果整理成结构化报告文档 |
| `/monitor <目标>` | 设置对某个指标或状态的持续监控 |
| `/summarize <内容>` | 对文档、网页或长文本进行摘要提炼 |

### 代码开发 Skills

| 命令 | 说明 |
|------|------|
| `/commit` | 分析 git diff，生成规范的 commit 信息并提交 |
| `/review` | 对当前 git diff 进行代码审查 |
| `/explain <文件>` | 深入解释代码工作原理 |
| `/fix [错误信息]` | 分析并修复 bug |
| `/scaffold <描述>` | 生成项目或模块骨架代码 |
| `/refactor <文件>` | 对代码进行重构 |
| `/test <文件>` | 为代码生成单元测试 |
| `/docs <文件>` | 生成文档注释或 README |

---

## 工具列表

### 信息获取

| 工具 | 说明 |
|------|------|
| `web_search` | 搜索网络信息 |
| `web_fetch` | 获取指定网页内容，智能提取正文 |
| `file_read` | 读取文件，支持行范围，默认显示行号 |
| `grep` | 跨平台递归文本搜索 |
| `glob` | 文件路径搜索 |

### 任务执行

| 工具 | 说明 |
|------|------|
| `bash` | 执行 shell 命令，跨平台（Windows PowerShell 兼容） |
| `file_write` | 创建或覆盖文件 |
| `file_edit` | 精准字符串替换（要求 oldStr 唯一） |
| `todo_write` | 任务列表管理（pending / in_progress / completed） |
| `todo_read` | 读取当前任务列表 |

### 人机交互

| 工具 | 说明 |
|------|------|
| `ask_user` | 向用户提问，支持预设选项 |
| `request_decision` | 结构化决策上报 |

### 定时调度

| 工具 | 说明 |
|------|------|
| `schedule_cron` | 管理定时任务（create / list / delete / toggle） |

### Skill 管理

| 工具 | 说明 |
|------|------|
| `skill` | 调用已注册的 skill（内置或自定义） |
| `skill_list` | 列出所有可用 skill |
| `skill_save` | 将当前工作流沉淀为可复用 skill |

### 多智能体协调

| 工具 | 说明 |
|------|------|
| `agent` | 派生子工作者处理独立子任务 |
| `team_create` | 创建智能体团队 |
| `team_delete` | 删除团队并中止所有任务 |
| `agent_spawn` | 向团队派生子工作者 |
| `team_status` | 查看团队所有工作者的运行状态 |
| `team_wait` | 等待团队所有工作者完成 |
| `send_message` | 向其他工作者发送消息 |
| `receive_message` | 接收其他工作者的消息 |

### 长期记忆

| 工具 | 说明 |
|------|------|
| `memory_add` | 写入长期记忆（6 种类型） |
| `memory_search` | 语义搜索记忆 |
| `memory_recall` | 按分类列出记忆 |
| `memory_fact` | 向知识图谱写入三元组 |
| `memory_status` | 查看记忆系统统计 |

---

## 决策上报机制

工作者遇到以下情况时，会暂停执行并通过 `request_decision` 工具向你上报：

- 操作不可逆（删除数据、发布内容、提交到主分支）
- 多个方案各有权衡，没有明显最优解
- 发现与原始目标的重大偏差
- 超出授权范围（涉及费用、生产环境）

---

## 定时任务

工作者可以设置定时任务，在指定时间自动触发执行。

```
# cron 表达式格式（5位：分 时 日 月 周）
0 9 * * 1-5    工作日早 9 点
0 18 * * *     每天下午 6 点
*/30 * * * *   每 30 分钟
```

任务保存在 `~/.hrids-agent/crons.json`，进程重启后自动恢复。

---

## 权限控制

| 模式 | 说明 |
|------|------|
| `ask`（默认） | 写操作前询问用户 |
| `auto` | 自动允许所有操作（`--auto`） |
| `readonly` | 只允许只读操作（`--readonly`） |
| `plan` | 只读，写操作需手动确认（`--plan`） |

权限规则持久化在 `~/.hrids-agent/permission-rules.json`：

```json
{
  "alwaysAllow": ["bash"],
  "alwaysDeny": [],
  "alwaysAsk": ["file_write"],
  "allowedPaths": ["/home/user/projects/myapp/src"],
  "deniedPaths": [".env", "secrets/"]
}
```

`deniedPaths` 优先级高于 `allowedPaths`，高于工具级规则，高于模式默认值。

---

## 长期记忆系统

工作者拥有跨会话的长期记忆，分为 4 层：

```
L0 身份层     (~100 tokens)      固定身份定义，每次注入 system prompt
L1 核心摘要   (~500-800 tokens)  按重要性排序的记忆摘要
L2 按需检索   (~200-500 tokens)  按分类过滤，工具调用触发
L3 语义搜索   (按需)             sqlite-vec KNN 向量搜索 / TF-IDF 降级
```

记忆类型：`decision`（决策）/ `preference`（偏好）/ `milestone`（里程碑）/ `problem`（问题）/ `fact`（事实）/ `emotional`（情感）

会话结束后自动从对话中提取记忆（由 `MEMORY_CONDENSE=true` 控制是否用 LLM 精炼）。

### Embedding 配置

```bash
# OpenAI Embedding
npm run dev -- --embedding-provider openai --embedding-model text-embedding-3-small

# Ollama 本地 Embedding
npm run dev -- --embedding-provider ollama --embedding-model nomic-embed-text --embedding-base-url http://localhost:11434

# 默认：TF-IDF（无需额外配置）
```

---

## Skill 自动沉淀

会话结束后，若工具调用次数 >= 5 次，工作者会自动判断本次工作流是否值得沉淀为可复用 skill，并写入 `~/.hrids-agent/skills/`。

也可以手动触发：

```
你：把刚才的工作流保存为 skill
```

---

## 自定义 Skills

在以下目录创建 `SKILL.md` 文件即可添加自定义 skill：

```
~/.hrids-agent/skills/<skill-name>/SKILL.md    # 用户级（全局生效）
<项目目录>/.agent/skills/<skill-name>/SKILL.md  # 项目级（仅当前项目）
```

`SKILL.md` 格式：

```markdown
---
description: 这个 skill 的简短描述
when-to-use: 什么情况下使用
argument-hint: <参数提示>
---

# Skill 内容

这里写注入给工作者的 prompt 内容...

## 用户补充说明

{{args}}
```

优先级：项目级 > 用户级 > 内置。

---

## MCP 工具扩展

在 `~/.hrids-agent/config.json` 中配置 MCP 服务器：

```json
{
  "mcpServers": [
    {
      "name": "filesystem",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
    },
    {
      "name": "github",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "ghp_..." }
    }
  ]
}
```

MCP 工具以 `mcp__<服务器名>__<工具名>` 格式注册，工作者可以直接调用。

---

## 项目记忆文件

在项目根目录创建 `AGENT.md` 或 `CLAUDE.md`，工作者启动时自动读取并注入上下文：

```markdown
# 项目说明

这是一个 React + TypeScript 项目，使用 Vite 构建。

## 约定
- 组件文件使用 PascalCase
- 所有注释使用中文
- 提交信息遵循 Conventional Commits
```

---

## 配置文件

配置保存在 `~/.hrids-agent/config.json`：

```json
{
  "model": "claude-sonnet-4-5",
  "provider": "anthropic",
  "permissionMode": "ask",
  "maxTokens": 8096,
  "maxTurns": 50,
  "maxBudgetUsd": 5.0,
  "autoCompactThreshold": 60000,
  "agentCwd": "/home/user/workspace",
  "mcpServers": []
}
```

| 字段 | 说明 | 默认值 |
|------|------|--------|
| `model` | 默认模型 | `claude-sonnet-4-5` |
| `permissionMode` | 权限模式 | `ask` |
| `maxTokens` | 单次响应最大 token | `8096` |
| `maxTurns` | 单次会话最大轮次 | `50` |
| `maxBudgetUsd` | 单次会话成本上限（USD） | 不限 |
| `autoCompactThreshold` | 自动压缩触发阈值（token 估算） | `60000` |
| `agentCwd` | 持久化工作目录 | `~/.hrids-agent/work/` |

---

## 会话管理

```bash
# 列出最近的会话
npm run dev -- --list-sessions

# 恢复指定会话
npm run dev -- --resume <sessionId>

# 强制创建新会话（默认自动恢复上次会话）
npm run dev -- --new-session
```

会话保存在 `~/.hrids-agent/sessions/`，格式为 JSONL。

---

## 数据目录结构

```
~/.hrids-agent/
├── config.json            # 全局配置
├── permission-rules.json  # 权限规则
├── crons.json             # 定时任务
├── sessions/              # 会话历史
├── memory/                # 长期记忆数据库（SQLite）
├── skills/                # 用户级自定义 skills（含自动沉淀）
└── work/                  # 默认工作目录
```
