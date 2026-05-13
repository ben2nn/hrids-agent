# DeepSeek-Reasonix Tool-Call Repair 系统分析

---

## 一、问题背景

DeepSeek 模型在工具调用方面存在以下已知问题：

1. **工具调用 JSON 泄漏到 `reasoning_content`**（`<think>` 标签内），忘记填充正式的 `tool_calls` 字段
2. **参数丢失**：schema 超过 10 个参数或深度嵌套时丢参数
3. **调用风暴**：相同工具重复调用，浪费 token
4. **JSON 截断**：`max_tokens` 限制导致 JSON 不完整

---

## 二、四步修复管道

入口：`src/repair/index.ts`，`ToolCallRepair` 类驱动。

执行顺序：**scavenge → truncation → storm**（Schema flatten 在注册时执行）。

### 2.1 Scavenge（内容回收）

**文件**：`src/repair/scavenge.ts`

从非正式渠道中抢救工具调用。

**双通道扫描**：
- Pattern A - DSML invoke 块：`<｜DSML｜invoke name="...">` 格式
- Pattern B - 原始 JSON 对象：三种形状
  - `{ name, arguments }` — 简单格式
  - `{ type: "function", function: { name, arguments } }` — OpenAI 风格
  - `{ tool_name, tool_args }` — R1 自由格式变体

**防御措施**：
- 输入上限 100KB（防 ReDoS）
- 去重：`signature()` 函数（`name::arguments` 拼接）
- 最大回收数：默认 4 个

### 2.2 Schema Flatten（Schema 扁平化）

**文件**：`src/repair/flatten.ts`

**问题**：DeepSeek 对超过 2 层深度或超过 10 个叶子节点的 schema 会丢失参数。

**解决方案**：
1. `analyzeSchema()` 递归遍历 schema 树，统计 `leafCount` 和 `maxDepth`
2. 当 `leafCount > 10` 或 `maxDepth > 2` 时触发扁平化
3. `flattenSchema()` 将嵌套属性展平为点号路径（如 `config.output.format` → `config.output.format`）
4. `nestArguments()` 在 dispatch 时将点号路径参数还原为嵌套结构

**集成位置**：`ToolRegistry.register()` 时自动分析并存储 `flatSchema`。

### 2.3 Truncation Repair（截断修复）

**文件**：`src/repair/truncation.ts`

**问题**：模型输出的 JSON 可能因 token 限制被截断。

**修复策略**（逐字符扫描）：
1. 维护栈追踪 `{`、`[`、`"` 的嵌套状态
2. 五种修复：
   - 修剪尾部逗号：`/,$/` 匹配后移除
   - 填充悬挂键：`/"\s*:\s*$/` 匹配后追加 ` null`
   - 关闭未终止字符串：追加闭合 `"`
   - 闭合开放结构：反向弹出栈中剩余的 `{`、`[`
3. 尝试 `JSON.parse`，失败则回退为 `{}`

### 2.4 Storm Breaker（调用风暴抑制）

**文件**：`src/repair/storm.ts`

**问题**：模型可能陷入重复调用循环。

**机制设计**：
- **滑动窗口**：默认大小 6，存储最近的 `RecentEntry`
- **阈值**：默认 3，同一签名出现 3 次即触发抑制
- **变异调用特殊处理**：检测到变异调用时清除窗口中所有 readOnly 条目（"编辑 → 读取验证" 是正常模式）
- **豁免机制**：`isStormExempt` 回调允许廉价状态检查工具跳过计数
- **重置**：每个用户回合开始时调用 `resetStorm()`

---

## 三、工具并行调度

**位置**：`src/loop.ts` 第 1067-1166 行

### 3.1 分组策略

```
[read_file, list_dir, search_files] → chunk 1 (并行)
[edit_file]                         → 串行屏障
[read_file, grep]                   → chunk 2 (并行)
```

### 3.2 配置

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `REASONIX_PARALLEL_MAX` | 3 (硬上限 16) | 最大 chunk 大小 |
| `REASONIX_TOOL_DISPATCH=serial` | unset | 强制串行模式 |

### 3.3 并行安全标记

已标记 `parallelSafe: true` 的工具：
- 只读文件系统：`read_file`, `list_directory`, `directory_tree`, `search_files`, `search_content`, `glob`, `get_file_info`
- Web：`web_search`, `web_fetch`
- 内存：`recall_memory`, `semantic_search`
- 子代理：`spawn_subagent`
- 作业：`job_output`, `wait_for_job`, `list_jobs`

---

## 四、SEARCH/REPLACE 编辑模式

**文件**：`src/tools/fs/edit.ts`

### 4.1 edit_file

- **精确匹配**：`search` 参数必须唯一匹配（空白敏感）
- **唯一性校验**：找到第一个匹配后继续找第二个，有歧义则拒绝
- **换行符适配**：自动检测文件换行符风格
- **Diff 输出**：LCS 算法生成类 git-diff 格式

### 4.2 multi_edit

- **跨文件原子编辑**：一次调用对多个文件执行 N 个编辑
- **顺序执行**：同一文件的后续编辑可匹配前面编辑插入的文本
- **全有或全无**：任何编辑失败，所有文件都不写入
- **内存缓冲**：先读入内存 Map，全部验证通过后才批量写入磁盘

---

## 五、文件系统工具安全

**文件**：`src/tools/filesystem.ts`

- **路径沙箱**：`safePath()` 剥离前导 `/` 或 `\`，检测 `..` 逃逸
- **读取预算**：默认最大 2MB
- **大文件自动预览**：超过 200 行返回 head(80) + tail(40) + 导出大纲
- **目录遍历限制**：深度 2，每目录 50 项，跳过 `node_modules`、`.git`

---

## 六、Shell 工具安全

**文件**：`src/tools/shell.ts`

- **白名单机制**：只读命令直接执行，修改状态命令需确认
- **确认门控**：`NeedsConfirmationError` → `PauseGate` → TUI
- **"always allow" 持久化**：用户选择后前缀加入项目级允许列表
- **后台作业系统**：`run_background` + `job_output`/`wait_for_job`/`stop_job`/`list_jobs`

---

## 七、子代理系统

**文件**：`src/tools/subagent.ts`

### 7.1 架构

子代理是隔离的子循环（`CacheFirstLoop`），继承父注册表但排除 `spawn_subagent`（深度=1 硬上限）。

### 7.2 内置类型

- **explore**：广撒网只读调查，20 次迭代预算
- **verify**：窄范围 YES/NO/INCONCLUSIVE 检查，8 次迭代预算

### 7.3 成本控制

- 默认使用 `deepseek-v4-flash`（廉价快速）
- 推理预算默认 `high`（低于主循环的 `max`）
- 会话级预算守卫：
  - 软提示：spawn 超过 1 次后附加注释
  - 强提示：超过 4 次或累计 50,000 tokens 时要求论证必要性

### 7.4 中断传播

父 `AbortSignal` 通过 `addEventListener("abort", ...)` 桥接到子循环。
