# hrids-agent 作为独立开发者/工作者的完整分析

> 最后更新：2026-04-13（第三轮全量代码扫描后）

---

## 一、项目定位与现状

hrids-agent 是一个原创的智能体 CLI，借鉴了 Claude Code 的架构思想，完全独立实现。代码规模约 6,500 行，架构分层清晰，已具备独立开发者工作者的完整形态。

技术栈：Node.js (tsx) + TypeScript + React/Ink + Commander.js + better-sqlite3 + sqlite-vec

---

## 二、已具备的核心能力

| 模块 | 实现情况 | 说明 |
|------|---------|------|
| LLM 查询引擎 | ✅ 完整 | 流式响应、工具循环、上下文压缩（LLM 生成摘要）、成本追踪、并发保护、abort 支持 |
| 多提供商支持 | ✅ 完整 | Anthropic / OpenAI / DeepSeek / Groq / Ollama / 阿里云 / 智谱 / NVIDIA / 自定义，自动识别 |
| 工具系统 | ✅ 26 个工具 | 见下方工具清单 |
| 权限管理 | ✅ 完整 | auto / ask / readonly / plan 四种模式，持久化规则（alwaysAllow / alwaysDeny / alwaysAsk） |
| Plan Mode | ✅ 完整 | `/plan` 命令切换，只读保护，写操作需确认 |
| 会话持久化 | ✅ 完整 | JSONL 格式，支持 `--resume` 恢复，元数据索引 |
| Gateway 服务 | ✅ 完整 | HTTP REST + WebSocket，多会话并发（默认 20），Bearer Token 鉴权，空闲超时 |
| 记忆系统 | ✅ 完整 | 4 层架构（L0 身份 / L1 核心摘要 / L2 按需 / L3 语义搜索），知识图谱三元组 |
| 向量存储 | ✅ 完整 | sqlite-vec（默认）/ pgvector / SeekDB 三种后端，TF-IDF 降级 |
| Embedding | ✅ 完整 | OpenAI / Ollama / TF-IDF（默认），内存缓存，批量请求 |
| 记忆提取 | ✅ 完整 | 纯正则启发式，无需 LLM，识别 6 种类型，会话结束后自动提取 |
| 多智能体协调 | ✅ 完整 | AgentPool + MessageBus + TeamManager，并行/串行，点对点/广播消息 |
| 子智能体派生 | ✅ 完整 | AgentTool 继承父智能体 provider 和 tools，无循环依赖 |
| CLI 入口 | ✅ 完整 | 交互 / 单次（`-p`）/ server（NDJSON）/ gateway 四种模式 |
| React/Ink UI | ✅ 完整 | 流式输出，Ctrl+C 中断任务（运行中）或退出（空闲时） |
| 技能系统 | ✅ 完整 | 8 个内置 skill，用户级（`~/.hrids-agent/skills/`）和项目级（`.agent/skills/`）扩展 |
| 项目指令文件 | ✅ 完整 | 自动读取 `CLAUDE.md` / `AGENT.md`（当前目录→父目录→主目录）注入系统上下文 |
| Git 上下文感知 | ✅ 完整 | 自动注入分支、工作区变更（`git status`）、最近 5 条提交 |
| 工作目录持久化 | ✅ 完整 | `--cwd` 参数 + `config.agentCwd`，bash `cd` 命令跨工具调用保持状态 |
| MCP 工具支持 | ✅ 完整 | 动态加载外部 MCP 服务器，stdio 传输，自动 JSON Schema 转换 |
| 成本追踪 | ✅ 完整 | 覆盖 Anthropic / OpenAI / DeepSeek / Groq 等主流模型定价，缓存 token 计费 |
| 斜杠命令系统 | ✅ 完整 | `/clear` `/compact` `/cost` `/model` `/plan` `/commit` `/review` `/help` 等 |

---

## 三、工具清单（26 个）

### 基础工具（11 个）

