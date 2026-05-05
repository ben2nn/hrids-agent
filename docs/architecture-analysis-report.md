# hrids-agent 架构设计分析报告

> 生成日期：2026-04-29  
> 分析范围：完整源码 + Git 提交历史（共 21 次提交，跨度 2026-04-13 ~ 2026-04-29）

---

## 一、项目定位与整体目标

**hrids-agent** 是一个原创的自主工作者（Agentic CLI）框架，核心理念是：

> "你只做决策，它负责执行。"

它不是对某个 AI SDK 的简单封装，而是一套完整的智能体运行时，具备：

- 多 LLM 提供商支持与故障转移
- 分层权限控制（ask / craft / plan 三种模式）
- 4 层长期记忆架构（L0~L3）
- 多智能体团队协调
- 多运行模式（CLI / Server / Gateway）
- Skill 系统（内置 + 用户自定义 + 自动沉淀）
- MCP 工具扩展协议支持

---

## 二、整体架构分层

```
┌─────────────────────────────────────────────────────────────────┐
│                        运行模式层（modes/）                       │
│   交互 TUI │ 单次执行（print）│ Server NDJSON │ Gateway HTTP+WS  │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│                     Gateway 服务层（gateway/）                    │
│   SessionManager（会话生命周期）│ HTTP REST │ WebSocket 广播      │
│   IM 平台适配器（钉钉、企业微信等）                                │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│                      核心引擎层（core/）                          │
│   QueryEngine（推理循环）│ PermissionManager │ SessionStore      │
│   ContextBuilder │ CostTracker │ CommandRegistry │ DsmlParser    │
│   coordinator/（TeamManager + AgentPool + MessageBus）           │
│   providers/（Anthropic + OpenAI + FallbackProvider）            │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│                       工具层（tools/）                            │
│   文件系统 │ Shell │ Web │ 人机交互 │ 定时任务 │ Skill │ 多智能体  │
│   MCP 代理工具                                                    │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│                      记忆系统层（memory/）                        │
│   L0 身份 │ L1 核心摘要 │ L2 按需检索 │ L3 语义向量搜索           │
│   SQLite + sqlite-vec │ TF-IDF 降级 │ 知识图谱三元组              │
└─────────────────────────────────────────────────────────────────┘
```

---

## 三、核心模块设计详解

### 3.1 QueryEngine —— 推理循环核心

`src/core/QueryEngine.ts`（973 行）是整个系统的心脏，实现了完整的 Agentic 推理循环。

#### 设计亮点

**① 流式事件驱动架构**

`send()` 方法是一个 `AsyncGenerator<StreamEvent>`，向外 yield 细粒度事件：

```
text_delta → tool_start → tool_log → tool_end → usage → done
```

这使得 TUI、WebSocket、NDJSON 等不同消费端可以用统一接口接收实时输出，无需轮询。

**② 三级上下文压缩策略（成本优化）**

按成本从低到高依次触发，避免不必要的 LLM 调用：

| 优先级 | 策略 | 成本 | 触发条件 |
|--------|------|------|----------|
| 0（最廉价） | `applyToolResultBudget()` — 总量预算截断 | 零 | 每轮开始前 |
| 1 | `pruneOldToolResults()` — 旧工具输出替换占位符 | 零 | 压缩前预处理 |
| 2 | `generateCompactSummary()` — LLM 生成结构化摘要 | 有成本 | token 超阈值 |

摘要支持**迭代更新**（`previousSummary` 字段），避免多次压缩后信息层层丢失。

**③ 中英文感知的 Token 估算**

```typescript
// CJK 字符：+6 再整体 /4 ≈ 1.5 token/字
// ASCII 字符：+1 再整体 /4 ≈ 0.25 token/字符
```

比简单的字符数估算更准确，减少中文场景下的误触发压缩。

**④ 工具对完整性修复（`sanitizeToolPairs`）**

压缩后可能出现孤立的 `tool_use`（无对应 `tool_result`）或反向孤立，会导致 API 报错。`sanitizeToolPairs()` 在每次压缩后自动修复，插入 stub result 或删除孤立 result。

