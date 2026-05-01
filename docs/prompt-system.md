# 提示词系统设计文档

> 更新日期：2026-05-02  
> 对应源码：`src/core/coordinator/coordinatorPrompt.ts`、`src/core/QueryEngine.ts`、`src/core/ContextBuilder.ts`

---

## 一、设计目标

提示词系统需要同时满足三个相互制约的目标：

1. **缓存命中率**：固定内容尽量不变，让 Anthropic API 的 prompt caching 生效，降低 token 成本
2. **内容精准性**：不同任务类型注入不同规则，避免无关内容占用上下文窗口
3. **状态实时性**：任务进度、工作目录、Git 状态等动态信息每轮都要最新

三者的矛盾通过**分层架构**解决：固定的内容放静态层（可缓存），变化的内容放动态层（不缓存）。

---

## 二、整体架构

```
每次 LLM 调用的 system prompt 结构（string[]）
─────────────────────────────────────────────────────────
[0]  角色定义          ┐
[1]  执行原则          │
[2]  谨慎操作          │  静态层（8 个 section）
[3]  工具使用          │  内容固定，逐元素打 cache_control
[4]  任务计划          │  API 缓存命中后只计 cache_read token
[5]  决策上报          │
[6]  文件路径          │
[7]  输出规范          ┘
─────────────────────────────────────────────────────────
[8]  工具速查          ── 动态生成（按实际工具列表，含 MCP）
─────────────────────────────────────────────────────────
[9+] 扩展层            ── 按消息关键词按需注入（0~N 个）
─────────────────────────────────────────────────────────
[末] 动态层            ── 每条消息重新计算（记忆、环境、Git）
─────────────────────────────────────────────────────────
[末] 任务状态          ── 每轮 LLM 调用前注入（有未完成任务时）
─────────────────────────────────────────────────────────
```

**关键约束**：静态层的元素数量和顺序固定不变，扩展层和动态层只追加在末尾，不影响静态层的缓存命中位置。

---

## 三、静态层（每次请求都携带）

文件：`src/core/coordinator/coordinatorPrompt.ts` → `STATIC_SECTIONS`

共 8 个 section，合计约 1571 字。内容固定，适合 API 缓存。

| # | 常量名 | 内容摘要 | 字符数 |
|---|--------|---------|--------|
| 0 | `SECTION_INTRO` | 角色定义 + prompt injection 防御声明 | ~115 |
| 1 | `SECTION_EXECUTION` | 豁免情况 + 工具调用规范 + 错误处理 | ~293 |
| 2 | `SECTION_ACTIONS` | 需要确认的操作类型 + 禁止破坏性绕过 | ~152 |
| 3 | `SECTION_TOOLS` | 专用工具优先于 shell + 并行调用规范 | ~309 |
| 4 | `SECTION_TODO` | 单步直接执行 / 多步建计划 / 高不确定性先确认 | ~278 |
| 5 | `SECTION_DECISION` | `request_decision` 触发条件 + `ask_user` 规范 | ~163 |
| 6 | `SECTION_FILE_PATH` | 必须用相对路径 + 禁止写用户主目录 | ~166 |
| 7 | `SECTION_OUTPUT` | 中文回复 + 简洁直接 + markdown 格式 | ~88 |

### 设计原则

- `SECTION_EXECUTION` 是唯一定义"豁免情况"的地方（问候/闲聊/纯知识问答直接回复，不调用工具），不在其他 section 重复
- `SECTION_TODO` 只保留核心决策规则（~280 字），完整的 4 状态机移到扩展层 `EXT_TASK`，避免每次请求都携带详细规则
- `SECTION_TOOLS` 中的 `SHELL_TOOL_NAME` 在模块加载时根据 `process.platform` 确定（Windows 用 `powershell`，其他用 `bash`），之后内容固定

---

## 四、工具速查层（每次请求，内容随工具列表变化）

文件：`coordinatorPrompt.ts` → `buildToolsReferenceSection(tools)`

每条消息都重新生成，根据当前会话实际加载的工具动态列出分组。

**内置工具分组**（`BUILTIN_TOOL_GROUPS`）：

| 分组 | 工具 |
|------|------|
| 信息获取 | `web_search` / `web_fetch` / `file_read` / `grep` / `glob` / `memory_search` |
| 文件操作 | `file_write` / `file_edit` |
| 执行命令 | `bash` 或 `powershell`（平台自动选择） |
| 任务管理 | `todo_write` / `todo_update` / `todo_append` / `todo_reset` / `todo_read` |
| 人机交互 | `ask_user` / `request_decision` |
| 协作 | `agent` / `schedule_cron` |
| 技能管理 | `skill` / `skill_list` / `skill_save` |
| SkillHub | `skillhub_search` / `skillhub_install` / `skillhub_recommend` / `skillhub_config` / `skillhub_setup` |

**MCP 工具**：格式为 `mcp__serverName__toolName`，按 server 名自动分组，追加在内置工具之后。

**兜底**：无工具列表时使用 `SECTION_TOOLS_REFERENCE_FALLBACK`（静态字符串，内容固定，可缓存）。

