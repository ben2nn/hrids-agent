# Event Sourcing v2 改进设计

本文档是 `event-sourcing.md` 的改进方案，针对当前事件存储设计中发现的问题提出具体修改。每个改进项独立成节，可按优先级分批实施。

## 改进总览

| # | 改进项 | 优先级 | 影响范围 | 状态 |
|---| --- | --- | --- | --- |
| 1 | JSONL 读取容错 | 高 | `ConversationStore.loadEvents()` | 待实施 |
| 2 | Schema 版本标记 | 高 | `events.jsonl` 文件格式 | 待实施 |
| 3 | 系统事件独立类型 | 中 | 事件类型、QueryEngine、投影层 | 待实施 |
| 4 | 工具执行记录事件 | 中 | 事件类型、QueryEngine | 待实施 |
| 5 | 请求完成事件 | 中 | 事件类型、QueryEngine、投影层 | 待实施 |
| 6 | toolCalls 拆分为独立事件 | 低 | 事件类型、QueryEngine、投影层 | 待评估 |
| 7 | 事件 ID 全局唯一 | 低 | 事件工厂函数 | 待评估 |
| 8 | 事件类型命名简化 | — | 全部事件类型 | 评估后保留现状 |

---

## 改进 1：JSONL 读取容错

### 问题

`appendFileSync` 写入不是原子的。进程在写入中途崩溃可能产生半行 JSON：

```jsonl
{"type":"user_message","id":"user-1","content":"hel
{"type":"assistant_message","id":"asst-1","text":"hi"}
```

当前 `loadEvents()` 直接 `JSON.parse` 每行，遇到损坏行会抛异常导致整个会话加载失败。

### 方案

在 `JsonlEventStorage.loadEvents()` 中逐行 try/catch，跳过损坏行并记录警告：

```ts
loadEvents(): ConversationEvent[] {
  if (!existsSync(this.eventsPath)) return []
  const content = readFileSync(this.eventsPath, 'utf-8')
  if (!content.trim()) return []

  const events: ConversationEvent[] = []
  const lines = content.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      events.push(JSON.parse(line) as ConversationEvent)
    } catch {
      // 跳过损坏行，记录到 stderr
      process.stderr.write(`[events.jsonl] 第 ${i + 1} 行 JSON 解析失败，已跳过: ${line.slice(0, 80)}...\n`)
    }
  }

  return events
}
```

### 附加：写入保护

`rewrite()` 方法已使用 tmp + rename 原子写入，这是正确的。`saveEvents()` 使用 `appendFileSync`，在 Node.js 中单次 `appendFileSync` 对小于 `PIPE_BUF`（通常 4KB）的写入是原子的。超出时可改为先写 tmp 再 append：

```ts
saveEvents(events: ConversationEvent[]): void {
  const lines = events.map(e => JSON.stringify(e)).join('\n') + '\n'
  // 对于大块写入，使用 tmp + append 模式
  if (lines.length > 4096) {
    const tmp = this.eventsPath + '.tmp'
    writeFileSync(tmp, lines, 'utf-8')
    // 用 appendFileSync 追加 tmp 内容（保持 append-only 语义）
    appendFileSync(this.eventsPath, readFileSync(tmp, 'utf-8'), 'utf-8')
    unlinkSync(tmp)
  } else {
    appendFileSync(this.eventsPath, lines, 'utf-8')
  }
}
```

### 涉及文件

- `src/core/ConversationStore.ts` — `JsonlEventStorage.loadEvents()` 和 `saveEvents()`

---

## 改进 2：Schema 版本标记

### 问题

事件结构没有版本号。未来修改事件格式（如加 `agentId`、改字段类型）时，无法区分新旧格式，也无法做数据迁移。

### 方案

在 `events.jsonl` 文件首行写入 schema marker：

```jsonl
{"$schema":"hrids-events/v1"}
{"type":"user_message","id":"user-1","timestamp":1778241325720,"content":"你好"}
{"type":"assistant_message","id":"asst-1","timestamp":1778241331412,"text":"你好！"}
```

规则：

