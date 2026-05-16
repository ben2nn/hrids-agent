# events.jsonl 待完善事件清单

## 概述

双存储架构（messages.jsonl + events.jsonl）已基本完成，22 种事件中 18 种已实现。以下 4 种事件因涉及跨模块改动暂未实现。

---

## 1. `tool_log` — 工具执行流式日志

**优先级**：中

**用途**：实时推送工具执行过程中的逐行输出（如 bash 命令的 stdout），用于 UI 流式展示。

**接口定义**：
```typescript
interface ToolLogEvent extends BaseEvent {
  type: 'tool_log'
  toolCallId: string
  line: string
}
```

**实现方案**：

在 `src/core/QueryEngine.ts` 的 `executeOneTool()` 中，为工具执行添加 `onLog` 回调：

```typescript
// executeOneTool() 内部
const onLog = (line: string) => {
  this.store.appendEvents({
    type: 'tool_log',
    id: genId('tl'),
    ts: Date.now(),
    requestId: this.currentRequestId,
    toolCallId: tc.id,
    line,
  })
}
```

**需修改文件**：
- `src/core/QueryEngine.ts` — executeOneTool() 添加 onLog 回调
- `src/core/Tool.ts` — ToolDef 接口添加 `onLog?: (line: string) => void`
- `src/tools/BashTool.ts` — 执行时调用 onLog 输出逐行日志

**注意事项**：
- 高频写入可能影响性能，考虑批量写入或采样
- tool_log 不需要写入 messages.jsonl，仅写入 events.jsonl

---

## 2. `model_escalated` — 模型升级

**优先级**：低

**用途**：记录 FallbackProvider 在主模型失败后切换到备用模型的事件，用于成本分析和故障追踪。

**接口定义**：
```typescript
interface ModelEscalatedEvent extends BaseEvent {
  type: 'model_escalated'
  fromModel: string
  toModel: string
  reason: 'self_report' | 'failure_threshold' | 'user_request'
  rationale?: string
}
```

**实现方案**：

在 `src/core/providers/FallbackProvider.ts` 的 `stream()` 方法中，当切换 provider 时触发事件。

**难点**：FallbackProvider 当前没有对 ConversationStore 的访问权限。

**可选方案**：
1. **回调注入**：在 FallbackProvider 构造时传入 `onModelEscalated` 回调
2. **事件总线**：引入全局事件总线，FallbackProvider 发布事件，QueryEngine 订阅并写入 store
3. **QueryEngine 层拦截**：在 QueryEngine 的 `onFallbackStatus` 回调中，根据 status 类型判断是否为模型升级

**推荐方案 3**（最小改动）：

```typescript
// QueryEngine 构造函数中
this.provider.onFallbackStatus = (event) => {
  if (event.type === 'switching') {
    this.store.appendEvents(createModelEscalatedEvent(
      this.currentRequestId,
      event.fromModel,  // 需要 FallbackProvider 提供
      event.toModel,
      'failure_threshold',
      event.reason,
    ))
  }
}
```

**需修改文件**：
- `src/core/providers/FallbackProvider.ts` — onFallbackStatus 回调增加 fromModel/toModel 字段
- `src/core/QueryEngine.ts` — onFallbackStatus 回调中处理 switching 事件
- `src/core/ConversationStore.ts` — createModelEscalatedEvent 已定义，无需修改

---

## 3. `cap_registered` / `cap_removed` — 工具能力注册/移除

**优先级**：低

**用途**：记录工具的动态注册和注销事件，用于审计和可观测性。

**接口定义**：
```typescript
interface CapRegisteredEvent extends BaseEvent {
  type: 'cap_registered'
  toolName: string
  permission: 'ask' | 'allow' | 'deny'
}

interface CapRemovedEvent extends BaseEvent {
  type: 'cap_removed'
  toolName: string
}
```

**实现方案**：

**难点**：ToolRegistry 是独立类，没有对 ConversationStore 的访问权限。工具注册发生在启动阶段（main.ts、bootstrap），不在 QueryEngine 内部。

