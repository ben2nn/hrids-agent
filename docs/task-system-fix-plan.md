# 任务系统结构性缺陷整改方案

> 基于 GPT-5.4 评估报告，结合代码库实际状态（2026-04-30）

## 问题定位

GPT-5.4 识别出三个结构性缺口，经代码核查全部属实：

| # | 缺陷 | 根因文件 | 影响 |
|---|------|---------|------|
| 1 | Todo 推送单例，多会话串流 | `TodoTool.ts:27`、`SessionManager.ts:206` | A 会话改任务，B 会话收到推送 |
| 2 | Cron 无会话归属，硬绑知了会话 | `gatewayMode.ts:37`、`ScheduleCronTool.ts` | 所有定时任务落到同一会话 |
| 3 | 子智能体继承 todo_* 工具，快照双真相 | `index.ts:34`、`AgentTool.ts:86`、`AgentPool.ts:226` | 子任务改计划，父任务拿旧快照继续跑 |

**补充确认**：`startDate`/`endDate` 字段已进入数据模型和 REST API，但 `scheduleJob()` 从未消费（`ScheduleCronTool.ts:226`）。属于契约暴露、行为未落地。

**不需要动的部分**：`runWithCwd`/`runWithSession` 的 AsyncLocalStorage 隔离思路正确；`ask_user`/`request_decision` 已按 sessionId Map 路由，无需改动。

---

## 整改一：Todo 推送改为 sessionId → callback Map

### 问题

```typescript
// TodoTool.ts:27 —— 全局单例，后注册的会话覆盖前一个
let todosUpdatedCallback: (() => void) | null = null

export function setTodosUpdatedCallback(cb: (() => void) | null): void {
  todosUpdatedCallback = cb  // ← 每次 createSession 都覆盖这里
}
```

`SessionManager.createSession()` 每次都调用 `setTodosUpdatedCallback`，最后创建的会话"接管"全局回调。A 会话修改任务 → 触发 `triggerTodosUpdated()` → 实际推送给 B 会话的 WebSocket。

### 修改方案

**文件：`src/tools/TodoTool.ts`**

将单例回调改为 `Map<sessionId, callback>`，触发时通过 `getCurrentSessionId()` 路由到正确的会话。

```typescript
// ─── WebSocket 推送回调（会话级 Map，替代全局单例）────────────────────────────

// key: sessionId（Gateway 多会话）或 '__global__'（CLI/Server 单会话）
const todosUpdatedCallbacks = new Map<string, () => void>()

/**
 * 注册 todos_updated 推送回调（由 SessionManager 调用）
 * Gateway 模式传入 sessionId 实现会话级隔离；CLI/Server 模式不传，使用 '__global__'
 */
export function setTodosUpdatedCallback(
  cb: (() => void) | null,
  sessionId?: string,
): void {
  const key = sessionId ?? '__global__'
  if (cb) todosUpdatedCallbacks.set(key, cb)
  else todosUpdatedCallbacks.delete(key)
}

/** 内部触发推送回调 —— 按当前 AsyncLocalStorage 上下文的 sessionId 路由 */
function triggerTodosUpdated(): void {
  const sessionId = getCurrentSessionId()
  // Gateway 多会话：精确路由到当前会话
  if (sessionId) {
    const cb = todosUpdatedCallbacks.get(sessionId)
    if (cb) { cb(); return }
  }
  // CLI/Server 单会话：回退到 '__global__'
  const globalCb = todosUpdatedCallbacks.get('__global__')
  if (globalCb) globalCb()
}
```

**文件：`src/gateway/SessionManager.ts`**

`setTodosUpdatedCallback` 调用时传入 `sessionId`：

```typescript
// 修改前（line 206）：
setTodosUpdatedCallback(() => {
  const s = this.sessions.get(sessionId)
  if (s) {
    const todos = loadTodos()
    this.broadcast(s, { type: 'todos_updated', todos })
  }
})

// 修改后：传入 sessionId，实现会话级隔离
setTodosUpdatedCallback(() => {
  const s = this.sessions.get(sessionId)
  if (s) {
    const todos = loadTodos()
    this.broadcast(s, { type: 'todos_updated', todos })
  }
}, sessionId)  // ← 新增第二个参数
```