- marker 必须是文件第一行，以 `$schema` 字段标识
- 版本格式：`hrids-events/v{major}`，major 变更表示不兼容的格式变更
- 读取时：如果首行无 `$schema`，默认为 `v0`（当前格式）
- 写入时：`rewrite()` 和首次 `saveEvents()` 始终写入最新版本 marker

### 实现

```ts
const CURRENT_SCHEMA = 'hrids-events/v1'

// loadEvents() 中
loadEvents(): ConversationEvent[] {
  // ...
  let startIdx = 0
  const firstLine = lines[0]?.trim()
  if (firstLine) {
    try {
      const marker = JSON.parse(firstLine)
      if (marker.$schema) {
        startIdx = 1  // 跳过 marker 行
        // 未来可按 marker.$schema 做版本分支
      }
    } catch { /* 不是 marker，按 v0 处理 */ }
  }

  for (let i = startIdx; i < lines.length; i++) {
    // ... 解析事件
  }
}

// rewrite() 中
rewrite(events: ConversationEvent[]): void {
  const marker = JSON.stringify({ $schema: CURRENT_SCHEMA }) + '\n'
  const body = events.map(e => JSON.stringify(e)).join('\n') + '\n'
  const tmp = this.eventsPath + '.tmp'
  writeFileSync(tmp, marker + body, 'utf-8')
  renameSync(tmp, this.eventsPath)
}
```

### 涉及文件

- `src/core/ConversationStore.ts` — `JsonlEventStorage` 的 `loadEvents()`、`saveEvents()`、`rewrite()`

---

## 改进 3：系统事件独立类型

### 问题

当前系统注入消息复用 `user_message` 和 `assistant_message` 类型，靠内容前缀（`[系统提示]`、`[定时任务触发]`、`[图片内容:`）区分。这导致：

- 投影层无法可靠区分真实用户输入和系统注入
- 前端只能靠 `content.startsWith('[系统提示]')` 过滤，容易被 LLM 输出混淆
- 语义不清：系统提示不是用户消息，cron 触发不是助手回复

### 方案

新增 `system_event` 类型：

```ts
interface SystemEvent {
  type: 'system_event'
  id: string
  timestamp: number
  requestId?: string
  kind: 'error_recovery' | 'cron_trigger' | 'vision_inject' | 'turn_limit' | 'user_abort'
  content: string
  /** cron 触发时的任务描述 */
  cronDescription?: string
  /** 视觉模型注入时的图片路径 */
  images?: string[]
}
```

`kind` 取值说明：

| kind | 触发场景 | 当前实现 |
| --- | --- | --- |
| `error_recovery` | LLM 请求失败后注入恢复提示 | `user_message` + `[系统提示] 上次执行因错误中断` |
| `cron_trigger` | 定时任务触发 | `assistant_message` + `[定时任务触发: ...]` |
| `vision_inject` | 图片识别结果注入 | `user_message` + `[图片内容: ...]` + `assistant_message` |
| `turn_limit` | 达到最大轮次限制 | `user_message` + `[系统提示] 任务因达到最大轮次限制` |
| `user_abort` | 用户中止任务 | `user_message` + `[系统提示] 任务被用户中止` |

### 投影层适配

**projectForDisplay**：

```ts
case 'system_event': {
  // 根据 kind 决定展示方式
  if (ev.kind === 'cron_trigger') {
    messages.push({ role: 'user', content: ev.content, isCron: true, cronDescription: ev.cronDescription })
  } else if (ev.kind === 'vision_inject') {
    messages.push({ role: 'user', content: ev.content, images: ev.images })
  } else {
    // error_recovery / turn_limit / user_abort → 注入为系统提示，不影响展示
    // 可选：前端是否展示由 UI 层决定
  }
  break
}
```

**projectForLLM**：

```ts
case 'system_event': {
  // 所有系统事件都注入为 user 消息，LLM 需要感知这些上下文
  messages.push({ role: 'user', content: ev.content })
  break
}
```

### 迁移策略

旧数据中的 `[系统提示]` 前缀消息保持不变，投影层同时兼容两种格式：

```ts
// projectForLLM 中
case 'user_message': {
  // 旧格式兼容：[系统提示] 前缀的消息仍然作为 user 消息注入
  messages.push({ role: 'user', content: ev.content })
  break
}
```