**可选方案**：
1. **ToolRegistry 注入 store**：构造时传入 store 引用
2. **装饰器模式**：在 QueryEngine 层包装 register/unregister 调用
3. **启动时批量记录**：在 QueryEngine 初始化时，遍历已注册工具并批量写入 cap_registered 事件

**推荐方案 3**（最简单）：

```typescript
// QueryEngine 构造函数中，初始化完成后
for (const tool of this.tools.getAll()) {
  this.store.appendEvents(createCapRegisteredEvent(
    tool.name,
    tool.readonly ? 'allow' : 'ask',
  ))
}
```

**需修改文件**：
- `src/core/QueryEngine.ts` — 构造函数中批量写入 cap_registered
- 动态注册/注销场景（如 MCP 工具热加载）需要额外处理

**注意事项**：
- cap_registered 的 permission 字段应反映当前权限模式下的默认行为，而非实际权限决策
- cap_removed 目前无动态注销场景，可暂缓实现

---

## 4. `hook_fired` — Hook 触发

**优先级**：低

**用途**：记录各生命周期 hook 的执行结果，用于调试和审计。

**接口定义**：
```typescript
interface HookFiredEvent extends BaseEvent {
  type: 'hook_fired'
  hookName: string
  phase: 'pre_tool' | 'post_tool' | 'pre_send' | 'post_send' | 'compact'
  outcome: 'ok' | 'blocked' | 'modified' | 'err'
}
```

**实现方案**：

当前 QueryEngine 中有以下 hook 回调点：
- `onBeforeSend` — pre_send
- `onAfterSend` — post_send
- `onBeforeCompact` — compact
- `onPermissionRequest` — pre_tool

在每个 hook 执行后写入事件：

```typescript
// 示例：onBeforeSend
try {
  await this.onBeforeSend(msgText)
  this.store.appendEvents(createHookFiredEvent('onBeforeSend', 'pre_send', 'ok'))
} catch {
  this.store.appendEvents(createHookFiredEvent('onBeforeSend', 'pre_send', 'err'))
}
```

**需修改文件**：
- `src/core/QueryEngine.ts` — 所有 hook 回调点（约 6 处）

**注意事项**：
- hook 执行失败不应阻断主流程（当前已是 try/catch 静默处理）
- hook_fired 事件的 hookName 应使用可读名称，如 'onBeforeSend'、'onPermissionRequest'

---

## 5. `error_recovery` — 错误恢复

**优先级**：低

**用途**：记录 LLM 调用失败后的重试行为，区分于 `error` 事件（记录错误本身）。

**接口定义**：
```typescript
interface ErrorRecoveryEvent extends BaseEvent {
  type: 'error_recovery'
  errorType: string
  attempt: number
  maxAttempts: number
}
```

**实现方案**：

重试逻辑在 `src/core/providers/FallbackProvider.ts` 中，同 `model_escalated` 存在 store 访问问题。

**推荐方案**：在 QueryEngine 的 `onFallbackStatus` 回调中处理：

```typescript
this.provider.onFallbackStatus = (event) => {
  if (event.type === 'retrying') {
    this.store.appendEvents(createErrorRecoveryEvent(
      event.reason ?? 'unknown',
      event.attempt,      // 需要 FallbackProvider 提供
      event.maxAttempts,  // 需要 FallbackProvider 提供
    ))
  }
}
```

**需修改文件**：
- `src/core/providers/FallbackProvider.ts` — onFallbackStatus 回调增加 attempt/maxAttempts 字段
- `src/core/QueryEngine.ts` — onFallbackStatus 回调中处理 retrying 事件

---

## 实施建议

| 阶段 | 事件 | 预估工作量 |
|------|------|-----------|
| Phase 1 | `tool_log` | 2h |
| Phase 2 | `model_escalated` + `error_recovery` | 1h（共用 FallbackProvider 改动） |
| Phase 3 | `cap_registered` | 0.5h |
| Phase 4 | `hook_fired` | 1h |
| Phase 5 | `cap_removed` | 0.5h（需有动态注销场景） |

## 验证方式

每个事件实现后，验证方法：
1. `npx tsc --noEmit` 编译通过
2. 触发对应场景，检查 events.jsonl 中是否正确写入
3. Gateway 推送是否正常（events 通过 NDJSON stdout 推送给前端）
