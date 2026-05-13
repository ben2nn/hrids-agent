# Claude Code 核心架构分析

---

## 一、查询引擎架构 (QueryEngine)

### 1.1 整体设计

QueryEngine 是整个系统的核心类，采用 **"每个对话一个引擎实例"** 的设计模式。

**关键设计原则**：
- 一个 QueryEngine 对应一个会话
- 每次 `submitMessage()` 调用开启同一个会话中的新一轮 (turn)
- 状态跨轮次持久化：消息列表、文件缓存、token 用量等
- AsyncGenerator 模式：所有消息通过 `yield` 逐步推送

### 1.2 核心配置 (QueryEngineConfig)

| 参数 | 用途 |
|------|------|
| `tools` | 可用工具集 |
| `commands` | 斜杠命令列表 |
| `mcpClients` | MCP 服务器连接 |
| `agents` | Agent 定义 |
| `canUseTool` | 权限校验函数 |
| `thinkingConfig` | 思考模式配置 |
| `maxTurns` | 最大轮次限制 |
| `maxBudgetUsd` | 最大预算限制 |
| `taskBudget` | 任务级 token 预算 |

### 1.3 submitMessage 流程

```
1. 初始化阶段 → 清除技能发现缓存，设置工作目录
2. 系统提示构建 → fetchSystemPromptParts() 组装
3. 用户输入处理 → processUserInput() 处理斜杠命令
4. 会话持久化 → 写入转录日志
5. 查询循环 → query() 执行 API 调用和工具执行
6. 消息分发 → 按类型分别处理和转发
7. 终止条件检查 → USD 预算、最大轮次、重试限制
8. 结果提取 → 生成 SDK result 消息
```

### 1.4 权限追踪

引擎包装了 `canUseTool` 函数，当工具被拒绝时自动记录到 `permissionDenials` 数组，最终在 SDK result 消息中返回给调用方。

### 1.5 消息压缩

- **Snip 压缩**：移除历史中的冗余片段
- **Compact 边界处理**：释放压缩边界之前的消息以供 GC 回收
- **进度和附件内联记录**：立即写入转录日志，防止 dedup 循环出错

---

## 二、查询循环 (query.ts)

### 2.1 核心架构

`query()` 函数是系统的心脏，实现了完整的 **模型调用 → 工具执行 → 结果反馈** 循环。

### 2.2 状态管理

```typescript
type State = {
  messages: Message[]
  toolUseContext: ToolUseContext
  autoCompactTracking: AutoCompactTrackingState | undefined
  maxOutputTokensRecoveryCount: number
  hasAttemptedReactiveCompact: boolean
  maxOutputTokensOverride: number | undefined
  pendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined
  stopHookActive: boolean | undefined
  turnCount: number
  transition: Continue | undefined
}
```

每次迭代在循环顶部解构 state，继续站点通过 `state = next` 整体替换。

### 2.3 主流程 (while true)

```
1. 内存预取启动 → startRelevantMemoryPrefetch()
2. 技能发现预取 → startSkillDiscoveryPrefetch()
3. 上下文压缩管线：
   ├── Snip 压缩
   ├── Microcompact
   ├── Context Collapse
   └── Autocompact
4. Token 阻塞检查
5. 模型调用 → deps.callModel()
6. 流式消息处理 → yield 消息，处理回退和错误扣留
7. 停止钩子处理 → post-sampling hooks 和 stop hooks
8. Token 预算检查
9. 工具执行 → StreamingToolExecutor 或 runTools
10. 附件注入 → 排队命令、文件变更通知、记忆预取结果
11. 轮次限制检查
```

### 2.4 错误恢复机制

| 错误类型 | 恢复策略 |
|---------|---------|
| 模型回退 | FallbackTriggeredError → 切换 fallback 模型 |
| Prompt-too-long | 先 Context Collapse 排空，再 Reactive Compact |
| Max output tokens | 先升级到 64k，再注入恢复消息多轮续写（最多 3 次） |
| 流式回退 | 生成 tombstone 并清理状态 |
| 媒体大小错误 | Reactive Compact 的 strip-retry 机制 |

### 2.5 依赖注入 (QueryDeps)

```typescript
interface QueryDeps {
  callModel: typeof queryModelWithStreaming
  microcompact: typeof microcompactMessages
  autocompact: typeof autoCompactIfNeeded
  uuid: typeof randomUUID
}
```

测试可直接注入 mock 依赖，无需 spy 模块。

### 2.6 Token 预算系统

- 当 token 使用量低于预算的 90% 时，注入 nudge 消息促使模型继续
- 检测收益递减：连续 3 次以上增量低于 500 tokens 时自动停止
- 追踪 continuationCount、lastDeltaTokens 等指标

---

## 三、上下文管理策略

### 3.1 双层上下文模型

**系统上下文 (getSystemContext)**：
- Git 状态快照（分支、主分支、最近 5 次提交、用户名、文件状态）
- 超过 2000 字符时自动截断
- 使用 lodash memoize 进行会话级缓存

**用户上下文 (getUserContext)**：
- CLAUDE.md 文件内容
- 当前日期信息
- 支持 `CLAUDE_CODE_DISABLE_CLAUDE_MDS` 环境变量禁用

### 3.2 缓存失效机制

`setSystemPromptInjection()` 在注入值变更时同时清除 `getUserContext` 和 `getSystemContext` 的缓存。

### 3.3 Git 状态获取

`getGitStatus()` 使用 memoize 缓存，并行执行 5 个 git 命令。

---

## 四、会话历史处理

### 4.1 本地历史

- 存储在 `~/.claude/history.jsonl`，JSONL 格式追加写入
- 最大保留 100 条
- 使用文件锁保护并发写入
- 粘贴内容分层存储：小内容内联，大内容哈希引用

### 4.2 远程会话历史

通过 REST API 分页获取：
- `fetchLatestEvents()` — 获取最新一页
- `fetchOlderEvents()` — 通过游标向前翻页
- 每页 100 条，OAuth 认证

---

## 五、系统初始化 (setup.ts)

### 5.1 初始化流程

```
1. Node.js 版本检查（>= 18）
2. 会话 ID 设置
3. UDS 消息服务器启动
4. 队友模式快照
5. 终端备份恢复
6. 工作目录设置
7. Hooks 配置快照
8. FileChanged 监视器
9. Worktree 处理
```

### 5.2 安全检查

- `bypassPermissions` 模式禁止 root/sudo 运行（除非在沙箱中）
- Ant 用户要求在无网络访问的 Docker/沙箱容器中运行

---

## 六、关键设计模式

1. **AsyncGenerator 驱动** — 支持背压和流式处理
2. **函数式状态更新** — `setAppState(f: prev => next)` 避免并发问题
3. **Feature Gate + Dead Code Elimination** — 编译时代码消除
4. **依赖注入** — QueryDeps 使测试可注入 mock
5. **多层压缩管线** — Snip → Microcompact → Context Collapse → Autocompact
6. **错误扣留** — 可恢复错误先扣留，恢复成功后丢弃
7. **事务性转录** — 关键消息立即写入转录日志，确保崩溃后可恢复

---

## 七、性能优化策略

- **并行预取** — 内存预取、技能发现在模型流式输出期间并行执行
- **流式工具执行** — StreamingToolExecutor 在模型输出时就开始执行工具
- **延迟加载** — 大量模块通过 `require()` 和 `import()` 延迟加载
- **Memoize 缓存** — 上下文和 git 状态使用 memoize 进行会话级缓存
- **Fire-and-forget** — 非关键路径的磁盘写入使用 fire-and-forget 模式