同时在 `destroySession()` 中注销回调，防止内存泄漏：

```typescript
async destroySession(id: string): Promise<void> {
  // ... 现有逻辑 ...
  setTodosUpdatedCallback(null, id)  // ← 新增：注销推送回调
  setGatewayAskCallback(null, id)    // 已有
  setGatewayDecisionCallback(null, id)  // 已有
  setResetDecisionCallback(null, id)    // 已有
}
```

### 影响范围

- `TodoTool.ts`：修改 `setTodosUpdatedCallback` 签名和 `triggerTodosUpdated` 实现
- `SessionManager.ts`：修改调用处传参，`destroySession` 补充注销
- CLI/Server 模式：`setTodosUpdatedCallback(cb)` 不传 sessionId，行为不变（向后兼容）

---

## 整改二：Cron 增加 sessionId 归属，去掉知了会话硬绑定

### 问题

**问题 A：Cron 无会话归属**

```typescript
// ScheduleCronTool.ts:15 —— CronJob 接口无 sessionId 字段
export interface CronJob {
  id: string
  expression: string
  task: string
  // ... 无 sessionId
}

// server.ts:947 —— POST /crons 创建接口无 sessionId
const job = {
  id, expression, description, task,
  // ... 无 sessionId
}
```

**问题 B：触发时硬绑知了会话**

```typescript
// gatewayMode.ts:37 —— 所有 cron 都路由到同一个知了会话
setCronTriggerCallback((job) => {
  const zhileFile = join(homedir(), '.hrids-agent', 'zhile-session.json')
  const { sessionId } = JSON.parse(readFileSync(zhileFile, 'utf-8'))
  // 所有 job 都投递到这个 sessionId，无论是谁创建的
  await gateway.manager.sendCronReminder(sessionId, { ... })
})
```

**问题 C：`startDate`/`endDate` 字段未被消费**

```typescript
// ScheduleCronTool.ts:226 —— scheduleJob 从未检查 startDate/endDate
function scheduleJob(job: CronJob) {
  if (!job.enabled) return
  // ← 没有 startDate/endDate 检查
  let nextRun = job.nextRunAt
  // ...
}
```

### 修改方案

#### 步骤 1：CronJob 接口增加 sessionId 字段

**文件：`src/tools/ScheduleCronTool.ts`**

```typescript
export interface CronJob {
  id: string
  expression: string
  description: string
  task: string
  createdAt: number
  lastRunAt?: number
  nextRunAt?: number
  enabled: boolean
  once?: boolean
  startDate?: string   // 生效开始日期（ISO 日期字符串）
  endDate?: string     // 生效结束日期（ISO 日期字符串）
  sessionId?: string   // ← 新增：归属会话 ID（可选，兼容旧数据）
}
```

#### 步骤 2：scheduleJob 消费 startDate/endDate

```typescript
function scheduleJob(job: CronJob) {
  if (!job.enabled) return

  const now = Date.now()

  // 检查 endDate：已过期则跳过调度
  if (job.endDate) {
    const end = new Date(job.endDate).getTime()
    if (!isNaN(end) && now > end) {
      console.info(`[cron] 任务已过有效期，跳过调度: ${job.id} (endDate: ${job.endDate})`)
      return
    }
  }

  // 检查 startDate：未到生效日期则延迟到 startDate 再调度
  let fromTime: number | undefined
  if (job.startDate) {
    const start = new Date(job.startDate).getTime()
    if (!isNaN(start) && now < start) {
      // 从 startDate 开始计算第一次执行时间
      fromTime = start
    }
  }

  // 计算下次执行时间（传入 fromTime 影响起算点）
  let nextRun = job.nextRunAt
  let delay = nextRun ? nextRun - now : -1

  if (delay <= 0) {
    nextRun = parseNextRun(job.expression, fromTime)
    // ... 其余逻辑不变
  }
  // ...
}
```

