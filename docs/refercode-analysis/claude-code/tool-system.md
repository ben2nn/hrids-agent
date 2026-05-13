# Claude Code 工具系统分析

---

## 一、Tool 接口定义

### 1.1 核心类型

```typescript
type Tool<Input, Output, P extends ToolProgressData> = {
  name: string
  aliases?: string[]
  searchHint?: string
  inputSchema: Input                           // Zod schema
  outputSchema?: z.ZodType<unknown>
  maxResultSizeChars: number                   // 结果持久化阈值
  shouldDefer?: boolean                        // 是否延迟加载
  alwaysLoad?: boolean                         // 是否始终加载

  // 核心方法
  call(args, context, canUseTool, parentMessage, onProgress?)
  description(input, options)
  prompt(options)
  validateInput?(input, context)
  checkPermissions(input, context)

  // 行为属性
  isEnabled(): boolean
  isReadOnly(input): boolean
  isDestructive?(input): boolean
  isConcurrencySafe(input): boolean
  interruptBehavior?(): 'cancel' | 'block'

  // UI 渲染
  renderToolUseMessage(input, options): React.ReactNode
  renderToolResultMessage?(content, progress, options): React.ReactNode
  // ...
}
```

### 1.2 buildTool() 工厂函数

提供安全默认值：

| 方法 | 默认值 |
|------|--------|
| `isEnabled` | `() => true` |
| `isConcurrencySafe` | `() => false` |
| `isReadOnly` | `() => false` |
| `isDestructive` | `() => false` |
| `checkPermissions` | `{ behavior: 'allow' }` |

**设计原则**：假设工具不安全，只有显式声明才被信任。

---

## 二、工具注册机制

### 2.1 条件加载 + 特性标志

**核心工具（始终加载）**：
- `AgentTool` — 子代理管理
- `BashTool` — Shell 命令执行
- `FileReadTool` / `FileEditTool` / `FileWriteTool` — 文件操作
- `GlobTool` / `GrepTool` — 文件搜索
- `NotebookEditTool` — Jupyter Notebook 编辑
- `WebFetchTool` / `WebSearchTool` — 网络访问
- `TodoWriteTool` — 任务管理
- `SkillTool` — 技能调用
- `AskUserQuestionTool` — 用户交互

**条件加载工具**：
- `REPLTool` — 仅 `USER_TYPE === 'ant'`
- `SleepTool` — `PROACTIVE` 或 `KAIROS` 特性
- `CronCreateTool` / `CronDeleteTool` / `CronListTool` — `AGENT_TRIGGERS` 特性
- `MonitorTool` — `MONITOR_TOOL` 特性
- `WorkflowTool` — `WORKFLOW_SCRIPTS` 特性
- `PowerShellTool` — 平台特定条件

### 2.2 工具池组装流程

```
getAllBaseTools()
    |
filterToolsByDenyRules()
    |
isEnabled() 检查
    |
assembleToolPool()  -- 合并内置工具 + MCP 工具（去重，内置优先）
```

**Prompt 缓存稳定性**：工具池按名称排序，避免顺序变化导致缓存失效。

---

## 三、核心工具实现

### 3.1 BashTool

- 最复杂的工具，约 1500+ 行
- 完整的命令解析（AST 分析）、安全检查、沙箱执行
- 子命令级权限检查：复合命令拆分为子命令独立检查
- 支持后台执行、超时控制、进度报告
- 命令分类为搜索/读取/列表操作以便 UI 折叠显示

### 3.2 FileEditTool

- `strict: true` 启用严格模式
- `backfillObservableInput` 展开相对路径和 `~` 路径，防止权限绕过
- 文件大小限制 1 GiB
- 支持 git diff 追踪和文件历史记录

### 3.3 FileReadTool

- `isReadOnly() => true`，`isConcurrencySafe() => true`
- 支持 PDF、图片、Notebook 等多种格式
- 内置行号添加和行数限制
- 封锁危险设备路径（/dev/zero, /dev/random 等）

### 3.4 AgentTool

- 实现子代理（subagent）系统，支持后台运行
- 支持 worktree 隔离和远程执行
- 通过 `assembleToolPool()` 为子代理构建独立工具池
- 区分同步/异步代理、单次/持续代理

### 3.5 SkillTool

- 模型调用斜杠命令的桥梁
- 从 `getCommands()` 和 MCP 技能中收集可用技能
- 支持内联执行和 fork（子代理）执行两种模式

### 3.6 GlobTool / GrepTool

- `isReadOnly() => true`，`isConcurrencySafe() => true`
- 使用 `preparePermissionMatcher` 支持通配符权限规则匹配
- 当 Bun 内嵌搜索工具可用时，这两个工具会被省略

---

## 四、工具执行流程

```
1. 模型生成 tool_use block (name + input)
    |
2. 查找工具: findToolByName(tools, name)  -- 支持别名
    |
3. 输入验证: tool.validateInput(input, context)
    |
4. 权限检查: canUseTool(tool, input, context, message, toolUseID)
    |-- tool.checkPermissions(input, context)  -- 工具特定
    |-- hasPermissionsToUseTool()              -- 通用权限引擎
    |-- useCanUseTool()                        -- UI 交互层
    |
5. 执行: tool.call(input, context, canUseTool, message, onProgress)
    |
6. 结果处理:
    |-- tool.mapToolResultToToolResultBlockParam(output, toolUseID)
    |-- tool.renderToolResultMessage(output, progress, options)
    |-- 结果大小检查 -> 超过 maxResultSizeChars 则持久化到磁盘
    |
7. 上下文更新: contextModifier (对于非并发安全工具)
```

---

## 五、关键设计模式

1. **工厂模式** — `buildTool()` 统一构建所有工具，提供安全默认值
2. **条件加载** — 通过 `feature()` (编译时) 和 `process.env` (运行时) 进行死代码消除
3. **懒加载** — 命令通过 `load()` 延迟加载实现模块
4. **Memoize 缓存** — 命令列表、技能索引等使用 lodash memoize 缓存
5. **安全优先** — 默认 `isReadOnly: false`、`isConcurrencySafe: false`
6. **MCP 集成** — MCP 工具通过 `assembleToolPool()` 统一管理
7. **Prompt 缓存稳定性** — 工具池按名称排序