---

## 五、扩展层（按消息关键词按需注入）

文件：`coordinatorPrompt.ts` → `EXTENSIONS` + `classifyTask()`

`classifyTask(message)` 对用户消息做关键词正则匹配，命中则注入对应扩展块。扩展块追加在工具速查之后，不影响静态层缓存。

### 5.1 扩展块列表

| 扩展块 ID | 常量名 | 内容 | 字符数 |
|-----------|--------|------|--------|
| `task` | `EXT_TASK` | 完整 4 状态任务状态机 + 工具速查 | ~450 |
| `code` | `EXT_CODE` | 代码开发规范 + skill_save 沉淀规则 | ~380 |
| `script` | `EXT_SCRIPT` | shell 超时参数规范 + 脚本文件管理 | ~370 |
| `crawl` | `EXT_CRAWL` | 爬虫策略选择 + 反爬处理 + 数据质量 | ~310 |
| `agent` | `EXT_AGENT` | 子智能体派生规范 + cron 表达式格式 | ~360 |
| `file` | `EXT_FILE` | 分页读取 + 数据格式验证 + 编码规范 | ~240 |
| `memory` | `EXT_MEMORY` | `memory_add` 触发时机 + 记忆类型选择 | ~230 |
| `skillhub` | `EXT_SKILLHUB` | SkillHub 推荐时机 + 安装流程 | ~200 |

### 5.2 触发关键词

| 扩展块 | 触发关键词（正则） |
|--------|-----------------|
| `task` | "实现功能"、"添加功能"、"帮我做/完成/实现"、"分几步完成"、"重构"、"迁移" |
| `code` | "写代码"、"修改代码"、"bug"、"报错"、"错误修复"、TypeScript/Python/Rust 等语言名、"函数/类/接口/组件" |
| `script` | "运行脚本"、"执行脚本"、"pip install"、"npm install"、"批量处理"、"超时" |
| `crawl` | "爬虫"、"爬取"、"抓取"、"采集"、selenium/playwright/beautifulsoup |
| `agent` | "并行"、"并发"、"子智能体"、"定时任务"、"cron"、"每天/每周/每小时" |
| `file` | "读取文件"、"解析文件"、csv/excel/大文件、"数据转换"、"格式转换" |
| `memory` | "记住"、"记忆"、"以后都用"、"不要用" |
| `skillhub` | "技能"、"skill"、"帮我找工具"、"有没有现成"、腾讯会议/腾讯文档/Notion |

### 5.3 级联规则

```
crawl  → 自动追加 script
code   → 自动追加 task
crawl  → 自动追加 task
script → 自动追加 task
```

**示例**：消息"帮我爬取这个网站的数据" → 命中 `crawl` → 级联追加 `script` + `task` → 最终注入 3 个扩展块。

### 5.4 强制注入

`getCoordinatorSystemPrompt()` 支持 `forceExtensions` 参数，可绕过关键词匹配强制注入指定扩展块，用于测试或特殊场景。

---

## 六、动态层（每条消息重新计算）

文件：`src/core/ContextBuilder.ts` → `buildSystemContext()`

追加在扩展层之后，每条消息都重新计算，不缓存。

| 内容 | 来源 | 缓存策略 |
|------|------|---------|
| 项目记忆（AGENT.md） | `{cwd}/AGENT.md`、`{cwd}/.hrids/AGENT.md`、`~/.hrids-agent/AGENT.md`（按优先级） | 按 cwd 分桶，30 秒 TTL，LRU 淘汰（上限 100 条） |
| 长期记忆（L0+L1） | SQLite，按 sessionId 隔离（Gateway 模式）或全局（CLI 模式） | 无缓存，每次读取 |
| 环境信息 | `process.platform`、`process.env.SHELL`、`new Date()` | 无缓存，每次生成 |
| Git 状态 | `git branch --show-current` + `git status --short` + `git log --oneline -5` | 按 cwd 分桶，5 秒 TTL，LRU 淘汰（上限 200 条） |

**注入格式示例**：

```
## 项目记忆
[记忆文件: /path/to/AGENT.md]
...文件内容...

## 长期记忆（共 12 条，约 480 tokens）
...L0 身份 + L1 核心摘要...

## 环境信息
操作系统: Windows (win32)
Shell: PowerShell
当前时间: 2026/5/2 10:30:00
用户主目录: C:\Users\xxx
用户名: xxx
注意: Windows 环境，路径分隔符为 \，使用 PowerShell 语法

Git 状态:
当前分支: main
工作区变更:
 M src/core/coordinator/coordinatorPrompt.ts
最近提交:
abc1234 feat: refactor prompt system
```

---

## 七、任务状态注入（每轮 LLM 调用前）

文件：`src/core/QueryEngine.ts` → `buildLiveTodoContext()` + `streamOneTurn()`

这是独立于上述四层之外的特殊注入，在 `QueryEngine` 内部每轮调用 LLM 前动态追加到 system prompt 末尾。

### 7.1 触发条件

