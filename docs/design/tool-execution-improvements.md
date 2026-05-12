# 工具执行引擎改进方案

> 参考 Claude Code 和 DeepSeek-Reasonix 的设计，融合两者优势，适配 hrids-agent 现有架构。

## 背景

### 现状问题

1. **纯串行执行** — `QueryEngine.send()` 中工具调用是 `for` 逐个执行，`parallelSafe` 已声明但未使用
2. **无重复调用防护** — LLM 陷入死循环时只能手动中断
3. **大文件处理粗暴** — 超过 12000 字符直接截断，丢失尾部错误信息
4. **文件预览缺失** — 大文件无 head/tail/outline 自动预览，浪费 token

### 参考设计

| 特性 | Claude Code | Reasonix | 本方案采纳 |
|------|-------------|----------|-----------|
| 并行调度 | `partitionToolCalls` 自动分区 | `parallelSafe` 手动声明 | Claude Code（自动分区） |
| 防重复调用 | 无 | Storm Breaker 滑动窗口 | Reasonix |
| 大文件预览 | 无 | head+tail+outline | Reasonix |
| 结果截断 | 简单截断 | head+tail 策略 | Reasonix |
| 流式工具执行 | StreamingToolExecutor | 无 | 暂不采纳（改动过大） |

---

## 改动清单

### 1. 自动并行调度

**文件**: `src/core/QueryEngine.ts`（改造）+ `src/core/ToolScheduler.ts`（新增）

**现状**:
```typescript
// QueryEngine.ts line 980
for (const tc of toolCalls) {
  totalToolCalls++
  for await (const ev of this.executeOneTool(tc)) { ... }
}
```

**目标**: 将 `toolCalls` 按 `parallelSafe` 自动分区，连续的 safe 工具合并为并行批次。

**新增 `ToolScheduler.ts`**:

```typescript
interface ToolBatch {
  parallel: boolean
  calls: Array<{ id: string; name: string; input: unknown }>
}

/**
 * 按 parallelSafe 分区：
 * - 连续的 safe 工具 → 合并为一个并行批次
 * - 非 safe 工具 → 各自独立串行批次
 */
export function partitionToolCalls(
  toolCalls: Array<{ id: string; name: string; input: unknown }>,
  tools: ToolDef[],
): ToolBatch[] {
  return toolCalls.reduce<ToolBatch[]>((batches, tc) => {
    const tool = tools.find(t => t.name === tc.name)
    const isSafe = tool?.capabilities?.parallelSafe === true

    if (isSafe && batches.length > 0 && batches[batches.length - 1].parallel) {
      batches[batches.length - 1].calls.push(tc)
    } else {
      batches.push({ parallel: isSafe, calls: [tc] })
    }
    return batches
  }, [])
}
```

**改造 `send()` 循环** (line 976-1004，原有 `for (const tc of toolCalls)` 串行循环):

```typescript
const batches = partitionToolCalls(toolCalls, this.config.tools)

for (const batch of batches) {
  if (batch.parallel && batch.calls.length > 1) {
    // 并行执行 — 流式产出事件，不等全部完成
    yield* this.executeBatch(batch.calls)
  } else {
    // 串行执行（保持原有逻辑）
    for (const tc of batch.calls) { /* 原有逻辑 */ }
  }
  if (toolAborted) break
}
```

**`executeBatch` 实现 — 流式事件产出**:

核心问题：不能用 collect-then-replay 模式，否则并行工具的实时日志会丢失。
解决方案：用共享事件队列 + `Promise.race` 轮询，事件到达即 yield。

