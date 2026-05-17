# QueryEngine 重构计划 — 双层事件架构 + 工具执行拆分 + 主循环合并

## Context

对 QueryEngine 进行全面重构。核心变更：

1. **双层独立事件类型** — RuntimeEvent（运行时，给 UI）和 KernelEvent（持久化，给审计）完全独立
2. **EventBridge** — 统一事件发射层，自动注入 requestId/ts，处理 Runtime/Kernel 双写
3. **ToolExecutor 独立模块** — 工具执行生命周期从 QueryEngine 拆出，通过 EventBridge 发射事件
4. **单一 run() 主循环** — 删除 send()，只保留 sendStreaming() 流式语义
5. **常量集中管理** — 消除魔法数字

---

## 零、影响评估与风险分析

### 0.1 策略决策（基于用户反馈）

| 决策 | 说明 |
|------|------|
| **核心架构先行** | 先完成 QueryEngine 内部重构（RuntimeEvent/KernelEvent/EventBridge/ToolExecutor），Gateway/CLI/前端后续独立重构 |
| **引入 EventBridge** | 统一事件发射层：自动注入 requestId/ts、集中双写逻辑、简化 ToolExecutor 返回值 |
| **Gateway 后续重构** | Gateway 本身计划重构，本次不考虑 toClientMessage() 适配 |
| **events.jsonl v1** | 新架构全新格式，schema marker 使用 `hrids-events/v1`，不考虑旧格式兼容 |
| **只保留 sendStreaming 语义** | 删除 `send()`，只保留 `sendStreaming()` 的流式工具执行模式，重命名为 `run()` |
| **测试后续重写** | 4 个已损坏测试文件不管，重构完成后重新覆盖 |

### 0.2 影响范围

**本次重构范围（核心架构）：**

| 文件 | 改动 |
|------|------|
| `src/core/QueryEngine.ts` | 大规模重构（1817行 → ~800行） |
| `src/core/ConversationStore.ts` | 类型替换 ConversationEvent → KernelEvent |
| 新建 `src/core/RuntimeEvent.ts` | 运行时事件类型 |
| 新建 `src/core/KernelEvent.ts` | 持久化事件类型 + 28 个工厂函数 |
| 新建 `src/core/EventBridge.ts` | EventBridge — 统一事件发射层 |
| 新建 `src/core/ToolExecutor.ts` | 工具执行模块 |
| 新建 `src/core/engine-constants.ts` | 常量 |

**后续独立重构（不在本次范围）：**

| 文件 | 改动 |
|------|------|
| `src/gateway/SessionManager.ts` | toClientMessage() 适配 RuntimeEvent |
| `src/gateway/types.ts` | ServerMessage 类型 |
| `web/src/lib/types.ts` | 前端类型 |
| `web/src/store/messageStore.ts` | 消费 WS 消息 |

**调用方迁移（send/run 接口变更）：**

| 调用方 | 当前 | 迁移后 |
|--------|------|--------|
| CLI UI (App.tsx) | `sendStreaming()` | `run()` |
| Gateway SessionManager | `send()` | `run()` |
| CLI run 命令 | `send()` | `run()` |
| Print 模式 | `send()` | `run()` |
| Server 模式 | `send()` | `run()` |
| AgentPool / AgentTool | `send()` | `run()` |

所有调用方统一使用 `run()`（流式工具执行模式），不再区分批量/流式。

### 0.3 风险与解决方案

#### 风险 1：ToolExecutor 拆分 — 状态依赖（已解决）

**问题**：工具执行方法共享 6 个 `this` 状态字段。

**解决**：通过构造函数注入 `EventBridge` 和 getter 函数，不持有 QueryEngine 引用：

```typescript
export class ToolExecutor {
  constructor(
    private registry: ToolRegistry,
    private permissions: PermissionManager,
    private events: EventBridge,   // EventBridge，替代直接操作 store
    private deps: {
      getAbortSignal: () => AbortSignal
      getStormBreaker: () => StormBreaker
      onPermissionRequest?: (req: PermissionRequest) => Promise<boolean>
      onTodoSnapshotRefresh?: (snapshot: Todo[]) => void
    },
  ) {}
}
```

- `events`（EventBridge 实例）注入 — ToolExecutor 通过 `events.toolIntent(...)` 等方法发射事件，不需要知道 store 的存在
- `requestId` 和 `ts` 由 EventBridge 自动注入（构造时传入），ToolExecutor 无需关心
- `abortSignal` 和 `stormBreaker` 通过 getter 获取（每轮请求变化）
- `onPermissionRequest` 通过回调注入（子 Agent 不需要）
- `onTodoSnapshotRefresh` 用于 postExecution 中刷新 todo 快照

#### 风险 2：executeOneTool vs executeOneToolCore 重复（已解决）

**发现**：两个方法是逐行相同的副本。注释说"不写入 ConversationStore"但实际上都写了。

**解决**：只保留 `executeOneTool()` 作为 ToolExecutor 的 `execute()`，删除 `executeOneToolCore()`。

#### 风险 3：事件写入分散（已解决）

**问题**：45 个 `store.appendEvents()` 调用点分布在 QueryEngine、ToolExecutor、postRunHooks 等模块。每个调用点都要手动传入 `requestId` 和 `ts`。

**解决**：引入 `EventBridge` 作为统一事件发射层。

**EventBridge 核心价值**：
1. **自动注入 ts** — `kernelEvent()` 内部自动补全 `Date.now()`，各方法只需传入 requestId
2. **双写逻辑集中** — `budget_exceeded`/`error`/`tool_progress` 等需要同时写 store + yield UI 的事件，只在 EventBridge 中定义一次
3. **ToolExecutor 返回值简化** — 不需要 `runtimeEvents[]` 数组搬运，ToolExecutor 直接调用 `events.toolStart(...)`

