# hrids-agent 设计与功能清单

> 生成日期: 2026-05-13
> 用途: 与需求文档比对，评估项目完成度

---

## 一、项目基础信息

| 项目 | 值 |
|------|-----|
| 项目名称 | hrids-agent |
| 版本 | 1.0.0 |
| 模块类型 | ESM (`"type": "module"`) |
| TypeScript | 5.7 |
| Node.js | >=18 |
| 入口文件 | `src/main.ts` |
| 测试框架 | Vitest |
| 前端构建 | Vite + React 18 |

### 核心依赖

| 类别 | 依赖 |
|------|------|
| AI/LLM | @anthropic-ai/sdk, @modelcontextprotocol/sdk |
| 数据库 | better-sqlite3, sqlite-vec |
| CLI | commander |
| Web 服务 | express, ws |
| 终端 UI | ink, react |
| 图片处理 | sharp |
| 数据校验 | zod |
| 配置 | js-yaml |
| 鉴权 | jsonwebtoken |
| 文件解析 | mammoth (Word), xlsx (Excel) |
| 其他 | qrcode |

---

## 二、目录结构

```
src/
├── main.ts                    # 入口：CLI 解析、模式分发
├── core/                      # 核心引擎层
│   ├── Config.ts              # YAML 配置加载
│   ├── QueryEngine.ts         # LLM 循环执行引擎
│   ├── ConversationStore.ts   # 事件溯源存储
│   ├── projections.ts         # 双投影（显示/LLM）
│   ├── ToolRegistry.ts        # 工具注册中心
│   ├── ToolScheduler.ts       # 工具并行调度
│   ├── Tool.ts                # 工具抽象定义
│   ├── PermissionManager.ts   # 三级权限管理
│   ├── ContextBuilder.ts      # 系统上下文构建
│   ├── CommandSafety.ts       # 命令安全分析
│   ├── NetworkPolicy.ts       # 网络访问策略
│   ├── MediaProcessor.ts      # 图片/PDF 处理
│   ├── StormBreaker.ts        # 重复调用防抖
│   ├── FileLeaseManager.ts    # 文件写入锁
│   ├── CostTracker.ts         # 成本追踪
│   ├── SessionStore.ts        # 会话持久化
│   ├── logger.ts              # 结构化日志
│   ├── LlmError.ts            # LLM 错误类型
│   ├── cwd.ts                 # 会话级工作目录
│   ├── sessionContext.ts      # 会话上下文
│   ├── proxySetup.ts          # 系统代理检测
│   ├── postRunHooks.ts        # 记忆提炼+技能沉淀
│   ├── retry.ts               # 指数退避重试
│   ├── audit.ts               # 审计日志
│   ├── schema.ts              # Zod→JSON Schema
│   ├── CommandRegistry.ts     # 斜杠命令注册
│   ├── coordinator/           # 多智能体协调
│   │   ├── coordinatorPrompt.ts
│   │   ├── AgentPool.ts
│   │   ├── MessageBus.ts
│   │   ├── TeamManager.ts
│   │   ├── ProfileLoader.ts
│   │   └── agentContext.ts
│   └── providers/             # LLM 提供商层
│       ├── types.ts
│       ├── registry.ts
│       ├── FallbackProvider.ts
│       ├── AnthropicProvider.ts
│       └── OpenAIProvider.ts
├── tools/                     # 工具实现层
│   ├── index.ts               # 30+ 工具注册
│   ├── BashTool.ts
│   ├── PowerShellTool.ts
│   ├── FileReadTool.ts
│   ├── FileWriteTool.ts
│   ├── FileEditTool.ts
│   ├── GlobTool.ts
│   ├── GrepTool.ts
│   ├── WebSearchTool.ts
│   ├── WebFetchTool.ts
│   ├── TodoTool.ts            # 5 子工具
│   ├── AskUserTool.ts
│   ├── DecisionTool.ts
│   ├── AgentTool.ts           # 5 子工具
│   ├── TeamTools.ts           # 6 子工具
│   ├── ScheduleCronTool.ts
│   ├── McpTool.ts
│   ├── SkillTool.ts
│   ├── SkillHubTool.ts
│   └── WorkdirTools.ts        # 4 子工具
├── memory/                    # 长期记忆系统
│   ├── types.ts
│   ├── store.ts
│   ├── layers.ts
│   ├── pipeline.ts
│   ├── extractor.ts
│   ├── embedding.ts
│   ├── vectorStore.ts
│   ├── MemoryTool.ts          # 6 子工具
│   └── index.ts
├── gateway/                   # HTTP+WebSocket 网关
│   ├── server.ts
│   ├── SessionManager.ts
│   ├── types.ts
│   └── im/                    # IM 平台接入
│       ├── types.ts
│       ├── BasePlatformAdapter.ts
│       ├── PlatformManager.ts
│       └── platforms/
│           ├── telegram.ts
│           ├── weixin.ts
│           └── webhook.ts
├── modes/                     # 运行模式
│   ├── interactiveMode.ts
│   ├── printMode.ts
│   ├── serverMode.ts
│   └── gatewayMode.ts
├── skills/                    # 技能系统
│   ├── types.ts
│   ├── registry.ts
│   ├── bundled/index.ts
│   └── index.ts
├── tui/                       # 终端 UI
│   ├── App.tsx
│   ├── InkRenderer.ts
│   └── SimpleTextInput.tsx
├── bootstrap/                 # 启动引导
└── commands/                  # 斜杠命令

web/src/                       # Web 前端
├── App.tsx
├── main.tsx
├── index.css
├── components/                # ~30 个组件
├── store/                     # 8 个 Zustand store
├── lib/                       # 工具库
└── i18n/                      # 国际化

tests/unit/                    # 27 个单元测试
```