**⑤ DSML 格式工具调用解析**

针对 DeepSeek 等不原生支持 tool_use 的模型，通过 `DsmlParser` 从文本中解析 XML 格式的工具调用，实现跨模型兼容。

**⑥ 并发保护与 abort 机制**

`running` 标志防止同一 engine 并发执行；`AbortController` 支持随时中止，工具执行用 `Promise.race([toolPromise, timeoutPromise, abortPromise])` 三路竞争。

**⑦ 查询意图检测**

`isQueryIntent()` 通过正则模式识别"你记得上次..."类的回忆性问题，对这类消息禁用 continuation 自动执行，避免 LLM 误判为需要继续操作的任务。

---

### 3.2 PermissionManager —— 分层权限控制

`src/core/PermissionManager.ts` 实现了一套精细的权限决策引擎。

#### 权限决策优先级（从高到低）

```
1. 工具级硬拦截（checkPermission）—— 无论任何模式都生效
2. deniedPaths 路径黑名单
3. allowedPaths 路径白名单
4. alwaysDeny 规则
5. alwaysAsk 规则（即使在 craft 模式下也询问）
6. alwaysAllow 规则
7. 模式默认值（craft=允许 / plan=拒绝写操作 / ask=询问用户）
```

#### 规则语法设计

支持三种匹配模式，表达力逐步增强：

```
"bash"           → 匹配工具 bash 的所有调用（工具级）
"bash(git *)"    → 通配符匹配（bash 工具中以 git 开头的命令）
"bash(npm run)"  → 精确匹配（bash 工具中的 npm run 命令）
```

#### 拒绝追踪机制

记录连续拒绝次数和会话内总拒绝次数，当达到阈值时，给 LLM 返回更强烈的提示：

```
"用户拒绝了此操作（已连续拒绝 3 次，会话内共拒绝 5 次）。请停止尝试此类操作，直接询问用户希望如何处理。"
```

---

### 3.3 长期记忆系统 —— 4 层架构

借鉴 mempalace 的分层设计，在 token 预算和信息完整性之间取得平衡。

```
L0 身份层（~100 tokens）
  └─ 固定身份定义，每次注入 system prompt
  └─ 存储：SQLite identity 表（key-value）

L1 核心摘要层（~500-800 tokens）
  └─ 按时间衰减重要性排序（90天半衰期）
  └─ 过滤已失效（superseded）记忆
  └─ 按 room 分组展示

L2 按需检索层（~200-500 tokens）
  └─ 按 wing/room 分类过滤
  └─ 工具调用触发（memory_recall）

L3 语义搜索层（按需）
  └─ 主路径：sqlite-vec KNN 向量搜索（HNSW 近似最近邻）
  └─ 降级路径：TF-IDF 关键词匹配（无 embedding 时）
  └─ 工具调用触发（memory_search）
```

#### 记忆更新策略

采用**软删除 + 版本链**：旧记忆标记 `superseded_by` 指向新版本，保留历史可追溯性，同时搜索时自动过滤已失效记忆。

#### 多会话隔离

Gateway 模式下每个会话有独立的 SQLite 文件（`memory/sessions/<sessionId>/palace.db`），防止跨用户记忆泄漏。

---

### 3.4 多智能体协调系统

#### 三层协调架构

```
TeamManager（会话级单例）
  └─ 管理多个 Team
  └─ 持有独立的 MessageBus（会话间完全隔离）

AgentPool（每个 Team 一个）
  └─ 并发控制（maxConcurrent，默认 5）
  └─ 任务队列 + 状态追踪

MessageBus（发布/订阅）
  └─ 智能体间异步通信
  └─ send_message / receive_message 工具
```

#### AgentTool 的隔离设计

子智能体通过 `runWithCwd` + `runWithSession` 双重隔离：

- **工作目录隔离**：`isolated=true` 时创建临时目录，任务完成后自动清理
- **会话隔离**：子智能体有独立的 `subSessionId`，避免 todo 等工具污染父会话状态
- **记忆继承**：子智能体继承父会话的记忆快照（L0+L1），但不写回父会话