**事件分类**：

| 类别 | 事件 | 行为 |
|------|------|------|
| 仅写 store（审计） | `session_opened`, `user_message`, `request_started`, `model_turn_started/ended`, `assistant_message`, `request_ended`, `tool_intent`, `tool_confirm`, `tool_dispatched`, `tool_result`, `effect_file_touched`, `effect_memory_written`, `session_compacted`, `policy_budget_warn`, `policy_storm_blocked`, `policy_plan_blocked`, `recovery_max_output`, `capability_registered`, `hook_fired`, `model_escalated` | `store.appendEvents()` |
| 仅推送 Runtime（UI） | `text_delta`, `thinking_delta`, `tool_start`, `tool_end`, `permission_request`, `permission_denied`, `usage`, `compact_start`, `done`, `interrupted`, `continuation_needed`, `fallback_status` | `runtimeBuffer.push()` |
| 双写（store + Runtime） | `error`, `budget_exceeded`, `turn_limit`, `compact_done`, `tool_log`/`tool_progress` | 两者都执行 |

**调用分布**：

| 模块 | 通过 EventBridge 调用 |
|------|-------------------|
| QueryEngine 构造 | `events.sessionOpened()` |
| QueryEngine.run() | `events.userMessage()`, `events.requestStarted()`, `events.modelTurnStarted()`, `events.textDelta()`, `events.error()`, ... |
| ToolExecutor.validate() | `events.toolIntent()`, `events.toolConfirm()`, `events.planBlocked()`, `events.stormBlocked()` |
| ToolExecutor.execute() | `events.toolDispatched()`, `events.toolStart()`, `events.toolProgress()`, `events.toolResult()`, `events.toolEnd()` |
| ToolExecutor.postProcess() | `events.fileTouched()` |
| compactHistory() | `events.sessionCompacted()` |
| postRunHooks.ts | `events.memoryWritten()` — 在 run() 末尾调用，可访问当前 events 实例 |

#### 风险 4：FallbackProvider 回调集成（已解决）

**发现**：
1. `FallbackStatusEvent` 定义了 `retrying`/`switching`/`rate_limited` 三种类型，但当前**只有 switching 被实际触发**
2. `QueryEngineConfig.onFallbackStatus` 是**死代码** — 定义了但从未连接到 FallbackProvider
3. `onStatus` 回调在 `setupProvider()` 时注册，QueryEngine 构造时 provider 已创建

**解决方案**：

**步骤 1**：扩展 `FallbackStatusEvent` 增加 `fromModel`/`fromProvider` 字段：
```typescript
export interface FallbackStatusEvent {
  type: 'retrying' | 'switching' | 'rate_limited'
  provider: string        // 目标 provider
  model: string           // 目标 model
  fromProvider?: string   // 源 provider（switching 时）
  fromModel?: string      // 源 model（switching 时）
  attempt?: number
  maxAttempts?: number
  delayMs?: number
  reason?: string
}
```

**步骤 2**：在 `FallbackProvider.ts` 的 retry 循环中补充 `retrying` 事件触发：
```typescript
// 第 129-163 行的 retry 循环中
this.onStatus?.({
  type: 'retrying',
  provider: provider.name,
  model: provider.model,
  attempt,
  maxAttempts: MAX_RETRIES,
  delayMs: delay,
  reason: llmErr.message,
})
```

**步骤 3**：在 switching 事件中补充 `fromModel`/`fromProvider`（第 173 行）：
```typescript
this.onStatus?.({
  type: 'switching',
  provider: next.name,
  model: next.model,
  fromProvider: provider.name,
  fromModel: provider.model,
  reason: `${provider.model} 失败`,
})
```

**步骤 4**：QueryEngine 构造时注册补充回调，写入 KernelEvent：
```typescript
// 在 QueryEngine 构造函数中
const originalOnStatus = (provider as any).onStatus
;(provider as any).onStatus = (event: FallbackStatusEvent) => {
  originalOnStatus?.(event) // 保留 main.ts 的 stderr 输出
  if (event.type === 'switching') {
    this.store.appendEvents(createModelEscalatedEvent(
      event.fromModel ?? 'unknown',
      event.model,
      'failure_threshold',
      event.reason,
    ))
  }
}
```

**注意**：
- 此处直接写 store 而非通过 EventBridge，因为回调在构造函数中注册，无法访问 run() 时创建的 events 实例。`model_escalated` 是纯审计事件（无 RuntimeEvent），直接写 store 即可。
- 直接修改 provider 的 onStatus 属性是临时方案。更好的做法是在 FallbackProvider 中支持多个监听者，或在 QueryEngineConfig 中增加 `onFallbackEvent` 回调。

### 0.4 五个场景的处理方案

#### 场景 1：compactHistory() — replaceEvents()

**现状**：`compactHistory()` 调用 `store.replaceEvents()` 用 2 个事件替换整个日志。

**处理**：
- 改造 `replaceEvents()` 接受 `KernelEvent[]`
- 使用 `createSessionCompactedEvent()` + `createAssistantMessageEvent()` 工厂函数生成新事件
- 不需要特殊处理 — events.jsonl 不考虑兼容

#### 场景 2：Gateway 会话恢复 — migrateEventsToMessages()

**现状**：`server.ts:639` 调用 `migrateEventsToMessages()` 处理旧格式归档。

**处理**：本次重构不改 Gateway。`migrateEventsToMessages()` 继续处理旧格式（`LegacyConversationEvent`），与新 KernelEvent 格式独立。Gateway 后续重构时再统一。

