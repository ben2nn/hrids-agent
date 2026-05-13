# DeepSeek-Reasonix 参考价值评估

---

## 一、高参考价值（可直接借鉴）

### 1.1 三层内存分区

**价值**：极高

**适用场景**：任何需要管理 LLM 上下文的系统

**核心思想**：
- **ImmutablePrefix**：不可变的系统提示 + 工具定义 + few-shots，作为缓存 key
- **AppendOnlyLog**：仅追加的对话历史
- **VolatileScratch**：每轮重置的临时工作区

**借鉴要点**：
```typescript
class MemoryPartition {
  readonly prefix: ImmutablePrefix   // 缓存 key
  readonly log: AppendOnlyLog        // 对话历史
  readonly scratch: VolatileScratch  // 临时工作区

  buildMessages(): ChatMessage[] {
    return [...this.prefix.toMessages(), ...this.log.toMessages()]
  }
}
```

### 1.2 Tool-Call Repair 管道

**价值**：极高

**适用场景**：任何使用 DeepSeek 模型的工具调用系统

**四步管道**：
1. **Scavenge** — 从 `reasoning_content` 中回收泄漏的工具调用
2. **Flatten** — Schema 扁平化（>10 参数或 >2 层深度时）
3. **Truncation** — 修复被截断的 JSON
4. **Storm** — 抑制重复调用（滑动窗口 + 阈值）

**借鉴要点**：
```typescript
class ToolCallRepair {
  process(declaredCalls, reasoningContent, content): ToolCall[] {
    let calls = declaredCalls
    calls = this.scavenge(calls, reasoningContent, content)
    calls = this.fixTruncation(calls)
    calls = this.detectStorm(calls)
    return calls
  }
}
```

### 1.3 Flash-First + Auto-Escalation

**价值**：高

**适用场景**：多模型切换的成本优化

**核心思想**：
- 默认使用廉价模型（flash）
- 模型自报告 `<<<NEEDS_PRO>>>` 时自动升级
- 工具调用失败超过阈值时自动升级
- 升级标记在流式输出中被缓冲吸收，用户无感知

**借鉴要点**：
```typescript
class ModelEscalator {
  private failureCount = 0
  private readonly THRESHOLD = 3

  shouldEscalate(): boolean {
    return this.failureCount >= this.THRESHOLD
  }

  recordFailure(): void {
    this.failureCount++
  }
}
```

### 1.4 本地 Tokenizer Preflight

**价值**：高

**适用场景**：避免发送超大请求导致 API 错误

**核心思想**：
- 使用本地 tokenizer 估算请求大小
- 超过 95% 上下文窗口时触发紧急折叠
- 避免 API 400 错误浪费成本

### 1.5 滑动窗口风暴检测

**价值**：中高

**适用场景**：防止模型陷入重复调用循环

**核心思想**：
- 滑动窗口（默认大小 6）存储最近调用
- 同一签名出现 3 次即触发抑制
- 变异调用清除 readOnly 条目（"编辑 → 读取验证" 是正常模式）
- 豁免机制允许廉价状态检查工具跳过计数

---

## 二、中等参考价值（理念可借鉴）

### 2.1 Schema 扁平化

**价值**：中

**说明**：DeepSeek 对复杂 schema 的处理能力有限，自动扁平化可提高工具调用成功率。

### 2.2 SEARCH/REPLACE 编辑模式

**价值**：中

**说明**：精确匹配 + 唯一性校验 + 换行符适配，比直接覆盖更安全。

### 2.3 预算控制

**价值**：中

**说明**：`/budget` 命令设置软性 USD 上限，80% 时警告，100% 时拒绝。

### 2.4 子代理成本守卫

**价值**：中

**说明**：会话级预算守卫，spawn 超过阈值时要求论证必要性。

---

## 三、低参考价值（差异较大）

| 模块 | 说明 |
|------|------|
| Ink TUI | 特定于 React/Ink 框架 |
| DeepSeek Tokenizer | 绑定 DeepSeek 模型 |
| MCP 传输层 | 标准协议，你可能已有实现 |

---

## 四、与 DeepSeek-TUI 的对比

| 维度 | DeepSeek-TUI | DeepSeek-Reasonix |
|------|-------------|-------------------|
| 语言 | Rust | TypeScript |
| 缓存策略 | Seam Manager (L1/L2/L3) | 三层内存分区 |
| 工具修复 | 无 | 四步管道（scavenge/flatten/truncation/storm） |
| 成本控制 | 检查点-重启周期 | Flash-First + Auto-Escalation |
| 上下文管理 | 周期边界推进 | 多级阈值折叠 |
| 子代理 | 非阻塞 spawn + 文件租约 | 隔离子循环 + 成本守卫 |

---

## 五、借鉴优先级建议

### P0（立即引入）

1. **三层内存分区** — 保证前缀缓存稳定性
2. **Tool-Call Repair 管道** — 提高 DeepSeek 工具调用成功率
3. **本地 Tokenizer Preflight** — 避免 API 错误浪费成本

### P1（近期引入）

4. **Flash-First + Auto-Escalation** — 多模型成本优化
5. **滑动窗口风暴检测** — 防止重复调用
6. **多级阈值上下文折叠** — 智能上下文管理

### P2（中期引入）

7. **预算控制** — 软性 USD 上限
8. **子代理成本守卫** — 会话级预算管理
9. **使用量统计与聚合** — 成本可视化
