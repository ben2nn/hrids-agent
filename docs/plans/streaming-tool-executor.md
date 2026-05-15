# 流式工具执行计划

**状态：✅ 已实现**

## Context

将 `hrids-agent` 的工具执行从批量模式升级为流式模式，实现 LLM 边输出边执行工具，提升响应速度和用户体验。

**架构决策**：采用方案 C（分离执行与记录）
- UI 层：流式体验，实时显示工具执行进度
- Store 层：批次写入，保持事件溯源架构不变
- 两层解耦，ConversationStore 无需修改

## 现有架构

```
QueryEngine.send() → AsyncGenerator<StreamEvent>
  └→ LLM 完整响应
  └→ 解析所有 tool_use
  └→ ToolScheduler.partitionToolCalls() 分批
  └→ executeBatch() 批量执行
  └→ yield tool_start / tool_end 事件
  └→ ConversationStore.appendEvents() 批次写入
```

**优点**：逻辑简单，事件溯源友好（ConversationStore 按批次记录）
**缺点**：LLM 输出期间工具空闲，用户看到长时间 spinner

## 目标架构

**方案 C：分离执行与记录**（保持事件溯源兼容）

```
┌─────────────────────────────────────────────────────┐
│  UI 层（流式体验）                                    │
│  StreamingToolExecutor → 实时 yield tool_start/end   │
└───────────────────────┬─────────────────────────────┘
                        │ 工具结果暂存
┌───────────────────────▼─────────────────────────────┐
│  记录层（事件溯源，批次写入）                          │
│  LLM 结束 → 一次性 appendEvents(assistant + results) │
└─────────────────────────────────────────────────────┘
```

```
QueryEngine.sendStreaming() → AsyncGenerator<StreamEvent>
  └→ LLM 流式输出 (text_delta)
  └→ 增量解析 tool_use JSON
  └→ 检测到完整工具定义 → StreamingToolExecutor.submitToolUse()
  └→ 工具执行并行进行
  └→ yield text_delta / tool_start / tool_end 给 UI（实时）
  └→ 工具结果暂存到 pendingResults[]
  └→ LLM 结束后 → ConversationStore.appendEvents()（批次写入）
```

## 实施计划

### 1. 新增 JSON 增量解析器

**新建** `src/core/IncrementalJsonParser.ts`

- 输入：LLM 流式文本片段
- 输出：检测到完整的 JSON 对象时触发回调
- 处理：嵌套 JSON、转义字符、流式不完整片段
- 参考：SSE 的 data 行拼接逻辑

```typescript
interface IncrementalJsonParser {
  feed(chunk: string): void
  onObject(callback: (obj: any) => void): void
  reset(): void
}
```

### 2. 新增 StreamingToolExecutor

**新建** `src/core/StreamingToolExecutor.ts`

- 接收：IncrementalJsonParser 输出的 tool_use 对象
- 调度：复用现有 `ToolRegistry.dispatch()` 执行
- 并发控制：
  - `isConcurrencySafe=true` 的工具立即并行执行
  - `isConcurrencySafe=false` 的工具排队串行执行
- 结果缓冲：收集所有工具结果，按原始顺序输出
- 超时处理：单工具超时（30s 默认）→ 取消 + 错误事件

```typescript
interface StreamingToolExecutor {
  submitToolUse(toolUse: ToolUse): void
  onResult(callback: (result: ToolResult) => void): void
  waitAll(): Promise<ToolResult[]>  // 等待所有工具完成，返回结果列表
  cancel(): void
}
```

**与 QueryEngine 的协作**：
- QueryEngine 调用 `submitToolUse()` 提交工具
- 通过 `onResult()` 获取每个工具的完成事件，yield 给 UI
- LLM 结束后调用 `waitAll()` 获取所有结果，写入 ConversationStore

### 3. 修改 QueryEngine

**修改** `src/core/QueryEngine.ts`

新增 `sendStreaming()` 方法：

```typescript
async *sendStreaming(
  userMessage: string,
  abortSignal?: AbortSignal
): AsyncGenerator<StreamEvent> {
  // 1. 构建消息（复用现有逻辑）
  // 2. 调用 LLM streaming API
  // 3. 同时处理两个流：
  //    - yield text_delta 给 UI
  //    - 增量解析 tool_use JSON → StreamingToolExecutor
  // 4. StreamingToolExecutor 执行工具 → yield tool_start/tool_end 给 UI
  // 5. 工具结果暂存到 pendingResults[]
  // 6. LLM 结束后：
  //    - ConversationStore.appendEvents(assistant + results)  ← 批次写入
  //    - 如果有工具结果 → 递归调用 sendStreaming()（多轮）
  // 7. yield done 事件
}
```

保持 `send()` 不变，向后兼容。

### 4. 修改 ToolScheduler

**修改** `src/core/ToolScheduler.ts`

新增 `scheduleStreaming()` 方法：

```typescript
function scheduleStreaming(
  toolUse: ToolUse,
  tools: ToolDefinition[]
): ToolBatch {
  // 单工具调度（非批次）
  // 返回该工具应该立即执行还是排队
}
```