---

### 3.5 工作目录管理 —— AsyncLocalStorage 隔离

`src/core/cwd.ts` 是一个精妙的基础设施设计：

```typescript
const cwdStorage = new AsyncLocalStorage<{ cwd: string }>()

// Gateway 模式：每个会话在独立的 AsyncLocalStorage 上下文中运行
runWithCwd(session.info.cwd, () => runWithSession(sessionId, () => ...))

// 工具层：统一从 getGlobalCwd() 获取当前上下文的 cwd
const filePath = resolve(getGlobalCwd(), input.path)
```

这解决了 Gateway 多会话并发时的 cwd 竞争问题：每个会话的调用链在独立的异步上下文中，`getGlobalCwd()` 自动返回当前会话的 cwd，无需显式传参。

---

### 3.6 多提供商架构

#### 提供商注册表设计

```
内置提供商（registry.ts）
  ├─ anthropic（Anthropic Messages API）
  ├─ openai / deepseek / groq / aliyun / zhipu / nvidia / kimi / minimax / google / openrouter
  └─ ollama（本地，无需 API Key）

自定义提供商（config.json customProviders）
  └─ 用户自定义 baseUrl + transport 类型
```

#### Fallback 链设计

```json
{
  "llm": {
    "fallbacks": [
      { "provider": "aliyun", "models": ["qwen-plus", "qwen-max"] },
      { "provider": "deepseek", "models": ["deepseek-chat"] },
      { "provider": "anthropic", "models": ["claude-3-5-haiku-20241022"] }
    ]
  }
}
```

`FallbackProvider` 在当前提供商失败时自动切换到下一个，对 QueryEngine 完全透明。

---

### 3.7 Gateway 模式 —— 多会话服务

`SessionManager` 是 Gateway 模式的核心，管理完整的会话生命周期：

- **会话隔离**：每个会话有独立的 QueryEngine、PermissionManager、TeamManager、MemoryStore
- **事件回放缓冲区**：新 WebSocket 连接时回放最近 200 条事件，避免错过进行中的输出
- **空闲超时**：默认 30 分钟无活动自动销毁，防止资源泄漏
- **优雅关闭**：等待所有 busy 会话完成后再销毁，保证数据不丢失
- **视觉模型动态切换**：检测到图片/PDF 附件时自动切换到 vision 模型，任务完成后恢复

---

### 3.8 Skill 系统

三级优先级：**项目级 > 用户级 > 内置**

```
内置 skills（src/skills/bundled/）
  └─ research / plan / report / commit / review / explain / fix / scaffold 等

用户级 skills（~/.hrids-agent/skills/<name>/SKILL.md）
  └─ 跨项目通用，自动沉淀的 skill 写入此处

项目级 skills（<项目>/.agent/skills/<name>/SKILL.md）
  └─ 仅当前项目生效，可提交到 git
```

SKILL.md 支持 `{{args}}` 占位符和 `#[[file:path]]` 文件引用，实现动态内容注入。

---

## 四、迭代历史分析

### 阶段一：基础框架搭建（2026-04-13）

**提交：** `first commit`

初始版本已包含完整的核心骨架：

- `QueryEngine`（576 行）—— 推理循环基础版
- `PermissionManager`（210 行）—— 权限控制基础版
- `SessionStore`（86 行）—— 会话持久化
- `coordinator/AgentPool`（170 行）—— 多智能体基础
- 完整的工具集（BashTool、FileReadTool、FileWriteTool 等）
- 长期记忆系统（memory/）
- Skill 系统（skills/）

**设计决策**：从第一天起就采用了 Agentic 架构，而非简单的 chatbot 模式。

---

### 阶段二：功能完善期（2026-04-15 ~ 2026-04-22）

**提交：** `功能提交` → `web` → `123` → `增加图片支持 等等`

这一阶段主要是功能堆叠：