#### 场景 3：多 Agent 子会话 — 事件隔离

**现状**：`AgentPool.ts` 和 `AgentTool.ts` 各自创建独立 QueryEngine，store 无磁盘持久化。

**处理**：
- 子 Agent 的 ToolExecutor 与父完全隔离（独立实例）
- 权限回调不继承（子 Agent 使用 `craft` 模式自动批准）
- 重构后子 Agent 创建方式不变，只需适配 `run()` 接口
- **无需特殊处理** — 隔离性天然保证

#### 场景 4：IM 平台转发 — text_delta

**现状**：`PlatformManager.ts:631` 只消费 `text_delta` 事件。

**处理**：
- RuntimeEvent 保持 `text_delta` 类型名不变
- IM 转发逻辑不受影响
- **无需改动**

#### 场景 5：Abort 语义统一

**现状**：`send()` 和 `sendStreaming()` 的 abort 检查点不同。`sendStreaming()` 通过 fire-and-forget IIFE 启动工具，abort 后可能有 in-flight 工具。

**处理**：只保留 `sendStreaming()` 语义（重命名为 `run()`）：
- 新 `run()` 继承 `sendStreaming()` 的 abort 逻辑
- Abort 检查点：循环顶部 + LLM 流式每个 chunk 后 + in-flight 工具 drain 循环
- 工具 abort 通过 `Promise.race([toolPromise, abortPromise])` 实现（不变）
- 工具执行不真正取消，只在 race 中被放弃（不变）
- `markToolCallPruned()` 防止孤立 tool_use 块（不变）

**关键**：合并后只有一套 abort 逻辑，不再有两套的差异问题。

---

## 一、双层事件类型

### 1.1 RuntimeEvent — 运行时事件（给 UI/WS 消费）

定义在 `src/core/RuntimeEvent.ts`。**类型名与旧 StreamEvent 完全一致**，确保 CLI UI 和后续 Gateway 重构时无需改名。

```typescript
import type { ToolResult } from './Tool.js'

export type RuntimeEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'tool_start'; id: string; name: string; input: unknown; description: string }
  | { type: 'tool_log'; id: string; name: string; line: string }
  | { type: 'tool_end'; id: string; name: string; result: ToolResult }
  | { type: 'permission_request'; toolName: string; description: string; isReadonly: boolean; isDestructive?: boolean; ruleContent?: string; key: string }
  | { type: 'permission_denied'; id: string; toolName: string; description: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; costUsd: number }
  | { type: 'turn_limit'; turns: number }
  | { type: 'budget_exceeded'; costUsd: number; limitUsd: number }
  | { type: 'compact_start' }
  | { type: 'compact_done'; summary: string }
  | { type: 'interrupted'; reason: InterruptReason; message: string }
  | { type: 'continuation_needed' }
  | { type: 'fallback_status'; status: 'retrying' | 'switching' | 'rate_limited'; provider: string; model: string; delayMs?: number; reason?: string }
  | { type: 'done' }
  | { type: 'error'; message: string }
```

**与旧 StreamEvent 的差异**：
- 类型名完全不变（text_delta, tool_start, tool_log, tool_end 等）
- 字段结构完全不变（id, name, input, description 等）
- 保持 `interrupted`、`continuation_needed`、`fallback_status`（原计划删除，现保留）
- 新增 `RuntimeEvent` 类型导出，替代旧的 `StreamEvent` 类型

### 1.2 KernelEvent — 持久化事件（给 events.jsonl 审计）

用下划线分隔命名空间，含完整审计字段。定义在 `src/core/KernelEvent.ts`。

与 RuntimeEvent 的区别：RuntimeEvent 用短名（`tool_start`），KernelEvent 用带命名空间的长名（`tool_dispatched`）。

```typescript
export type KernelEvent =
  // 会话
  | { type: 'session_opened'; sessionId: string; resumed: boolean }
  // 请求
  | { type: 'request_started'; requestId: string; mode: string; model: string }
  | { type: 'request_ended'; requestId: string; status: string; totalTurns: number; totalToolCalls: number; durationMs: number; inputTokens: number; outputTokens: number; costUsd: number }
  // 消息
  | { type: 'user_message'; requestId?: string; content: string; trigger?: 'user' | 'cron'; cronDescription?: string }
  | { type: 'assistant_message'; requestId?: string; text: string; thinking?: string; toolCount?: number }
  // LLM
  | { type: 'model_turn_started'; requestId?: string; model: string; provider: string }
  | { type: 'model_turn_ended'; requestId?: string; durationMs: number; inputTokens: number; outputTokens: number }
  // 工具生命周期
  | { type: 'tool_intent'; requestId?: string; toolCallId: string; toolName: string; input: unknown; description?: string }
  | { type: 'tool_confirm'; requestId?: string; toolCallId: string; toolName: string; decision: 'allow' | 'deny' | 'always_allow' | 'session_allow'; mode: string; isReadonly: boolean; isDestructive: boolean; reason?: string }
  | { type: 'tool_dispatched'; requestId?: string; toolCallId: string; toolName: string }
  | { type: 'tool_progress'; requestId?: string; toolCallId: string; line: string }
  | { type: 'tool_result'; requestId?: string; toolCallId: string; toolName: string; durationMs: number; status: 'ok' | 'err' | 'denied' | 'timeout' | 'abort'; outputPreview?: string; errorSummary?: string }
  // 副作用
  | { type: 'effect_file_touched'; requestId?: string; path: string; mode: 'create' | 'edit' | 'delete'; bytes: number }
  | { type: 'effect_memory_written'; scope: string; key: string }
  // 策略
  | { type: 'policy_budget_warn'; spentUsd: number; capUsd: number; percentage: number }
  | { type: 'policy_budget_blocked'; spentUsd: number; capUsd: number }
  | { type: 'policy_storm_blocked'; requestId?: string; toolCallId: string; toolName: string; input: unknown; recentCount: number; windowSize: number }
  | { type: 'policy_plan_blocked'; requestId?: string; toolCallId: string; toolName: string; reason: string }
  | { type: 'policy_turn_limit'; totalTurns: number; limit: number }
  // 压缩
  | { type: 'session_compacted'; requestId?: string; summary: string }
  // 恢复
  | { type: 'recovery_max_output'; attempt: number; maxAttempts: number }
  // 能力
  | { type: 'capability_registered'; toolName: string; permission: string }
  | { type: 'capability_removed'; toolName: string }
  // Hook
  | { type: 'hook_fired'; hookName: string; phase: string; outcome: string }
  // 模型切换
  | { type: 'model_escalated'; fromModel: string; toModel: string; reason: string; rationale?: string }
  // 错误
  | { type: 'error'; message: string; recoverable: boolean }
```

