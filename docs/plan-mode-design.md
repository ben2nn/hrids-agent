# Plan 模式设计方案

> 分析日期：2026-04-16  
> 涉及模块：`src/core/PermissionManager.ts`、`src/core/QueryEngine.ts`、`src/gateway/SessionManager.ts`、`web/src/components/chat/InputBar.tsx`、`web/src/store/sessionStore.ts`、`web/src/lib/types.ts`

---

## 一、现状分析

### 已实现的部分

| 位置 | 内容 |
|------|------|
| `PermissionManager.ts` | `plan` 模式下写操作直接返回 `false`（拒绝） |
| `SessionManager.ts` | 处理 `set_permission_mode` 消息，支持运行时切换模式 |
| `InputBar.tsx` | `CraftDropdown` 组件支持 ask / plan / auto 三种模式切换 |
| `types.ts` | `permission_mode_changed` 服务端消息类型已定义 |
| `sessionStore.ts` | `setPermissionMode()` 方法通过 WS 发送模式切换指令并乐观更新本地状态 |

### 存在的问题

**问题 1：系统提示词没有感知 plan 模式**

LLM 不知道自己处于 plan 模式，会照常尝试调用写工具，然后被拒绝，体验很差。应该在 plan 模式下注入专门的系统提示，告诉 LLM "只做分析和规划，不要执行写操作"。

**问题 2：写操作被拒绝后没有有意义的反馈**

`permission_denied` 事件转换为 `tool_end denied`，LLM 收到的是"用户拒绝了此操作"，它不知道这是 plan 模式导致的，可能会反复尝试写操作。

**问题 3：没有"从 plan 切换到 act"的流程**

用户看完计划后，如何一键切换到 auto/ask 模式并执行？目前只能手动切换模式再重新发消息，流程割裂。

**问题 4：UI 没有 plan 模式的视觉提示**

用户不清楚当前处于 plan 模式，也不知道写操作会被拦截，缺乏明确的状态反馈。

**问题 5：`continuation_needed` 事件没有被前端处理**

plan 模式下 LLM 说"接下来我会..."，会触发 `continuation_needed` 事件，但 `toClientMessage()` 对此返回 `null`，前端完全不知道 LLM 有继续执行的意图。

---

## 二、设计方案

### 方案一：最小可行方案（推荐优先实施）

**目标**：让 plan 模式真正可用，LLM 能正确规划而不是反复被拒绝。

#### 改动 1 — 注入 plan 模式系统提示

**文件**：`src/gateway/SessionManager.ts`

在 `runMessage()` 中检测当前权限模式，如果是 plan 模式，在系统提示末尾动态追加以下内容：

```
## 当前模式：Plan（规划模式）
你现在处于规划模式。在此模式下，所有写操作（文件写入、命令执行等）均被禁止。
你的任务是：
1. 使用只读工具（file_read、glob、grep 等）充分了解现状
2. 制定详细的执行计划，列出每一步要做什么、修改哪些文件、执行什么命令
3. 不要尝试调用任何写操作工具
用户确认计划后，会切换到执行模式。
```

实现方式：在 `runMessage()` 开始时，检查 `session.permissions.getMode() === 'plan'`，若是则调用 `session.engine.setSystemPrompt(basePropmt + planModeAppendix)`。

#### 改动 2 — 写操作被拒绝时给 LLM 更好的反馈

**文件**：`src/core/QueryEngine.ts`

当前写法：
```typescript
toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: '用户拒绝了此操作', is_error: true })
```

改为根据当前权限模式返回不同内容：
```typescript
const denyReason = this.config.permissions.getMode() === 'plan'
  ? '[Plan 模式] 此操作在规划模式下被禁止。请继续完成规划，不要尝试执行写操作。'
  : '用户拒绝了此操作'
toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: denyReason, is_error: true })
```

#### 改动 3 — 转发 `continuation_needed` 事件给前端

**文件**：`src/gateway/SessionManager.ts`

在 `toClientMessage()` 函数中，`continuation_needed` 目前返回 `null`，改为：

```typescript
case 'continuation_needed':
  return { type: 'continuation_needed' }
```

同时在 `types.ts` 的 `ServerMessage` 联合类型中补充：
```typescript
| { type: 'continuation_needed' }
```

#### 改动 4 — 前端处理 `continuation_needed`

**文件**：`web/src/store/messageStore.ts`

在 `MessageState` 中增加 `pendingContinuation: Set<string>`（按 sessionId），在 `handleServerMessage` 中处理：

```typescript
case 'continuation_needed':
  // 标记该会话有待确认的继续执行意图
  set(state => ({
    pendingContinuation: new Set([...state.pendingContinuation, sessionId])
  }))
  break
```

#### 改动 5 — plan 模式 UI 视觉提示 + 继续执行按钮