```typescript
interface PendingTool {
  tc: { id: string; name: string; input: unknown }
  gen: AsyncGenerator<ToolExecutionEvent>
  promise: Promise<ToolResult>
  done: boolean
  result?: ToolResult
}

private async *executeBatch(
  calls: Array<{ id: string; name: string; input: unknown }>
): AsyncGenerator<StreamEvent | ToolExecutionEvent> {
  const pending: PendingTool[] = calls.map(tc => {
    const gen = this.executeOneTool(tc)
    // 启动 generator 的首次迭代（到第一个 yield）
    const promise = gen.next() // 不 await，立即开始
    return { tc, gen, promise: promise.then(() => {}), done: false }
  })

  // 逐个消费 generator 的事件，任一完成即处理
  const active = new Set(pending.map((_, i) => i))

  while (active.size > 0) {
    // 并行等待所有活跃 generator 的下一个事件
    const racePromises = [...active].map(i => ({
      i,
      p: pending[i].gen.next().then(
        result => ({ i, done: result.done, value: result.value })
      )
    }))

    const winner = await Promise.race(racePromises.map(r => r.p))
    const { i, done, value } = winner

    if (done) {
      active.delete(i)
      continue
    }

    const ev = value as ToolExecutionEvent
    if (ev.type === '__tool_result__') {
      const block = ev.block as { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
      this.store.appendEvents(createToolResultEvent(
        block.tool_use_id, pending[i].tc.name, block.content,
        block.is_error === true, this.currentRequestId ?? undefined,
      ))
    } else {
      yield ev as StreamEvent
      if (this.abortController.signal.aborted) {
        // abort 时清空所有活跃 generator
        for (const idx of active) {
          pending[idx].gen.return(undefined)
        }
        break
      }
    }
  }
}
```

**关键约束**:
- 事件流式产出，不等全部完成 — 保持实时日志体验
- `abort` 信号通过 `gen.return()` 主动关闭所有活跃 generator
- 结果写入 store 的顺序按实际完成顺序（非 toolCalls 顺序），但 `tool_use_id` 在每个事件中已关联，不影响正确性
- 并行执行中任一工具出错不影响其他工具

---

### 2. Storm Breaker 防重复调用

**文件**: `src/core/StormBreaker.ts`（新增）+ `QueryEngine.ts`（集成）

**设计参考**: Reasonix `src/repair/` 的 storm breaker 机制

**新增 `StormBreaker.ts`**:

```typescript
interface CallFingerprint {
  name: string
  argsHash: string
  turn: number
}

export class StormBreaker {
  private recentCalls: CallFingerprint[] = []
  private readonly WINDOW_SIZE = 5
  private readonly REPEAT_THRESHOLD = 2

  /**
   * 检查是否陷入重复调用风暴
   * @returns null（正常）| 错误提示字符串（触发风暴防护）
   */
  check(name: string, input: unknown, currentTurn: number): string | null {
    const argsHash = this.hashArgs(input)

    // 统计窗口内相同调用次数
    const sameCount = this.recentCalls.filter(
      r => r.name === name && r.argsHash === argsHash
    ).length

    // 记录本次调用
    this.recentCalls.push({ name, argsHash, turn: currentTurn })
    if (this.recentCalls.length > this.WINDOW_SIZE * 2) {
      this.recentCalls = this.recentCalls.slice(-this.WINDOW_SIZE)
    }

    if (sameCount >= this.REPEAT_THRESHOLD) {
      return [
        `[Storm Breaker] 工具 "${name}" 已被连续调用 ${sameCount + 1} 次且参数完全相同。`,
        `请停止重试，换一种方式解决问题。`,
        `如果确实需要重复调用，请先调用其他工具（如读取相关文件）获取新信息后再试。`,
      ].join('\n')
    }
    return null
  }

  /** 写操作成功时清空窗口 — 允许 read→edit→verify 正常序列 */
  clearOnMutation(): void {
    this.recentCalls = []
  }

  /** abort 时重置 */
  reset(): void {
    this.recentCalls = []
  }

  private hashArgs(input: unknown): string {
    try {
      return JSON.stringify(input, Object.keys(input as object).sort())
    } catch {
      return String(input)
    }
  }
}
```

**集成到 `executeOneTool()`** (在 Zod 校验通过后、工具执行前，即 line 550 和 line 552 之间):

