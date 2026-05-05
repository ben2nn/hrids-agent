# 任务系统设计文档

## 设计目标

为 hrids-agent 设计一套全新的任务管理系统，解决 LLM 在执行复杂任务时的五个核心失控点：

1. **计划被覆盖**：LLM 重新规划时替换整个任务列表，原有进度丢失
2. **执行停滞**：完成一步后输出文字总结然后停下，缺乏持续执行的驱动
3. **过早完成**：没有验收标准，LLM 凭主观判断标记完成
4. **压缩后漂移**：上下文压缩后不知道自己在做什么，容易重新规划
5. **范围失控**：意图模糊的任务直接执行，跑偏后才发现

---

## 设计原则

**接口设计优于 prompt 约束**
能通过接口物理上阻止的错误行为，不依赖 prompt 规则来禁止。

**工具返回值驱动执行循环**
每个工具的返回值必须明确告诉 LLM 下一步调用什么工具、传什么参数。LLM 不需要"思考下一步"，跟着返回值走。

**状态机替代规则列表**
System prompt 描述状态机（当前状态 → 唯一正确的下一步），而不是约束规则（不能做什么）。

**可选字段不增加认知负担**
验收标准、依赖关系、任务背景均为可选字段，简单任务完全不用，复杂任务按需填写。

**不确定性决定是否需要规划确认**
低不确定性任务直接执行，高不确定性任务先输出规划等用户确认，再建立任务列表。

---

## 数据结构

```typescript
interface Todo {
  // 核心字段（必须）
  id: string                                        // 系统自增，LLM 不传，格式 "1", "2", "3"...
  content: string                                   // 任务内容
  status: 'pending' | 'in_progress' | 'completed'  // 状态
  priority: 'high' | 'medium' | 'low'              // 优先级，影响 todo_read 展示排序
  createdAt: number                                 // 创建时间戳（ms），用于排序和过期判断

  // 质量保障字段（可选）
  acceptance?: string[]   // 验收标准，完成前逐条确认，需配合 confirmations 参数
  dependsOn?: string[]    // 依赖的任务 id，依赖未完成时不能开始
  context?: string        // 任务背景/来源，压缩后意图锚点
}
```

**LLM 不传 id，由系统自增。** 这从根本上消灭了"LLM 用新 id 覆盖已有任务"的可能性。

**所有工具参数必须是合法 JSON，不接受其他格式。** 工具 schema 使用 `z.strictObject()` 强制约束字段类型和枚举值，LLM 传入非法格式时在 schema 验证层直接拒绝，不进入执行逻辑。

**`saveTodos()` 使用原子写入。** 先写临时文件 `todos.json.tmp`，再 `rename` 替换，防止并发写入时文件半写损坏。与 `SessionStore.ts` 的 meta.json 写入模式一致。

---

## 存储结构

**参考** Kiro 将 specs 放在 `.kiro/specs/` 的目录约定，任务文件存储在**当前工作目录**的 `.hrids/` 目录下，形成与 Kiro 对称的目录结构。

这是独立的设计，不与 Kiro 集成，只是借鉴了"项目配置放在工作目录隐藏文件夹"的约定。`.hrids/` 是 hrids-agent 自己的目录，Kiro 有自己的 `.kiro/`，两者互不干扰。

```
{cwd}/
└── .hrids/
    ├── tasks/
    │   └── todos.json        ← 任务列表（本次实现）
    ├── specs/                ← 功能规格（Kiro 生成，已存在于会话工作目录）
    │   └── {feature}/
    │       ├── requirements.md
    │       ├── design.md
    │       └── tasks.md
    └── rules/                ← 项目级规则（预留，本次不实现）
```

| Kiro（参考对象） | hrids-agent（本系统） | 用途 |
|------|-------------|------|
| `.kiro/specs/` | `.hrids/specs/` | 功能规格文档 |
| `.kiro/steering/` | `.hrids/rules/` | 项目级规则/约定（预留） |
| — | `.hrids/tasks/` | 当前执行任务列表（新增） |

**路径解析：**

```typescript
import { resolve } from 'path'
import { getGlobalCwd } from '../core/cwd.js'

function getTodoFile(): string {
  return resolve(getGlobalCwd(), '.hrids', 'tasks', 'todos.json')
}
```

**`.gitignore` 建议：**

```gitignore
# 任务是临时执行状态，不提交
.hrids/tasks/

# specs 和 rules 是项目配置，建议提交到 git
# .hrids/specs/
# .hrids/rules/
```

