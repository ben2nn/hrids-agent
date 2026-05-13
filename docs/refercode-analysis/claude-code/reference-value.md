# Claude Code 参考价值评估

---

## 一、高参考价值（可直接借鉴）

### 1.1 AsyncGenerator 消息管道

**价值**：极高

**适用场景**：任何需要流式处理的 LLM 应用

**核心思想**：
- 整个消息管道基于 AsyncGenerator 实现
- 支持背压和流式处理
- 通过 `yield` 逐步推送消息

**借鉴要点**：
```typescript
async function* queryLoop(messages: Message[]): AsyncGenerator<LoopEvent> {
  while (true) {
    const response = await callModel(messages)
    yield { type: 'assistant_delta', content: response.delta }

    if (response.toolCalls.length > 0) {
      const results = await executeTools(response.toolCalls)
      yield { type: 'tool_results', results }
      messages.push(...results)
    } else {
      break
    }
  }
}
```

### 1.2 四层上下文压缩管线

**价值**：极高

**适用场景**：长会话上下文管理

**压缩层级**：
1. **Snip** — 移除历史中的冗余片段
2. **Microcompact** — 工具结果大小限制和缓存编辑
3. **Context Collapse** — 上下文折叠投影（读时投影，不改变原始数组）
4. **Autocompact** — 自动压缩，当 token 数超过阈值时触发

**借鉴要点**：
```typescript
class ContextCompactor {
  async compact(messages: Message[]): Promise<Message[]> {
    let result = messages
    result = this.snip(result)
    result = this.microcompact(result)
    result = this.contextCollapse(result)
    result = await this.autocompact(result)
    return result
  }
}
```

### 1.3 分层权限系统

**价值**：高

**适用场景**：工具调用权限管理

**层级结构**：
```
工具级 checkPermissions()
    ↓
规则级 allow/deny/ask 规则匹配
    ↓
模式级 default/acceptEdits/bypassPermissions/plan
    ↓
分类器级 AI 自动决策
```

**借鉴要点**：
```typescript
type PermissionDecision = 'allow' | 'deny' | 'ask'

function hasPermissionsToUseTool(
  tool: Tool,
  input: unknown,
  context: PermissionContext
): PermissionDecision {
  // 1. 工具特定检查
  const toolDecision = tool.checkPermissions(input, context)
  if (toolDecision) return toolDecision

  // 2. 规则匹配
  const ruleDecision = checkRules(tool, input, context.rules)
  if (ruleDecision) return ruleDecision

  // 3. 模式检查
  const modeDecision = checkMode(context.mode, tool, input)
  if (modeDecision) return modeDecision

  // 4. 默认行为
  return 'ask'
}
```

### 1.4 错误扣留机制

**价值**：高

**适用场景**：可恢复错误的优雅处理

**核心思想**：
- 可恢复错误（prompt-too-long、max-output-tokens、媒体大小）先扣留不 yield
- 恢复成功后丢弃扣留的错误
- 恢复失败时才表面化给用户

**借鉴要点**：
```typescript
class ErrorWithholder {
  private withheld: Error[] = []

  withhold(error: Error): void {
    this.withheld.push(error)
  }

  async tryRecover(): Promise<boolean> {
    try {
      await this.recover()
      this.withheld = []  // 恢复成功，丢弃错误
      return true
    } catch {
      this.surface()  // 恢复失败，表面化错误
      return false
    }
  }
}
```

### 1.5 依赖注入 (QueryDeps)

**价值**：中高

**适用场景**：测试友好的架构设计

**核心思想**：
- 查询循环的 I/O 依赖通过 `QueryDeps` 接口注入
- 测试可直接注入 mock 依赖，无需 spy 模块

**借鉴要点**：
```typescript
interface QueryDeps {
  callModel: typeof queryModelWithStreaming
  microcompact: typeof microcompactMessages
  autocompact: typeof autoCompactIfNeeded
  uuid: typeof randomUUID
}

// 生产环境
const prodDeps: QueryDeps = {
  callModel: queryModelWithStreaming,
  microcompact: microcompactMessages,
  autocompact: autoCompactIfNeeded,
  uuid: randomUUID,
}

// 测试环境
const testDeps: QueryDeps = {
  callModel: mockCallModel,
  microcompact: mockMicrocompact,
  autocompact: mockAutocompact,
  uuid: () => 'test-uuid',
}
```

### 1.6 Feature Gate + Dead Code Elimination

**价值**：中高

**适用场景**：条件编译和代码消除

**核心思想**：
- 通过 `feature()` 宏实现编译时代码消除
- 配合 bundler 的 tree-shaking 移除死代码

---

## 二、中等参考价值（理念可借鉴）

### 2.1 工具工厂模式

**价值**：中

**说明**：`buildTool()` 统一构建所有工具，提供安全默认值（默认不安全，显式声明才信任）。

### 2.2 命令懒加载

**价值**：中

**说明**：命令通过 `load()` 延迟加载实现模块，减少启动开销。

### 2.3 Memoize 缓存

**价值**：中

**说明**：上下文和 git 状态使用 lodash memoize 进行会话级缓存。

### 2.4 环形缓冲区

**价值**：中

**说明**：activities 和 stderr 使用环形缓冲区限制内存占用。

### 2.5 事务性转录

**价值**：中

**说明**：关键消息立即写入转录日志，确保进程崩溃后可恢复。

---

## 三、低参考价值（差异较大）

| 模块 | 说明 |
|------|------|
| Bridge 远程架构 | 特定于 Claude Code 的远程控制场景 |
| Ink TUI | 特定于 React/Ink 框架 |
| OpenTelemetry 集成 | 生产级可观测性，你的项目可能不需要 |

---

## 四、与其他参考项目的对比

| 维度 | Claude Code | DeepSeek-TUI | DeepSeek-Reasonix |
|------|-------------|-------------|-------------------|
| 语言 | TypeScript | Rust | TypeScript |
| 运行时 | Bun | Tokio | Node.js |
| 上下文管理 | 四层压缩管线 | Seam Manager (L1/L2/L3) | 多级阈值折叠 |
| 工具修复 | 无 | 无 | 四步管道 |
| 成本控制 | 预算系统 | 检查点-重启周期 | Flash-First + Auto-Escalation |
| 权限系统 | 分层权限（工具/规则/模式/分类器） | 三层安全屏障 | 白名单 + 确认门控 |
| 会话管理 | JSONL + 远程 API | SQLite | JSONL |

---

## 五、借鉴优先级建议

### P0（立即引入）

1. **AsyncGenerator 消息管道** — 流式处理的优雅架构
2. **四层上下文压缩管线** — 长会话上下文管理
3. **分层权限系统** — 工具调用权限管理

### P1（近期引入）

4. **错误扣留机制** — 可恢复错误的优雅处理
5. **依赖注入 (QueryDeps)** — 测试友好的架构设计
6. **工具工厂模式** — 统一构建，安全默认值

### P2（中期引入）

7. **Feature Gate + Dead Code Elimination** — 条件编译
8. **事务性转录** — 崩溃恢复
9. **环形缓冲区** — 内存限制