- Web 前端（React + Vite）
- 图片/PDF 多模态支持
- Gateway HTTP+WebSocket 服务

提交信息较随意（"123"、"web"），说明处于快速原型阶段。

---

### 阶段三：架构重构（2026-04-28）

**提交：** `feat: refactor core architecture with bootstrap setup and mode separation`

这是最重要的一次重构，涉及 19 个文件，核心变化：

1. **启动流程模块化**：将 `main.ts` 中的启动逻辑拆分到 `bootstrap/`（setupProvider、setupSession）
2. **运行模式分离**：将四种运行模式拆分到 `modes/`（gateway、interactive、print、server）
3. **路径安全工具**：新增 `pathSafety.ts`，防止路径遍历攻击
4. **会话上下文管理**：新增 `sessionContext.ts`（AsyncLocalStorage 隔离 sessionId）
5. **Schema 验证**：新增 `schema.ts`（Zod → JSON Schema 转换）
6. **权限规则增强**：支持通配符匹配、路径级权限控制

---

### 阶段四：IM 平台集成（2026-04-28）

**提交：** `feat(gateway): add IM platform adapter framework with multi-platform support`

新增 `gateway/im/` 目录，实现 IM 平台适配器框架：

- 抽象 `PlatformManager` 接口
- 企业微信（Weixin）完整协议实现（含消息持久化和分块发送）
- 支持多平台并行接入

---

### 阶段五：多智能体协调重构（2026-04-29 上午）

**提交：** `feat(core): refactor agent coordination with context isolation and session pruning`

涉及 24 个文件的大规模重构：

1. **Agent 上下文隔离**：新增 `agentContext.ts`，子智能体状态完全独立
2. **会话自动清理**：新增 `autoPruneSessions` 配置，支持按数量和天数清理旧会话
3. **记忆管道增强**：改进跨智能体交互的上下文保留
4. **移除遗留迁移脚本**：`requestId` 已原生支持，不再需要数据修复脚本

---

### 阶段六：DSML 解析器（2026-04-29 下午）

**提交序列：**
1. `feat(core): add DSML text-based tool call parsing for DeepSeek models`
2. `feat(core): add comprehensive DSML parser with tool call extraction and validation`
3. `解决合并冲突：采用远程版本（DSML 解析已迁移到 DsmlParser.ts）`
4. `refactor(core): migrate DSML parsing to dedicated module`

这一系列提交展示了一个典型的迭代过程：

- 先在 QueryEngine 内部实现 DSML 解析（快速验证）
- 发现合并冲突（多分支并行开发）
- 重构为独立的 `DsmlParser.ts` 模块（关注点分离）

**DSML 的价值**：让 DeepSeek、Qwen 等不原生支持 tool_use 的模型也能调用工具，大幅扩展了可用模型范围。

---

### 阶段七：craft 模式增强（2026-04-29 下午）

**提交：** `feat(core): enhance task execution with craft mode auto-continuation and improved decision handling`

- craft 模式下取消轮次上限（`maxTurns = Infinity`）
- 改进 `request_decision` 工具的决策处理
- 轮次上限触发后自动续跑（而非打断用户）

---

### 阶段八：Git 缓存与记忆文件缓存（2026-04-29 下午）

**提交：** `feat(core): refactor git context and memory file caching with async operations`

- Git 状态按 cwd 分桶缓存（5 秒 TTL），避免每条消息执行 3 次 git 命令
- 记忆文件按 cwd 分桶缓存（30 秒 TTL）
- 两者都实现了 LRU 淘汰（Map 迭代顺序 + 上限控制），防止 Gateway 长期运行内存泄漏

---

### 阶段九：质量提升（2026-04-29 晚）

**提交：**
- `feat(tools): add XML format support for todo list parsing` —— Todo 工具支持 XML 格式
- `test: add comprehensive unit test suite for core tools and utilities` —— 补充单元测试

---

## 五、关键设计模式总结

### 5.1 分层隔离原则

项目在多个维度都采用了分层隔离：