### 5. ConversationStore 适配

**无需修改 ConversationStore**

流式模式下，事件记录策略：

```typescript
// QueryEngine.sendStreaming() 内部
async *sendStreaming() {
  const pendingToolResults: ToolResultEvent[] = []
  let fullText = ''
  let fullToolCalls: ToolCallEvent[] = []

  for await (const chunk of llmStream) {
    if (chunk.type === 'text_delta') {
      fullText += chunk.text
      yield { type: 'text_delta', ...chunk }  // UI 实时显示
    }
    if (chunk.type === 'tool_use') {
      fullToolCalls.push(chunk)
      // 立即执行，yield 给 UI
      const result = await executeTool(chunk)
      pendingToolResults.push(result)
      yield { type: 'tool_start', tool: chunk }
      yield { type: 'tool_end', result }
    }
  }

  // LLM 结束后，一次性写入 ConversationStore（保持事件溯源）
  store.appendEvents(
    createAssistantMessageEvent(fullText, fullToolCalls, requestId),
    ...pendingToolResults
  )
}
```

**关键点**：
- UI 层：流式体验，实时显示工具执行进度
- Store 层：批次写入，保持事件溯源架构不变
- 两层解耦，互不影响

### 6. App.tsx 集成

**修改** `src/cli/ui/App.tsx`

```typescript
// 渐进迁移：默认用 send()，可通过配置切换到 sendStreaming()
const useStreaming = config.get('experimental.streamingTools')

if (useStreaming) {
  for await (const event of engine.sendStreaming(input)) {
    handleEvent(event)  // UI 实时更新（text_delta / tool_start / tool_end）
    // ConversationStore 写入由 sendStreaming() 内部处理，UI 无需关心
  }
} else {
  for await (const event of engine.send(input)) {
    handleEvent(event)
  }
}
```

**UI 无需修改**：流式模式下的 tool_start / tool_end 事件与现有事件类型兼容。

## 文件清单（实际实现）

| 操作 | 文件 | 说明 |
|------|------|------|
| 修改 | `src/core/QueryEngine.ts` | 新增 `executeOneToolCore()` + `sendStreaming()` |
| 修改 | `src/cli/ui/App.tsx` | `send()` → `sendStreaming()` |

**无需新建文件**：复用 `executeOneToolCore()` 替代独立的 StreamingToolExecutor
**无需修改**：ConversationStore、ToolScheduler（保持现有逻辑）

## 关键技术点

### JSON 增量解析

~~不需要~~ — LLM Provider 的 `StreamChunk` 已经支持 `type: 'tool_call'`，tool call 作为完整对象到达，无需增量 JSON 解析。

### 并发控制

实际实现中，所有工具（无论 `parallelSafe`）都在 LLM 流式输出期间立即启动执行。每个工具通过独立的 `executeOneToolCore()` 异步执行，事件通过队列传回主循环。工具的 `parallelSafe` 属性由 `validateAndPrepareTool` 内部的权限检查处理。

### 事件时序

流式模式下，UI 事件交错显示，Store 批次写入：

```
t=0.1s  text_delta: "我来"           → UI 显示
t=0.2s  text_delta: "看看"           → UI 显示
t=0.3s  tool_start: read_file        → UI 显示 spinner
t=0.4s  text_delta: "项目结构"        → UI 显示
t=0.5s  tool_end: read_file (成功)    → UI 显示结果
t=0.6s  tool_start: glob             → UI 显示 spinner
t=0.7s  tool_end: glob (成功)        → UI 显示结果
t=0.8s  done                         → Store 批次写入所有事件
```

**UI 层**：实时处理 text_delta / tool_start / tool_end 交错
**Store 层**：done 时一次性写入 assistant_message + tool_result[]

## 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| JSON 解析错误 | 工具调用失败 | 回退到批量模式 + 错误日志 |
| 工具结果乱序 | 上下文混乱 | 按原始顺序缓冲输出 |
| 并发工具冲突 | 数据竞争 | 严格区分 safe/unsafe 工具 |

**已解决**：事件溯源兼容性 — 通过方案 C（UI 流式 + Store 批次写入）完全兼容，无需修改 ConversationStore。

## 验证方式

1. **单元测试**：IncrementalJsonParser 边界情况（截断、嵌套、转义）
2. **集成测试**：Mock LLM 流式输出，验证工具执行时序
3. **事件溯源兼容性**：验证流式模式下 ConversationStore 的事件记录与批量模式一致
4. **端到端测试**：实际 LLM 调用，对比批量/流式模式的总耗时
5. **性能基准**：记录从用户输入到第一个工具开始执行的延迟

## 启用方式

默认关闭，通过配置启用：

```json
{
  "experimental": {
    "streamingTools": true
  }
}
```

或环境变量：`HRIDS_STREAMING_TOOLS=1`

**回退机制**：
- JSON 解析错误 → 自动回退到批量模式
- 工具执行超时 → 取消 + 错误事件
- 配置关闭 → 使用现有 `send()` 方法