---

## 工具接口

### 工具一览

| 工具 | 职责 | 核心约束 |
|------|------|---------|
| `todo_write` | 首次建立完整计划 | 列表非空时拒绝，LLM 不传 id |
| `todo_update` | 更新单条任务状态 | 接受 id + status，有 acceptance 时需附 confirmations |
| `todo_append` | 追加新任务 | 不影响已有任务，LLM 不传 id |
| `todo_reset` | 请求重置计划 | 必须先经用户确认，不可直接执行 |
| `todo_read` | 读取当前状态 | 只读 |

---

### todo_write — 建立计划

```typescript
inputSchema: {
  todos: z.array(z.strictObject({
    content:    z.string(),                                  // 任务内容，纯文本字符串
    priority:   z.enum(['high', 'medium', 'low']),           // 优先级枚举值
    acceptance: z.array(z.string()).optional(),              // 验收标准，字符串数组
    dependsOn:  z.array(z.string()).optional(),              // 依赖的任务序号，如 ["1", "2"]
    context:    z.string().optional(),                       // 任务背景，纯文本字符串
  })).min(1)   // schema 层强制非空，不只是执行逻辑判断
}
```

**格式约束（写入工具 description）：**
- 参数必须是合法的 JSON 对象，不接受 XML、YAML 或其他格式
- `todos` 是 JSON 数组，每项是 JSON 对象，字段名和值必须符合 schema
- 不要传 `id` 字段，系统自动分配，传了也会被忽略
- `acceptance` 和 `dependsOn` 是字符串数组，不是逗号分隔的字符串

执行逻辑：
- `.hrids/tasks/todos.json` 存在且非空时，直接返回错误，附带当前计划
- 系统自动分配递增 id（从 1 开始）
- **写入前做有向图环检测**：若 `dependsOn` 存在循环依赖，拒绝写入并提示冲突链路（如 "任务 A → B → A 形成循环"）
- **自动将第一个任务标记为 `in_progress`**，省去 LLM 额外调用一次 `todo_update`
- 使用原子写入（临时文件 + rename），防止并发写入损坏
- 保存后触发 WebSocket 推送

**所有写操作（`todo_write`、`todo_update`、`todo_append`、`todo_reset` 用户允许后）均触发 WebSocket `todos_updated` 推送，前端实时刷新任务列表。**

返回值（成功）：
```
计划已建立（共 4 项），已自动开始第一个任务。

▸ [1] 分析需求（进行中）
○ [2] 实现后端 API
○ [3] 编写前端组件
○ [4] 写测试

现在执行：「分析需求」
完成后调用 todo_update(id='1', status='completed')
```

返回值（列表已存在）：
```
错误：任务计划已存在，禁止覆盖。
当前计划：
  ▸ [2] 实现后端 API（进行中）
  ○ [3] 编写前端组件
  ○ [4] 写测试

如需追加任务请用 todo_append，更新状态请用 todo_update。
```

---

### todo_update — 更新单条状态

```typescript
inputSchema: z.strictObject({
  id:            z.string(),                                      // 任务 id，如 "1"、"2"
  status:        z.enum(['in_progress', 'completed']),            // 只允许这两个值
  confirmations: z.array(z.boolean()).optional(),                 // 有 acceptance 时必须提供，逐条确认
})
```

**格式约束：**
- 参数必须是合法的 JSON 对象
- `id` 是字符串类型，不是数字（传 `"1"` 而不是 `1`）
- `status` 只接受 `"in_progress"` 或 `"completed"` 两个枚举值，不接受其他字符串
- 有 `acceptance` 字段的任务标记 `completed` 时，必须同时传 `confirmations`，且长度与 `acceptance` 一致、全部为 `true`，否则系统拒绝完成

执行逻辑：
- `in_progress`：检查 `dependsOn`，依赖未完成则拒绝；自动将其他 in_progress 任务降为 pending
- `completed`：
  - 若有 `acceptance` 字段，检查 `confirmations` 参数：未提供或未全部为 `true` 时返回验收清单，不标记完成；全部确认后才真正标记完成
  - 无验收标准时**自动将下一个 pending 任务（按优先级 high→medium→low，同优先级按 id 顺序）标记为 `in_progress`**，省去 LLM 额外调用一次 `todo_update`