### 涉及文件

- `src/core/ConversationStore.ts` — 新增 `SystemEvent` 类型和 `createSystemEvent()` 工厂函数
- `src/core/projections.ts` — `projectForDisplay()` 和 `projectForLLM()` 增加 `system_event` 分支
- `src/core/QueryEngine.ts` — 将 `[系统提示]` 注入改为 `createSystemEvent()`
- `src/gateway/SessionManager.ts` — cron trigger 和 vision inject 改为 `createSystemEvent()`

---

## 改进 4：工具执行记录事件

### 问题

当前事件日志只记录工具的输入（`assistant_message.toolCalls`）和输出（`tool_result`），不记录执行过程：

- 无法审计工具执行耗时
- `tool_log`（bash stdout、爬虫日志等）完全丢失
- 无法事后分析工具失败原因（只有最终错误消息）

### 方案

新增 `tool_execution` 事件，记录工具执行的元数据（不含完整日志，避免膨胀）：

```ts
interface ToolExecutionEvent {
  type: 'tool_execution'
  id: string
  timestamp: number
  requestId?: string
  toolCallId: string
  toolName: string
  /** 执行耗时（毫秒） */
  durationMs: number
  /** 执行状态 */
  status: 'success' | 'error' | 'denied' | 'aborted'
  /** 输出摘要（截断后的前 500 字符） */
  outputPreview?: string
  /** 错误摘要 */
  errorSummary?: string
  /** 来源：哪个智能体执行的 */
  agentId?: string
}
```

### 写入时机

在 `QueryEngine.executeOneTool()` 的 finally 块中写入：

```ts
private async *executeOneTool(tc) {
  const startTime = Date.now()
  let status: 'success' | 'error' | 'denied' | 'aborted' = 'success'
  let outputPreview: string | undefined
  let errorSummary: string | undefined

  try {
    // ... 执行工具 ...
    yield { type: '__tool_result__', block: ... }
    outputPreview = result.output?.slice(0, 500)
  } catch (err) {
    status = 'error'
    errorSummary = String(err).slice(0, 200)
  } finally {
    this.store.appendEvents(createToolExecutionEvent(
      tc.id, tc.name, Date.now() - startTime,
      status, outputPreview, errorSummary,
      this.currentRequestId ?? undefined,
    ))
  }
}
```

### 投影层

`projectForDisplay` 和 `projectForLLM` 默认忽略 `tool_execution` 事件（它不影响对话内容）。可选在前端展示工具耗时：

```ts
// projectForDisplay 中，可选增强
case 'tool_execution': {
  // 可选：在 toolCard 中附加耗时信息
  // 默认跳过，不影响消息内容
  break
}
```

### 存储影响

每个多轮对话增加约 10-20 个 `tool_execution` 事件，每个约 200 字符，额外开销约 2-4KB/对话。可接受。

### 涉及文件

- `src/core/ConversationStore.ts` — 新增 `ToolExecutionEvent` 类型和工厂函数
- `src/core/QueryEngine.ts` — `executeOneTool()` finally 块写入事件
- `src/core/projections.ts` — 可选在 toolCard 中展示耗时

---

## 改进 5：请求完成事件

### 问题

当前事件日志中，一轮用户请求的执行过程由多个事件组成，但没有明确的结束标记：

```jsonl
{"type":"user_message","content":"帮我分析这个项目"}        // 请求开始
{"type":"assistant_message","text":"","toolCalls":[...]}     // LLM 调用工具 A
{"type":"tool_result","toolCallId":"tc-1","content":"..."}   // 工具 A 结果
{"type":"assistant_message","text":"","toolCalls":[...]}     // LLM 调用工具 B
{"type":"tool_result","toolCallId":"tc-2","content":"..."}   // 工具 B 结果
{"type":"assistant_message","text":"分析完成"}               // LLM 最终回复
                                                           // ← 无结束标记
```

这导致：

- **不知道一轮请求何时结束**——投影层只能靠"遇到下一个 user_message"推断上一轮结束
- **不知道整体执行状态**——成功？失败？被中止？达到轮次限制？
- **不知道总耗时和总 token**——这些信息在 WebSocket 的 `usage` 和 `done` 事件里有，但不持久化
- **多轮工具调用的边界模糊**——连续 5 个 tool_call + tool_result，哪个属于哪一轮 LLM 调用？