```typescript
// line ~550, Zod 校验通过后
const stormError = this.stormBreaker.check(tc.name, parsedInput, totalToolCalls)
if (stormError) {
  yield {
    type: '__tool_result__',
    block: {
      type: 'tool_result',
      tool_use_id: tc.id,
      content: stormError,
      is_error: true,
    },
  }
  continue
}
```

> 注：使用 `totalToolCalls`（工具调用计数器）而非 `turns`（LLM 轮次计数器），
> 因为同一 turn 内可能有多个工具调用，滑动窗口需要按工具粒度追踪。

**写操作成功后清空窗口** (在 `executeOneTool` 中 `yield { type: 'tool_end' }` 之后、`__tool_result__` yield 之前，即 line 610 和 line 638 之间):

```typescript
// tool_end yield 之后
if (result.type === 'success' && !tool.readonly) {
  this.stormBreaker.clearOnMutation()
}
// 继续 yield __tool_result__...
```

---

### 3. 大文件自动预览

**文件**: `src/tools/FileReadTool.ts`（改造）

**设计参考**: Reasonix `read_file` 的 head+tail+outline 策略

**新增常量**:

```typescript
const AUTO_PREVIEW_THRESHOLD = 200  // 超过此行数触发自动预览
const PREVIEW_HEAD_LINES = 80
const PREVIEW_TAIL_LINES = 40
const OUTLINE_MAX_ENTRIES = 30
```

**新增 `extractExportOutline` 函数**:

```typescript
const EXPORT_RE = /^export\s+(default\s+)?(function|class|const|let|var|interface|type|enum)\s+(\w+)/

function extractExportOutline(lines: string[]): string | null {
  const entries: Array<{ line: number; text: string }> = []
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(EXPORT_RE)
    if (match) {
      entries.push({ line: i + 1, text: match[0].replace(/\s*\{.*/, '') })
    }
  }
  if (entries.length === 0) return null

  const display = entries.length > OUTLINE_MAX_ENTRIES
    ? [...entries.slice(0, 25), { line: -1, text: `... ${entries.length - 25} more ...` }, ...entries.slice(-5)]
    : entries

  return display
    .map(e => e.line === -1 ? e.text : `  L${String(e.line).padStart(4)}: ${e.text}`)
    .join('\n')
}
```

**改造 `execute()` 方法** (在 `allLines` 计算之后、行范围计算之前，即 line 51 和 line 55 之间插入):

```typescript
// line 51: const allLines = content.split('\n')
// line 52: const totalLines = allLines.length

// ── 新增：大文件自动预览 ──
if (!input.startLine && !input.endLine && totalLines > AUTO_PREVIEW_THRESHOLD) {
  const lineNumWidth = String(totalLines).length
  const fmtLine = (num: number, text: string) =>
    `${String(num).padStart(lineNumWidth, ' ')} | ${text}`

  const head = allLines.slice(0, PREVIEW_HEAD_LINES)
  const tail = allLines.slice(-PREVIEW_TAIL_LINES)
  const outline = extractExportOutline(allLines)
  const omitted = totalLines - PREVIEW_HEAD_LINES - PREVIEW_TAIL_LINES

  const preview = [
    `# 文件预览: ${input.path} (${totalLines} 行)`,
    `# 使用 startLine/endLine 参数读取特定范围\n`,
    ...head.map((line, i) => fmtLine(i + 1, line)),
    `\n... 省略 ${omitted} 行 ...\n`,
    ...tail.map((line, i) => fmtLine(totalLines - PREVIEW_TAIL_LINES + i + 1, line)),
    outline ? `\n# 导出符号轮廓\n${outline}` : '',
  ].join('\n')

  return { type: 'success', output: preview }
}
// ── 原有行范围计算逻辑继续 ──
// line 55: const startIdx = ...
```

> 注：插入点必须在行范围计算（line 55）之前，否则 `endIdx` 会被 `MAX_LINES` 截断，
> 导致预览逻辑永远触发不了（allLines 已被截断为 2000 行）。
> `fmtLine` 内联定义，复用现有行号格式化逻辑。

---

### 4. 结果截断优化

**文件**: `QueryEngine.ts`（改造，line 630-636）

**现状**: 简单 `slice(0, MAX_TOOL_RESULT_CHARS)` 截断

**改造为 head+tail 策略**:

```typescript
function truncateToolResult(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content

  const tailReserve = 1024  // 保留尾部 1KB（错误信息通常在末尾）
  const headChars = maxChars - tailReserve
  const head = content.slice(0, headChars)
  const tail = content.slice(-tailReserve)

  return `${head}\n\n... [已截断 ${content.length - maxChars} 字符] ...\n\n${tail}`
}
```

**集成位置**: `executeOneTool()` 的结果截断处（line 630-636）

```typescript
// 原来:
if (output.length > MAX_TOOL_RESULT_CHARS) {
  output = output.slice(0, MAX_TOOL_RESULT_CHARS) + '\n...[已截断]...'
}

