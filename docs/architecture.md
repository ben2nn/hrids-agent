# 架构文档

---

## 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                        入口层                                │
│  CLI (src/main.ts)  →  Commander.js 解析参数                │
│                                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │ 交互模式  │  │ 非交互   │  │ Server   │  │ Gateway  │  │
│  │ (Ink TUI)│  │ (-p)     │  │ (stdin)  │  │ (HTTP/WS)│  │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                       核心引擎层                             │
│                                                             │
│  QueryEngine ──────────────────────────────────────────    │
│    │  流式 LLM 调用 + 工具调用循环                           │
│    │  上下文压缩（token 预算管理）                           │
│    │  任务快照注入（todo 状态 → system prompt）              │
│    │                                                        │
│    ├── PermissionManager（权限三级拦截）                     │
│    ├── CostTracker（费用追踪）                               │
│    └── ToolDef[]（工具集合）                                 │
│                                                             │
│  LLMProvider（提供商抽象层）                                 │
│    ├── AnthropicProvider                                    │
│    ├── OpenAIProvider                                       │
│    ├── DeepSeekAnthropicProvider                            │
│    └── FallbackProvider（多模型 Fallback 链）               │
└─────────────────────────────────────────────────────────────┘
                              │
                    ┌─────────┴─────────┐
                    ▼                   ▼
┌──────────────────────┐   ┌──────────────────────────────┐
│      工具系统         │   │         记忆系统              │
│                      │   │                              │
│  19 个内置工具        │   │  MemoryStack（4 层记忆）      │
│  + AgentTool（子智能体）│  │    L0: 身份层 (~100 tokens)  │
│  + MCP 工具（动态加载）│   │    L1: 核心摘要 (~500 tokens)│
│                      │   │    L2: 按需检索               │
│  BashTool / PowerShell│  │    L3: 向量搜索               │
│  FileRead/Write/Edit  │   │                              │
│  Glob / Grep          │   │  MemoryStore（SQLite）        │
│  WebFetch / WebSearch │   │  EmbeddingProvider           │
│  TodoTool（5个）      │   │    OpenAI / Aliyun / Ollama  │
│  AskUser / Decision   │   │    降级：TF-IDF              │
│  ScheduleCron         │   └──────────────────────────────┘
│  SkillTool / SkillHub │
│  TeamTools            │
└──────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    多智能体协调层                             │
│                                                             │
│  TeamManager ──────────────────────────────────────────    │
│    │  CLI 模式：进程级全局单例                               │
│    │  Gateway 模式：会话级独立实例（sessionId 隔离）         │
│    │                                                        │
│    ├── AgentPool（并发子智能体池）                           │
│    └── MessageBus（智能体间通信）                            │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                     Gateway 层                              │
│                                                             │
│  SessionManager ───────────────────────────────────────    │
│    │  会话生命周期管理（创建/销毁/空闲超时）                  │
│    │  WebSocket 订阅/广播                                   │
│    │  事件回放缓冲区（重连恢复）                             │
│    │                                                        │
│    └── ManagedSession（每个会话独立）                        │
│          engine / provider / permissions                    │
│          subscribers（WebSocket 集合）                      │
│          replayBuffer（最近 200 条事件）                     │
│                                                             │
│  Express HTTP REST API                                      │
│  WebSocket Server                                           │
│                                                             │
│  PlatformManager（IM 平台接入）                             │
│    ├── TelegramAdapter                                      │
│    ├── WeixinAdapter（扫码登录）                             │
│    └── WebhookAdapter                                       │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Web 前端（src/web/）                      │
│                                                             │
│  React + Vite + Tailwind + Zustand                         │
│                                                             │
│  WsClient（WebSocket 客户端，指数退避重连）                  │
│  Store 层：                                                 │
│    messageStore / sessionStore / connectionStore            │
│    todoStore / fileTreeStore / automationStore              │
│                                                             │
│  页面：Chat / Skills / Automation / Settings               │
└─────────────────────────────────────────────────────────────┘
```

---

## 核心数据流

### 用户发送消息（Gateway 模式）

```
用户 → WebSocket → SessionManager.runMessage()
  → runWithCwd(session.cwd)          # 建立会话级 cwd 上下文
  → runWithSession(sessionId)        # 建立会话级 sessionId 上下文
  → buildSystemContext()             # 动态注入记忆、Git 状态、环境信息
  → QueryEngine.send(message)        # 进入 LLM 对话循环
      → streamOneTurn()              # 流式调用 LLM
          → provider.stream()        # 调用具体 LLM API
          → yield text_delta         # 流式文本推送
          → yield tool_call          # 工具调用请求
      → executeOneTool()             # 执行工具
          → checkPermission()        # 硬拦截（危险命令黑名单）
          → PermissionManager.check()# 权限策略决策
          → tool.execute()           # 实际执行
          → yield tool_result        # 工具结果
      → 循环直到 LLM 停止输出
  → broadcast(event)                 # 广播事件给所有 WebSocket 订阅者
  → saveSession()                    # 持久化会话历史
  → autoExtractMemories()            # 后台记忆提炼