### 方案

新增 `request_complete` 事件，在一轮用户请求的 LLM 执行全部结束后写入：

```ts
interface RequestCompleteEvent {
  type: 'request_complete'
  id: string
  timestamp: number
  requestId?: string        // 与 user_message 的 requestId 对应（并发拒绝时可能为空）
  status: 'completed' | 'error' | 'aborted' | 'turn_limit' | 'budget_exceeded' | 'permission_denied'
  totalTurns: number        // LLM 调用轮次（streamOneTurn 调用次数）
  totalToolCalls: number    // 工具调用总次数
  durationMs: number        // 从请求开始到结束的总耗时
  inputTokens?: number      // 本次请求消耗的输入 token
  outputTokens?: number     // 本次请求消耗的输出 token
  costUsd?: number          // 本次请求的费用
  error?: string            // status=error 时的错误信息
}
```

### 事件流变化

```jsonl
{"type":"user_message","id":"u-1","requestId":"req-1","content":"帮我分析这个项目"}
{"type":"assistant_message","id":"a-1","requestId":"req-1","toolCalls":[{"id":"tc-1","name":"glob","input":{...}}]}
{"type":"tool_result","id":"t-1","requestId":"req-1","toolCallId":"tc-1","toolName":"glob","content":"..."}
{"type":"assistant_message","id":"a-2","requestId":"req-1","toolCalls":[{"id":"tc-2","name":"bash","input":{...}}]}
{"type":"tool_result","id":"t-2","requestId":"req-1","toolCallId":"tc-2","toolName":"bash","content":"..."}
{"type":"assistant_message","id":"a-3","requestId":"req-1","text":"分析完成，发现以下问题..."}
{"type":"request_complete","id":"rc-1","requestId":"req-1","status":"completed","totalTurns":3,"totalToolCalls":2,"durationMs":12500,"inputTokens":3200,"outputTokens":800,"costUsd":0.005}
```

### send() 退出路径分析

`QueryEngine.send()` 是 async generator，有 6 条退出路径全部汇入 `finally` 块：

```text
send() 内部 while 循环
  │
  ├─ 正常完成（无工具调用，自然 break）──────┐
  ├─ budget_exceeded（循环顶部检查，break）──┤
  ├─ streamOneTurn 内部 LLM 错误 ───────────┤  ← 被 streamOneTurn catch，yield error 后 return
  ├─ turn_limit（循环末尾检查，break）───────┤  ← break 前注入 [系统提示]
  ├─ aborted（循环顶部/末尾检查，break）────┤  ← break 前注入 [系统提示]
  └─ 未捕获异常（外层 catch）───────────────┤  ← catch 设置 exitStatus='error'
                                              ▼
                                        finally 块
                                        write request_complete
                                        yield { type: 'done' }
```

### 实现难点

**难点 1：`finally` 块不知道退出原因**

需要新增状态变量，在各退出路径设置：

```ts
let exitStatus: 'completed' | 'error' | 'aborted' | 'turn_limit' | 'budget_exceeded' = 'completed'
```

**难点 2：`streamOneTurn` 吞掉 LLM 错误**

`streamOneTurn` 内部 catch 了 LLM 异常，yield `error` + `interrupted` 后 `return`。外层 `send()` 的 `for await` 只看到 generator 结束，不会抛异常。需要在循环内检测这些事件：

```ts
for await (const ev of this.streamOneTurn(...)) {
  if (ev.type === 'interrupted') {
    exitStatus = ev.reason  // 'error' | 'turn_limit' | ...
  }
}
```

**难点 3：token/cost 归属**

`CostTracker` 是会话级累计值，`request_complete` 需要本次请求的增量。在 `send()` 入口快照：

```ts
const costBefore = this.costs.getCostUsd()
const usageBefore = this.costs.getUsage()

// finally 中：
const usageAfter = this.costs.getUsage()
const deltaInput = usageAfter.inputTokens - usageBefore.inputTokens
const deltaOutput = usageAfter.outputTokens - usageBefore.outputTokens
const deltaCost = this.costs.getCostUsd() - costBefore
```