### 1.3 事件写入策略 — EventBridge

**使用 `EventBridge` 作为统一事件发射层**。各模块通过 `events.xxx()` 方法发射事件，EventBridge 内部处理 store 写入和 RuntimeEvent 推送。

**EventBridge 设计**：

```typescript
export class EventBridge {
  constructor(
    private store: ConversationStore,
    private runtimeBuffer: RuntimeEvent[],
    private requestId?: string,  // 可选：sessionOpened() 在构造函数中调用时无 requestId
  ) {}

  /** 自动补全 ts，requestId 由各方法按需传入 */
  private kernelEvent(event: KernelEvent): void {
    this.store.appendEvents({ ...event, ts: Date.now() })
  }

  // ── 仅写 store（审计）──
  sessionOpened(sessionId: string, resumed: boolean) {
    this.kernelEvent({ type: 'session_opened', sessionId, resumed })  // 无 requestId
  }
  userMessage(content: string, trigger?: 'user' | 'cron') {
    this.kernelEvent({ type: 'user_message', requestId: this.requestId, content, trigger })
  }
  requestStarted(mode: string, model: string) {
    this.kernelEvent({ type: 'request_started', requestId: this.requestId, mode, model })
  }
  toolIntent(toolCallId: string, toolName: string, input: unknown, description?: string) {
    this.kernelEvent({ type: 'tool_intent', requestId: this.requestId, toolCallId, toolName, input, description })
  }
  toolConfirm(toolCallId: string, toolName: string, decision: string, ...) {
    this.kernelEvent({ type: 'tool_confirm', requestId: this.requestId, toolCallId, toolName, decision, ... })
  }
  toolDispatched(toolCallId: string, toolName: string) {
    this.kernelEvent({ type: 'tool_dispatched', requestId: this.requestId, toolCallId, toolName })
  }
  toolResult(toolCallId: string, toolName: string, durationMs: number, status: string, ...) {
    this.kernelEvent({ type: 'tool_result', requestId: this.requestId, toolCallId, toolName, durationMs, status, ... })
  }
  fileTouched(path: string, mode: string, bytes: number) {
    this.kernelEvent({ type: 'effect_file_touched', requestId: this.requestId, path, mode, bytes })
  }
  // ... 其他仅 store 事件

  // ── 仅推送 Runtime（UI）──
  textDelta(delta: string) {
    this.runtimeBuffer.push({ type: 'text_delta', delta })
  }
  thinkingDelta(delta: string) {
    this.runtimeBuffer.push({ type: 'thinking_delta', delta })
  }
  toolStart(id: string, name: string, input: unknown, description: string) {
    this.runtimeBuffer.push({ type: 'tool_start', id, name, input, description })
  }
  toolEnd(id: string, name: string, result: ToolResult) {
    this.runtimeBuffer.push({ type: 'tool_end', id, name, result })
  }
  // ... 其他仅 Runtime 事件

  // ── 双写（store + Runtime）──
  error(message: string, recoverable = true) {
    this.runtimeBuffer.push({ type: 'error', message })
    this.kernelEvent({ type: 'error', requestId: this.requestId, message, recoverable })
  }
  budgetExceeded(costUsd: number, limitUsd: number) {
    this.runtimeBuffer.push({ type: 'budget_exceeded', costUsd, limitUsd })
    this.kernelEvent({ type: 'policy_budget_blocked', requestId: this.requestId, spentUsd: costUsd, capUsd: limitUsd })
  }
  toolProgress(toolCallId: string, line: string) {
    this.runtimeBuffer.push({ type: 'tool_log', id: toolCallId, name: '', line })
    this.kernelEvent({ type: 'tool_progress', requestId: this.requestId, toolCallId, line })
  }
  // ... 其他双写事件
}
```

**架构图**：

```
QueryEngine ──► EventBridge ◄── ToolExecutor
                   │
         ┌─────────┴─────────┐
         ▼                   ▼
  Runtime Buffer        ConversationStore
(yielded to UI)       (KernelEvent Log)
```

**调用方式** — 各模块通过 EventBridge 方法发射事件：