---

## 三、核心架构设计

### 3.1 事件溯源对话架构

| 设计点 | 说明 | 文件 |
|--------|------|------|
| 事件类型 | 7 种: UserMessage, AssistantMessage, ToolResult, Compact, RequestComplete, System, ToolExecution | [ConversationStore.ts](src/core/ConversationStore.ts) |
| 存储方式 | JSONL 追加写入，不可变事件日志 | ConversationStore.ts |
| 显示投影 | 事件 → 用户气泡 + 工具卡片 | [projections.ts](src/core/projections.ts) |
| LLM 投影 | 事件 → LLM 消息格式，含裁剪优化 | projections.ts |
| Token 估算 | CJK 感知，中日韩字符按 2 token 计算 | projections.ts |
| 工具结果截断 | 头尾截断策略 | projections.ts |

### 3.2 LLM 执行循环

| 功能 | 说明 | 文件 |
|------|------|------|
| 主循环 | send() 方法，LLM→工具→LLM 循环 | [QueryEngine.ts](src/core/QueryEngine.ts) |
| 流式接收 | streamOneTurn() 流式处理 | QueryEngine.ts |
| 工具验证 | 3 阶段: 工具查找→权限检查→Zod 验证→Storm Breaker | QueryEngine.ts |
| 工具执行 | 按 parallelSafe 分区，串行/并行混合 | QueryEngine.ts |
| 心跳协议 | CONTINUE/DONE 标记，max_output_tokens 自动恢复（最多 3 次） | QueryEngine.ts |
| 自动压缩 | token 超阈值（默认 100k）时 LLM 生成结构化摘要 | QueryEngine.ts |
| 成本预算 | maxBudgetUsd 阈值控制 | QueryEngine.ts |
| 多模态 | 图片 ContentBlock 支持 | QueryEngine.ts |

### 3.3 多提供商 LLM 系统

| 设计点 | 说明 | 文件 |
|--------|------|------|
| 传输协议 | 两种: anthropic_messages (SDK) / openai_chat (fetch API) | providers/ |
| 故障转移 | 按平台分组，指数退避重试（3 次/模型），记住成功位置 | [FallbackProvider.ts](src/core/providers/FallbackProvider.ts) |
| 空响应检测 | 自动重试空响应 | FallbackProvider.ts |

### 3.4 工具系统

| 设计点 | 说明 | 文件 |
|--------|------|------|
| 工具抽象 | ToolDef 接口: name, description, inputSchema(Zod), readonly, isDestructive, stormExempt, capabilities | [Tool.ts](src/core/Tool.ts) |
| 能力声明 | ToolCapabilities: requiresNetwork, requiresShell, isInteractive, parallelSafe, maxExecutionTimeMs | Tool.ts |
| 自动扁平化 | 分析 schema 深度，预计算扁平版本（解决某些模型丢失深层参数） | [ToolRegistry.ts](src/core/ToolRegistry.ts) |
| 并行调度 | ToolScheduler 按 parallelSafe 分区执行 | [ToolScheduler.ts](src/core/ToolScheduler.ts) |
| 拦截器 | 支持拦截器、审计监听器、结果增强器 | ToolRegistry.ts |

