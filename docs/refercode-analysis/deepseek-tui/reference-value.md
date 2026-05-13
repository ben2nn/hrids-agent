# DeepSeek-TUI 参考价值评估

---

## 一、高参考价值（可直接借鉴）

### 1.1 延迟加载工具目录

**价值**：极高

**适用场景**：任何需要管理大量 LLM 工具的系统

**核心思想**：
- 默认只加载 ~20 个核心工具
- 其余工具标记为 `defer_loading = true`
- 模型可通过 `tool_search_tool_regex` 或 `tool_search_tool_bm25` 按需发现和激活

**借鉴要点**：
```typescript
interface ToolDef {
  name: string
  deferLoading: boolean  // 新增：是否延迟加载
  // ...
}

class ToolRegistry {
  private activeTools: Set<string>
  private deferredTools: Map<string, ToolDef>

  // BM25 搜索延迟工具
  searchDeferredTools(query: string): ToolDef[] {
    // 实现 BM25 相似度搜索
  }

  // 激活延迟工具
  activateTool(name: string): void {
    const tool = this.deferredTools.get(name)
    if (tool) {
      this.activeTools.add(name)
    }
  }
}
```

### 1.2 Prefix Cache 友好排序

**价值**：高

**适用场景**：LLM 工具列表优化

**核心思想**：
- 始终加载的工具排在前面（保持稳定字节偏移）
- 被激活的延迟工具追加到尾部
- 避免破坏 LLM 的 prefix cache

**借鉴要点**：
```typescript
class ToolRegistry {
  getActiveTools(): ToolDef[] {
    const alwaysLoaded = this.tools.filter(t => !t.deferLoading)
    const activated = this.tools.filter(t => t.deferLoading && this.isActive(t.name))
    return [...alwaysLoaded, ...activated]  // 稳定排序
  }
}
```

### 1.3 连接健康三态模型

**价值**：高

**适用场景**：任何 HTTP 客户端的鲁棒性设计

**核心思想**：
```
Healthy → Degraded → Recovering
```

- 连续 2 次失败后标记为 Degraded
- Degraded 状态下定期发送探测请求（冷却期 15 秒）
- 探测成功后回到 Healthy 状态

**借鉴要点**：
```typescript
enum ConnectionHealth {
  Healthy,
  Degraded,
  Recovering,
}

class HealthMonitor {
  private state = ConnectionHealth.Healthy
  private consecutiveFailures = 0
  private lastProbeTime = 0

  recordSuccess(): void {
    this.state = ConnectionHealth.Healthy
    this.consecutiveFailures = 0
  }

  recordFailure(): void {
    this.consecutiveFailures++
    if (this.consecutiveFailures >= 2) {
      this.state = ConnectionHealth.Degraded
    }
  }

  shouldProbe(): boolean {
    if (this.state !== ConnectionHealth.Degraded) return false
    return Date.now() - this.lastProbeTime > 15000  // 15 秒冷却
  }
}
```

### 1.4 检查点-重启周期

**价值**：中高

**适用场景**：长会话上下文管理

**核心思想**：
- 当输入 token 估计值超过阈值时
- 生成 briefing（当前周期摘要）
- 归档当前周期
- 用种子消息重启新周期

**优势**：保持前缀缓存热度，比传统压缩更高效

**借鉴要点**：
```typescript
class CycleManager {
  private cycleCount = 0
  private currentCycleStarted = Date.now()
  private cycleBriefings: string[] = []

  shouldAdvanceCycle(tokenCount: number): boolean {
    return tokenCount > this.config.cycleThreshold  // 768K tokens
  }

  async advanceCycle(session: Session): Promise<void> {
    const briefing = await this.generateBriefing(session)
    this.cycleBriefings.push(briefing)
    this.cycleCount++
    session.archiveCurrentCycle(briefing)
    session.restartWithSeed(briefing)
  }
}
```

### 1.5 Bash Arity 字典

**价值**：高

**适用场景**：命令安全策略、自动补全

**核心思想**：
- 覆盖 30+ 常用工具
- Arity 语义：`("git status", 2)` 表示 2 个位置词
- Flag（`-` 开头）不计入 arity
- 三级匹配策略：最长候选 → 逐级回退 → 基础命令