| 工具名 | 类型 | 说明 |
|--------|------|------|
| `bash` | 写 | 跨平台 shell，Windows PowerShell 兼容，持久化工作目录，危险命令黑名单 |
| `file_read` | 只读 | 读取文件，默认显示行号（`行号 │ 内容`），支持行范围，1MB 大小限制 |
| `file_write` | 写 | 创建/覆盖文件，自动创建父目录 |
| `file_edit` | 写 | 精准字符串替换，要求 oldStr 唯一，防止误改 |
| `glob` | 只读 | 文件路径搜索，跟随 bash `cd` 的工作目录 |
| `grep` | 只读 | 纯 Node.js 递归实现，跨平台，自动跳过 node_modules/.git，支持扩展名过滤 |
| `web_fetch` | 只读 | 获取网页，智能提取正文（移除 script/style，解码 HTML 实体，保留段落结构） |
| `web_search` | 只读 | Anthropic 原生 web_search beta 工具（claude-haiku-4-5 驱动） |
| `ask_user` | 只读 | 向用户提问，支持预设选项，交互模式和 server 模式均可用 |
| `todo_write` | 写 | 任务列表管理（pending / in_progress / completed），追踪复杂任务进度 |
| `todo_read` | 只读 | 读取当前任务列表 |

### 子智能体工具（1 个）

| 工具名 | 类型 | 说明 |
|--------|------|------|
| `agent` | 写 | 派生子智能体，继承父智能体 provider/tools，支持工具白名单，最多 30 轮 |

### 团队协调工具（7 个）

| 工具名 | 类型 | 说明 |
|--------|------|------|
| `team_create` | 写 | 创建智能体团队，设置最大并发数 |
| `team_delete` | 写 | 删除团队并中止所有任务 |
| `agent_spawn` | 写 | 向团队派生子智能体，支持后台运行（并行）或等待完成（串行） |
| `team_status` | 只读 | 查看团队所有智能体的运行状态 |
| `team_wait` | 只读 | 等待团队所有智能体完成，返回汇总结果 |
| `send_message` | 写 | 向其他智能体发送消息（点对点或广播） |
| `receive_message` | 只读 | 接收其他智能体的消息，支持等待超时 |

### 记忆工具（5 个）

| 工具名 | 类型 | 说明 |
|--------|------|------|
| `memory_add` | 写 | 写入长期记忆，支持 6 种类型（decision/preference/milestone/problem/emotional/fact） |
| `memory_search` | 只读 | 语义搜索记忆（向量或 TF-IDF 降级） |
| `memory_recall` | 只读 | 按 wing/room 过滤列出记忆（L2 层） |
| `memory_fact` | 写 | 向知识图谱写入三元组（主语-谓语-宾语） |
| `memory_status` | 只读 | 查看记忆系统统计（总数、类型分布、知识图谱规模） |

---

## 四、内置 Skill 清单（8 个）

| 命令 | 功能 |
|------|------|
| `/commit` | 分析 git diff，生成 Conventional Commits 规范提交信息并提交 |
| `/review` | 代码审查，输出结构化报告（必须修复 / 建议改进 / 优点） |
| `/explain` | 深入解释代码工作原理（整体功能、核心逻辑、设计决策、依赖关系） |
| `/fix` | 分析并修复 bug（定位根因 → 制定方案 → 实施 → 验证） |
| `/scaffold` | 生成项目/模块骨架代码（最小化原则，可直接运行） |
| `/refactor` | 代码重构，保持行为不变（命名/拆分/消除重复/简化条件/类型安全） |
| `/test` | 生成单元测试（happy path + 边界条件 + 错误路径） |
| `/docs` | 生成文档注释或 README |

---

## 五、多提供商支持详情

