# Claude Code 命令与权限系统分析

---

## 一、命令系统

### 1.1 命令类型定义

```typescript
type Command = CommandBase & (PromptCommand | LocalCommand | LocalJSXCommand)
```

**PromptCommand（提示型命令）**：
- `type: 'prompt'`
- 将命令内容展开为发送给模型的提示词
- 例如：`/review`, `/init`, `/security-review`
- 支持 `allowedTools`、`model`、`context`（inline/fork）

**LocalCommand（本地执行型命令）**：
- `type: 'local'`
- 在本地执行 TypeScript 代码，返回文本结果
- 例如：`/compact`, `/cost`, `/diff`
- 通过 `load()` 懒加载实现模块

**LocalJSXCommand（本地 JSX 型命令）**：
- `type: 'local-jsx'`
- 渲染 React (Ink) UI 组件
- 例如：`/ultrareview`, `/config`, `/permissions`

### 1.2 命令公共属性

```typescript
type CommandBase = {
  name: string
  aliases?: string[]
  description: string
  isEnabled?: () => boolean
  isHidden?: boolean
  availability?: CommandAvailability[]  // 'claude-ai' | 'console'
  loadedFrom?: 'commands_DEPRECATED' | 'skills' | 'plugin' | 'bundled' | 'mcp'
  source?: SettingSource | 'builtin' | 'mcp' | 'plugin' | 'bundled'
  whenToUse?: string              // 模型决策用
  disableModelInvocation?: boolean
  userInvocable?: boolean
  kind?: 'workflow'
  isSensitive?: boolean
}
```

### 1.3 命令来源

```
bundledSkills              -- 内置技能
builtinPluginSkills        -- 内置插件技能
skillDirCommands           -- 用户 .claude/skills/ 目录中的技能
workflowCommands           -- 工作流脚本
pluginCommands             -- 外部插件命令
pluginSkills               -- 外部插件技能
COMMANDS()                 -- 核心内置命令（~100+个）
dynamicSkills              -- 运行时发现的技能
mcpSkills                  -- MCP 服务器提供的技能
```

### 1.4 命令加载流程

```
loadAllCommands(cwd)           -- 并行加载所有命令源（memoized by cwd）
    |
meetsAvailabilityRequirement() -- 过滤认证/提供者要求
    |
isCommandEnabled()             -- 过滤特性开关
    |
合并动态技能（去重，插入到内置命令之前）
```

### 1.5 命令调度逻辑

```
用户输入 "/review 123"
    |
processSlashCommand()
    |
findCommand("review", commands)  -- 按 name/aliases 查找
    |
根据命令类型分发：
    |-- PromptCommand: getPromptForCommand() -> 发送给模型
    |-- LocalCommand: load() -> call() -> 返回结果
    |-- LocalJSXCommand: load() -> call() -> 渲染 UI
```

### 1.6 远程模式安全过滤

- `REMOTE_SAFE_COMMANDS` — 仅允许影响本地 TUI 状态的命令
- `BRIDGE_SAFE_COMMANDS` — 移动端/远程桥接可用的命令
- `isBridgeSafeCommand()` — 按类型和白名单过滤

---

## 二、权限管理系统

### 2.1 权限模式

| 模式 | 行为 |
|------|------|
| `default` | 默认模式，敏感操作需用户确认 |
| `acceptEdits` | 自动接受文件编辑，其他操作需确认 |
| `bypassPermissions` | 跳过所有权限检查（需显式启用） |
| `dontAsk` | 不询问用户，直接拒绝需要确认的操作 |
| `plan` | 计划模式，限制写操作 |
| `auto` | AI 分类器自动决策 |
| `bubble` | 内部模式，权限向上冒泡到父代理 |

### 2.2 权限规则体系

**规则来源**：
- `userSettings` — 用户全局配置 (~/.claude/settings.json)
- `projectSettings` — 项目配置 (.claude/settings.json)
- `localSettings` — 本地配置 (.claude/settings.local.json)
- `flagSettings` — CLI 标志
- `policySettings` — 组织策略
- `cliArg` — 命令行参数
- `command` — 命令级规则
- `session` — 会话级规则

**规则行为**：
- `allow` — 始终允许
- `deny` — 始终拒绝
- `ask` — 需要用户确认

**规则值格式**：
```typescript
{
  toolName: string       // 如 "Bash", "FileEdit", "WebFetch"
  ruleContent?: string   // 如 "git *", "domain:github.com"
}
```

### 2.3 权限决策流程

```
1. 工具自身 checkPermissions() -- 工具特定逻辑
   |
2. 规则匹配检查
   |-- 2a. 拒绝规则精确匹配 -> deny
   |-- 2b. 允许规则精确匹配 -> allow
   |
3. 权限模式检查
   |-- bypassPermissions -> allow
   |-- dontAsk -> deny
   |-- plan -> 根据 isReadOnly 判断
   |-- acceptEdits -> 对文件编辑 allow
   |
4. 安全检查
   |-- 工作目录检查
   |-- 路径约束检查
   |
5. 分类器检查 (auto 模式)
   |-- AI 分类器判断 -> allow/deny
   |
6. 默认行为 -> ask (请求用户确认)
```

### 2.4 Bash 工具特殊权限

- **子命令级权限检查**：复合命令拆分为子命令独立检查
- **命令语义分析**：AST 解析识别命令类型
- **安全分类器**：可选的 AI 分类器对命令进行安全评估
- **通配符规则匹配**：支持 `Bash(git *)` 等模式
- **沙箱执行**：可选的沙箱隔离

### 2.5 权限上下文

```typescript
type ToolPermissionContext = {
  mode: PermissionMode
  additionalWorkingDirectories: Map<string, AdditionalWorkingDirectory>
  alwaysAllowRules: ToolPermissionRulesBySource
  alwaysDenyRules: ToolPermissionRulesBySource
  alwaysAskRules: ToolPermissionRulesBySource
  isBypassPermissionsModeAvailable: boolean
  shouldAvoidPermissionPrompts?: boolean    // 后台代理自动拒绝
  awaitAutomatedChecksBeforeDialog?: boolean // 协调器模式
  prePlanMode?: PermissionMode              // 计划模式前的状态
}
```

### 2.6 UI 权限确认流程

`useCanUseTool` Hook 将权限决策与 Ink UI 集成：

```
1. 调用 hasPermissionsToUseTool() 获取决策
2. allow -> 直接执行
3. deny -> 显示拒绝消息
4. ask -> 根据上下文分发：
   |-- 交互式环境 -> 显示权限确认 UI
   |-- 协调器模式 -> 等待自动化检查
   |-- Swarm Worker -> 向上冒泡
   |-- 后台代理 -> 自动拒绝
```

---

## 三、关键设计模式

1. **分层权限** — 工具级 → 规则级 → 模式级 → 分类器级
2. **安全优先** — 默认 `isReadOnly: false`、`isConcurrencySafe: false`
3. **条件加载** — 通过 `feature()` 宏实现编译时代码消除
4. **懒加载** — 命令通过 `load()` 延迟加载实现模块
5. **Memoize 缓存** — 命令列表使用 lodash memoize 缓存
6. **远程安全过滤** — REMOTE_SAFE_COMMANDS 和 BRIDGE_SAFE_COMMANDS 白名单