- id 不存在时返回错误："任务 id='X' 不存在，请调用 todo_read 确认当前任务列表"
- 每次执行成功后触发 WebSocket 推送

返回值（标记 in_progress）：
```
任务「实现后端 API」已开始（id: 2）。进度：1/4。

现在执行：「实现后端 API」
完成后调用 todo_update(id='2', status='completed')
```

返回值（标记 completed，无验收标准，有下一个任务）：
```
✓ 任务「分析需求」已完成（1/4）。已自动开始下一个任务。

▸ [2] 实现后端 API（进行中）
○ [3] 编写前端组件
○ [4] 写测试

现在执行：「实现后端 API」
完成后调用 todo_update(id='2', status='completed')
```

返回值（标记 completed，有验收标准，未提供 confirmations）：
```
任务「实现后端 API」标记完成前，请逐条确认以下验收标准：

□ [0] POST /api/login 返回 JWT token
□ [1] 密码错误时返回 401
□ [2] token 过期时返回 403
□ [3] 单元测试覆盖以上三个场景

全部满足后调用：
todo_update(id='2', status='completed', confirmations=[true, true, true, true])
```

返回值（依赖未完成）：
```
错误：任务「编写前端组件」依赖任务「实现后端 API」（id: 2），
但该任务尚未完成（当前状态：in_progress）。
请先完成任务 2，再开始任务 3。
```

返回值（全部完成）：
```
✓ 所有 4 个任务已完成。

现在输出最终结果给用户，不要再调用任何任务工具。
```

---

### todo_append — 追加新任务

```typescript
inputSchema: z.strictObject({
  todos: z.array(z.strictObject({
    content:    z.string(),
    priority:   z.enum(['high', 'medium', 'low']),
    acceptance: z.array(z.string()).optional(),
    dependsOn:  z.array(z.string()).optional(),
    context:    z.string().optional(),
  })).min(1),
})
```

**格式约束：**
- 与 `todo_write` 相同，参数必须是合法的 JSON 对象
- 不要传 `id` 字段，系统自动分配

执行逻辑：追加到列表末尾，系统自动分配 id（当前最大 id + 1）。
- `dependsOn` 只能引用已存在的任务 id，引用不存在的 id 时返回错误
- **写入前做有向图环检测**：若新任务的 `dependsOn` 与现有任务形成循环，拒绝写入并提示冲突链路
- 使用原子写入（临时文件 + rename）
- 执行成功后触发 WebSocket 推送

返回值：
```
已追加 2 个新任务（id: 5, 6）。

当前仍在执行：「实现后端 API」（id: 2）。
请继续完成当前任务，不要切换到新追加的任务。
完成后调用 todo_update(id='2', status='completed')。
```

---

### todo_reset — 请求重置计划

LLM **不能直接清空任务列表**，必须通过此工具上报用户，由用户决定是否允许重置。

```typescript
inputSchema: z.strictObject({
  reason:  z.string(),           // 说明为什么需要重置当前计划
  newPlan: z.string().optional() // 可选：描述重置后的新方案，帮助用户做决策
})
```

**格式约束：**
- `reason` 和 `newPlan` 均为纯文本字符串，不要传 JSON 对象或数组

执行逻辑：
- 触发 `request_decision` 流程，将重置请求上报给用户
- 具体实现：`todo_reset` 内部直接复用 `DecisionTool` 的底层基础设施（`resolveDecision` 机制），不依赖 LLM 主动调用 `request_decision`，避免 LLM 绕过确认步骤
- **决策超时 5 分钟**：用户未响应时自动视为拒绝，LLM 继续执行原计划。`todo_reset` 自行实现超时逻辑（`Promise.race` + `setTimeout`），不依赖 `DecisionTool` 的现有机制（`DecisionTool` 本身没有超时实现）
- 任务列表为空时直接返回错误："当前没有任务计划，无需重置"
- **用户允许重置前，自动备份当前任务列表**到 `.hrids/tasks/todos.bak.{timestamp}.json`，支持手动回滚
- 展示当前计划状态 + LLM 的重置理由 + 新方案描述
- 等待用户决策，LLM 不能继续执行直到用户响应

用户看到的决策请求：
```
LLM 请求重置任务计划

原因：发现原方案无法实现，需要换一种技术路线

当前计划：
  ✓ [1] 分析需求
  ▸ [2] 实现后端 API（进行中）
  ○ [3] 编写前端组件
  ○ [4] 写测试

新方案：改用 GraphQL 替代 REST API，需要重新规划步骤

选项：
  [允许重置] 清空当前计划，LLM 将建立新计划
  [拒绝重置] 保留当前计划，LLM 继续执行
```