| 模块 | EventBridge 调用 |
|------|---------------|
| QueryEngine 构造 | `events.sessionOpened()` |
| QueryEngine.run() | `events.userMessage()`, `events.requestStarted()`, `events.modelTurnStarted()`, `events.modelTurnEnded()`, `events.assistantMessage()`, `events.requestEnded()`, `events.budgetWarn()`, `events.budgetExceeded()`, `events.turnLimit()`, `events.error()`, `events.recoveryMaxOutput()` |
| ToolExecutor.validate() | `events.toolIntent()`, `events.toolConfirm()`, `events.planBlocked()`, `events.stormBlocked()` |
| ToolExecutor.execute() | `events.toolDispatched()`, `events.toolStart()`, `events.toolProgress()`, `events.toolResult()`, `events.toolEnd()` |
| ToolExecutor.postProcess() | `events.fileTouched()` |
| compactHistory() | `events.sessionCompacted()` |
| postRunHooks.ts | `events.memoryWritten()` — 在 run() 末尾调用，可访问当前 events 实例 |

**RuntimeEvent 与 KernelEvent 的关系**（由 EventBridge 内部处理）：
- 仅 store 事件：调用者只需 `events.toolIntent(...)`，EventBridge 自动写 store
- 仅 Runtime 事件：调用者只需 `events.textDelta(...)`，EventBridge 自动推入 buffer
- 双写事件：调用者只需 `events.error(...)`，EventBridge 同时写 store + 推 buffer
- **调用者无需关心双写逻辑** — 全部封装在 EventBridge 内部

**命名差异说明**（EventBridge 内部映射）：
- `events.toolProgress()` → RuntimeEvent `tool_log` + KernelEvent `tool_progress`
- `events.toolStart()` → 仅 RuntimeEvent `tool_start`（KernelEvent 由 `toolDispatched()` 单独写入）
- `events.toolEnd()` → 仅 RuntimeEvent `tool_end`（KernelEvent 由 `toolResult()` 单独写入）

**durationMs 处理**：
- ToolExecutor.execute() 记录 `startTime = Date.now()`
- 执行完成后调用 `events.toolResult(toolCallId, toolName, durationMs, status, ...)`
- EventBridge 内部自动写入 `store.appendEvents(createToolResultEvent(...))`

---

## 二、ToolExecutor 独立模块

定义在 `src/core/ToolExecutor.ts`，从 QueryEngine 中提取工具执行生命周期。

### 2.1 构造函数与依赖注入

```typescript
export class ToolExecutor {
  /** 工具调用计数器（Storm Breaker 滑动窗口用） */
  private totalToolCalls = 0

  constructor(
    private registry: ToolRegistry,
    private permissions: PermissionManager,
    private events: EventBridge,   // EventBridge — 自动注入 requestId/ts
    private deps: {
      getAbortSignal: () => AbortSignal
      getStormBreaker: () => StormBreaker
      onPermissionRequest?: (req: PermissionRequest) => Promise<boolean>
      onTodoSnapshotRefresh?: (snapshot: Todo[]) => void
    },
  ) {}
}
```

**依赖说明**：

| 依赖 | 来源 | 生命周期 |
|------|------|---------|
| `registry` | QueryEngine.config.registry | 整个会话不变 |
| `permissions` | QueryEngine.config.permissions | 整个会话不变 |
| `events` | QueryEngine.events（每次 run() 重建） | **每次 run() 新实例**（新 requestId） |
| `deps.getAbortSignal` | 闭包捕获 this.abortController.signal | 每次 run() 更新 |
| `deps.getStormBreaker` | 闭包捕获 this.stormBreaker | **每次 run() 重建**，必须用 getter |
| `deps.onPermissionRequest` | QueryEngine.onPermissionRequest | 外部注册，可选 |
| `deps.onTodoSnapshotRefresh` | 回调，刷新 QueryEngine.activeTodoSnapshot | 每次 todo 工具后调用 |

**关键设计**：
- ToolExecutor 通过 `events.toolIntent(...)` 等方法发射事件，**不需要知道 store 的存在**
- requestId 和 ts 由 EventBridge 构造时自动注入，ToolExecutor 无需关心
- stormBreaker 不能直接注入，因为 QueryEngine 每次 `run()` 会 `new StormBreaker()`
- events 每次 run() 重建（新 requestId），QueryEngine 在 run() 开头创建新实例并注入

### 2.2 三阶段方法

#### validate(tc) — 校验 + 权限 + Storm Breaker

从 `validateAndPrepareTool()` (lines 457-585, 128行) 提取。

```typescript
interface ValidateResult {
  ok: boolean
  tool?: ToolDef
  effectiveInput?: unknown
  // ok=false 时的错误信息
  execStatus?: 'denied' | 'error' | 'abort'
  errorSummary?: string
  resultContent?: ContentBlock
}
```

**内部流程**（与原 validateAndPrepareTool 相同）：
1. `registry.get(tc.name)` — 工具查找
2. `tool.checkPermission()` — 工具自身硬检查
3. `permissions.check()` 或 `onPermissionRequest` — 权限管理器/UI 回调
4. Zod 校验 + todo 自动修复
5. Storm Breaker 检查

**关键**：validate() 通过 `events.toolIntent(...)`、`events.toolConfirm(...)` 等方法发射事件。RuntimeEvent（如 `permission_request`）直接推入 EventBridge 的 runtimeBuffer，主循环在 drainQueue() 时自动 yield。**不需要返回 runtimeEvents 数组**。

#### execute(tc) — 执行单个工具

从 `executeOneTool()` (lines 732-834, 102行) 提取。**删除 `executeOneToolCore()`**（lines 1232-1328，逐行相同的副本）。

```typescript
interface ExecuteResult {
  /** 工具结果块（写入 messages store） */
  block: ContentBlock
  /** 输出预览（截断后） */
  outputPreview: string
  /** 执行状态 */
  status: 'ok' | 'err' | 'timeout' | 'abort'
  /** 错误摘要（status=err 时） */
  errorSummary?: string
  /** 执行耗时 ms */
  durationMs: number
}
```