```

### System Prompt 构建流程

```
getCoordinatorSystemPrompt(message, tools)
  → STATIC_SECTIONS（8 个固定 section，适合 API 缓存）
  → buildToolsReferenceSection(tools)（动态工具速查，含 MCP 工具）
  → classifyTask(message)（关键词分类）
  → 按需注入扩展块（EXT_TASK / EXT_CODE / EXT_CRAWL 等）

buildSystemContext(basePrompt, cwd, sessionId)
  → 追加记忆文件内容（AGENT.md）
  → 追加长期记忆（L0 + L1）
  → 追加环境信息（OS、Shell、Git 状态）
```

### 权限检查流程

```
PermissionManager.check(req)
  ├── 只读操作 → 直接放行
  ├── 永久拒绝规则（alwaysDeny）→ 拒绝
  ├── 路径黑名单（deniedPaths）→ 拒绝
  ├── 路径白名单（allowedPaths）→ 不在白名单则询问
  ├── 永久允许规则（alwaysAllow）→ 放行（plan 模式无效）
  ├── 强制询问规则（alwaysAsk）→ 询问用户
  ├── craft 模式 → 直接放行
  ├── plan 模式 → 直接拒绝
  └── ask 模式 → 会话内已批准则放行，否则询问用户
```

---

## 关键设计决策

### 1. 工作目录隔离（AsyncLocalStorage）

每个 Gateway 会话有独立的工作目录，通过 `AsyncLocalStorage` 实现异步上下文隔离，避免多会话并发时 cwd 互相污染。

```typescript
// 每个会话在自己的 cwd 上下文中运行
runWithCwd(session.info.cwd, () =>
  runWithSession(sessionId, () =>
    engine.send(message)
  )
)
```

### 2. System Prompt 分层缓存

静态层（8 个固定 section）内容不变，适合 Anthropic API 的 prompt caching。动态层（工具速查、扩展块、记忆、环境信息）追加在末尾，不影响静态层缓存命中率。

### 3. 上下文压缩策略（三级）

1. **tool_result 总量预算截断**（免费，每轮运行）：超出 60000 字符时从最旧的 tool_result 开始截断
2. **旧工具输出 prune**（免费）：超过 800 字符的旧 tool_result 替换为占位符
3. **LLM 摘要压缩**（消耗 token）：历史消息数超过阈值时调用 LLM 生成结构化摘要，支持迭代更新

### 4. 会话级记忆隔离

Gateway 多会话模式下，每个会话有独立的 `MemoryStack` 和 `MemoryStore` 实例，防止跨用户记忆泄漏。CLI 单会话模式使用全局单例。

### 5. 事件回放缓冲区

每个会话维护最近 200 条事件的回放缓冲区。WebSocket 重连时，若 agent 正在运行（busy 状态），自动回放缓冲区恢复流式状态，用户无感知断线重连。

### 6. 多模型 Fallback 链

`FallbackProvider` 按配置顺序尝试各平台/模型，某个模型失败时自动切换到下一个，实现高可用。

---

## 目录结构

```
src/
├── main.ts                    # 入口，CLI 参数解析
├── bootstrap/
│   ├── setupProvider.ts       # LLM 提供商初始化
│   └── setupSession.ts        # 会话初始化（恢复/新建）
├── commands/
│   └── init.ts                # hrids-agent init 子命令
├── core/
│   ├── QueryEngine.ts         # 核心对话引擎
│   ├── Config.ts              # 配置系统
│   ├── PermissionManager.ts   # 权限管理
│   ├── ContextBuilder.ts      # System prompt 动态层构建
│   ├── SessionStore.ts        # 会话持久化
│   ├── CostTracker.ts         # 费用追踪
│   ├── cwd.ts                 # 工作目录管理（AsyncLocalStorage）
│   ├── audit.ts               # 审计日志
│   ├── logger.ts              # 结构化日志
│   ├── Tool.ts                # 工具接口定义
│   ├── coordinator/
│   │   ├── coordinatorPrompt.ts  # System prompt 生成
│   │   ├── TeamManager.ts        # 多智能体团队管理
│   │   ├── AgentPool.ts          # 子智能体并发池
│   │   └── MessageBus.ts         # 智能体间消息总线
│   └── providers/
│       ├── AnthropicProvider.ts
│       ├── OpenAIProvider.ts
│       ├── FallbackProvider.ts
│       └── registry.ts           # 提供商注册表
├── tools/                     # 19 个内置工具
├── memory/                    # 记忆系统
├── skills/                    # 技能系统
├── gateway/
│   ├── server.ts              # HTTP + WebSocket 服务器
│   ├── SessionManager.ts      # 会话管理器
│   └── im/                    # IM 平台接入
│       ├── BasePlatformAdapter.ts
│       ├── PlatformManager.ts
│       └── platforms/
│           ├── telegram.ts
│           ├── weixin.ts
│           └── webhook.ts
├── modes/
│   ├── interactiveMode.ts     # Ink TUI 交互模式
│   ├── printMode.ts           # 非交互模式
│   ├── serverMode.ts          # Server 模式
│   └── gatewayMode.ts         # Gateway 模式
├── tui/
│   └── App.tsx                # Ink TUI 根组件
└── web/                       # React Web 前端
    └── src/
        ├── App.tsx
        ├── components/
        ├── store/             # Zustand 状态管理
        └── lib/
            ├── wsClient.ts    # WebSocket 客户端
            └── gateway.ts     # REST API 客户端
```