返回值（用户允许）：
```
用户已允许重置。任务列表已清空。
请调用 todo_write 建立新计划。
```

返回值（用户拒绝）：
```
用户拒绝了重置请求。请继续执行原有计划。
当前执行中：「实现后端 API」（id: 2）。
请继续完成，完成后调用 todo_update(id='2', status='completed')。
```

---

### todo_read — 读取状态

```typescript
inputSchema: z.strictObject({})  // 无参数
```

列表为空时返回：
```
当前没有任务计划。
如需建立计划，调用 todo_write。
```

列表非空时返回（默认只展示未完成任务 + 最近 3 条已完成，按优先级排序）：
```
进度：2/5 完成

已完成（最近）：
✓ [1] 分析需求
✓ [2] 实现后端 API

未完成（按优先级）：
▸ [3] 编写前端组件（进行中）[high]
  验收标准：
    □ [0] LoginForm 组件渲染正常
    □ [1] 表单验证逻辑完整
    □ [2] 对接 /api/login 接口
○ [4] 写测试 [medium]
○ [5] 更新文档 [low]

当前执行中：「编写前端组件」（id: 3）。
完成后调用 todo_update(id='3', status='completed', confirmations=[true, true, true])
```

---

## 规划确认机制

### 两种执行路径

**直接执行（低不确定性）**
```
用户：把 getUserName 重命名为 getUsername
LLM：直接调用 todo_write 建立任务，立即开始执行
```

**规划确认（高不确定性）**
```
用户：帮我重构认证模块的架构
LLM：先输出规划方案（不调用 todo_write），等用户确认
用户：确认 / 调整
LLM：调用 todo_write 建立任务，开始执行
```

### 判断标准

必须先输出规划方案等用户确认：
- 任务涉及架构决策或方案选择（有多种可行路径）
- 任务影响范围超出单个文件或模块
- 任务包含不可逆操作（删除、重构、数据迁移）
- 用户意图模糊，需要澄清范围

直接建立任务并执行：
- 意图明确，范围清晰
- 单文件或局部修改
- 用户明确说"直接做"

### 规划方案格式

```
我的计划：

目标：[一句话描述用户的最终目标]

方案：
1. [步骤描述]
2. [步骤描述]
...

影响范围：[涉及的文件/模块]
预计步骤：N 个任务

确认后开始执行，或告诉我需要调整的地方。
```

---

## System Prompt 状态机

LLM 在任何时刻只需要知道一件事：**现在该调用哪个工具，传什么参数**。以下是完整的工具调用序列，没有歧义。

```
# 任务执行流程

收到复杂任务（3步以上）时：
  1. 调用 todo_write（建立计划，系统自动开始第一个任务）
  2. 执行当前任务（调用相应工具完成实际工作）
  3. 调用 todo_update(id='N', status='completed')
     → 系统自动开始下一个任务，返回值告诉你下一步
  4. 重复步骤 2-3，直到返回"所有任务已完成"

意图模糊或影响范围广时（架构决策、不可逆操作、多种可行方案）：
  先输出规划方案，等用户确认后再调用 todo_write

发现遗漏步骤时：
  调用 todo_append（追加，不中断当前任务）
  继续执行当前任务，不要切换

需要推翻原有计划时：
  调用 todo_reset（上报用户，等待决策）
  不要直接调用 todo_write

# 执行纪律

- 每次工具调用完成后，立即调用下一个工具，不输出中间总结
- 工具返回值已告知下一步，跟着走，不需要自行判断
- 遇到错误：分析根因，换方案重试，同一错误不超过 2 次相同修复
- 任务未完成前不输出最终结果
```

---

## 压缩恢复机制

**方案：每次请求前动态注入到 system prompt 末尾，而不是注入到历史消息中。**

注入到历史消息的问题：下次压缩时该消息会被当作普通历史处理，可能被摘要化丢失（二次压缩问题）。

正确方案是在 `QueryEngine` 每次构建 API 请求时，从文件实时读取任务状态，动态追加到 system prompt 末尾。这样无论压缩多少次，每次 LLM 调用都能看到最新的任务状态。