### 3.5 多智能体协调

| 设计点 | 说明 | 文件 |
|--------|------|------|
| 子智能体池 | Semaphore 并发控制，隔离 sessionId/cwd，继承记忆 | [AgentPool.ts](src/core/coordinator/AgentPool.ts) |
| 消息总线 | 点对点 + 广播，队列 + 实时订阅者模式 | [MessageBus.ts](src/core/coordinator/MessageBus.ts) |
| 团队管理 | 团队生命周期，每会话隔离（Gateway 模式） | [TeamManager.ts](src/core/coordinator/TeamManager.ts) |
| 配置加载 | 多目录: 项目 .hrids/specialists/ > 全局 ~/.hrids/specialists/ > 配置内联 | [ProfileLoader.ts](src/core/coordinator/ProfileLoader.ts) |
| 系统提示词 | 8 静态段 + 9 种任务扩展类型 | [coordinatorPrompt.ts](src/core/coordinator/coordinatorPrompt.ts) |

### 3.6 权限管理

| 模式 | 说明 | 文件 |
|------|------|------|
| ask | 逐次确认 | [PermissionManager.ts](src/core/PermissionManager.ts) |
| craft | 自主执行 | PermissionManager.ts |
| plan | 只读模式 | PermissionManager.ts |
| 持久化规则 | alwaysAllow, alwaysDeny, alwaysAsk, allowedPaths, deniedPaths | PermissionManager.ts |
| 规则格式 | "bash(git *)" + glob 匹配 | PermissionManager.ts |
| 拒绝追踪 | 连续/总计阈值 | PermissionManager.ts |

---

## 四、工具系统详细清单

### 4.1 Shell 工具

| 工具 | 功能 | 安全特性 | 文件 |
|------|------|----------|------|
| BashTool | Shell 命令执行 | 危险命令黑名单(20+), cd 拦截, 只读白名单(plan), 超时(120s) | [BashTool.ts](src/tools/BashTool.ts) |
| PowerShellTool | PowerShell 执行 | 同 BashTool | [PowerShellTool.ts](src/tools/PowerShellTool.ts) |

### 4.2 文件工具

| 工具 | 功能 | 文件 |
|------|------|------|
| FileReadTool | 文件读取 | [FileReadTool.ts](src/tools/FileReadTool.ts) |
| FileWriteTool | 文件写入 | [FileWriteTool.ts](src/tools/FileWriteTool.ts) |
| FileEditTool | 文件编辑（diff 方式） | [FileEditTool.ts](src/tools/FileEditTool.ts) |
| GlobTool | 文件名模式搜索 | [GlobTool.ts](src/tools/GlobTool.ts) |
| GrepTool | 文件内容正则搜索 | [GrepTool.ts](src/tools/GrepTool.ts) |

### 4.3 网络工具

| 工具 | 功能 | 文件 |
|------|------|------|
| WebSearchTool | 网络搜索 | [WebSearchTool.ts](src/tools/WebSearchTool.ts) |
| WebFetchTool | 网页内容抓取 | [WebFetchTool.ts](src/tools/WebFetchTool.ts) |

### 4.4 任务管理工具 (TodoTool)

| 子工具 | 功能 | 文件 |
|--------|------|------|
| todo_write | 创建任务 | [TodoTool.ts](src/tools/TodoTool.ts) |
| todo_update | 更新任务状态 | TodoTool.ts |
| todo_append | 追加任务 | TodoTool.ts |
| todo_reset | 重置任务列表 | TodoTool.ts |
| todo_read | 读取任务列表 | TodoTool.ts |

数据结构: id, content, status, priority, acceptanceCriteria, dependsOn, context

### 4.5 用户交互工具

| 工具 | 功能 | 模式支持 | 文件 |
|------|------|----------|------|
| AskUserTool | 向用户提问 | CLI / Server(NDJSON) / Gateway(WebSocket) | [AskUserTool.ts](src/tools/AskUserTool.ts) |
| DecisionTool | 结构化决策框架 | 选项、风险级别、推荐 | [DecisionTool.ts](src/tools/DecisionTool.ts) |