| 提供商 | 环境变量 | 自动识别前缀 |
|--------|---------|------------|
| Anthropic | `ANTHROPIC_API_KEY` | `claude-` |
| OpenAI | `OPENAI_API_KEY` | `gpt-`, `o1`, `o3`, `o4` |
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek-` |
| Groq | `GROQ_API_KEY` | `llama`, `mixtral`, `gemma` |
| 阿里云百炼 | `DASHSCOPE_API_KEY` | `qwen`, `qwq-`, `qvq-` |
| 智谱 AI | `ZHIPU_API_KEY` | `glm-`, `cogview-` |
| NVIDIA | `NVIDIA_API_KEY` | 需 `--provider nvidia` |
| Ollama | 无需 Key | localhost 自动识别 |
| 自定义 | `CUSTOM_API_KEY` | 需 `--provider custom --base-url` |

---

## 六、记忆系统架构（4 层）

```
L0 身份层    (~100 tokens)   — 固定身份定义，每次注入 system prompt
L1 核心摘要  (~500-800 tokens) — 按重要性排序的记忆摘要，按 room 分组
L2 按需检索  (~200-500 tokens) — 按 wing/room 过滤，工具调用触发
L3 语义搜索  (按需)           — sqlite-vec KNN / TF-IDF 降级
```

向量后端通过 `VECTOR_STORE` 环境变量切换：`sqlite`（默认）/ `pgvector` / `seekdb`

---

## 七、第二轮修复内容（2026-04-13）

本轮修复的是深层 bug，而非表面功能缺失：

**P1 — 直接影响功能**
- `GrepTool` 重写为纯 Node.js，彻底解决 Windows 兼容性（原依赖系统 grep/rg）
- `GlobTool` 改用 `getGlobalCwd()` 跟随 bash `cd`（原用 `process.cwd()` 导致路径错乱）
- `AgentTool` 改为从 `TeamManager` 继承 provider/tools，修复循环依赖
- `TeamManager` 新增 `getProvider()` / `getBaseTools()` 接口

**P2 — 影响使用质量**
- `PermissionManager` / `ContextBuilder` 路径统一为 `.hrids-agent`（原混用 `.my-agent`）
- `FileReadTool` 默认显示行号，提升 LLM 代码定位精度
- `WebFetchTool` HTML 解析重写，正确移除 script/style，解码 HTML 实体

**P3 — 体验优化**
- Ctrl+C 在任务运行中改为中断任务（而非退出），底部状态栏动态提示
- 新增 `--cwd` 参数和 `config.agentCwd` 配置项
- 新增 `/refactor`、`/test`、`/docs` 三个内置 skill

---

## 八、当前真实缺口

| 缺口 | 影响 | 优先级 | 状态 |
|------|------|--------|------|
| 无路径级权限控制 | 无法限制"只能改 src/，不能改 .env" | 中 | ✅ 已修复 |
| AgentTool 无 worktree 隔离 | 并行子智能体可能互相干扰文件系统 | 中 | ✅ 已修复 |
| OpenAIProvider Zod→JSON Schema 转换简陋 | 复杂嵌套类型无法正确转换，工具调用可能失败 | 中 | ✅ 已修复 |
| 子智能体无记忆快照 | 子智能体不继承父智能体的记忆上下文 | 低 | ✅ 已修复 |
| 无 LSP 工具 | 无法做代码诊断、跳转定义 | 低 | 待实现 |
| 无 Notebook 支持 | 不能操作 Jupyter .ipynb 文件 | 低 | 待实现 |

---

## 九、第三轮修复内容（2026-04-13）

**缺口 1 — OpenAIProvider Zod→JSON Schema 重写**
原实现只支持 4 种基础类型，`ZodEnum`、`ZodOptional`、`ZodUnion`、`ZodRecord`、`ZodLiteral`、`ZodNullable` 等全部降级为 `string`，导致非 Anthropic 提供商工具调用参数校验失败。重写为完整实现，支持所有常用 Zod 类型，正确处理 `Optional` 包装和 `required` 字段推断。

**缺口 2 — 路径级权限控制**
`PermissionManager` 新增 `allowedPaths`（白名单）和 `deniedPaths`（黑名单）两类路径规则，持久化到 `~/.hrids-agent/permission-rules.json`。`ToolDef` 接口新增可选 `getFilePath()` 方法，`FileWriteTool` 和 `FileEditTool` 已实现。`QueryEngine` 调用权限检查时自动传入路径。优先级：`deniedPaths` > `allowedPaths` 白名单 > 工具级规则 > 模式默认值。

**缺口 3 — AgentTool worktree 隔离**
`agent` 工具新增 `isolated` 参数（默认 `false`）。设为 `true` 时，子智能体在 `os.tmpdir()` 下创建独立临时目录，执行完毕后自动清理并恢复父智能体工作目录。并行任务建议开启，避免文件系统竞争。

**缺口 4 — 子智能体记忆快照**
`AgentTool` 和 `AgentPool` 在创建子智能体时，自动读取 L0+L1 记忆层注入 system prompt。记忆系统不可用时静默跳过，不影响主流程。

---

## 十、结论

hrids-agent 现在已经能够作为独立开发者工作者处理真实的开发任务：

- 单文件到多文件的代码修改 ✅
- 代码库搜索与理解（跨平台 grep + glob）✅
- 网络文档查询（web_fetch + web_search）✅
- 复杂任务规划与追踪（todo + plan mode）✅
- 并行子任务分解（team + agent_spawn，支持 worktree 隔离）✅
- 项目上下文感知（git 状态 + CLAUDE.md）✅
- 长期记忆（4 层向量化存储 + 知识图谱，子智能体继承）✅
- 多模型支持（9 个提供商，自动识别，完整 JSON Schema 转换）✅
- 路径级权限控制（allowedPaths / deniedPaths）✅
- 作为服务被外部调用（gateway 模式）✅