```typescript
// src/core/QueryEngine.ts — 每次调用 provider.stream() 前，动态追加到 systemPrompt
function buildLiveTodoContext(): string | null {
  try {
    const todos = loadTodos()  // 从 {cwd}/.hrids/tasks/todos.json 实时读取
    const active = todos.filter(t => t.status !== 'completed')
    if (!active.length) return null

    const completed = todos.filter(t => t.status === 'completed').length
    const lines = [
      '## 当前任务状态（实时）',
      `进度：${completed}/${todos.length}`,
    ]

    for (const t of active) {
      const icon = t.status === 'in_progress' ? '▸' : '○'
      const priority = t.priority !== 'medium' ? ` [${t.priority}]` : ''
      lines.push(`${icon} [${t.id}] ${t.content}${priority}`)
      // 对 in_progress 任务注入完整的验收标准和上下文
      if (t.status === 'in_progress') {
        if (t.context) lines.push(`  背景：${t.context}`)
        if (t.acceptance?.length) {
          lines.push('  验收标准：')
          t.acceptance.forEach((a, i) => lines.push(`    □ [${i}] ${a}`))
        }
        if (t.dependsOn?.length) lines.push(`  依赖：${t.dependsOn.join(', ')}`)
      }
    }

    const inProgress = active.find(t => t.status === 'in_progress')
    if (inProgress) {
      lines.push('')
      const hasAcceptance = inProgress.acceptance?.length
      if (hasAcceptance) {
        lines.push(`当前执行中：「${inProgress.content}」（id: ${inProgress.id}）。`)
        lines.push(`完成后调用 todo_update(id='${inProgress.id}', status='completed', confirmations=[true×${inProgress.acceptance!.length}])`)
      } else {
        lines.push(`当前执行中：「${inProgress.content}」（id: ${inProgress.id}）。`)
        lines.push(`完成后调用 todo_update(id='${inProgress.id}', status='completed')`)
      }
    }

    return lines.join('\n')
  } catch {
    return null  // 文件不存在或读取失败时静默跳过
  }
}
```

注入位置：`streamOneTurn()` 调用 `provider.stream()` 前，构建临时的 `systemPromptWithTodo` 数组（不修改 `this.config.systemPrompt` 共享引用），只在本次调用中使用：

```typescript
// streamOneTurn() 内部
const liveTodo = buildLiveTodoContext()
const systemPromptForThisTurn = liveTodo
  ? [...this.config.systemPrompt, liveTodo]
  : this.config.systemPrompt

const streamFn = () => this.config.provider.stream(
  this.history as never,
  toolsForLLM,
  systemPromptForThisTurn,  // ← 使用临时数组，不污染 config
  ...
)
```

**注意**：任务状态是动态层，不参与 Anthropic prompt cache（cache_control 只打在静态层元素上），每次请求都会重新发送，这是预期行为。

**优势对比：**

| 方案 | 二次压缩安全 | 实时性 | 实现复杂度 |
|------|------------|--------|-----------|
| 注入历史消息（旧方案） | ❌ 可能被摘要化 | 仅压缩时更新 | 低 |
| 动态注入 system prompt（新方案） | ✅ 每次请求都是最新状态 | 每次请求实时读取 | 低 |

---

## 实现计划

- [ ] **1. 新建 src/tools/TodoTool.ts**（全新文件，不改造旧文件）
  - 实现 `getTodoFile()`：路径为 `{cwd}/.hrids/tasks/todos.json`，使用 `getGlobalCwd()`
  - 实现 `loadTodos()` / `saveTodos()`，`saveTodos()` 使用原子写入（临时文件 + rename）
  - 实现系统自增 id 逻辑
  - 实现有向图环检测函数 `detectCycle(todos, newDependsOn)`，`todo_write` 和 `todo_append` 写入前调用
  - 实现 `todo_write`：列表非空时拒绝，LLM 不传 id，inputSchema 加 `.min(1)` 约束和 `z.strictObject()` 严格模式，支持 acceptance/dependsOn/context，写入前做环检测
  - 实现 `todo_update`：单条状态更新，依赖检查，有 acceptance 时强制要求 `confirmations` 参数（全部 true 才标记完成），无 acceptance 时按优先级自动推进下一个任务
  - 实现 `todo_append`：追加新任务，系统分配 id，写入前做环检测，原子写入
  - 实现 `todo_reset`：触发 `request_decision` 上报用户，5 分钟超时自动拒绝，用户允许前先备份到 `todos.bak.{timestamp}.json`，用户允许后清空列表
  - 实现 `todo_read`：默认只展示未完成任务 + 最近 3 条已完成，按优先级排序，含驱动性提示
  - 导出 `loadTodos` 供 `QueryEngine` 动态注入 system prompt 使用
  - 导出 `setTodosUpdatedCallback` 供 SessionManager 注册推送回调