### 4.6 智能体工具 (AgentTool)

| 子工具 | 功能 | 文件 |
|--------|------|------|
| agent | 阻塞式子智能体调用 | [AgentTool.ts](src/tools/AgentTool.ts) |
| agent_spawn | 异步启动子智能体 | AgentTool.ts |
| agent_wait | 等待子智能体完成 | AgentTool.ts |
| agent_cancel | 取消子智能体 | AgentTool.ts |
| agent_list | 列出活跃子智能体 | AgentTool.ts |

特性: ProfileLoader 解析、隔离 worktree、记忆上下文继承

### 4.7 团队工具 (TeamTools)

| 子工具 | 功能 | 文件 |
|--------|------|------|
| team_create | 创建团队 | [TeamTools.ts](src/tools/TeamTools.ts) |
| team_delete | 删除团队 | TeamTools.ts |
| agent_spawn | 团队内启动智能体 | TeamTools.ts |
| team_status | 团队状态查询 | TeamTools.ts |
| team_wait | 等待团队完成 | TeamTools.ts |
| send_message | 发送消息 | TeamTools.ts |
| receive_message | 接收消息 | TeamTools.ts |

### 4.8 调度工具

| 工具 | 功能 | 文件 |
|------|------|------|
| ScheduleCronTool | 5 字段 cron 表达式，持久化到 ~/.hrids/crons.json，mutex 并发保护，支持一次性/周期任务、起止日期、会话路由 | [ScheduleCronTool.ts](src/tools/ScheduleCronTool.ts) |

### 4.9 协议集成

| 工具 | 功能 | 文件 |
|------|------|------|
| McpTool | MCP 协议集成，连接池(30min 空闲超时)，会话级隔离，自动注册为 mcp__serverName__toolName | [McpTool.ts](src/tools/McpTool.ts) |

### 4.10 技能工具

| 工具 | 功能 | 文件 |
|------|------|------|
| SkillTool | 从 SkillRegistry 查找技能并注入 prompt | [SkillTool.ts](src/tools/SkillTool.ts) |
| SkillHubTool | 技能市场（搜索/安装/卸载） | [SkillHubTool.ts](src/tools/SkillHubTool.ts) |

### 4.11 记忆工具 (MemoryTool)

| 子工具 | 功能 | 文件 |
|--------|------|------|
| memory_add | 添加记忆 | [MemoryTool.ts](src/memory/MemoryTool.ts) |
| memory_search | 向量/关键词混合搜索 | MemoryTool.ts |
| memory_recall | 按需检索 | MemoryTool.ts |
| memory_fact | 知识图谱三元组操作 | MemoryTool.ts |
| memory_update | 更新记忆 | MemoryTool.ts |
| memory_status | 记忆状态查询 | MemoryTool.ts |

### 4.12 工作目录工具 (WorkdirTools)

| 子工具 | 功能 | 文件 |
|--------|------|------|
| workdir_init | 初始化工作目录 | [WorkdirTools.ts](src/tools/WorkdirTools.ts) |
| workdir_deliver | 交付产物 | WorkdirTools.ts |
| workdir_cleanup | 清理工作目录 | WorkdirTools.ts |
| workdir_list | 列出工作目录 | WorkdirTools.ts |

---

## 五、记忆系统

### 5.1 四层记忆架构

| 层级 | 名称 | 功能 | 文件 |
|------|------|------|------|
| L0 | 核心摘要 | 时间衰减排序，3200 字符上限，每次对话注入 | [layers.ts](src/memory/layers.ts) |
| L1 | 按需检索 | 按重要性排序，recall() 调用 | layers.ts |
| L2 | 深度搜索 | 向量/关键词混合搜索 | layers.ts |
| L3 | 知识图谱 | 三元组 (subject, predicate, object)，置信度，有效期 | layers.ts |

### 5.2 记忆存储

| 组件 | 说明 | 文件 |
|------|------|------|
| 存储层 | JSONL 桶文件 + SQLite 向量索引 | [store.ts](src/memory/store.ts) |
| 存储路径 | ~/.hrids/agents/{agent}/memory/ | store.ts |
| 桶文件 | facts.jsonl, preferences.jsonl, decisions.jsonl | store.ts |

