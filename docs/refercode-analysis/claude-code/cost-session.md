# Claude Code 成本追踪与会话管理分析

---

## 一、成本追踪机制

### 1.1 核心状态存储

全局成本状态存储在单例 `STATE` 对象中：

| 字段 | 用途 |
|------|------|
| `totalCostUSD` | 累计总费用（美元） |
| `totalAPIDuration` | API 调用总耗时 |
| `totalToolDuration` | 工具执行总耗时 |
| `totalLinesAdded` / `totalLinesRemoved` | 代码变更行数 |
| `modelUsage` | 按模型分组的 token 用量 |
| `hasUnknownModelCost` | 未知模型定价标记 |

**Per-turn 追踪**：`turnToolDurationMs`、`turnToolCount`、`turnHookDurationMs` 等在每轮开始时重置。

### 1.2 成本计算与累加

`addToTotalSessionCost(cost, usage, model)` 执行流程：

1. 按模型累计 token 用量
2. 更新全局 STATE
3. 通过 OpenTelemetry 发送遥测指标
4. 递归处理 Advisor 子调用

### 1.3 成本持久化与恢复

- **`saveCurrentSessionCosts()`** — 写入项目配置文件
- **`getStoredSessionCosts(sessionId)`** — 读取之前保存的数据（严格校验 sessionId）
- **`restoreCostStateForSession(sessionId)`** — 恢复会话时调用，写回内存 STATE

### 1.4 成本摘要钩子

`useCostSummary` 在进程 `exit` 事件时触发：
1. 输出费用摘要到 stdout
2. 调用 `saveCurrentSessionCosts()` 持久化

### 1.5 OpenTelemetry 集成

- `claude_code.cost.usage`（单位 USD）
- `claude_code.token.usage`（单位 tokens）
- `claude_code.session.count`
- `claude_code.lines_of_code.count`
- `claude_code.pull_request.count`
- `claude_code.commit.count`
- `claude_code.code_edit_tool.decision`
- `claude_code.active_time.total`

---

## 二、会话生命周期管理

### 2.1 会话 ID 管理

- **生成**：`randomUUID()` 生成初始 `sessionId`
- **切换**：`switchSession(sessionId, projectDir)` 原子性更新
- **重新生成**：`regenerateSessionId({ setCurrentAsParent })` 创建新 UUID
- **信号机制**：`onSessionSwitch` 允许其他模块订阅会话切换事件

### 2.2 会话持久化标志

- `sessionPersistenceDisabled` — 控制是否禁用持久化
- `sessionProjectDir` — 会话 transcript 文件所在目录
- `sessionSource` — 标记会话来源

### 2.3 会话历史

通过 HTTP API 分页获取：
- `fetchLatestEvents()` — 获取最新一页（`anchor_to_latest: true`）
- `fetchOlderEvents()` — 通过游标向前翻页
- 每页 100 条，OAuth 认证

---

## 三、Bridge 架构（远程/本地会话）

### 3.1 核心类型

**配置**：
- `BridgeConfig` — 包含 `dir`、`machineName`、`branch`、`maxSessions`、`spawnMode` 等
- `SpawnMode` — 三种模式：
  - `'single-session'` — 单会话，结束后销毁 bridge
  - `'worktree'` — 持久 server，每会话独立 git worktree
  - `'same-dir'` — 持久 server，共享 cwd

**会话控制**：
- `SessionHandle` — 运行中会话的句柄：`sessionId`、`done`、`kill()`/`forceKill()`、`activities`
- `SessionSpawner` — 会话生成器接口
- `SessionActivity` — 活动类型：`tool_start` | `text` | `result` | `error`

### 3.2 会话创建

**`createBridgeSession()`** — POST `/v1/sessions`
- 构建请求体包含 `title`、`events`、`session_context`
- OAuth token + org UUID + beta header 认证

**`archiveBridgeSession(sessionId)`** — POST `/v1/sessions/{id}/archive`
- 归档会话，409 表示已归档（幂等安全）

### 3.3 会话运行器

`createSessionSpawner(deps)` 返回 `SessionSpawner`，`spawn()` 执行流程：

1. 生成调试文件和 transcript 文件
2. 生成子进程参数（`--print`、`--sdk-url`、`--session-id` 等）
3. 设置环境变量
4. spawn 子进程（stdio 为 `['pipe', 'pipe', 'pipe']`）
5. stdout NDJSON 解析 → 活动环形缓冲区
6. stderr 捕获 → 最近 10 行环形缓冲区
7. control_request 处理 → 权限请求转发
8. 首条用户消息检测 → 推导会话标题
9. 完成 Promise → `'completed'` | `'failed'` | `'interrupted'`

**会话控制**：
- `kill()` — 发送 SIGTERM
- `forceKill()` — 发送 SIGKILL
- `writeStdin()` — 向子进程 stdin 写入数据
- `updateAccessToken()` — 刷新 token

---

## 四、项目引导状态

管理新项目首次使用的引导流程：

- **引导步骤**：`workspace`（创建工作区）和 `claudemd`（运行 `/init`）
- `isProjectOnboardingComplete()` — 检查所有步骤是否已完成
- `shouldShowProjectOnboarding()` — 使用 memoize 缓存
- `maybeMarkProjectOnboardingComplete()` — 每次 prompt 提交时调用

---

## 五、架构总结

### 数据流

```
API 调用 → usage 数据 → addToTotalSessionCost()
                           ├── STATE 内存累加
                           ├── OTel 计数器上报
                           └── Advisor 子调用递归

进程退出 → useCostSummary hook
              ├── formatTotalCost() 输出到 stdout
              └── saveCurrentSessionCosts() → 磁盘持久化

会话恢复 → restoreCostStateForSession(sessionId)
              ├── getStoredSessionCosts() 读取 projectConfig
              └── setCostStateForRestore() 写回 STATE
```

### Bridge 会话生命周期

```
createBridgeSession() → POST /v1/sessions → session ID
       ↓
createSessionSpawner().spawn() → child process (CLI)
       ├── stdout NDJSON → activity 环形缓冲区
       ├── control_request → 权限请求转发
       └── done Promise → completed/failed/interrupted
       ↓
archiveBridgeSession() → POST /v1/sessions/{id}/archive
```

### 关键设计特点

1. **成本状态双层** — 内存 STATE 实时计算，projectConfig 跨会话恢复
2. **会话 ID 关联键** — 恢复时严格校验 sessionId 匹配
3. **Bridge 解耦** — spawn 子进程 + NDJSON 流协议 + stdin 控制通道
4. **OTel 集成** — 生产级可观测性
5. **环形缓冲区** — activities 和 stderr 限制内存占用
