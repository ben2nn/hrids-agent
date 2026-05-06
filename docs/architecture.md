# hrids-agent 架构文档

> 版本 0.1.0 | 原创智能体 CLI，借鉴 agentic CLI 架构思想构建
>
> 通用自主工作者 CLI —— 你只做决策，它负责执行。

---

## 目录

1. [项目概览](#1-项目概览)
2. [技术栈](#2-技术栈)
3. [项目结构](#3-项目结构)
4. [核心架构](#4-核心架构)
5. [模块详解](#5-模块详解)
6. [运行模式](#6-运行模式)
7. [启动流程](#7-启动流程)
8. [数据流](#8-数据流)
9. [配置系统](#9-配置系统)
10. [扩展机制](#10-扩展机制)

---

## 1. 项目概览

hrids-agent 是一个 TypeScript 编写的通用自主工作者 CLI 工具，支持多种 LLM 提供商、长期记忆、多智能体协调、定时任务调度和 MCP 工具扩展。用户只需做决策，智能体自动负责执行。

### 核心能力

| 能力 | 说明 |
|------|------|
| **多 LLM 提供商** | Anthropic / OpenAI / DeepSeek / Groq / 阿里云百炼 / 智谱 / NVIDIA / Ollama 等，自动故障转移 |
| **工具生态** | 20+ 内置工具：文件操作、网络搜索、Shell 执行、任务管理、定时调度等 |
| **运行模式** | 交互式 TUI / 单次执行 / Server(stdin) / Gateway(HTTP+WS) |
| **长期记忆** | 4 层记忆架构 (L0 身份 / L1 摘要 / L2 按需 / L3 语义搜索)，支持 sqlite-vec 向量检索 |
| **多智能体** | 派生子智能体并行处理，团队管理，消息总线通信 |
| **MCP 扩展** | 支持 Model Context Protocol 服务器，兼容 Claude Desktop 格式 |
| **Skill 系统** | 内置 + 用户自定义技能，SkillHub 市场集成，自动沉淀工作流 |
| **定时任务** | Cron 表达式调度，持久化存储，进程重启自动恢复 |
| **权限控制** | 4 级权限模式 (ask/craft/plan/readonly)，细粒度路径和内容规则 |

---

## 2. 技术栈

| 分类 | 技术 | 说明 |
|------|------|------|
| **语言** | TypeScript 5.7 | 严格模式，ES2022 target，ESM 模块 |
| **运行时** | Node.js >= 18.0.0 | ESM (type: "module") |
| **CLI 框架** | Commander v13 | 命令行参数解析 |
| **TUI** | Ink v5 + React 18 | 终端 UI 渲染 |
| **HTTP 服务** | Express v5 | Gateway REST API |
| **WebSocket** | ws v8 | Gateway 实时通信 |
| **AI SDK** | @anthropic-ai/sdk v0.39 | Anthropic API 调用 |
| **MCP** | @modelcontextprotocol/sdk v1.29 | MCP 服务器接入 |
| **数据库** | better-sqlite3 v12 + sqlite-vec v0.1 | 本地向量存储和记忆持久化 |
| **参数校验** | Zod v3 | 工具输入 Schema 定义及运行时校验 |
| **图片处理** | Sharp v0.33 | 图片压缩和格式转换 |
| **文档解析** | mammoth + xlsx | Word/Excel 文件预览 |
| **认证** | jsonwebtoken v9 | Gateway JWT 鉴权 |
| **测试** | Vitest v2 + fast-check | 单元测试 + 属性测试 |
| **前端** | React 18 + Vite | Gateway 内嵌 Web UI（源码位于 `web/`） |

---

## 3. 项目结构

```
hrids-agent/
├── src/
│   ├── main.ts                    # 应用入口，Commander CLI 定义
│   ├── bootstrap/                  # 启动初始化
│   │   ├── setupProvider.ts        # LLM 提供商创建和配置
│   │   └── setupSession.ts         # 会话恢复/创建工作目录
│   ├── core/                       # 核心引擎
│   │   ├── Config.ts               # 配置加载/合并/规范化/缓存
│   │   ├── QueryEngine.ts          # 查询引擎：LLM 调用/工具执行/上下文压缩
│   │   ├── Tool.ts                 # 工具抽象接口和类型定义
│   │   ├── CommandRegistry.ts      # 斜杠命令注册和执行
│   │   ├── ContextBuilder.ts       # 系统上下文构建（Git/环境/记忆）
│   │   ├── PermissionManager.ts    # 权限管理和规则持久化
│   │   ├── SessionStore.ts         # 会话 JSONL 持久化和归档
│   │   ├── CostTracker.ts          # Token 用量和费用追踪
│   │   ├── MediaProcessor.ts       # 多模态媒体预处理
│   │   ├── DsmlParser.ts           # DSML 格式工具调用解析
│   │   ├── coordinator/            # 多智能体协调
│   │   │   ├── AgentPool.ts        # 智能体池（并发控制、任务提交/等待）
│   │   │   ├── TeamManager.ts      # 团队管理器（创建团队、派发任务）
│   │   │   ├── MessageBus.ts       # 智能体间消息总线
│   │   │   ├── coordinatorPrompt.ts # Coordinator system prompt 分层设计
│   │   │   ├── agentContext.ts     # 智能体名称上下文注入
│   │   │   └── sessionContext.ts   # 会话上下文隔离
│   │   ├── providers/              # LLM 提供商适配器
│   │   │   ├── index.ts            # 提供商工厂（自动推断、Fallback 构建）
│   │   │   ├── registry.ts         # 内置/自定义提供商注册
│   │   │   ├── types.ts            # 提供商通用接口定义
│   │   │   ├── AnthropicProvider.ts    # Anthropic Messages API
│   │   │   ├── OpenAIProvider.ts       # OpenAI Chat Completions API
│   │   │   ├── DeepSeekAnthropicProvider.ts # DeepSeek Anthropic 协议
│   │   │   ├── FallbackProvider.ts     # 多平台故障转移
│   │   │   └── dashscopeModels.ts      # 阿里云百炼模型列表
│   │   └── [其他辅助模块]
│   │       ├── logger.ts           # 结构化日志
│   │       ├── audit.ts            # 审计日志
│   │       ├── retry.ts            # 指数退避重试
│   │       ├── cwd.ts              # 全局工作目录管理
│   │       ├── pathSafety.ts       # 路径安全校验
│   │       ├── proxySetup.ts       # 系统代理配置
│   │       ├── schema.ts           # Zod→JSON Schema 转换
│   │       └── postRunHooks.ts     # 会话结束钩子（记忆提炼/Skill 沉淀）
│   ├── tools/                      # 内置工具集 (20+)
│   │   ├── index.ts                # ALL_TOOLS 汇总导出
│   │   ├── BashTool.ts             # Shell 命令执行 (Linux/macOS)
│   │   ├── PowerShellTool.ts       # PowerShell 执行 (Windows)
│   │   ├── FileReadTool.ts         # 文件读取（行范围、分页）
│   │   ├── FileWriteTool.ts        # 文件创建/覆盖
│   │   ├── FileEditTool.ts         # 精准字符串替换
│   │   ├── GlobTool.ts             # 文件路径匹配
│   │   ├── GrepTool.ts             # 内容正则搜索
│   │   ├── WebFetchTool.ts         # 网页内容获取
│   │   ├── WebSearchTool.ts        # 网络搜索
│   │   ├── AskUserTool.ts          # 向用户提问
│   │   ├── DecisionTool.ts         # 结构化决策上报
│   │   ├── TodoTool.ts             # 任务状态机管理 (write/update/append/reset/read)
│   │   ├── ScheduleCronTool.ts     # Cron 定时任务调度
│   │   ├── AgentTool.ts            # 子智能体派生
│   │   ├── TeamTools.ts            # 团队协作工具
│   │   ├── SkillTool.ts            # Skill 调用/列表/保存
│   │   ├── SkillHubTool.ts         # SkillHub 市场集成
│   │   └── McpTool.ts              # MCP 工具动态加载
│   ├── gateway/                    # Gateway HTTP+WS 服务
│   │   ├── server.ts               # Express + WebSocket 服务器
│   │   ├── SessionManager.ts       # 会话生命周期管理
│   │   ├── types.ts                # Gateway 类型定义
│   │   └── im/                     # IM 平台接入
│   │       ├── PlatformManager.ts  # 多平台管理器
│   │       ├── BasePlatformAdapter.ts # 平台适配器基类
│   │       ├── types.ts            # IM 类型
│   │       └── platforms/
│   │           ├── telegram.ts     # Telegram Bot 适配器
│   │           ├── weixin.ts       # 微信适配器
│   │           └── webhook.ts      # Webhook 适配器
│   ├── memory/                     # 长期记忆系统
│   │   ├── index.ts                # 记忆模块入口
│   │   ├── layers.ts               # 4 层记忆堆栈 (L0-L3)
│   │   ├── store.ts                # SQLite 持久化存储
│   │   ├── MemoryTool.ts           # 记忆操作工具 (add/search/recall/fact/status)
│   │   ├── extractor.ts            # 对话记忆提取
│   │   ├── pipeline.ts             # 记忆处理流水线
│   │   ├── embedding.ts            # Embedding 提供商（OpenAI/Ollama/TF-IDF）
│   │   ├── vectorStore.ts          # 向量存储抽象层
│   │   └── types.ts                # 记忆类型定义
│   ├── skills/                     # Skill 系统
│   │   ├── index.ts                # Skill 模块入口
│   │   ├── registry.ts             # Skill 注册表（用户级/项目级/内置）
│   │   ├── types.ts                # Skill 类型定义
│   │   └── bundled/                # 内置 Skills
│   ├── modes/                      # 运行模式
│   │   ├── interactiveMode.ts      # 交互式 TUI 模式
│   │   ├── printMode.ts            # 单次执行模式 (-p)
│   │   ├── serverMode.ts           # stdin NDJSON 模式
│   │   └── gatewayMode.ts          # HTTP+WS Gateway 模式
│   ├── commands/
│   │   └── init.ts                 # hrids-agent init 命令
│   ├── tui/                        # 终端 UI
│   │   └── App.tsx                 # Ink React 主界面组件
│   └── web/                        # Gateway 内嵌前端 (React + Vite)
├── tests/                          # 测试文件
├── scripts/                        # 开发脚本
├── refercode/                      # 参考代码（claude-code / hermes-agent / mempalace / openclaw）
├── docs/                           # 文档
├── dist/                           # 编译输出
├── config.example.json             # 配置文件模板
├── package.json                    # 依赖和脚本
├── tsconfig.json                   # TypeScript 配置
└── vitest.config.ts                # 测试配置
```

---

## 4. 核心架构

### 4.1 总体分层

```
┌─────────────────────────────────────────────┐
│                  入口层 (main.ts)             │
│  CLI 解析 → 配置加载 → 模式分发               │
└───────────────┬─────────────────────────────────┘
                │
    ┌───────────┼───────────┬──────────────┐
    ▼           ▼           ▼              ▼
┌───────┐ ┌───────┐ ┌──────────┐ ┌──────────┐
│交互模式│ │打印模式│ │Server模式 │ │Gateway模式│
│ (TUI) │ │ (-p)  │ │ (stdin)  │ │(HTTP+WS) │
└───┬───┘ └───┬───┘ └────┬─────┘ └────┬─────┘
    │         │          │            │
    └─────────┼──────────┼────────────┘
              ▼          ▼
    ┌──────────────────────────────┐
    │      QueryEngine (核心引擎)     │
    │  LLM 调用 → 工具执行 → 循环    │
    └──────────┬───────────────────┘
               │
    ┌──────────┼──────────┬──────────┬──────────┐
    ▼          ▼          ▼          ▼          ▼
┌───────┐ ┌───────┐ ┌────────┐ ┌───────┐ ┌────────┐
│Provider│ │ Tools │ │Permission│ │Memory │ │Context │
│ (LLM) │ │ (20+) │ │ Manager │ │ Stack │ │Builder │
└───────┘ └───────┘ └────────┘ └───────┘ └────────┘
```

### 4.2 QueryEngine 执行循环

QueryEngine 是整个系统的核心，实现了一个智能体执行循环：

```
用户消息
  │
  ▼
┌──────────────────────────────────────┐
│ 1. 预处理                             │
│    - 多模态媒体 @引用 → ContentBlock   │
│    - 任务快照预热（从磁盘恢复）          │
│    - onBeforeSend 钩子                │
├──────────────────────────────────────┤
│ 2. 每轮循环 (while turns < maxTurns)  │
│    ├─ 成本/Context 预算检查             │
│    ├─ 旧工具输出/图片 block 裁剪        │
│    ├─ autoCompact 触发判断             │
│    │   └─ 超阈值 → generateCompactSummary │
│    │       → onBeforeCompact 归档      │
│    │       → compactHistory + sanitize │
│    ├─ streamOneTurn (LLM 流式调用)     │
│    │   ├─ plan 模式写工具标注不可用      │
│    │   ├─ 实时任务状态注入 system prompt │
│    │   ├─ Provider.stream() 流式接收    │
│    │   └─ 成本追踪 + 超限检查           │
│    ├─ DSML 文本工具调用解析（可选）       │
│    ├─ 无工具调用 → 完成/继续判断         │
│    └─ 有工具调用 → executeOneTool 串行   │
│        ├─ checkPermission (硬拦截)       │
│        ├─ PermissionManager.check       │
│        ├─ Zod 参数校验 + 自动修复         │
│        ├─ Promise.race (工具执行/超时/abort)│
│        ├─ 日志流式输出                    │
│        ├─ todo 工具 → 刷新快照           │
│        └─ 输出截断 (MAX_TOOL_RESULT_CHARS)│
├──────────────────────────────────────┤
│ 3. 后处理                             │
│    ├─ 达最大轮次 → interrupted 通知    │
│    ├─ 被 abort → 注入系统提示           │
│    └─ onAfterSend 钩子 + done 事件     │
└──────────────────────────────────────┘
```

### 4.3 上下文压缩策略

系统采用**分层截断 + LLM 摘要**的混合策略管理上下文窗口：

| 优先级 | 策略 | 触发条件 | 方式 |
|--------|------|----------|------|
| P0 | tool_result 总量预算截断 | 总字符 > 60000 | 从旧到新替换为占位符，无 LLM 调用 |
| P1 | 旧图片 block 裁剪 | 保护最近 4 条消息 | 替换为文本占位符 |
| P2 | 旧工具输出 prune | 保护最近 40 条消息 | 超出 800 字符的结果替换为占位符 |
| P3 | LLM 结构化摘要 | tokens > 100000 阈值 | 调用 LLM 生成结构化摘要，支持迭代更新 |

压缩产生的摘要采用结构化格式：目标 / 约束与偏好 / 进展 / 关键决策 / 相关文件 / 下一步 / 关键上下文。

---

## 5. 模块详解

### 5.1 提供商系统 (providers/)

#### 架构设计

```
ProviderFactory (index.ts)
├── createProvider()            单一提供商创建
├── createFallbackProvider()    多提供商故障转移
├── createGroupedFallbackProvider()  分组故障转移（同平台内重试，跨平台切换）
├── createTypedProvider()       按模型类型创建 (llm/vision/multimodal/speech)
├── createProviderFromConfig()  从 config.json 完整创建
│
├── 提供商注册表 (registry.ts)
│   ├── 内置提供商 13 个
│   ├── 别名映射（如 qwen → aliyun）
│   ├── 模型名→提供商推断规则
│   └── 自定义提供商支持
│
└── 传输适配器
    ├── AnthropicProvider        Messages API (anthropic_messages)
    ├── OpenAIProvider           Chat Completions API (openai_chat)
    ├── DeepSeekAnthropicProvider  DeepSeek 的 Anthropic 协议实现
    └── FallbackProvider         多平台自动故障转移
```

#### 提供商推断优先级

1. **显式指定** (`--provider` 或 `config.provider`)
2. **baseUrl 判断** (localhost → Ollama)
3. **模型名前缀推断** (内置规则：`claude-*` → Anthropic, `gpt-*` → OpenAI, `deepseek-*` → DeepSeek, `qwen-*` → Aliyun)
4. **兜底** (有 apiKey → Anthropic)

#### 故障转移策略

```
[平台1: aliyun] qwen3.5-flash → qwen3.5-plus → qwen3.5-max
    ↓ (全部失败)
[平台2: deepseek] deepseek-chat → deepseek-reasoner
    ↓ (全部失败)
[平台3: anthropic] claude-3-5-haiku → claude-3-5-sonnet
```

同平台内按 models 顺序重试，全部失败后切换到下一平台。

### 5.2 工具系统 (tools/)

#### 工具抽象接口 (Tool.ts)

```typescript
interface ToolDef<TInput extends z.ZodTypeAny> {
  name: string                    // 工具名称
  description: string             // 告诉 LLM 何时使用
  inputSchema: TInput             // Zod Schema（参数校验 + JSON Schema 生成）
  readonly: boolean               // 是否只读
  isDestructive?: boolean         // 是否破坏性操作
  execute(input, ctx?): Promise<ToolResult>  // 执行
  checkPermission?(input): Promise<PermissionResult>  // 硬拦截
  describe?(input): string        // 用户可读描述
  getFilePath?(input): string     // 涉及的文件路径
  getRuleContent?(input): string  // 权限规则内容匹配
}
```

#### 内置工具清单 (25 个)

| 分类 | 工具 | 说明 |
|------|------|------|
| **信息获取** | `web_search` | 搜索网络信息 |
| | `web_fetch` | 获取网页内容，智能提取正文 |
| | `file_read` | 读取文件，支持行范围，默认显示行号 |
| | `grep` | 递归文本搜索，支持正则 |
| | `glob` | 文件路径模式匹配 |
| **文件操作** | `file_write` | 创建或覆盖文件 |
| | `file_edit` | 精准字符串替换（要求 oldStr 唯一） |
| **执行命令** | `bash` / `powershell` | 跨平台 Shell 执行（按平台自动选择） |
| **任务管理** | `todo_write` | 建立任务计划 |
| | `todo_update` | 更新单个任务状态 |
| | `todo_append` | 追加新任务 |
| | `todo_reset` | 重置任务列表 |
| | `todo_read` | 只读查看任务状态 |
| **人机交互** | `ask_user` | 向用户提问，支持预设选项 |
| | `request_decision` | 结构化决策上报 |
| **协作** | `agent` | 派生子智能体处理独立子任务 |
| | `schedule_cron` | 定时任务管理 (create/list/delete/toggle) |
| | `team_create` / `team_delete` | 创建/删除智能体团队 |
| | `agent_spawn` / `team_status` / `team_wait` | 团队管理 |
| | `send_message` / `receive_message` | 智能体间消息通信 |
| **技能管理** | `skill` / `skill_list` / `skill_save` | 调用/列出/保存 Skill |
| **SkillHub** | `skillhub_search` / `skillhub_install` / 等 | 技能市场集成 |
| **记忆** | `memory_add` / `memory_search` / `memory_recall` / 等 | 长期记忆操作 |
| **扩展** | `mcp__*` | MCP 工具（动态加载） |

#### 工具执行安全机制

1. **checkPermission** — 工具级硬拦截（不询问用户，直接拒绝危险操作）
2. **PermissionManager.check** — 策略决策（模式 + 规则 + 用户确认）
3. **Zod 参数校验** — 执行前验证 LLM 传入的参数格式
4. **自动修复** — LLM 传单个对象而非数组时，自动包装为数组
5. **超时保护** — 默认 60 分钟兜底，工具可自定义 timeout
6. **Abort 信号** — 用户中止时立即停止
7. **输出截断** — 单条结果 > 12000 字符截断

### 5.3 权限系统 (PermissionManager)

#### 权限模式

| 模式 | CLI 标志 | 行为 |
|------|---------|------|
| `ask` | 默认 | 写操作前询问用户 |
| `craft` | `--craft` | 自主执行，无需确认（无轮次上限） |
| `plan` | `--plan` | 只读模式，写操作一律拒绝 |

#### 权限检查流程

```
操作请求
  │
  ├─ 只读操作 → 直接放行
  │
  ├─ alwaysDeny 规则匹配 → 直接拒绝
  │
  ├─ deniedPaths 路径匹配 → 直接拒绝
  │
  ├─ allowedPaths 白名单不匹配 → 询问用户
  │
  ├─ alwaysAllow 规则匹配 (非 plan 模式) → 放行
  │   └─ alwaysAsk 覆盖 alwaysAllow → 询问用户
  │
  └─ 模式策略
      ├─ craft  → 放行
      ├─ plan   → 拒绝
      └─ ask    → 询问用户
```

#### 规则格式

```
"bash"           → 匹配 bash 工具的所有调用
"bash(git *)"    → 匹配 git 开头的命令（通配符）
"bash(npm run)"  → 精确匹配 npm run 命令
"file_write"     → 匹配所有 file_write 调用
```

拒绝追踪：连续拒绝 3 次或总拒绝 20 次后，LLM 响应中附加警告。

### 5.4 记忆系统 (memory/)

#### 4 层架构

```
┌────────────────────────────────────────────┐
│ L0: 身份层 (~100 tokens)                    │
│     固定身份定义，每次注入 system prompt       │
│     格式: "用户是 {role}，偏好用 {lang}..."    │
├────────────────────────────────────────────┤
│ L1: 核心摘要层 (~500-800 tokens)             │
│     按重要性排序的记忆摘要，每次注入             │
│     覆盖: 决策 / 偏好 / 里程碑 / 问题 / 事实    │
├────────────────────────────────────────────┤
│ L2: 按需检索层 (~200-500 tokens)             │
│     按 wing/room 分类过滤，工具调用触发         │
│     关键词匹配 + 时间衰减排序                  │
├────────────────────────────────────────────┤
│ L3: 语义搜索层 (按需)                        │
│     sqlite-vec 向量搜索 / TF-IDF 降级         │
│     支持跨分类相似度检索                       │
└────────────────────────────────────────────┘
```

#### 记忆类型

| 类型 | 说明 | 触发时机 |
|------|------|----------|
| `decision` | 技术决策 | "选择 X 方案" |
| `preference` | 用户偏好 | "以后都用 Y" |
| `milestone` | 重要里程碑 | "上线了"、"搞定了" |
| `problem` | Bug 根因或解决方案 | 问题分析和修复 |
| `fact` | 项目名、技术栈等事实 | 项目描述信息 |
| `emotional` | 情感记录 | 用户情绪反馈 |

#### 知识图谱

支持三元组存储 (`subject -[predicate]-> object`)，带时间戳和置信度。支持实体查询、时效性检查、过期失效。

### 5.5 多智能体系统 (coordinator/)

```
TeamManager (全局/会话级单例)
  │
  ├── MessageBus        ← 同一会话内所有智能体共享消息总线
  │
  └── AgentPool         ← 智能体池（信号量控制并发数，默认 5）
       │
       ├── submit()     ← 提交任务，返回 agent ID
       │    └── runTask()
       │        ├── Semaphore.acquire()
       │        ├── 创建独立 QueryEngine (craft 模式)
       │        ├── 隔离 sessionId (ephemeral- 前缀)
       │        ├── 隔离 cwd (子智能体 cd 不影响父会话)
       │        ├── 注入智能体名 + 会话上下文
       │        └── 完成后 5 分钟自动清理
       │
       ├── wait()       ← Promise 等待（无轮询）
       ├── waitAll()    ← 等待全部完成
       ├── abort()      ← 中止单个任务
       └── getTask()    ← 查询任务状态
```

**多会话隔离**：
- CLI 模式：进程级全局单例
- Gateway 模式：sessionId → TeamManager 映射，每个会话独立的 MessageBus 和记忆上下文

**子智能体安全措施**：
- 默认排除 `todo_write/todo_update/todo_append/todo_reset`（防止双真相问题）
- `ephemeral-` 前缀临时会话，启动时自动清理
- 继承父会话的 cwd 和记忆上下文

### 5.6 Coordinator Prompt 系统

System prompt 采用**分层设计**，优化 API 缓存命中率：

```
┌─────────────────────────────────────┐
│ 静态层 (STATIC_SECTIONS)             │  ← 内容固定，逐元素 cache_control
│ ├─ 身份介绍 (SECTION_INTRO)          │
│ ├─ 执行原则 (SECTION_EXECUTION)      │
│ ├─ 谨慎操作 (SECTION_ACTIONS)        │
│ ├─ 工具使用 (SECTION_TOOLS)          │
│ ├─ 任务计划 (SECTION_TODO)           │
│ ├─ 决策上报 (SECTION_DECISION)       │
│ ├─ 文件路径 (SECTION_FILE_PATH)      │
│ ├─ 输出规范 (SECTION_OUTPUT)         │
│ └─ 指代解析 (SECTION_COREFERENCE)    │
├─────────────────────────────────────┤
│ 工具速查 (动态生成)                   │  ← 根据实际工具列表 + MCP 工具生成
├─────────────────────────────────────┤
│ 扩展层 (按任务类型注入)               │  ← classifyTask() 分类后追加
│ ├─ EXT_TASK      (多步骤任务)        │
│ ├─ EXT_SCRIPT    (脚本执行)          │
│ ├─ EXT_CRAWL     (爬虫规范)          │
│ ├─ EXT_CODE      (代码开发)          │
│ ├─ EXT_AGENT     (多智能体)          │
│ ├─ EXT_FILE      (文件处理)          │
│ ├─ EXT_MEMORY    (记忆管理)          │
│ └─ EXT_SKILLHUB  (技能市场)          │
├─────────────────────────────────────┤
│ 动态层 (ContextBuilder)              │  ← Git 状态、环境信息、记忆文件等
└─────────────────────────────────────┘
```

任务分类基于关键词匹配，`crawl → script → task` 和 `code → task` 存在隐含连锁（爬虫隐含脚本，脚本/代码隐含多步骤任务）。

### 5.7 Gateway 服务 (gateway/)

#### 架构

```
┌──────────────────────────────────────────┐
│              HTTP Server (Express)        │
│                                           │
│  REST API:                                │
│  ├─ POST /api/login         登录鉴权       │
│  ├─ GET  /health            健康检查       │
│  ├─ GET/POST /sessions      会话管理       │
│  ├─ GET/PUT/DELETE /sessions/:id 会话操作  │
│  ├─ GET  /sessions/:id/messages  历史消息  │
│  ├─ GET  /sessions/:id/files   文件浏览    │
│  ├─ PUT  /sessions/:id/file-content  文件编辑│
│  ├─ POST /sessions/:id/upload  文件上传   │
│  ├─ GET/POST/PUT/DELETE /crons  定时任务   │
│  ├─ GET/PUT /mcp              MCP 配置     │
│  ├─ GET  /skills              技能列表     │
│  ├─ GET  /im/platforms         IM 平台管理  │
│  ├─ GET  /config              配置管理     │
│  └─ GET  /api/logs, /api/usage  日志/用量  │
│                                           │
├──────────────────────────────────────────┤
│           WebSocket Server (ws)           │
│  ws://host:port/sessions/:id/stream       │
│  ├─ 实时流式推送 (StreamEvent → JSON)      │
│  ├─ 客户端消息处理 (abort/user_reply 等)    │
│  └─ 消息缓冲区回放 (重连后 catch up)        │
├──────────────────────────────────────────┤
│           SessionManager                  │
│  ├─ 会话生命周期 (create/destroy/abort)    │
│  ├─ 空闲超时销毁                           │
│  ├─ 最大会话数限制                         │
│  └─ Cron → IM 推送回调                    │
├──────────────────────────────────────────┤
│           PlatformManager (IM)            │
│  ├─ Telegram Bot 适配器                   │
│  ├─ 微信适配器 (扫码登录)                   │
│  └─ Webhook 适配器                        │
└──────────────────────────────────────────┘
```

#### 鉴权模式

| 模式 | 配置 | 说明 |
|------|------|------|
| `none` | 无 users 无 token | 无鉴权，适合本地使用 |
| `token` | 设置 gateway.token | 静态 Bearer Token |
| `login` | 设置 gateway.users[] | 用户名/密码 → JWT (7 天有效) |

#### WebSocket 消息协议

客户端 → 服务端：
```json
{"type": "message", "message": "你好"}
{"type": "abort"}
{"type": "user_reply", "answer": "..."}
{"type": "decision_reply", "answer": "1"}
{"type": "set_cwd", "cwd": "/path/to/dir"}
```

服务端 → 客户端 (StreamEvent JSON)：
```json
{"type": "ready"}
{"type": "text_delta", "delta": "..."}
{"type": "tool_start", "id": "...", "name": "...", "input": {...}, "description": "..."}
{"type": "tool_log", "id": "...", "name": "...", "line": "..."}
{"type": "tool_end", "id": "...", "name": "...", "result": {...}}
{"type": "permission_denied", "id": "...", "toolName": "...", "description": "..."}
{"type": "usage", "inputTokens": 100, "outputTokens": 200, "costUsd": 0.001}
{"type": "compact_start" / "compact_done"}
{"type": "interrupted", "reason": "turn_limit"|"budget_exceeded"|"aborted"|"error"}
{"type": "continuation_needed"}
{"type": "done"}
{"type": "error", "message": "..."}
```

---

## 6. 运行模式

hrids-agent 支持 4 种运行模式：

```bash
# 1. 交互模式（默认）— Ink React TUI
npm run dev

# 2. 单次执行模式 — 执行一条指令后退出
npm run dev -- -p "帮我写一个 hello world"

# 3. Server 模式 — stdin NDJSON
npm run dev -- --server

# 4. Gateway 模式 — HTTP + WebSocket 服务
npm run dev -- --gateway
npm run gateway  # 等价，先构建前端再启动
```

### 模式对比

| 特性 | 交互模式 | 单次执行 | Server | Gateway |
|------|---------|----------|--------|---------|
| 多轮对话 | ✓ | ✗ | ✓ | ✓ |
| 流式输出 | ✓ (Ink) | ✓ (stdout) | ✓ (NDJSON) | ✓ (WS JSON) |
| 会话持久化 | ✓ | ✓ | ✓ | ✓ |
| 多会话并发 | ✗ | ✗ | ✗ | ✓ |
| 前端 UI | ✗ | ✗ | ✗ | ✓ (内嵌) |
| IM 接入 | ✗ | ✗ | ✗ | ✓ |
| 历史恢复 | 自动 | 手动 | 手动 | 手动 |

---

## 7. 启动流程

```
main()
 │
 ├─ 1. setupSystemProxy()                 系统代理配置
 │
 ├─ 2. new Command('hrids-agent')          CLI 定义
 │     ├─ init 子命令
 │     └─ 主命令 (所有选项)
 │
 ├─ 3. loadConfig()                       配置文件加载
 │     ├─ 读取 ~/.hrids-agent/config.json
 │     ├─ 合并旧格式/apiKeys 迁移
 │     ├─ 读取 mcp.json
 │     └─ 规范化 → ResolvedConfig
 │
 ├─ 4. validateStartupConfig()            配置校验
 │
 ├─ 5. resetEmbeddingProvider()           Embedding 初始化
 │
 ├─ 6. 模式分发
 │     ├─ --gateway → runGatewayMode()
 │     ├─ --list-sessions → listSessions()
 │     ├─ --print → setupSession() + setupProvider() + runPrintMode()
 │     ├─ --server → setupSession() + setupProvider() + runServerMode()
 │     └─ default  → setupSession() + setupProvider() + runInteractiveMode()
 │
 ├─ 7. setupSession()                     会话初始化
 │     ├─ 恢复上次会话 or 创建新会话
 │     ├─ 创建/恢复工作目录 (git init)
 │     └─ 加载历史消息
 │
 ├─ 8. setupProvider()                    LLM 提供商创建
 │     ├─ createProviderFromConfig()
 │     └─ Fallback 链构建
 │
 ├─ 9. PermissionManager()                权限管理器
 │
 ├─ 10. loadMcpTools()                    MCP 工具加载
 │
 ├─ 11. TeamManager.init()               全局团队管理器
 │
 ├─ 12. getCoordinatorSystemPrompt()     System prompt 构建
 │     └─ buildSystemContext()            注入环境/Git/记忆
 │
 └─ 13. new QueryEngine()                核心引擎创建
      └─ restoreScheduledJobs()           恢复定时任务
```

---

## 8. 数据流

### 8.1 用户消息处理流程

```
用户输入 (文本 + @图片引用)
  │
  ├─ CommandRegistry.parse()              斜杠命令检测？
  │   └─ 是 → 命令执行 → 返回 CommandResult
  │
  ├─ MediaProcessor.extractMediaFromText() @引用预处理
  │   ├─ 本地图片 → Sharp 压缩 + 缓存
  │   ├─ URL 图片 → fetch + 压缩 + 缓存
  │   └─ PDF → 直接传输
  │
  ├─ classifyTask(message)                任务分类
  │   └─ 匹配关键词 → 扩展块列表
  │
  ├─ buildPromptForMessage()              动态更新 system prompt
  │   └─ getCoordinatorSystemPrompt() + buildSystemContext()
  │
  └─ engine.send(message)                 进入执行循环
      │
      ├─ 历史存原始文本 (不含 base64)
      ├─ 发给 LLM 含 image block
      ├─ LLM 流式响应
      │   ├─ text_delta → 流式输出
      │   └─ tool_use → 工具执行
      │       ├─ 权限检查
      │       ├─ 参数校验
      │       ├─ 执行 + 日志
      │       └─ 结果截断
      ├─ 无工具调用
      │   ├─ completion 信号 → 结束
      │   ├─ continuation 信号 → ask/plan 模式暂停确认
      │   └─ craft 模式 → 自动继续
      └─ 循环直到完成 / 超限 / 中止
```

### 8.2 会话持久化

```
sessions/{sessionId}/
├── transcript.jsonl                     # 对话历史（增量追加）
├── meta.json                            # 元数据（标题、模型、消息数）
├── archives.json                        # 压缩归档元数据列表
└── transcript.{timestamp}.archive.jsonl # 压缩归档段

每次 send 完成后:
  saveSession() → 增量追加到 transcript.jsonl

压缩时:
  archiveSession() → 复制到 archive.jsonl
  更新 archives.json
```

### 8.3 定时任务调度

```
crons.json                                # 持久化
  ↓ 启动时
restoreScheduledJobs()                     # 解析所有 enabled 任务
  ↓ 每个任务
setTimeout(下次执行时间 - now)
  ↓ 触发时
1. 检查 enabled 状态
2. 计算下次执行时间 (下一次 setTimeout)
3. 发送消息到对应 session 的 engine.send()
4. trigger: 'cron' + cronDescription
```

---

## 9. 配置系统

### 9.1 配置优先级

```
CLI 参数 > config.json > 默认值
```

### 9.2 配置文件位置

```
~/.hrids-agent/
├── config.json           # 主配置 (模型/提供商/行为/日志)
├── mcp.json              # MCP 服务器配置 (兼容 Claude Desktop 格式)
├── permission-rules.json # 权限规则 (持久化)
├── crons.json            # 定时任务 (持久化)
├── skills-disabled.json  # 禁用技能列表
├── zhile-session.json    # 知了专属会话绑定
├── sessions/             # 会话历史
├── memory/               # 长期记忆 (SQLite)
├── skills/               # 用户级 Skills
├── logs/                 # 日志文件
└── work/                 # 默认工作目录
```

### 9.3 config.json 结构

```typescript
interface AgentConfig {
  model: string                      // 默认模型
  provider?: string                  // 默认提供商
  llm?: ModelTypeConfig             // LLM 配置（含 fallbacks）
  vision?: ModelTypeConfig          // 视觉模型
  multimodal?: ModelTypeConfig      // 全模态模型
  speech?: ModelTypeConfig          // 语音模型
  embedding?: EmbeddingConfig       // 向量模型
  vectorStore?: VectorStoreConfig   // 向量存储后端
  agent?: AgentBehaviorConfig       // 运行时行为
  gateway?: GatewayConfig           // Gateway 配置
  logging?: LoggingConfig           // 日志配置
  skillHub?: SkillHubConfig         // 技能市场
  mcpServers: McpServerConfig[]     // MCP 服务器
  customProviders?: CustomProviderConfig[]  // 自定义提供商
}
```

### 9.4 向后兼容

Config 系统自动迁移旧版扁平字段到新的嵌套分组：
- `config.permissionMode` → `config.agent.permissionMode`
- `config.apiKeys` → 注入到各 `fallbacks[].apiKey`
- `config.mcpServers` 支持 `mcp.json` 的两种格式（对象/数组）

---

## 10. 扩展机制

### 10.1 MCP 工具扩展

```
配置方式:
1. config.json 的 mcpServers 数组
2. mcp.json (兼容 Claude Desktop 两种格式)

工具命名: mcp__<server>__<tool>

示例:
{
  "name": "filesystem",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
}

生成的工具:
- mcp__filesystem__read_file
- mcp__filesystem__write_file
- mcp__filesystem__list_directory
...
```

### 10.2 Skill 系统

```
Skill 来源 (优先级):
1. 项目级: {cwd}/.agent/skills/<name>/SKILL.md
2. 用户级: ~/.hrids-agent/skills/<name>/SKILL.md
3. 内置:   src/skills/bundled/

SKILL.md 格式:
---
description: 描述
when-to-use: 何时使用
argument-hint: <参数>
allowed-tools: [tool1, tool2]
---

# 注入给 LLM 的 Prompt 内容

{{args}}  ← 用户参数插槽
```

### 10.3 自定义提供商

```json
{
  "customProviders": [
    {
      "name": "MyLLM",
      "baseUrl": "https://my-llm.example.com/v1"
    }
  ]
}
```

配置后在 `llm.fallbacks` 中使用 `"provider": "MyLLM"` 即可。

### 10.4 项目记忆文件

```
{项目目录}/AGENT.md           → 项目级记忆
{项目目录}/.hrids/AGENT.md    → 项目级记忆（隐藏目录）
~/.hrids-agent/AGENT.md       → 用户级全局记忆
```

启动时自动读取并注入 system prompt 的 `## 项目记忆` 部分。

---

## 附录

### A. 关键技术决策

| 决策 | 原因 |
|------|------|
| ESM 模块 | Node.js 生态趋势，更好的 tree-shaking |
| better-sqlite3 而非 ORM | 零配置本地部署，性能和可靠性 |
| Zod 参数校验 | 运行时类型安全 + JSON Schema 生成 |
| 上下文压缩混合策略 | 廉价截断先行，LLM 摘要兜底 |
| System prompt 分层缓存 | 利用 Anthropic prompt cache 降低成本 |
| 子智能体排除 todo 工具 | 防止共享任务文件导致双真相问题 |
| 图片 block 历史替换 | 避免 base64 数据在每轮请求中重复传输 |
| 原子写入 (tmp + rename) | 防止并发写入时文件损坏 |

### B. 参考代码

`refercode/` 目录包含 4 个参考项目：
- **claude-code-main**: Claude Code CLI 架构参考
- **hermes-agent-2026.4.23**: 另一个 agentic CLI 实现
- **mempalace-main**: 记忆宫殿（4 层记忆架构参考）
- **openclaw-2026.4.22**: 多平台智能体框架

### C. 测试策略

- **测试框架**: Vitest + fast-check (属性测试)
- **覆盖率目标**: statements 70% / branches 60% / functions 70% / lines 70%
- **环境**: Node.js forks pool
- **超时**: 10s (test) / 10s (hook)
- **重试**: 1 次 (flaky test 容错)