### 5.3 记忆处理管道

| 阶段 | 说明 | 文件 |
|------|------|------|
| 提取 | extractFromConversation() 正则提取 | [extractor.ts](src/memory/extractor.ts) |
| 提炼 | LLM 批量提炼（一次调用压缩多条） | [pipeline.ts](src/memory/pipeline.ts) |
| 去重 | 向量相似度去重 | pipeline.ts |
| 写入 | 写入 JSONL + 向量索引 | pipeline.ts |

### 5.4 向量系统

| 组件 | 说明 | 文件 |
|------|------|------|
| 嵌入后端 | OpenAI API / Ollama 本地 / TF-IDF 降级 | [embedding.ts](src/memory/embedding.ts) |
| 故障转移 | EmbeddingFallbackProvider 多模型切换 | embedding.ts |
| 缓存 | 内存缓存 1000 条目 | embedding.ts |
| 向量存储 | sqlite-vec(默认) / pgvector / SeekDB | [vectorStore.ts](src/memory/vectorStore.ts) |

### 5.5 自动沉淀

| 功能 | 说明 | 文件 |
|------|------|------|
| 记忆提炼 | 会话结束自动提取记忆 | [postRunHooks.ts](src/core/postRunHooks.ts) |
| 技能沉淀 | 会话结束自动沉淀技能 | postRunHooks.ts |

---

## 六、网关与 IM 集成

### 6.1 HTTP 网关

| 功能 | 说明 | 文件 |
|------|------|------|
| 服务框架 | Express v5 + WebSocketServer | [server.ts](src/gateway/server.ts) |
| 鉴权模式 | 无鉴权 / 静态 Token / JWT 登录 | server.ts |
| 速率限制 | 令牌桶算法，按 IP 限流 | server.ts |
| CORS | 跨域中间件 | server.ts |
| 静态文件 | SPA fallback | server.ts |

### 6.2 REST API 端点

| 类别 | 端点 |
|------|------|
| 会话 | CRUD、消息历史 |
| 文件 | 浏览、预览（Word/Excel/CSV） |
| 定时任务 | CRUD |
| MCP | 配置管理 |
| 技能 | 管理、市场搜索/安装/卸载 |
| IM | 平台管理 |
| 配置 | 查看/修改 |
| 日志 | 查看 |
| 用量 | 统计 |

### 6.3 WebSocket 协议

| 功能 | 说明 |
|------|------|
| 实时事件流 | 服务端推送对话事件 |
| 权限询问/回复 | ask_user 交互流程 |
| 模式切换 | 动态切换权限模式 |

### 6.4 会话管理器

| 功能 | 说明 | 文件 |
|------|------|------|
| 生命周期 | create / destroy / subscribe / unsubscribe | [SessionManager.ts](src/gateway/SessionManager.ts) |
| 空闲超时 | 默认 30 分钟自动销毁 | SessionManager.ts |
| 并发限制 | 最大 20 个会话 | SessionManager.ts |
| 事件回放 | 200 条缓冲区 | SessionManager.ts |
| 视觉模型 | 自动切换 | SessionManager.ts |
| 轮次续跑 | 轮次上限自动续跑 | SessionManager.ts |
| 优雅关闭 | 信号处理 | SessionManager.ts |

### 6.5 IM 平台接入

| 平台 | 功能 | 文件 |
|------|------|------|
| Telegram | Bot API 适配 | [telegram.ts](src/gateway/im/platforms/telegram.ts) |
| 微信 | 个人号 (iLink Bot API)，扫码登录 | [weixin.ts](src/gateway/im/platforms/weixin.ts) |
| Webhook | 通用 HTTP 回调 | [webhook.ts](src/gateway/im/platforms/webhook.ts) |

### 6.6 IM 公共功能

| 功能 | 说明 | 文件 |
|------|------|------|
| 消息合并 | 图片+文字 4 秒合并窗口 | [PlatformManager.ts](src/gateway/im/PlatformManager.ts) |
| 流式缓冲 | 1.5 秒编辑间隔 | PlatformManager.ts |
| 处理锁 | 防并发处理 | PlatformManager.ts |
| 会话映射 | IM key → agent session ID 持久化 | PlatformManager.ts |
| 内置命令 | /new, /reset, /status, /stop, /help | PlatformManager.ts |
| 图片落盘 | IM 图片转 @filename 引用 | PlatformManager.ts |