`CostTracker.getUsage()` 返回副本，可直接做差值。

**难点 4：`budget_exceeded` 的特殊路径**

`budget_exceeded` 在循环顶部检查后 `break`，与 `turn_limit` / `aborted` 不同，它**不注入 `[系统提示]`**。这是合理行为（超预算不应继续），但 `exitStatus` 需区分此场景。

**难点 5：autocompact 和 request_complete 的顺序**

autocompact 在循环中间触发，追加 `compact` 事件。`request_complete` 在循环结束后追加。事件顺序正确——`totalTurns` 包含 compact 后的轮次，`durationMs` 包含 compact 耗时。

**难点 6：`request_complete` 和 `[系统提示]` 的事件顺序**

`turn_limit` / `aborted` 路径先注入 `[系统提示]` user_message，再 `break` 落入 `finally` 写 `request_complete`：

```jsonl
{"type":"user_message","content":"[系统提示] 任务因达到最大轮次限制..."}
{"type":"request_complete","status":"turn_limit",...}
```

`request_complete` 不是最后一个事件，投影层需理解此结构。

**难点 7：Generator yield 顺序**

`request_complete` 是持久化用的，不需要 yield 给外部消费者（TUI/Gateway 只需要 `done` 事件）。在 `finally` 中先写入 store，再 yield done：

```ts
finally {
  this.store.appendEvents(createRequestCompleteEvent(...))  // 持久化
  yield { type: 'done' }  // 外部消费者只看到 done
}
```

### 实现方案

```ts
async *send(prompt: string): AsyncGenerator<StreamEvent> {
  // ── 请求级快照 ──
  const requestStartTime = Date.now()
  const costBefore = this.costs.getCostUsd()
  const usageBefore = this.costs.getUsage()
  let exitStatus: 'completed' | 'error' | 'aborted' | 'turn_limit' | 'budget_exceeded' = 'completed'
  let totalTurns = 0
  let totalToolCalls = 0

  try {
    // ... 主循环 ...
    while (turns < maxTurns) {
      totalTurns++

      // budget_exceeded（循环顶部）
      if (maxBudgetUsd !== undefined && this.costs.getCostUsd() >= maxBudgetUsd) {
        exitStatus = 'budget_exceeded'
        yield { type: 'budget_exceeded', ... }
        break
      }

      // autocompact（循环中部，不影响 exitStatus）

      // ── 调用 LLM ──
      for await (const ev of this.streamOneTurn(...)) {
        if (ev.type === '__llm_result__') { /* 提取结果 */ }
        else if (ev.type === 'interrupted') {
          exitStatus = ev.reason === 'error' ? 'error' : 'turn_limit'
          yield ev
        } else { yield ev }
      }

      // ── 执行工具 ──
      for (const tc of toolCalls) {
        totalToolCalls++
        for await (const ev of this.executeOneTool(tc)) {
          // ...
        }
      }

      // turn_limit（循环末尾）
      if (turns >= maxTurns) {
        exitStatus = 'turn_limit'
        yield { type: 'interrupted', reason: 'turn_limit', ... }
        this.store.appendEvents(createUserMessageEvent('[系统提示] ...'))
        break
      }

      // aborted（循环末尾）
      if (this.abortController.signal.aborted) {
        exitStatus = 'aborted'
        yield { type: 'interrupted', reason: 'aborted', ... }
        this.store.appendEvents(createUserMessageEvent('[系统提示] ...'))
        break
      }
    }
  } catch (err) {
    exitStatus = 'error'
    yield { type: 'error', message: String(err) }
  } finally {
    // ── 请求完成事件（持久化，不 yield 给外部）──
    const usageAfter = this.costs.getUsage()
    this.store.appendEvents(createRequestCompleteEvent(
      this.currentRequestId ?? undefined,
      exitStatus,
      totalTurns,
      totalToolCalls,
      Date.now() - requestStartTime,
      usageAfter.inputTokens - usageBefore.inputTokens,
      usageAfter.outputTokens - usageBefore.outputTokens,
      this.costs.getCostUsd() - costBefore,
    ))

    this.running = false
    if (this.onAfterSend) { try { this.onAfterSend() } catch { /* 忽略 */ } }
    yield { type: 'done' }
  }
}
```