- [ ] **2. 更新 src/tools/index.ts**
  - 移除旧 `TodoWriteTool`、`TodoReadTool` 的导入和注册
  - 注册新的 `TodoWriteTool`、`TodoUpdateTool`、`TodoAppendTool`、`TodoResetTool`、`TodoReadTool`

- [ ] **3. 更新 src/core/coordinator/coordinatorPrompt.ts**
  - 将 `SECTION_TODO` 替换为状态机描述
  - 加入规划确认的判断标准
  - 更新工具速查表（新增 `todo_update`、`todo_append`、`todo_reset`，移除旧 `todo_write` 的全量语义说明）

- [ ] **4. 更新 src/core/QueryEngine.ts — 动态任务状态注入**
  - 实现 `buildLiveTodoContext()` 函数，从文件实时读取任务状态
  - 在 `streamOneTurn()` 内部构建临时 `systemPromptForThisTurn` 数组（不修改 `this.config.systemPrompt` 共享引用），将 `buildLiveTodoContext()` 结果追加其中
  - 对 in_progress 任务注入完整的 acceptance、context、dependsOn 信息
  - 无活跃任务时不注入，避免无意义内容占用 token

- [ ] **5. 更新 src/gateway/SessionManager.ts**
  - 从新 `TodoTool.ts` 导入 `setTodosUpdatedCallback`
  - 注册推送回调（逻辑不变，仅更新 import 来源）
  - `todo_reset` 的决策推送复用 `DecisionTool` 的 `gatewayDecisionCallbacks` / `sessionDecisionResolves` 机制，在 `SessionManager` 中同时注册 `setGatewayDecisionCallback`（已有）

- [ ] **6. 更新前端类型定义**
  - `src/web/src/lib/types.ts` 中 `Todo` 接口新增 `acceptance`、`dependsOn`、`context`、`createdAt` 字段
  - `todos_updated` WebSocket 消息直接传 `Todo[]`，`Todo` 接口更新后自动生效，无需单独修改消息类型

- [ ] **7. 删除旧文件**
  - 新工具稳定后删除 `src/tools/TodoWriteTool.ts`
  - 旧文件中的 `setTodosUpdatedCallback`、`getCurrentSessionId` 路由逻辑已迁移到新 `TodoTool.ts`，确认无其他文件 import 旧工具后再删除
  - 旧文件的 `getTodoFile()` 使用 `sessionId` 路由到 `~/.hrids-agent/sessions/{sessionId}/todos.json`，新文件改为 `{cwd}/.hrids/tasks/todos.json`，旧路径完全废弃

- [ ] **8. 更新前端 TodoItem 组件（可选）**
  - 若有 `acceptance` 字段，展示验收标准列表

---

## 正确性属性

**属性 1：计划不可被 LLM 自行覆盖**
对于任意非空的任务列表，LLM 直接调用 `todo_write` 后，原有任务列表不变，返回错误信息。重置必须经过 `todo_reset` → 用户确认 → 清空 的完整流程。

**属性 2：id 单调递增且系统分配**
对于任意 `todo_write` 或 `todo_append` 调用，新任务的 id 均大于当前列表中所有任务的 id，且 LLM 无法指定 id。

**属性 3：同一时刻最多一个 in_progress**
对于任意 `todo_update(id, 'in_progress')` 调用，执行后列表中 status 为 `in_progress` 的任务有且仅有一个。

**属性 7：自动推进，最短工具调用路径**
`todo_write` 成功后自动将第一个任务标记为 `in_progress`，无需 LLM 额外调用 `todo_update`。`todo_update(completed)` 成功后（无验收标准时）自动将下一个 pending 任务标记为 `in_progress`，无需 LLM 额外调用 `todo_update`。整个执行循环中 LLM 只需调用 `todo_update(completed)`，系统自动处理状态推进。

**属性 4：依赖约束**
对于任意有 `dependsOn` 字段的任务，在其依赖的所有任务均为 `completed` 之前，调用 `todo_update(id, 'in_progress')` 返回错误。