**内部流程**：
1. 调用 `this.validate(tc)` — 校验阶段（通过 events 发射 toolIntent/toolConfirm）
2. `events.toolStart(...)` — 推入 RuntimeEvent 给 UI
3. `events.toolDispatched(...)` — 写入 KernelEvent 审计
4. 记录开始时间 `Date.now()`
5. `Promise.race([tool.execute(), timeoutPromise, abortPromise])` — 执行 + 超时 + abort
6. 日志轮询：每 30ms 从 `tool.onLog` 队列取出日志行 → `events.toolProgress(...)`
7. Abort 检查 + `markToolCallPruned()` 防止孤立块
8. 调用 `this.postProcess()` — 后处理（通过 events 发射 fileTouched）
9. `events.toolEnd(...)` — 推入 RuntimeEvent 给 UI
10. 计算 `durationMs = Date.now() - startTime`
11. `events.toolResult(...)` — 写入 KernelEvent 审计（含 durationMs）
12. 返回 `ExecuteResult`

**关键变更**：原 `executeOneTool()` 是 AsyncGenerator，yield StreamEvent 和 `__tool_result__`。重构后改为普通 async 方法，**所有事件通过 events 直接发射**，不需要返回 runtimeEvents 数组。主循环通过 drainQueue() 获取 RuntimeEvent。

#### postProcess(tc, tool, result) — 后处理

从 `postExecution()` (lines 591-620, 29行) 提取。

```typescript
interface PostProcessResult {
  block: ContentBlock
  outputPreview: string
}
```

**内部流程**（不变）：
1. `stormBreaker.clearOnMutation()` — 成功的非只读工具清除风暴窗口
2. `events.fileTouched(path, mode, bytes)` — 文件操作副作用事件
3. `onTodoSnapshotRefresh(loadTodos())` — todo 工具后刷新快照
4. `truncateToolResult()` — 截断输出

### 2.3 移出的方法映射

| 原方法 | 行数 | 新位置 | 变更 |
|--------|------|--------|------|
| `validateAndPrepareTool()` | 457-585 (128行) | `ToolExecutor.validate()` | 事件写入改用 events.xxx() |
| `executeOneTool()` | 732-834 (102行) | `ToolExecutor.execute()` | 改为返回 ExecuteResult |
| `executeOneToolCore()` | 1232-1328 (96行) | **删除** | 逐行重复，无实际差异 |
| `postExecution()` | 591-620 (29行) | `ToolExecutor.postProcess()` | todo 快照改用回调 |
| `executeToolBatches()` | 684-729 (45行) | **留在 QueryEngine** | 编排逻辑依赖主循环状态 |
| `executeBatch()` | 841-898 (57行) | **留在 QueryEngine** | 并行编排，与主循环紧耦合 |

**编排保留在 QueryEngine 的原因**：`executeToolBatches()` 和 `executeBatch()` 需要：
- 写入 tool 消息到 `store.appendMessage()`
- 检查 `abortController.signal.aborted`
- 传递 `currentRequestId` 给消息
- 与主循环的 yield/return 交互

这些与主循环状态紧耦合，不适合拆出。

---

## 三、合并主循环

### 3.1 设计

删除 `send()`（批量模式），只保留 `sendStreaming()` 的流式工具执行语义，重命名为 `run()`。

```typescript
async *run(userMessage: string | Message): AsyncGenerator<RuntimeEvent>
```

**为什么只保留流式模式**：
- `sendStreaming()` 是 CLI UI 的唯一调用路径，也是用户体验最好的模式
- `send()` 的批量模式（等 LLM 完全结束后再执行工具）延迟更高
- 两套方法导致 ~600 行重复代码
- 所有调用方统一使用 `run()`，无需配置切换

### 3.2 run() 内部结构（基于 sendStreaming + EventBridge）

```
run()
 ├─ 并发锁检查 + AbortController 重建 + CostTracker 重置
 ├─ 创建 EventBridge 实例（新 requestId）
 │    events = new EventBridge(store, runtimeBuffer, requestId)
 │    toolExecutor.events = events  // 注入到 ToolExecutor
 ├─ onBeforeSend hook
 ├─ events.userMessage() + events.requestStarted()
 ├─ while (turns < maxTurns)
 │    ├─ abort 检查
 │    ├─ checkBudget() → events.budgetWarn() / events.budgetExceeded()
 │    ├─ compactIfNeeded() → events.compactStart() / events.compactDone()
 │    ├─ events.modelTurnStarted()
 │    ├─ LLM 流式循环（provider.stream）
 │    │    ├─ text_delta → events.textDelta(delta)
 │    │    ├─ thinking_delta → events.thinkingDelta(delta)
 │    │    ├─ tool_call → 立即启动 ToolExecutor.execute() (fire-and-forget IIFE)
 │    │    │    └─ pushQueue({ done, toolCallId, result })
 │    │    ├─ 每个 chunk 后 drainRuntimeBuffer() → yield RuntimeEvent[]
 │    │    └─ abort 检查
 │    ├─ events.modelTurnEnded()
 │    ├─ events.assistantMessage()
 │    ├─ drainRuntimeBuffer() → yield 剩余 RuntimeEvent + 写入 tool 消息
 │    ├─ 等待 inFlight 工具完成
 │    └─ 无工具调用 → break
 ├─ events.requestEnded()
 ├─ onAfterSend hook
 └─ finally: running = false
```