#### 步骤 3：触发回调携带 sessionId，gatewayMode 按 sessionId 路由

**文件：`src/tools/ScheduleCronTool.ts`**

```typescript
// 触发回调签名不变（保持向后兼容），但 job 对象现在携带 sessionId
let onTrigger: ((job: CronJob) => void) | null = null
```

**文件：`src/modes/gatewayMode.ts`**

```typescript
setCronTriggerCallback((job) => {
  void (async () => {
    try {
      // 优先使用 job 自身的 sessionId 归属
      let targetSessionId: string | undefined = job.sessionId

      // 降级：无归属时回退到知了会话（兼容旧数据）
      if (!targetSessionId) {
        const zhileFile = join(homedir(), '.hrids-agent', 'zhile-session.json')
        if (!existsSync(zhileFile)) {
          logger.warn('[cron] 任务无 sessionId 归属且知了会话文件不存在，跳过触发', { jobId: job.id })
          return
        }
        const parsed = JSON.parse(readFileSync(zhileFile, 'utf-8')) as { sessionId?: string }
        targetSessionId = parsed.sessionId
      }

      if (!targetSessionId) {
        logger.warn('[cron] 无法确定目标会话，跳过触发', { jobId: job.id })
        return
      }

      let session = gateway.manager.getSession(targetSessionId)
      if (!session) {
        logger.warn('[cron] 目标会话不在内存中，尝试恢复', { jobId: job.id, sessionId: targetSessionId })
        try {
          await gateway.manager.createSession({ resume: targetSessionId })
          session = gateway.manager.getSession(targetSessionId)
        } catch (err) {
          logger.error('[cron] 恢复目标会话失败', { error: String(err) })
          return
        }
      }

      if (!session) {
        logger.error('[cron] 目标会话恢复后仍不存在', { jobId: job.id, sessionId: targetSessionId })
        return
      }

      logger.info('[cron] 触发定时任务', { jobId: job.id, sessionId: targetSessionId })
      await gateway.manager.sendCronReminder(targetSessionId, {
        id: job.id,
        description: job.description,
        task: job.task,
      })
    } catch (err) {
      logger.error('[cron] 触发定时任务失败', { jobId: job.id, error: String(err) })
    }
  })()
})
```

#### 步骤 4：POST /crons 接口接收 sessionId

**文件：`src/gateway/server.ts`**

```typescript
// POST /crons —— 创建定时任务
app.post('/crons', async (req, res) => {
  const body = req.body as {
    expression: string
    description: string
    task: string
    once?: boolean
    startDate?: string
    endDate?: string
    sessionId?: string   // ← 新增：归属会话 ID
  }
  // ...
  const job = {
    id,
    expression: body.expression,
    description: body.description,
    task: body.task,
    createdAt: Date.now(),
    nextRunAt,
    enabled: true,
    once,
    ...(body.startDate ? { startDate: body.startDate } : {}),
    ...(body.endDate ? { endDate: body.endDate } : {}),
    ...(body.sessionId ? { sessionId: body.sessionId } : {}),  // ← 新增
  }
  // ...
})
```

#### 步骤 5：ScheduleCronTool（LLM 工具）自动绑定当前会话

当 LLM 在某个会话中调用 `schedule_cron` 工具时，自动将当前 sessionId 写入 job：

```typescript
// ScheduleCronTool.ts —— execute 方法中
async execute(input) {
  const sessionId = getCurrentSessionId()  // 从 AsyncLocalStorage 获取
  const job: CronJob = {
    id: `cron-${Date.now().toString(36)}`,
    expression: input.expression,
    description: input.description,
    task: input.task,
    createdAt: Date.now(),
    enabled: true,
    once: input.once ?? false,
    ...(input.startDate ? { startDate: input.startDate } : {}),
    ...(input.endDate ? { endDate: input.endDate } : {}),
    ...(sessionId ? { sessionId } : {}),  // ← 自动绑定当前会话
  }
  // ...
}
```

### 影响范围

