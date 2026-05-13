# DeepSeek-Reasonix 核心架构分析

---

## 一、设计哲学

Reasonix 是 **opinionated, not general**（有主见的，而非通用的）。每个抽象都由 DeepSeek 特定的行为或经济属性驱动。产品北极星：**coding agent that stays cheap enough to leave on**（足够便宜可以一直开着的编码代理）。

---

## 二、三层内存分区架构

这是 Reasonix 最核心的设计，定义在 `src/memory/runtime.ts` 中。

### 2.1 ImmutablePrefix（不可变前缀层）

```typescript
export class ImmutablePrefix {
  readonly system: string;
  private _toolSpecs: ToolSpec[];
  readonly fewShots: readonly ChatMessage[];
  private _fingerprintCache: string | null = null;
}
```

**职责**：存放整个会话生命周期中 **绝不改变** 的内容——系统提示词、工具定义和少量示例对话。

**关键设计**：
- **SHA-256 指纹机制**：对 `system + tools + fewShots` 取 SHA-256 哈希（截取前16位），用于检测前缀变化
- **工具变更感知**：`addTool()`/`removeTool()` 会主动清除指纹缓存，强制重新计算
- **DeepSeek 前缀缓存映射**：只要内容不变，DeepSeek 服务端就能命中缓存

### 2.2 AppendOnlyLog（仅追加日志层）

```typescript
export class AppendOnlyLog {
  private _entries: ChatMessage[] = [];
  append(message: ChatMessage): void { ... }
  extend(messages: ChatMessage[]): void { ... }
  compactInPlace(replacement: ChatMessage[]): void { ... }
}
```

**职责**：存放用户输入、助手回复和工具调用结果等 **会话进行中产生的消息**。

**关键设计**：
- **追加语义**：正常路径只有 `append()` 和 `extend()`，不会修改已有消息
- **唯一的破坏性路径**：`compactInPlace()` 仅用于历史折叠和会话恢复
- **浅拷贝输出**：`toMessages()` 对每条消息做浅拷贝，防止外部修改

### 2.3 VolatileScratch（易失性草稿层）

```typescript
export class VolatileScratch {
  reasoning: string | null = null;
  planState: Record<string, unknown> | null = null;
  notes: string[] = [];
  reset(): void { ... }
}
```

**职责**：存放 **仅在当前工具迭代周期内有效** 的临时数据。

**关键设计**：
- **每轮重置**：在 `step()` 入口处调用 `reset()`
- **不参与 API 调用**：纯粹是循环内部的临时状态容器

### 2.4 三层关系图

```
ImmutablePrefix  ──→  DeepSeek API 的缓存 key
        +
AppendOnlyLog    ──→  动态增长的对话历史
        +
VolatileScratch  ──→  临时工作区（不参与 API 调用）
```

构建 API 消息时（`buildMessages` 方法）：

```typescript
private buildMessages(pendingUser: string | null): ChatMessage[] {
    const healed = healLoadedMessages(this.log.toMessages(), DEFAULT_MAX_RESULT_CHARS);
    const msgs: ChatMessage[] = [...this.prefix.toMessages(), ...healed.messages];
    if (pendingUser !== null) msgs.push({ role: "user", content: pendingUser });
    return msgs;
}
```

顺序：`ImmutablePrefix` 在前，`AppendOnlyLog` 在后。由于前缀始终不变，DeepSeek 的前缀缓存在多次 API 调用之间保持稳定命中。

---

## 三、Cache-First Loop 核心实现

核心循环定义在 `src/loop.ts` 的 `CacheFirstLoop` 类中。

### 3.1 类结构

```
CacheFirstLoop
├── client: DeepSeekClient          // API 客户端
├── prefix: ImmutablePrefix          // 不可变前缀
├── log: AppendOnlyLog               // 仅追加日志
├── scratch: VolatileScratch         // 易失性草稿
├── stats: SessionStats              // 会话统计
├── repair: ToolCallRepair           // 工具调用修复
├── context: ContextManager          // 上下文管理器
├── hooks: ResolvedHook[]            // 生命周期钩子
├── _inflight: InflightSet           // 进行中的工具调用集合
├── _turnAbort: AbortController      // 当前轮次的中止控制器
└── _turnFailures: TurnFailureTracker // 失败跟踪器
```