| 条件 | 注入内容 |
|------|---------|
| `activeTodoSnapshot === null` | 不注入（本会话尚未使用任务系统） |
| 快照非空，有未完成任务 | 注入完整任务状态 + 当前执行指令 |
| 快照非空，全部已完成 | 注入一行"全部完成"提示，告知 LLM 不要再调用任务工具 |
| 快照为空数组 `[]` | 不注入（任务列表已被重置） |

### 7.2 注入内容示例（有未完成任务时）

```
## 当前任务状态（实时）
进度：1/3
▸ [2] 编写单元测试
  背景：覆盖 QueryEngine 的核心路径
  验收标准：
    □ [0] 所有测试通过
    □ [1] 覆盖率 > 80%
○ [3] 更新文档
当前执行中：「编写单元测试」（id: 2）
完成后调用：todo_update(id='2', status='completed', confirmations=[true, true])
```

### 7.3 快照生命周期

```
send() 开始
  │
  ├─ activeTodoSnapshot === null？
  │   └─ 是 → 预热：读取磁盘，有任务则激活快照（解决会话恢复后状态丢失问题）
  │
  ├─ [每轮] streamOneTurn() → 注入快照到 system prompt
  │
  └─ executeOneTool() 检测到 todo_* 工具调用成功
      └─ 立即刷新：activeTodoSnapshot = loadTodos()
```

**快照预热**（2026-05-02 新增）：`send()` 开始时，若快照为 null 且磁盘上已有任务，主动读取一次。解决了会话恢复后首轮消息看不到任务状态的问题。

---

## 八、完整调用链

```
用户发送消息
  │
  ▼
SessionManager._runMessageInContext()
  ├─ getCoordinatorSystemPrompt(content, allTools)
  │   ├─ STATIC_SECTIONS（8 个固定 section）
  │   ├─ buildToolsReferenceSection(tools)（工具速查，动态）
  │   └─ classifyTask(content) → 按需追加扩展块
  │
  ├─ buildSystemContext(coordinatorPrompt, cwd, sessionId)
  │   ├─ 追加：项目记忆（AGENT.md）
  │   ├─ 追加：长期记忆（L0+L1）
  │   └─ 追加：环境信息 + Git 状态
  │
  ├─ plan 模式？→ 追加 Plan 模式附录
  │
  └─ engine.setSystemPrompt(fullPrompt)
       │
       ▼
     QueryEngine.send()
       ├─ 快照预热（activeTodoSnapshot === null 时）
       │
       └─ [每轮] streamOneTurn()
             ├─ buildLiveTodoContext(activeTodoSnapshot)
             └─ provider.stream([...systemPrompt, liveTodo], ...)
```

---

## 九、缓存策略说明

文件：`src/core/providers/AnthropicProvider.ts`

Anthropic API 支持对 system prompt 的各个 block 单独打 `cache_control: { type: 'ephemeral' }`。

**打标规则**：
- 静态层的前 `STATIC_SECTION_COUNT - 1` 个 section 打 `cache_control`
- 最后一个静态 section 不打标（因为后面还有动态内容追加，打标无意义）
- 工具速查、扩展层、动态层不打标（内容每次变化，缓存无效）

**效果**：静态层（~1571 字）在内容不变时命中缓存，只计 `cache_read_input_tokens`（约为正常 token 价格的 1/10），显著降低高频对话的成本。

---

## 十、扩展指南

### 新增扩展块

1. 在 `coordinatorPrompt.ts` 中定义新的 `PromptExtension` 常量：

```typescript
const EXT_MY_FEATURE: PromptExtension = {
  id: 'my_feature',
  content: `# 我的功能规范\n\n...`,
}
```

2. 在 `TaskType` 联合类型中添加新类型：

```typescript
export type TaskType = 'task' | 'script' | ... | 'my_feature'
```

3. 在 `CLASSIFY_RULES` 中添加触发规则：

```typescript
{
  type: 'my_feature',
  keywords: [/关键词1|关键词2/i],
},
```

4. 在 `EXTENSIONS` 映射中注册：

```typescript
const EXTENSIONS: Record<TaskType, PromptExtension> = {
  // ...
  my_feature: EXT_MY_FEATURE,
}
```

### 修改静态层

修改静态层内容会导致所有已缓存的 prompt 失效（缓存 key 基于内容哈希）。建议：
- 小幅修改（修正措辞、补充规则）：直接改，缓存会在下次请求后重建
- 大幅重构（调整结构、拆分 section）：注意 `STATIC_SECTION_COUNT` 是否需要同步更新

### 调试提示词

```typescript
import { getCoordinatorSystemPrompt, classifyTask } from './src/core/coordinator/coordinatorPrompt.js'

// 查看某条消息会触发哪些扩展
console.log(classifyTask('帮我爬取这个网站的数据'))
// → ['crawl', 'script', 'task']

// 查看完整 prompt 结构
const sections = getCoordinatorSystemPrompt('帮我修复这个 bug', tools)
sections.forEach((s, i) => console.log(`[${i}]`, s.slice(0, 50)))
```