| 维度 | 隔离机制 |
|------|----------|
| 工作目录 | AsyncLocalStorage（cwd.ts） |
| 会话 ID | AsyncLocalStorage（sessionContext.ts） |
| 记忆存储 | 独立 SQLite 文件（sessions/<id>/palace.db） |
| 多智能体 | 独立 QueryEngine + 独立 PermissionManager |
| 消息总线 | 每个 TeamManager 持有独立 MessageBus |

### 5.2 成本意识设计

每个涉及 LLM 调用的地方都有成本控制：

- `CostTracker`：精确追踪每次调用的 token 和费用
- `maxBudgetUsd`：会话级成本上限，超出立即中止
- 三级压缩策略：优先使用零成本的字符串操作
- 工具输出截断：单条 12000 字符上限 + 总量 60000 字符预算

### 5.3 可观测性设计

- `auditLog()`：所有写操作和权限决策都有审计记录
- `logger.child()`：每个组件有独立的日志子记录器
- `StreamEvent`：细粒度事件流，前端可精确追踪每个工具调用的生命周期

### 5.4 防御性编程

- 工具执行超时（默认 10 分钟，可覆盖）
- 并发保护（`running` 标志）
- 原子写入（先写 `.tmp` 再 `rename`，防止文件损坏）
- 路径安全检查（`pathSafety.ts`）
- 孤立工具对修复（`sanitizeToolPairs`）

---

## 六、架构优势与潜在改进点

### 优势

1. **高度模块化**：每个关注点都有独立模块，边界清晰
2. **多模式统一**：CLI / Server / Gateway 共享同一个 QueryEngine，无代码重复
3. **跨模型兼容**：DSML 解析器让非原生 tool_use 模型也能工作
4. **生产级特性**：审计日志、成本追踪、会话持久化、优雅关闭
5. **可扩展性强**：工具注册、Skill 系统、MCP 协议都支持外部扩展

### 潜在改进点

1. **测试覆盖率**：单元测试在最后阶段才补充，核心模块（QueryEngine、PermissionManager）的测试覆盖仍有提升空间
2. **Plan 模式完整性**：`docs/plan-mode-design.md` 记录了 5 个已知问题（系统提示感知、拒绝反馈、切换流程等），部分已在后续提交中修复，但 `continuation_needed` 事件的前端处理仍待完善
3. **配置复杂度**：`AgentConfig` 接口已相当复杂，新用户上手成本较高，`init` 命令是一个好的缓解措施
4. **IM 平台扩展**：目前只有企业微信的完整实现，其他平台（钉钉等）的适配器框架已就绪但实现待补充

---

## 七、数据流全景图

```
用户输入
  │
  ▼
[运行模式层] 解析输入，构建 Message 对象
  │
  ▼
[SessionManager / 直接调用] 设置 cwd 上下文 + sessionId 上下文
  │
  ▼
[QueryEngine.send()]
  ├─ onBeforeSend 钩子（动态更新 systemPrompt）
  ├─ 意图检测（isQueryIntent）
  ├─ applyToolResultBudget（零成本截断）
  ├─ autocompact 检查（token 超阈值时压缩）
  │
  ├─ [streamOneTurn] 调用 LLM
  │   ├─ plan 模式：工具 description 追加不可用标注
  │   ├─ 流式输出 text_delta
  │   ├─ 收集 tool_calls
  │   └─ DSML 解析（非原生 tool_use 模型）
  │
  ├─ [executeOneTool] 执行工具
  │   ├─ 工具级硬拦截（checkPermission）
  │   ├─ PermissionManager 策略决策
  │   ├─ 审计日志
  │   └─ Promise.race（工具 / 超时 / abort）
  │
  ├─ continuation 检测（是否继续下一轮）
  └─ done
  │
  ▼
[postRunHooks] 后台异步
  ├─ autoExtractMemories（记忆提炼）
  └─ autoDistillSkill（Skill 自动沉淀）
  │
  ▼
[SessionStore] 持久化会话历史（增量追加）
```

---

*报告基于源码静态分析 + Git 历史动态分析生成。*