### 投影层适配

**projectForDisplay**：

```ts
case 'request_complete': {
  // 不生成展示消息，跳过
  // 未来可选：在前端展示执行摘要卡片（耗时、token、状态图标）
  break
}
```

**projectForLLM**：

```ts
case 'request_complete': {
  // LLM 不需要感知此事件，跳过
  break
}
```

### 收益

| 维度 | 无 request_complete | 有 request_complete |
| --- | --- | --- |
| 请求边界 | 靠下一个 user_message 推断 | requestId 精确匹配 |
| 执行状态 | 不可知 | status 字段明确 |
| 性能审计 | 丢失 | durationMs + tokens |
| 前端展示 | 无法显示"执行完成"状态 | 可基于 status 展示不同 UI |
| 投影层 | 需猜测哪条 assistant 是最终回复 | 最后一个 assistant 与 request_complete 之间的是工具执行过程 |

### 涉及文件

- `src/core/ConversationStore.ts` — 新增 `RequestCompleteEvent` 类型和 `createRequestCompleteEvent()` 工厂函数
- `src/core/QueryEngine.ts` — `send()` 重构退出逻辑，`finally` 写入事件
- `src/core/projections.ts` — 可选在前端展示执行摘要

---

## 改进 6：toolCalls 拆分为独立事件

### 问题

当前 `toolCalls` 嵌套在 `assistant_message` 内部，而 `tool_result` 是独立事件。这种不对称导致：

- 投影需要两遍扫描（先建 toolCallId 映射，再遍历）
- 无法独立索引 tool_call（按工具名查询需从 assistant_message 中提取）
- 语义混合：一个 assistant_message 既是文本回复又是工具调用请求

### 方案（评估中）

将 `toolCalls` 从 `assistant_message` 拆出为独立的 `tool_call` 事件：

```ts
interface ToolCallEvent {  // 从嵌套变为独立事件
  type: 'tool_call'
  id: string
  timestamp: number
  requestId?: string
  toolCallId: string      // tool_use id
  toolName: string
  input: unknown
  /** 关联的 assistant 消息 ID（可选，用于重建上下文） */
  assistantMessageId?: string
}

interface AssistantMessageEvent {
  type: 'assistant_message'
  id: string
  timestamp: number
  requestId?: string
  text: string
  // toolCalls 字段移除
}
```

事件序列变化：

```jsonl
// 当前（v1）
{"type":"assistant_message","id":"asst-1","text":"","toolCalls":[{"id":"tc-1","name":"bash","input":{...}}]}
{"type":"tool_result","id":"tres-1","toolCallId":"tc-1","toolName":"bash","content":"..."}

// 改进后（v2）
{"type":"assistant_message","id":"asst-1","text":""}
{"type":"tool_call","id":"tc-1","toolCallId":"call_xxx","toolName":"bash","input":{...},"assistantMessageId":"asst-1"}
{"type":"tool_result","id":"tres-1","toolCallId":"call_xxx","toolName":"bash","content":"..."}
```

### 权衡

| 维度 | 当前（嵌套） | 改进后（独立） |
| --- | --- | --- |
| 写入复杂度 | 低（一次 appendEvents） | 中（需拆分两次） |
| 投影复杂度 | 中（两遍扫描） | 低（一遍顺序遍历） |
| 独立查询 | 难（需解构 assistant） | 易（直接按 type 过滤） |
| 事件数量 | 少 | 多（每个 tool_call 多一行） |
| 向后兼容 | — | 需 v0/v1/v2 版本分支 |

### 结论

**建议暂不实施**。当前嵌套设计虽然不对称，但写入简单、事件数量少。如果未来需要独立查询工具调用（如按工具名聚合统计），再通过 schema 版本升级迁移。改进 2（schema 版本标记）是前置条件。

---

## 改进 7：事件 ID 全局唯一

### 问题

事件 ID 格式为 `{type}-{timestamp}-{seq}`，`seq` 是进程级内存计数器（`let _nextId = 0`）。进程重启后计数器归零，可能产生重复 ID。