---

## 七、运行模式

| 模式 | 触发方式 | 功能 | 文件 |
|------|----------|------|------|
| 交互模式 | 默认 | Ink React TUI, alternate screen, Cell 级 diff 渲染, stderr 拦截, raw mode | [interactiveMode.ts](src/modes/interactiveMode.ts) |
| 非交互模式 | `-p` 参数 | 执行一条消息后退出，输出截断(maxChars) | [printMode.ts](src/modes/printMode.ts) |
| 管道模式 | `--server` | NDJSON stdin/stdout, 斜杠命令, Promise 链串行, 支持 user_reply/decision_reply/abort/set_cwd | [serverMode.ts](src/modes/serverMode.ts) |
| 网关模式 | `--gateway` | HTTP+WebSocket 服务, cron 触发回调, 优雅关闭 | [gatewayMode.ts](src/modes/gatewayMode.ts) |

---

## 八、技能系统

### 8.1 技能注册表

| 功能 | 说明 | 文件 |
|------|------|------|
| 优先级 | 3 级: project > user > bundled | [registry.ts](src/skills/registry.ts) |
| Frontmatter | description, when-to-use, argument-hint, allowed-tools, user-invocable | registry.ts |
| 文件引用 | `#[[file:relative_path]]` 语法 | registry.ts |
| 参数替换 | `{{args}}` 占位符 | registry.ts |
| 禁用列表 | 用户可禁用特定技能 | registry.ts |

### 8.2 技能目录

| 级别 | 路径 |
|------|------|
| 项目级 | `.hrids/skills/` |
| 用户级 | `~/.hrids/skills/` |
| 内置 | 代码内 bundled/ |

### 8.3 内置技能

| 技能 | 功能 |
|------|------|
| /research | 深度调研 |
| /plan | 制定执行计划 |

---

## 九、终端 UI (TUI)

| 组件 | 功能 | 文件 |
|------|------|------|
| App.tsx | 主组件: 消息历史、流式渲染、工具进度、ask_user、斜杠命令、cron 队列、状态栏 | [App.tsx](src/tui/App.tsx) |
| InkRenderer.ts | Cell 级 diff: ANSI 解析→cell grid→diff→DEC 2026 同步输出, CJK 宽字符, 帧缓冲 | [InkRenderer.ts](src/tui/InkRenderer.ts) |
| SimpleTextInput.tsx | 文本输入组件 | [SimpleTextInput.tsx](src/tui/SimpleTextInput.tsx) |

---

## 十、Web 前端

### 10.1 技术栈

| 技术 | 用途 |
|------|------|
| React 18 | UI 框架 |
| Vite | 构建工具 |
| Zustand | 状态管理 |
| i18n | 国际化 (zh-CN / en-US) |

### 10.2 页面

| 页面 | 功能 |
|------|------|
| ChatPage | 主聊天界面 |
| AutomationPage | 自动化任务 |
| ConnectPage | IM 渠道管理 |
| ModelPage | 模型配置 |
| SettingsPage | 设置（通用/配置/渠道/日志/用量） |
| SkillsPage | 技能市场 |
| ZhilePage | 智乐页面 |

### 10.3 组件

| 类别 | 组件 |
|------|------|
| chat/ | AgentTurn, InputBar, MessageItem, MessageList, ToolCard |
| layout/ | NavBar, RightPanel, StatusBar |
| modals/ | AskUserModal, ConfirmModal, DecisionModal, NewSessionModal, PermissionModal, WeixinConnectModal |
| panel/ | FileContentModal, FileTreeNode, FileTreeView, TodoArtifacts, TodoItem |
| ui/ | Toast |

### 10.4 状态管理 (Zustand Store)

| Store | 功能 |
|-------|------|
| automationStore | 自动化任务状态 |
| connectionStore | 连接状态 |
| fileTreeStore | 文件树状态 |
| i18nStore | 国际化状态 |
| messageStore | 消息状态 |
| sessionStore | 会话状态 |
| themeStore | 主题状态 |
| todoStore | 任务状态 |

### 10.5 工具库

| 文件 | 功能 |
|------|------|
| gateway.ts | API 客户端 |
| markdown.ts | Markdown 渲染 |
| types.ts | 类型定义 |
| wsClient.ts | WebSocket 客户端 |