**属性 5：验收标准强制确认**
对于任意有 `acceptance` 字段的任务，调用 `todo_update(id, 'completed')` 时，若未提供 `confirmations` 参数或 `confirmations` 未全部为 `true`，系统拒绝标记完成并返回带索引的验收清单。只有 `confirmations` 长度与 `acceptance` 一致且全部为 `true` 时才真正标记完成。

**属性 8：无循环依赖**
对于任意 `todo_write` 或 `todo_append` 调用，若新任务的 `dependsOn` 与现有任务形成有向环，系统拒绝写入并返回具体的循环链路。

**属性 9：任务状态在每次 LLM 请求中可见**
对于任意 LLM 请求，若存在活跃任务（pending 或 in_progress），system prompt 末尾包含当前任务状态快照，且 in_progress 任务的 acceptance、context 完整呈现。该注入每次请求实时读取文件，不受上下文压缩影响。

---

## 设计决策记录

**决策 1：为什么不引入主子任务两层结构**
两层结构引入调用顺序依赖（必须先有 Plan 才能有 Task），LLM 出错时导致级联失败。`acceptance` 字段和 prompt 状态机已经能解决任务粒度和完成标准问题，不需要额外的层级。

**决策 2：为什么存储在 `{cwd}/.hrids/tasks/`**
参考 Kiro 将项目配置放在工作目录隐藏文件夹（`.kiro/`）的目录约定，hrids-agent 使用 `.hrids/` 作为自己的项目配置目录。这是独立设计，不与 Kiro 集成。

具体好处：
- 同一工作目录的多次会话共享任务列表，用户可以继续上次未完成的任务
- 不同工作目录的任务天然隔离
- `ContextBuilder.ts` 中已有 `{cwd}/.hrids/AGENT.md` 的读取逻辑，保持一致性
- `rules/` 子目录预留给未来的项目级规则功能

**决策 3：为什么 LLM 不传 id**
LLM 传 id 意味着它可以用相同 id 覆盖已有任务，或用新 id 绕过保护。系统自增 id 后，LLM 物理上无法覆盖已有任务。

**决策 4：为什么 acceptance 是可选的**
强制所有任务写验收标准会增加 LLM 认知负担，对简单任务没有价值。可选字段让复杂任务获得质量保障，不影响简单任务效率。

**决策 5：规划确认为什么不做成独立工具**
规划阶段输出的是自然语言描述，不需要结构化存储。规划确认是 LLM 的行为模式，通过 prompt 状态机描述比工具接口更合适，也不增加工具数量。

**决策 6：为什么新建文件而不是改造旧文件**
全新设计，无历史负债。新建 `TodoTool.ts` 比在旧 `TodoWriteTool.ts` 上打补丁更清晰，旧文件在新工具稳定后直接删除。

**决策 8：为什么 `todo_write` 和 `todo_update(completed)` 自动推进到下一个任务**
最短路径原则：LLM 在任何时刻只需要知道"现在该调用哪个工具"。自动推进消灭了两个冗余的 `todo_update(in_progress)` 调用——建立计划后和完成任务后，系统直接告知"现在执行 X，完成后调用 todo_update(id='N', status='completed')"，LLM 跟着走即可，不需要额外决策。
任务计划不是不可变的——用户有权修改，LLM 没有权限自行修改。`todo_reset` 把 LLM 的"重新规划冲动"转化为一个用户决策点：合理的重新规划（真的发现了更好的方案）可以被允许，不合理的重新规划（LLM 遇到障碍想逃避）会被用户识别并拒绝。这与现有 `request_decision` 工具的设计理念完全一致。

**决策 9：为什么压缩恢复改为 system prompt 动态注入而不是注入历史消息**
注入历史消息的方案存在二次压缩问题：下次压缩时该消息会被当作普通历史处理，可能被摘要化丢失。动态注入 system prompt 的方案每次请求都实时读取文件，完全不受压缩影响，且能保证 in_progress 任务的 acceptance、context 等关键信息始终完整呈现给 LLM。

**决策 10：为什么 `confirmations` 参数要求 LLM 显式传入而不是系统自动通过**
验收标准的核心价值是强制 LLM 在标记完成前逐条核对。如果系统自动通过，等于没有验收。要求 LLM 显式传入 `confirmations: [true, true, true]` 意味着 LLM 必须在工具调用参数里明确表达"我已确认每一条"，这是接口层面的强制约束，而不是 prompt 层面的软性要求。