当前场景下这不构成实际问题（同一会话不会跨进程并发写入），但在以下场景可能出问题：

- Gateway 多进程部署（worker cluster）
- 事件同步/合并（多端编辑同一会话）

### 方案

使用 `crypto.randomUUID()` 替代自增计数器：

```ts
function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
}
```

或使用 ULID（时间有序 + 全局唯一）：

```ts
import { ulid } from 'ulid'
function genId(_prefix: string): string {
  return ulid()  // 26 字符，时间有序，全局唯一
}
```

### 权衡

| 方案 | 长度 | 时间有序 | 全局唯一 | 人类可读 |
| --- | --- | --- | --- | --- |
| 当前 `{type}-{ts}-{seq}` | ~30 | 是 | 否 | 是 |
| `{type}-{ts}-{uuid8}` | ~35 | 是 | 是（极高概率） | 部分 |
| ULID | 26 | 是 | 是 | 否 |

### 结论

**建议采用 `{type}-{ts}-{uuid8}` 方案**，保持可读性同时保证唯一性。改动小，无兼容性问题（ID 是内部标识，不暴露给 API）。

### 涉及文件

- `src/core/ConversationStore.ts` — `genId()` 函数

---

---

## 改进 8：事件类型命名简化

### 评估

当前事件类型使用 `user_message`、`assistant_message` 等带 `_message` 后缀的命名。理论上可以简化为 `user`、`assistant`：

```jsonl
// 当前
{"type":"user_message","content":"..."}
{"type":"assistant_message","text":"..."}

// 简化方案
{"type":"user","content":"..."}
{"type":"assistant","text":"..."}
```

### 结论：保留现状

经评估，保持 `user_message` / `assistant_message` 命名，理由：

1. **与投影层 role 字段区分**：`DisplayMessage.role` 和 `ChatMessage.role` 都使用 `'user' | 'assistant'`。事件类型加 `_message` 后缀避免代码中 `ev.type === 'user'` 与 `msg.role === 'user'` 的语义混淆。
2. **事件类型空间更清晰**：`user_message` 是事件，`user` 是角色。当前命名在联合类型中一眼可区分：
   ```ts
   type ConversationEvent = UserMessageEvent | AssistantMessageEvent | ToolResultEvent | ...
   //                        ^^^ 明确是事件，不是角色
   ```
3. **改名收益微小**：去掉 `_message` 节省 8 字节/事件，但需要迁移全部历史数据，不值得。
4. **新事件类型已遵循此约定**：`system_event`、`tool_execution`、`request_complete` 都使用描述性后缀，命名体系一致。

---

## 实施顺序

```
阶段 1（高优先级，无破坏性变更）
  ├── 改进 1: JSONL 读取容错        ← 纯防御性修改，零风险
  └── 改进 2: Schema 版本标记        ← 为后续改进铺路

阶段 2（中优先级，新增事件类型）
  ├── 改进 3: 系统事件独立类型        ← 需迁移 QueryEngine + SessionManager
  ├── 改进 4: 工具执行记录事件        ← 新增事件类型，不影响现有逻辑
  └── 改进 5: 请求完成事件            ← 新增事件类型，需修改 QueryEngine.send() 退出路径

阶段 3（低优先级，可选）
  ├── 改进 6: toolCalls 拆分         ← 需评估收益，改进 2 是前置条件
  ├── 改进 7: 事件 ID 全局唯一       ← 改动小，可随时做
  └── 改进 8: 命名简化               ← 评估后保留现状，不实施
```

每个阶段独立可交付，不阻塞其他阶段。

---

## 参考文件

| 文件 | 涉及改进 |
| --- | --- |
| `src/core/ConversationStore.ts` | 1, 2, 3, 4, 5, 6, 7 |
| `src/core/projections.ts` | 3, 4, 5, 6 |
| `src/core/QueryEngine.ts` | 3, 4, 5 |
| `src/gateway/SessionManager.ts` | 3 |
| `src/gateway/SessionManager.ts` | 3 |
| `docs/event-sourcing.md` | 全部（需同步更新文档） |