---

## 十一、安全与防护

| 功能 | 说明 | 文件 |
|------|------|------|
| 命令安全分析 | 20+ 规则, 4 级风险 (low/medium/high/critical), 平台特定规则 | [CommandSafety.ts](src/core/CommandSafety.ts) |
| 网络访问策略 | 域名级控制, 默认阻止云元数据/localhost/私有 IP, 白名单/黑名单 | [NetworkPolicy.ts](src/core/NetworkPolicy.ts) |
| 路径穿越检查 | 防止目录遍历攻击 | PermissionManager / BashTool |
| 重复调用防抖 | 滑动窗口(10 调用), 阈值 3 次连续相同调用 | [StormBreaker.ts](src/core/StormBreaker.ts) |
| 文件写入锁 | 进程级协作锁, 10 分钟 TTL | [FileLeaseManager.ts](src/core/FileLeaseManager.ts) |
| JWT 鉴权 | 网关登录认证 | gateway server.ts |
| 速率限制 | 令牌桶算法, 按 IP | gateway server.ts |
| 审计日志 | 权限检查、会话创建/销毁记录 | [audit.ts](src/core/audit.ts) |

---

## 十二、辅助系统

| 功能 | 说明 | 文件 |
|------|------|------|
| 结构化日志 | JSON 格式, ~/.hrids/logs/agent.log, 10MB 轮转, child logger | [logger.ts](src/core/logger.ts) |
| 成本追踪 | 每模型定价表, input/output/cacheRead/cacheWrite, 前缀匹配 | [CostTracker.ts](src/core/CostTracker.ts) |
| 指数退避重试 | maxAttempts/baseDelayMs/maxDelayMs/jitter 可配置, LlmError 结构化判断 | [retry.ts](src/core/retry.ts) |
| LlmError | 结构化错误码, retryable 判断, retryAfterMs | [LlmError.ts](src/core/LlmError.ts) |
| 系统代理检测 | Windows 注册表 / macOS networksetup / Linux gsettings | [proxySetup.ts](src/core/proxySetup.ts) |
| 媒体处理 | sharp 图片压缩(最大 1568px, JPEG 85), LRU 缓存(50), @filename 引用, PDF 直传 | [MediaProcessor.ts](src/core/MediaProcessor.ts) |
| 上下文构建 | Git 状态, AGENT.md(3 位置), 记忆堆栈, 环境信息, Python venv, 上传文件 | [ContextBuilder.ts](src/core/ContextBuilder.ts) |
| 斜杠命令 | 命令注册与分发 | [CommandRegistry.ts](src/core/CommandRegistry.ts) |
| 会话工作目录 | AsyncLocalStorage 会话隔离 | [cwd.ts](src/core/cwd.ts) |
| 会话上下文 | sessionId 传播 | [sessionContext.ts](src/core/sessionContext.ts) |

---

## 十三、配置系统

### 13.1 配置文件

| 项目 | 值 |
|------|-----|
| 主配置 | `~/.hrids/config.yaml` (YAML 格式, JSON 兼容) |
| 旧路径迁移 | `~/.hrids-agent/` → `~/.hrids/` |
| 缓存机制 | 单例 + mtime 失效 |
| 示例配置 | `config.example.yaml` |

### 13.2 配置项

| 类别 | 配置项 |
|------|--------|
| LLM | llm.fallbacks (多模型故障转移组) |
| 视觉 | vision (视觉模型配置) |
| 多模态 | multimodal |
| 语音 | speech |
| 嵌入 | embedding.fallbacks |
| 向量存储 | vectorStore (sqlite-vec/pgvector/SeekDB) |
| 智能体行为 | maxTokens, maxTurns, maxBudgetUsd, autoCompactThreshold, permissionMode |
| 命令安全 | commandSafety |
| 网络策略 | networkPolicy |
| 网关 | gateway.port, gateway.host, gateway.users, gateway.jwtSecret |
| 日志 | logging |
| 技能市场 | skillHub |
| 自定义提供商 | customProviders |
| MCP | mcpServers |
| 多智能体 | multiAgent.agents, multiAgent.profiles |
| 工具权限 | toolPermissions |

---

## 十四、测试覆盖

### 14.1 测试文件清单 (27 个)