**EventBridge 与主循环的协作**：
- `runtimeBuffer: RuntimeEvent[]` — EventBridge 推入，主循环 drain 后 yield
- `drainRuntimeBuffer()` — 取出 buffer 中所有事件并 yield，然后清空
- ToolExecutor 的 IIFE 只需要 pushQueue({ done, toolCallId, result }) — 工具执行的 RuntimeEvent（tool_start/tool_end/tool_log）已由 EventBridge 直接推入 runtimeBuffer

### 3.3 事件流

```
QueryEngine.run() 通过 events.xxx() 发射事件：
  ┌─ 入口
  │   events.userMessage(content)          → store: user_message
  │   events.requestStarted(mode, model)   → store: request_started
  │
  ├─ 每轮 LLM 调用前后
  │   events.modelTurnStarted(model, prov) → store: model_turn_started
  │   events.modelTurnEnded(durationMs...) → store: model_turn_ended
  │
  ├─ LLM 流式输出
  │   events.textDelta(delta)              → runtimeBuffer: text_delta
  │   events.thinkingDelta(delta)          → runtimeBuffer: thinking_delta
  │
  ├─ LLM 完成
  │   events.assistantMessage(text, ...)   → store: assistant_message
  │
  ├─ 预算检查
  │   events.budgetWarn(spent, cap, pct)   → store: policy_budget_warn
  │   events.budgetExceeded(cost, limit)   → store: policy_budget_blocked + runtimeBuffer: budget_exceeded
  │
  ├─ 轮次限制
  │   events.turnLimit(turns, limit)       → store: policy_turn_limit + runtimeBuffer: turn_limit
  │
  ├─ 错误
  │   events.error(message, recoverable)   → store: error + runtimeBuffer: error
  │
  ├─ 恢复
  │   events.recoveryMaxOutput(attempt, max) → store: recovery_max_output
  │
  └─ 结束
      events.requestEnded(...)             → store: request_ended

ToolExecutor 通过 events.xxx() 发射事件：
  validate()
    → events.toolIntent(tc.id, tc.name, input)   → store: tool_intent
    → events.toolConfirm(tc.id, tc.name, ...)    → store: tool_confirm
    → events.planBlocked(tc.id, tc.name, reason) → store: policy_plan_blocked
    → events.stormBlocked(tc.id, tc.name, ...)   → store: policy_storm_blocked
    → events.permissionRequest(toolName, ...)     → runtimeBuffer: permission_request
    → events.permissionDenied(tc.id, toolName)   → runtimeBuffer: permission_denied

  execute()
    → events.toolStart(tc.id, tc.name, input, desc) → runtimeBuffer: tool_start
    → events.toolDispatched(tc.id, tc.name)          → store: tool_dispatched
    → events.toolProgress(tc.id, line)               → store: tool_progress + runtimeBuffer: tool_log
    → events.toolEnd(tc.id, tc.name, result)         → runtimeBuffer: tool_end
    → events.toolResult(tc.id, tc.name, dur, status) → store: tool_result

  postProcess()
    → events.fileTouched(path, mode, bytes)          → store: effect_file_touched
```

### 3.4 调用方迁移

| 调用方 | 当前 | 迁移后 |
|--------|------|--------|
| CLI UI (App.tsx) | `for await (ev of engine.sendStreaming(msg))` | `for await (ev of engine.run(msg))` |
| Gateway SessionManager | `for await (ev of engine.send(msg))` | `for await (ev of engine.run(msg))` |
| CLI run 命令 | `for await (ev of engine.send(msg))` | `for await (ev of engine.run(msg))` |
| Print 模式 | `for await (ev of engine.send(msg))` | `for await (ev of engine.run(msg))` |
| Server 模式 | `for await (ev of engine.send(msg))` | `for await (ev of engine.run(msg))` |
| AgentPool | `for await (ev of engine.send(msg))` | `for await (ev of engine.run(msg))` |
| AgentTool | `for await (ev of subEngine.send(msg))` | `for await (ev of subEngine.run(msg))` |

所有调用方行为一致：`for await (const ev of engine.run(msg))`。

### 3.5 公共逻辑提取

从 `send()` 和 `sendStreaming()` 的重复代码中提取：

| 新方法 | 替换的重复代码 | 行数估算 |
|--------|--------------|---------|
| `prepareRequest()` | 并发锁 + AbortController + CostTracker + onBeforeSend + events 初始化 | ~30行 |
| `checkBudget(costs, maxBudgetUsd)` | 预算检查 + events.budgetWarn() / events.budgetExceeded() | ~15行 |
| `compactIfNeeded(messages)` | 自动压缩触发 + events.compactStart() / events.compactDone() | ~20行 |
| `injectRecoveryMessage(content)` | 系统恢复消息写入 store（直接，无对应 events 方法） | ~8行 |
| `handleLoopExit(turns, maxTurns, aborted)` | events.turnLimit() + 恢复消息 | ~15行 |
| `finalizeRequest(startTime, turns, toolCalls, ...)` | events.requestEnded() + running 释放 + onAfterSend | ~15行 |

---

## 四、常量和辅助函数

### `src/core/engine-constants.ts`

```typescript
export const DEFAULT_MAX_TOKENS = 8096
export const DEFAULT_MAX_TURNS = 50
export const DEFAULT_AUTO_COMPACT_THRESHOLD = 100000
export const ABSOLUTE_MAX_MULTIPLIER = 3
export const DEFAULT_TOOL_TIMEOUT_MS = 60 * 60 * 1000
export const TOOL_TIMEOUT_MARGIN_MS = 5000
export const TOOL_LOG_POLL_MS = 30
export const BUDGET_WARN_RATIO = 0.8
export const STORM_WINDOW_SIZE = 10
```

### 辅助函数（QueryEngine 内）

