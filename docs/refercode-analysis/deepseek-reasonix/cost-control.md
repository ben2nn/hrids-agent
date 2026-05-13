# DeepSeek-Reasonix 成本控制分析

---

## 一、设计目标

Reasonix 的产品北极星：**coding agent that stays cheap enough to leave on**。每个子系统都回答这个问题：这会让月账单增加多少？

---

## 二、四大成本控制机制

### 2.1 Flash-First 策略

**文件**：`src/cli/ui/presets.ts`

三个预设模式：

| 预设 | 模型 | 推理力度 | 自动升级 | 相对成本 |
|------|------|---------|---------|---------|
| `auto` (默认) | v4-flash | max | 开启 | 1× |
| `flash` | v4-flash | max | 关闭 | 1× |
| `pro` | v4-pro | max | 关闭 | 3-12× |

**价格对比** (USD/百万 token)：

| 模型 | 缓存命中输入 | 缓存未命中输入 | 输出 |
|------|-------------|--------------|------|
| v4-flash | $0.028 | $0.139 | $0.278 |
| v4-pro | $0.139 | $1.667 | $3.333 |

**设计原则**：所有辅助调用（摘要生成、子代理、截断修复重试）硬编码 `v4-flash + effort=high`，无论用户选择什么预设。

### 2.2 Auto-Escalation（自动升级）

**触发路径 A：模型主动请求**

当 flash 模型输出 `<<<NEEDS_PRO>>>` 或 `<<<NEEDS_PRO: reason>>>` 时：
1. 流式输出缓冲前 256 字符，避免标记闪现
2. 检测到标记后中止当前调用
3. 后续迭代切换到 `deepseek-v4-pro`
4. 向用户发出升级警告

**触发路径 B：工具调用失败**

`TurnFailureTracker` 追踪失败事件：
- 阈值：`FAILURE_ESCALATION_THRESHOLD = 3`
- 失败类型：search-mismatch, scavenged, truncated, repeat-loop
- 跨越阈值时自动升级剩余迭代
- 每轮开始时重置计数器

**UI 反馈**：
- 黄色 `⇧ pro armed` pill — `/pro` 命令激活
- 红色 `⇧ pro escalated` pill — 自动升级激活

### 2.3 /pro 单次升级

**文件**：`src/cli/ui/slash/handlers/model.ts`

用户通过 `/pro` 命令为下一轮对话武装一次性的 pro 模型升级：

```
/pro          → 激活下一轮 pro
/pro off      → 取消激活
/pro cancel   → 取消激活
```

**机制**：
1. `armProForNextTurn()` 设置 `_proArmedForNextTurn = true`
2. 下一次 `step()` 开始时消费标志，设置 `_escalateThisTurn = true`
3. 升级仅对当前轮次有效，下一轮自动恢复 flash
4. UI 通过 `proArmed` 和 `escalatedThisTurn` getter 展示状态

### 2.4 Auto-Compaction（自动上下文压缩）

**文件**：`src/context-manager.ts`

**多级阈值策略**：

| 触发条件 | 动作 | 尾部保留 |
|---------|------|---------|
| promptTokens > 50% ctxMax | 正常折叠 | 20% ctxMax |
| promptTokens > 70% ctxMax | 激进折叠 | 10% ctxMax |
| promptTokens > 80% ctxMax | 强制摘要退出 | N/A |
| 本地预估 > 95% ctxMax | 紧急折叠（preflight） | 20% ctxMax |

**折叠流程**：
1. 从尾部向前扫描，在 user 消息边界处切割
2. 如果头部节省的 token 不足总量的 30%，跳过折叠
3. 调用 `summarizeForFold()` 用 `v4-flash` 生成摘要（即使在 pro 会话中）
4. 用摘要消息替换头部消息

**Preflight 紧急检查**：
- 在每次 API 调用前，使用本地 tokenizer 估算请求大小
- 超过 95% 上下文窗口时触发紧急折叠
- 折叠无法缩小时发出警告

---

## 三、Turn-End Auto-Compaction

**位置**：`src/loop.ts`

每个工具结果在轮次结束时超过 `TURN_END_RESULT_CAP_TOKENS`（3000）会被压缩：
- 模型在当前轮次有完整文本
- 后续轮次看到压缩摘要，可按需重新读取
- 一次额外的 `read_file` 调用比拖着 12KB 通过每个未来 prompt 便宜得多

---

## 四、Token 计数

### 4.1 本地 Tokenizer

**文件**：`src/tokenizer.ts`

- DeepSeek V3 的纯 TypeScript BPE tokenizer 移植
- 从 `deepseek-tokenizer.json.gz` 加载词汇表
- 与 API 实际计数有约 3-6% 偏差
- 导出函数：`encode()`, `countTokens()`, `estimateConversationTokens()`

### 4.2 成本计算

**文件**：`src/telemetry/stats.ts`

```typescript
成本 = (缓存命中 × $0.028 + 缓存未命中 × $0.139 + 输出 × $0.278) / 1,000,000
```

额外指标：
- `claudeEquivalentCost()` — 相同用量在 Claude Sonnet 4.6 下的成本
- `cacheSavingsUsd()` — 缓存命中带来的成本节省

---

## 五、预算控制

**文件**：`src/cli/ui/slash/handlers/model.ts`

- `/budget $5.00` 设置软性 USD 上限
- 每次 `step()` 开始时检查：已花费 >= 预算则拒绝本轮
- 达到 80% 预算时发出一次性警告
- `/budget off` 或 `/budget 0` 移除上限

---

## 六、使用量统计

### 6.1 使用量日志

**文件**：`src/telemetry/usage.ts`

- 追加式 JSONL 日志：`~/.reasonix/usage.jsonl`
- 每条记录：时间戳、会话名、模型、token 数、成本
- 支持子代理记录：技能名、任务预览、持续时间
- **日志压缩**：超过 5MB 时清理超过 365 天的旧记录

### 6.2 统计聚合

`aggregateUsage()` 提供四个滚动窗口：
- 今日（24小时）
- 本周（7天）
- 本月（30天）
- 全部时间

每个窗口：轮次数、token 总数、缓存命中率、成本、Claude 等效成本、缓存节省金额。

---

## 七、关键设计模式

1. **成本意识贯穿始终**：从默认模型选择到上下文管理，每个环节都考虑成本
2. **渐进式降级**：flash 模型遇到困难时自动升级，而非一开始就用昂贵模型
3. **本地估算优先**：使用本地 tokenizer 进行 preflight，避免 API 400 错误浪费成本
4. **缓存友好**：上下文折叠保持前缀不变，利用 DeepSeek prompt cache
5. **优雅降级**：所有磁盘操作用 try-catch 包裹，故障不中断对话
6. **最佳努力原则**：使用量日志、会话持久化采用 best-effort 写入