| 类别 | 测试文件 | 覆盖模块 |
|------|----------|----------|
| 核心 | QueryEngine.test.ts | 执行引擎 |
| 核心 | ConversationStore.test.ts | 事件溯源 |
| 核心 | Config.test.ts | 配置加载 |
| 核心 | PermissionManager.test.ts | 权限管理 |
| 核心 | projections.test.ts | 双投影 |
| 核心 | retry.test.ts | 重试机制 |
| 核心 | schema.test.ts | Zod→JSON Schema |
| 核心 | CostTracker.test.ts | 成本追踪 |
| 核心 | SessionStore.test.ts | 会话持久化 |
| 核心 | sessionContext.test.ts | 会话上下文 |
| 核心 | logger.test.ts | 日志系统 |
| 核心 | pathSafety.test.ts | 路径安全 |
| 核心 | flatten.test.ts | Schema 扁平化 |
| 工具 | BashTool.test.ts | Shell 工具 |
| 工具 | FileTools.test.ts | 文件工具 |
| 工具 | GlobTool.test.ts | 文件搜索 |
| 工具 | GrepTool.test.ts | 内容搜索 |
| 工具 | PowerShellTool.test.ts | PowerShell |
| 工具 | TodoTool.test.ts | 任务管理 |
| 工具 | TodoTools.test.ts | 任务工具 |
| 工具 | Tool.test.ts | 工具抽象 |
| 协调 | MessageBus.test.ts | 消息总线 |
| 协调 | CommandRegistry.test.ts | 斜杠命令 |
| 协调 | ScheduleCronTool.test.ts | 定时任务 |
| 记忆 | extractor.test.ts | 记忆提取 |
| 配置 | YamlLoader.test.ts | YAML 加载 |
| 网关 | RateLimiter.test.ts | 速率限制 |

---

## 十五、功能统计汇总

| 维度 | 数量 |
|------|------|
| **核心模块** | 8 个 (Config / QueryEngine / ConversationStore / ToolRegistry / PermissionManager / ContextBuilder / coordinator / providers) |
| **LLM 提供商** | 13+ (Anthropic, OpenAI, DeepSeek, Groq, Aliyun, Xiaomi, Zhipu, NVIDIA, Ollama, OpenRouter, Kimi, MiniMax, Google Gemini) |
| **工具总数** | 30+ 工具 (含子工具约 50+) |
| **记忆层级** | 4 层 (L0 核心摘要 / L1 按需检索 / L2 深度搜索 / L3 知识图谱) |
| **运行模式** | 4 种 (交互 / 非交互 / 管道 / 网关) |
| **IM 平台** | 3 个 (Telegram / 微信 / Webhook) |
| **安全规则** | 20+ 命令安全规则 + 网络策略 |
| **单元测试** | 27 个文件 |
| **Web 组件** | ~30 个 |
| **Zustand Store** | 8 个 |
| **REST API 端点** | 会话 / 消息 / 文件 / 任务 / MCP / 技能 / IM / 配置 / 日志 / 用量 |
| **配置项类别** | 15+ (LLM / 视觉 / 多模态 / 语音 / 嵌入 / 向量存储 / 行为 / 安全 / 网络 / 网关 / 日志 / 技能市场 / 自定义提供商 / MCP / 多智能体) |

---

## 十六、关键设计模式

| 模式 | 应用位置 |
|------|----------|
| 事件溯源 | ConversationStore - 不可变事件日志 |
| 投影模式 | projections - 同一事件多种视图 |
| 故障转移 | FallbackProvider - 多模型自动切换 |
| 策略模式 | PermissionManager - 三种权限模式 |
| 观察者模式 | ToolRegistry - 审计监听器 |
| 工厂模式 | providers/registry - 提供商创建 |
| 适配器模式 | IM platforms - 统一接口适配不同平台 |
| 管道模式 | memory/pipeline - 提炼流程 |
| 三层架构 | memory/layers - 分层记忆 |
| 连接池 | McpTool - MCP 连接复用 |
| 令牌桶 | RateLimiter - 速率限制 |
| 信号量 | AgentPool - 并发控制 |
| 互斥锁 | ScheduleCronTool / PlatformManager - 并发保护 |
| LRU 缓存 | MediaProcessor / ContextBuilder - 缓存淘汰 |
| 原子写入 | 配置保存 - .tmp + rename |