// 改为:
if (output.length > MAX_TOOL_RESULT_CHARS) {
  output = truncateToolResult(output, MAX_TOOL_RESULT_CHARS)
}
```

> 注：截断格式从"尾部追加提示"改为"中间插入提示"。需确认 `projections.ts` 中
> 的 `applyToolResultBudget()` 和 `pruneOldToolResults()` 不依赖原格式的精确字符串。
> 经审核，这两处只做字符长度判断和替换，不解析截断提示内容，无冲突。

---

### 5. ToolResult 类型扩展（预留）

**文件**: `src/core/Tool.ts`

**现状**: 只有 `success` / `error` 两种类型

**扩展**:

```typescript
export type ToolResult =
  | { type: 'success'; output: string }
  | { type: 'error'; message: string }
  // 新增：结构化数据载荷（为未来 plan/choice 工具预留）
  | { type: 'success'; output: string; structured?: unknown }
```

`structured` 字段可选，不影响现有工具。未来 plan 工具、choice 工具等可通过此字段携带结构化数据，避免像 Reasonix 那样用 Error 携带数据的 hack。

---

## 实施计划

| 阶段 | 改动 | 文件 | 风险 | 依赖 |
|------|------|------|------|------|
| P1 | Storm Breaker | 新增 `StormBreaker.ts` + `QueryEngine.ts` | 低 | 无 |
| P2 | 结果截断优化 | `QueryEngine.ts` | 低 | 无 |
| P3 | 大文件预览 | `FileReadTool.ts` | 低 | 无 |
| P4 | ToolResult 扩展 | `Tool.ts` | 低 | 无 |
| P5 | 自动并行调度 | 新增 `ToolScheduler.ts` + `QueryEngine.ts` | 中 | P1 |

**P1-P4 互不依赖，可并行实施。P5 依赖 P1（Storm Breaker 需在并行场景下工作）。**

---

## 测试策略

### Storm Breaker 测试
- 连续 3 次相同参数调用 → 第 3 次应被拦截
- 不同参数的调用 → 不应触发
- 写操作成功后 → 窗口清空，允许后续重复读取
- 并行场景下 → 每个工具独立检查

### 并行调度测试
- 全部 parallelSafe 工具 → 应合并为单个并行批次
- 全部非 safe 工具 → 应各自独立串行
- 混合场景 → safe 合并 + 非 safe 独立
- abort 信号 → 所有并行工具应被中止
- 结果顺序 → 与 toolCalls 原始顺序一致

### 大文件预览测试
- 小文件 (< 200 行) → 不触发预览
- 大文件无参数 → 自动预览 head+tail+outline
- 大文件指定 startLine/endLine → 正常范围读取
- 无 export 的文件 → outline 部分省略

### 截断优化测试
- 短内容 → 不截断
- 长内容 → head 90% + tail 1KB，中间有截断提示
- 末尾有错误信息 → 错误信息应保留在 tail 中