```typescript
function extractMessageText(msg: string | Message): string
private get requestId(): string | undefined
```

---

## 五、文件结构

```
src/core/
  RuntimeEvent.ts         ← 运行时事件类型定义（新建）
  KernelEvent.ts          ← 持久化事件类型 + 28 个工厂函数（新建，从 ConversationStore 迁移）
  EventBridge.ts    ← EventBridge — 统一事件发射层（新建）
  ToolExecutor.ts         ← 工具执行生命周期（新建）
  engine-constants.ts     ← 常量定义（新建）
  QueryEngine.ts          ← 主循环 run() + 配置 + 状态管理（重构）
  ConversationStore.ts    ← 存储层（改造：接收 KernelEvent）
  projections.ts          ← 投影层（不改动，消费 ChatMessage）
```

---

## 六、ConversationStore 改造

当前 ConversationStore 使用 `ConversationEvent` 联合类型。改造为使用 `KernelEvent`：

1. `appendEvents(...events: KernelEvent[])` — 替代当前的 `appendEvents(...events: ConversationEvent[])`
2. `getEventLog(): KernelEvent[]` — 返回类型改为 KernelEvent
3. 事件工厂函数（`createXxxEvent`，28 个）从 ConversationStore.ts 迁移到 `KernelEvent.ts`，同时重命名以匹配新 KernelEvent 类型名：
   - `createSessionOpenEvent` → `createSessionOpenedEvent`（type: `session_opened`）
   - `createReqStartEvent` → `createRequestStartedEvent`（type: `request_started`）
   - `createReqEndEvent` → `createRequestEndedEvent`（type: `request_ended`）
   - `createToolStartEvent` → `createToolDispatchedEvent`（type: `tool_dispatched`）
   - `createToolEndEvent` → `createToolResultEvent`（type: `tool_result`）
   - `createToolLogEvent` → `createToolProgressEvent`（type: `tool_progress`）
   - `createBudgetExceededEvent` → `createBudgetBlockedEvent`（type: `policy_budget_blocked`）
   - `createTurnLimitEvent` → `createPolicyTurnLimitEvent`（type: `policy_turn_limit`）
   - `createStormBlockedEvent` → `createPolicyStormBlockedEvent`（type: `policy_storm_blocked`）
   - `createPlanBlockedEvent` → `createPolicyPlanBlockedEvent`（type: `policy_plan_blocked`）
   - 其余工厂函数名称与 KernelEvent type 基本一致，仅需首字母规范化
4. `JsonlEventStorage` 不变（只是写入 JSON 行，不关心具体类型）
5. `replaceEvents()` 接受 `KernelEvent[]`
6. schema marker 使用 `hrids-events/v1`
7. 旧的 `ConversationEvent` 联合类型和工厂函数在重构完成后删除

### projections.ts

`projectForDisplay` 从 `ChatMessage[]` 投影，不消费事件。**无需改造**。

### Gateway toClientMessage()

**本次不改**。RuntimeEvent 类型名与旧 StreamEvent 一致，Gateway 无需适配。后续 Gateway 重构时统一处理。

---

## 七、events.jsonl 格式（v1）

**新架构全新格式**，schema marker 使用 `hrids-events/v1`。

- `ConversationStore.load()` 使用 `JSON.parse(line) as KernelEvent`（无运行时校验，与现有行为一致）
- 旧会话的 events.jsonl 不迁移，读取时未识别的类型静默跳过
- `LegacyConversationEvent` 和 `migrateEventsToMessages()` 保留（Gateway 后续重构时处理）
- 旧的 `ConversationEvent` 联合类型和工厂函数在重构完成后删除

---

## 八、实施顺序

| 步骤 | 内容 | 文件 | 风险 |
|------|------|------|------|
| 1 | 新建 `RuntimeEvent.ts` + `KernelEvent.ts`（类型 + 工厂函数） | 新建 2 文件 | 低 |
| 2 | 新建 `engine-constants.ts`，替换 QueryEngine 中魔法数字 | 新建 + 修改 QueryEngine | 低 |
| 3 | 改造 `ConversationStore.ts`：KernelEvent 替代 ConversationEvent | 修改 ConversationStore | 中 |
| 4 | 新建 `EventBridge.ts`，实现所有事件方法 | 新建 1 文件 | 中 |
| 5 | 新建 `ToolExecutor.ts`，从 QueryEngine 移出 validate/execute/postProcess | 新建 + 修改 QueryEngine | 中 |
| 6 | 删除 `executeOneToolCore()` + `send()`，合并为 `run()` | 修改 QueryEngine | 高 |
| 7 | 更新所有调用方使用 `run()` + `RuntimeEvent` | 修改 7 个文件 | 中 |
| 8 | FallbackProvider 扩展 + QueryEngine 集成 model_escalated/error_recovery | 修改 2 文件 | 低 |
| 9 | 编译验证 `npx tsc --noEmit` | — | — |

**步骤 1-2 可并行**（无依赖）。步骤 3-7 必须顺序执行。

---

## 九、验证

1. `npx tsc --noEmit` 编译通过
2. CLI 交互模式：消息、工具调用、权限拒绝、abort → 行为不变
3. events.jsonl：所有 KernelEvent 类型和字段正确写入
4. 流式工具执行：LLM 流式输出期间工具立即启动
5. in-flight 工具 drain：LLM 结束后等待所有工具完成
6. Abort：流式中途 abort 能及时响应，in-flight 工具正确清理
7. compactHistory：压缩后 events.jsonl 只含 session_compacted + assistant_message
8. 多 Agent：子 Agent 的 ToolExecutor 与父隔离