### 3.2 step() 方法流程

`step()` 是一个 **AsyncGenerator**，接受用户输入，产出 `LoopEvent` 事件流。

```
1. 预算检查 → 超过 100% 拒绝，超过 80% 警告
2. 轮次状态重置 → scratch.reset() + repair.resetStorm()
3. 主迭代循环 (maxToolIters 次)：
   a. 中止检查
   b. 上下文预检 → 超过 95% 触发紧急折叠
   c. API 调用（流式/非流式）
   d. 自动升级处理 → <<<NEEDS_PRO>>> 标记检测
   e. 工具调用修复 → ToolCallRepair.process()
   f. 上下文后检 → 50%/70%/80% 三级阈值
   g. 工具分发 → 并行/串行混合调度
   h. 风暴检测与自修正
4. 预算耗尽 → 强制模型生成摘要
```

### 3.3 并行工具调度

采用 **连续并行分组 + 串行屏障** 模式：

1. 顺序遍历工具调用列表
2. 连续的 `parallelSafe` 调用归入同一 chunk
3. 遇到非并行安全的调用形成串行屏障
4. 每个 chunk 使用 `Promise.allSettled()` 并行执行
5. 结果按声明顺序收集（保证确定性）

**并行安全标记**：`read_file`, `list_directory`, `search_files`, `web_search`, `recall_memory` 等只读工具。

### 3.4 流式升级标记缓冲

流式模式下，系统缓冲前 256 个字符，检测 `<<<NEEDS_PRO>>>` 标记：
- 检测到标记 → 中断流，切换到 pro 模型，用户无感知
- 未检测到 → 将缓冲内容 flush 给用户

---

## 四、前缀缓存稳定性保证

系统通过多层机制确保高缓存命中率：

1. **ImmutablePrefix 不可变性**：system prompt、工具定义和 few-shots 在会话开始时设定
2. **消息构建顺序**：`buildMessages()` 始终将 ImmutablePrefix 放在最前面
3. **会话名不变**：`clearLog()` 保持 session name，确保服务端缓存有效
4. **折叠而非删除**：通过 fold 压缩旧消息为摘要，保持连续性
5. **指纹验证**：`verifyFingerprint()` 检测意外的前缀修改

**实际效果**：99.82% 缓存命中率，435M input tokens 成本从 $61 降至 $12。

---

## 五、会话管理

### 5.1 存储格式

- **路径**：`~/.reasonix/sessions/<sanitized-name>.jsonl`
- **格式**：每行一个 JSON 对象（JSONL）
- **元数据**：`<name>.meta.json` 存储累积统计
- **权限**：`0o600`（仅所有者读写）

### 5.2 会话恢复

1. 加载 JSONL 文件中的所有消息
2. 治疗过大的工具结果（截断到 token 限制）
3. 为缺少 `reasoning_content` 的历史消息补上占位符
4. 追加到 AppendOnlyLog
5. 加载 SessionMeta 恢复累积统计

### 5.3 生命周期

- **新建**：`resolveSession()` 在 `forceNew` 时追加时间戳后缀
- **归档**：`archiveSession()` 重命名为 `__archive_<ts>`
- **清理**：`pruneStaleSessions()` 清理超过 90 天的旧会话

---

## 六、事件驱动架构

`step()` 方法产出 `LoopEvent` 事件流：

| EventRole | 含义 |
|-----------|------|
| `assistant_delta` | 助手回复增量内容 |
| `assistant_final` | 助手回复完成 |
| `tool_call_delta` | 工具调用参数增量 |
| `tool_start` | 工具开始执行 |
| `tool` | 工具执行完成 |
| `done` | 本轮结束 |
| `error` | 错误 |
| `warning` | 警告 |
| `status` | 状态指示 |

UI 层（TUI）可以实时渲染每一阶段的进展。