- `ScheduleCronTool.ts`：`CronJob` 接口增加 `sessionId?`，`scheduleJob` 消费 `startDate`/`endDate`，`execute` 自动绑定 sessionId
- `gatewayMode.ts`：触发回调按 `job.sessionId` 路由，无归属时降级到知了会话
- `server.ts`：`POST /crons` 接口接收 `sessionId` 字段
- 旧数据兼容：`sessionId` 为可选字段，旧 cron 数据无此字段时自动降级到知了会话

---

## 整改三：子智能体默认禁用 todo_* 工具

### 问题

**双真相根因**：

```
磁盘 todos.json（共享真相）
    ↑ 父 QueryEngine.activeTodoSnapshot（父会话快照）
    ↑ 子 QueryEngine.activeTodoSnapshot（子会话快照）
```

子智能体（`AgentTool.ts`、`AgentPool.ts`）默认继承 `ALL_TOOLS`，其中包含 `todo_write`、`todo_update`、`todo_append`、`todo_reset`、`todo_read`。

子任务修改了 `todos.json` → 父 `QueryEngine.activeTodoSnapshot` 不刷新（只有父自己调用 todo 工具后才刷新）→ 父任务 prompt 里仍注入旧快照 → 重复推进、错误完成、错误下一步提示。

**代码证据**：

```typescript
// AgentTool.ts:86 —— 子智能体继承全部工具，包括 todo_*
const allTools = mgr.getBaseTools()
const tools = input.allowed_tools
  ? allTools.filter(t => input.allowed_tools!.includes(t.name))
  : allTools  // ← 默认全部，包含 todo_write/update/append/reset

// AgentPool.ts:80 —— 同样逻辑
const tools = allowedTools
  ? this.baseTools.filter(t => allowedTools.includes(t.name))
  : this.baseTools  // ← 默认全部
```

```typescript
// QueryEngine.ts:764 —— 快照只在"自己调用 todo 工具成功后"刷新
const TODO_TOOLS = new Set(['todo_write', 'todo_update', 'todo_append', 'todo_reset', 'todo_read'])
if (TODO_TOOLS.has(tc.name) && finalResult.type === 'success') {
  this.activeTodoSnapshot = loadTodos()  // ← 只有当前 engine 调用才触发
}
```

### 修改方案

**策略：子智能体默认过滤 todo_* 工具，只有显式 `allowed_tools` 包含时才开放。**

这是最小侵入的修复方式，不需要把 Todo 改成会话级状态服务（那是更大的重构）。

#### 修改 AgentTool.ts

```typescript
// 默认从子智能体工具列表中排除的工具
// 理由：这些工具操作共享的任务计划文件，子智能体修改后父智能体快照不会自动刷新，
// 导致双真相问题。只有主协调器（父会话）才应该管理任务计划。
const SUB_AGENT_EXCLUDED_TOOLS = new Set([
  'todo_write',
  'todo_update',
  'todo_append',
  'todo_reset',
  // todo_read 保留：只读操作，子智能体可以查看任务状态
])

// execute 方法中：
const allTools = mgr.getBaseTools()
const tools = input.allowed_tools
  ? allTools.filter(t => input.allowed_tools!.includes(t.name))
  : allTools.filter(t => !SUB_AGENT_EXCLUDED_TOOLS.has(t.name))  // ← 默认排除写操作
```

#### 修改 AgentPool.ts

```typescript
// 与 AgentTool.ts 保持一致的排除规则
const SUB_AGENT_EXCLUDED_TOOLS = new Set([
  'todo_write',
  'todo_update',
  'todo_append',
  'todo_reset',
])

// submit 方法中：
const tools = allowedTools
  ? this.baseTools.filter(t => allowedTools.includes(t.name))
  : this.baseTools.filter(t => !SUB_AGENT_EXCLUDED_TOOLS.has(t.name))  // ← 默认排除
```

#### 父 QueryEngine 主动刷新快照（补充修复）

子智能体执行完毕后，父 QueryEngine 的快照可能已过期。在 `AgentTool.ts` 的 `execute` 方法末尾，通知父引擎刷新快照：