**借鉴要点**：
```typescript
interface ArityEntry {
  prefix: string[]  // ["git", "status"]
  arity: number     // 2
}

class BashArityDict {
  private entries: ArityEntry[] = [
    { prefix: ['git', 'status'], arity: 2 },
    { prefix: ['git', 'push'], arity: 2 },
    { prefix: ['npm', 'install'], arity: 2 },
    // ...
  ]

  classify(command: string[]): string | null {
    // 从最长候选（深度 3）向下搜索
    for (let depth = 3; depth >= 1; depth--) {
      const candidate = command.slice(0, depth)
      const entry = this.entries.find(e =>
        e.prefix.length === depth &&
        e.prefix.every((p, i) => p === candidate[i])
      )
      if (entry) return entry.prefix.join(' ')
    }
    return command[0] || null  // 回退到基础命令
  }
}
```

### 1.6 四级配置优先级

**价值**：高

**适用场景**：CLI 工具的配置管理

**核心思想**：
```
CLI 标志 > 配置文件 > 密钥存储 > 环境变量
```

**借鉴要点**：
```typescript
class ConfigResolver {
  resolve(key: string): string | undefined {
    return (
      this.cliOverrides[key] ||
      this.configFile[key] ||
      this.keyringStore.get(key) ||
      this.envVars[key.toUpperCase()]
    )
  }
}
```

---

## 二、中等参考价值（理念可借鉴）

### 2.1 SQLite 状态持久化

**价值**：中

**说明**：适合单用户 CLI，但你的项目可能需要更灵活的存储

**可借鉴点**：
- UPSERT 语义实现幂等写入
- 级联删除 + 软删除（归档）
- JSONL 辅助索引

### 2.2 MCP 协议实现

**价值**：中

**说明**：标准协议参考，但你可能已有自己的实现

**可借鉴点**：
- 工具命名空间隔离：`mcp__{server}__{tool}`
- 动态注册/启停服务器
- 工具过滤（allow/deny 白名单）

### 2.3 钩子系统

**价值**：中

**可借鉴点**：
- 三种 Sink 模式（stdout/jsonl/webhook）
- 单个 sink 失败不影响其他 sink
- 事件广播机制

### 2.4 子代理系统

**价值**：中

**可借鉴点**：
- 非阻塞 spawn + 异步结果收集
- 文件租约机制避免冲突
- Mailbox 消息传递

---

## 三、低参考价值（差异较大）

| 模块 | 说明 |
|------|------|
| TUI 渲染层 | 使用 ratatui，与你的项目 UI 框架可能不同 |
| SSE 流式解析 | 绑定 OpenAI 兼容 API 格式 |
| Git 快照 | 特定于文件编辑场景 |

---

## 四、关键设计模式总结

### 4.1 事件驱动架构

- 引擎通过 `Event` 通道与 UI 通信
- 实现非阻塞 UI 和实时流式更新
- 便于添加新的 UI 组件

### 4.2 工具注册表模式

- 统一的工具接口（`ToolSpec` / `ToolHandler`）
- 动态注册和查找
- 延迟加载 + 搜索发现

### 4.3 策略模式

- 沙箱策略（`SandboxPolicy`）
- 执行策略（`ExecPolicy`）
- 网络策略（`NetworkPolicy`）
- 审批策略（`ApprovalRequirement`）

### 4.4 守卫模式（RAII）

- `InteractiveTerminalGuard`：确保交互式工具后终端状态恢复
- 文件租约守卫：确保子代理完成后释放文件锁

### 4.5 观察者模式

- LSP 诊断注入
- Hook 系统（pre/post tool execution）
- 事件广播

---

## 五、借鉴优先级建议

### P0（立即引入）

1. **延迟加载工具目录** — 减少 LLM 上下文 token 消耗
2. **连接健康三态模型** — 提升 API 调用鲁棒性
3. **四级配置优先级** — 清晰的配置覆盖链

### P1（近期引入）

4. **Prefix Cache 友好排序** — LLM 缓存优化
5. **Bash Arity 字典** — 命令安全策略
6. **检查点-重启周期** — 长会话上下文管理

### P2（中期引入）

7. **子代理文件租约** — 避免并发冲突
8. **钩子系统** — 事件广播机制
9. **密钥多后端抽象** — 跨平台密钥管理