**文件**：`web/src/components/chat/InputBar.tsx`

- 当 `permissionMode === 'plan'` 时，在输入框上方显示蓝色提示条：
  ```
  📋 规划模式 — 写操作已禁用，Agent 将只分析和规划
  ```
- 当 `pendingContinuation` 包含当前 sessionId 时，显示"继续执行"按钮，点击后：
  1. 调用 `setPermissionMode(sessionId, 'ask')` 切换到 ask 模式
  2. 发送消息"请按照上述计划执行"

---

### 方案二：完整 Plan → Act 工作流（进阶）

在方案一基础上，增加以下能力：

#### "批准并执行"流程

- LLM 完成规划后，UI 在消息列表底部显示操作栏：
  - ✅ **批准计划并执行**（切换到 ask 模式 + 发送"请按照上述计划执行"）
  - ✏️ **修改计划**（保持 plan 模式，发送补充指令）
  - ❌ **放弃**（清空 pendingContinuation）
- 执行过程中每个写操作仍需用户确认（ask 模式），保持安全性

#### 计划结构化展示（可选）

- 检测 LLM 输出中的 markdown 有序列表/步骤，以更清晰的卡片形式展示
- 每个步骤标注"只读 🔍"或"写操作 ✏️"标签，帮助用户快速判断风险

---

## 三、实施优先级

| 优先级 | 改动描述 | 涉及文件 | 复杂度 |
|--------|----------|----------|--------|
| P0 | plan 模式系统提示注入 | `SessionManager.ts` | 低 |
| P0 | 写操作拒绝时的友好反馈 | `QueryEngine.ts` | 低 |
| P1 | `continuation_needed` 事件转发 | `SessionManager.ts`、`types.ts` | 低 |
| P1 | `continuation_needed` 前端状态处理 | `messageStore.ts` | 中 |
| P1 | plan 模式 UI 提示条 | `InputBar.tsx` | 低 |
| P2 | "批准并执行"按钮 | `InputBar.tsx`、`sessionStore.ts` | 中 |
| P3 | 计划步骤结构化展示 | `MessageItem.tsx`（新增解析逻辑） | 高 |

---

## 四、数据流梳理

### plan 模式下的完整消息流

```
用户切换到 plan 模式
  ↓
[InputBar] CraftDropdown 选择 plan
  ↓
[sessionStore] setPermissionMode(sessionId, 'plan')
  → WS 发送 { type: 'set_permission_mode', mode: 'plan' }
  ↓
[SessionManager] handleClientMessage → session.permissions.setMode('plan')
  → 广播 { type: 'permission_mode_changed', mode: 'plan' }
  ↓
[sessionStore] 乐观更新 session.permissionMode = 'plan'

用户发送消息
  ↓
[SessionManager] runMessage()
  → 检测 plan 模式 → setSystemPrompt(base + planModeAppendix)  ← 【改动 1】
  ↓
[QueryEngine] send()
  → LLM 调用只读工具（允许）
  → LLM 尝试调用写工具 → PermissionManager.check() → false
  → tool_result: '[Plan 模式] 此操作在规划模式下被禁止...'  ← 【改动 2】
  → LLM 理解后继续规划，输出计划文本
  → 检测到 continuation 意图 → yield { type: 'continuation_needed' }
  ↓
[SessionManager] toClientMessage()
  → { type: 'continuation_needed' }  ← 【改动 3】
  ↓
[messageStore] handleServerMessage()
  → pendingContinuation.add(sessionId)  ← 【改动 4】
  ↓
[InputBar] 显示"继续执行"按钮  ← 【改动 5】

用户点击"继续执行"
  ↓
[InputBar] setPermissionMode('ask') + sendMessage('请按照上述计划执行')
  ↓
[QueryEngine] 正常执行，ask 模式下每个写操作询问用户
```

---

## 五、关键文件索引

| 文件 | 作用 |
|------|------|
| `src/core/PermissionManager.ts` | 权限模式定义与检查逻辑，plan 模式在此拒绝写操作 |
| `src/core/QueryEngine.ts` | 工具调用执行循环，权限拒绝反馈在此生成 |
| `src/gateway/SessionManager.ts` | 会话生命周期管理，系统提示注入和事件转发在此处理 |
| `src/gateway/server.ts` | HTTP + WebSocket 服务器，`set_permission_mode` 消息路由 |
| `web/src/lib/types.ts` | 前后端消息类型定义 |
| `web/src/store/sessionStore.ts` | 会话状态管理，`setPermissionMode()` 在此实现 |
| `web/src/store/messageStore.ts` | 消息状态管理，`continuation_needed` 处理在此添加 |
| `web/src/components/chat/InputBar.tsx` | 输入栏 UI，plan 模式提示条和继续执行按钮在此添加 |