```typescript
// AgentTool.ts —— 子智能体执行完毕后，通知父会话刷新 todo 快照
// 通过 TeamManager 获取父会话的 engine，调用 refreshTodoSnapshot()
const parentEngine = mgr.getEngine?.()
if (parentEngine) {
  parentEngine.refreshTodoSnapshot()
}
```

对应在 `QueryEngine.ts` 中暴露刷新方法：

```typescript
/** 主动刷新任务快照（供子智能体执行完毕后通知父引擎使用） */
refreshTodoSnapshot(): void {
  try {
    this.activeTodoSnapshot = loadTodos()
  } catch {
    // 读取失败保持原快照
  }
}
```

> **注意**：`TeamManager.getEngine()` 需要确认是否已有此方法，若无则需补充。这是可选的增强，核心修复是"默认排除 todo 写工具"。

### 影响范围

- `AgentTool.ts`：默认工具列表排除 `todo_write/update/append/reset`
- `AgentPool.ts`：同上
- `QueryEngine.ts`：暴露 `refreshTodoSnapshot()` 方法（可选增强）
- 向后兼容：`allowed_tools` 显式包含 todo_* 时仍可使用（高级场景）

---

## 整改优先级与执行顺序

```
P0（立即修）：整改一 —— Todo 推送串会话
  影响：多会话下必现 bug，A 改任务 B 收到推送
  工作量：小（改 2 个文件，约 20 行）

P1（本周修）：整改三 —— 子智能体禁用 todo 写工具
  影响：子任务场景下任务计划被意外修改
  工作量：小（改 2 个文件，约 10 行）

P2（下周修）：整改二 —— Cron sessionId 归属
  影响：多会话下 cron 全落到知了会话
  工作量：中（改 3 个文件，约 50 行）

P3（顺手修）：startDate/endDate 消费
  影响：契约暴露但行为未落地，前端设置了不生效
  工作量：小（在整改二中一并完成）
```

---

## 不在本次整改范围内的事项

以下问题 GPT-5.4 也提到，但属于更大的架构重构，不在本次范围：

1. **Cron 语义问题**（"定时提醒" vs "定时执行任务"）：`sendCronReminder` 直接广播 assistant 文本，不经过 QueryEngine。改成真正执行任务需要重构 `sendCronReminder` → `runMessage`，涉及并发控制、历史管理等，单独立项。

2. **Todo 改成真正的会话级状态服务**：当前 `todos.json` 是 cwd 级共享文件，多会话共享同一 cwd 时仍有冲突。完整解法是把 Todo 存储改为 `sessionId` 维度，但这会破坏"任务跨会话持久化"的现有语义，需要产品决策。

3. **子智能体 todo_read 快照一致性**：子智能体读到的是磁盘当前状态，父快照是内存缓存，两者可能短暂不一致。这是缓存一致性问题，整改三的"排除写工具"已消除最危险的写冲突，读不一致是可接受的最终一致性。

---

## 验证方案

### 整改一验证

```bash
# 创建两个会话 A 和 B
# 在会话 A 中调用 todo_write 写入任务
# 验证：只有会话 A 的 WebSocket 收到 todos_updated 事件
# 验证：会话 B 的 WebSocket 不收到任何 todos_updated 事件
```

### 整改二验证

```bash
# 在会话 A 中通过 schedule_cron 工具创建一个 cron
# 验证：crons.json 中该 job 的 sessionId 字段 = 会话 A 的 sessionId
# 触发该 cron
# 验证：sendCronReminder 投递到会话 A，而非知了会话

# 创建一个 startDate = 明天的 cron
# 验证：今天不触发，明天触发

# 创建一个 endDate = 昨天的 cron
# 验证：scheduleJob 跳过，不注册 timer
```

### 整改三验证

```bash
# 在父会话中调用 agent 工具派生子智能体
# 不传 allowed_tools
# 验证：子智能体的工具列表中不包含 todo_write/update/append/reset
# 验证：子智能体包含 todo_read（只读工具保留）

# 传 allowed_tools: ['todo_write', 'bash']
# 验证：子智能体可以使用 todo_write（显式授权场景）
```
