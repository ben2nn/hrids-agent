# 设计文档：cli-display-format

## 概述

本功能对 `src/ui/App.tsx` 的显示层进行重构，建立统一的 CLI 对话显示格式规范。核心目标是：

1. **工具执行合并**：将 `tool_start` / `tool_log` / `tool_end` 三个事件合并为单一 ToolBlock，通过 `id` 定位并原地更新，而非追加三条独立消息
2. **cost 移出对话流**：`usage` 事件不再写入 `msgs` 历史，改为更新独立的 `costInfo` state，渲染在 StatusBar 中
3. **assistant 前缀**：持久化消息和流式缓冲均添加 `✦ ` 前缀
4. **颜色语义化**：定时任务触发（黄色）与权限拒绝（黄色）与普通 system 消息（灰色）形成区分
5. **StatusBar 完整化**：底部状态栏显示 provider + model + cost + 快捷键提示

重构范围仅限 `src/ui/App.tsx`，不涉及 `QueryEngine.ts` 或任何工具层代码。

---

## 架构

### 当前架构问题

```
StreamEvent → App.tsx → push() → msgs[]
                                   ↓
                              每条事件 = 一条消息（tool_start / tool_log / tool_end 各一条）
```

`usage` 事件也写入 `msgs[]`，导致 cost 消息频繁打断对话节奏。

### 目标架构

```
StreamEvent → App.tsx → 事件路由
                          ├─ text_delta      → streamBuf（实时）→ msgs（done 后持久化）
                          ├─ tool_start      → msgs 追加 ToolBlock（含 id）
                          ├─ tool_log        → toolProgress（临时）+ currentToolLogsRef
                          ├─ tool_end        → updateMsg(id) 原地更新 ToolBlock
                          ├─ usage           → costInfo state（不写 msgs）
                          ├─ permission_denied → msgs 追加（黄色 system）
                          ├─ compact_*       → msgs 追加（灰色 system）
                          ├─ cron 触发       → msgs 追加（黄色 system）
                          └─ error/budget    → msgs 追加（红色 error）
```

### 关键设计决策

**决策 1：updateMsg 替代 push**

当前 `push()` 只能追加新消息。为实现 ToolBlock 合并（`tool_end` 时更新同一条消息），需要引入 `updateMsg(id, updater)` 函数，通过消息的 `id` 字段定位并原地更新。

**决策 2：DisplayMsg 扩展 id 字段**

`ToolBlock` 需要在 `tool_start` 时创建、`tool_end` 时更新，因此 `DisplayMsg` 需要可选的 `id` 字段用于定位。非工具消息不需要 id，保持向后兼容。

**决策 3：costInfo 独立 state**

`usage` 事件携带的 token 用量和费用信息从 `msgs[]` 中剥离，存入独立的 `costInfo` state，仅在 StatusBar 中渲染。这样对话历史不再被 cost 消息打断。

**决策 4：颜色扩展**

引入 `'yellow-system'` 逻辑角色（或直接在渲染时判断），用于区分：
- 普通 system 消息：灰色（`gray`）
- 定时任务触发 / 权限拒绝：黄色（`yellow`）

实现上通过扩展 `MsgRole` 或在 `DisplayMsg` 中增加可选 `color` 字段来覆盖默认颜色。

---

## 组件与接口

### DisplayMsg（扩展后）

```typescript
type MsgRole = 'user' | 'assistant' | 'tool' | 'system' | 'error'
// 注意：移除 'cost'，cost 信息改由 costInfo state 承载

interface DisplayMsg {
  id?: string        // 工具消息专用，用于 updateMsg 定位
  role: MsgRole
  text: string
  color?: string     // 可选颜色覆盖（用于黄色 system 消息）
}
```

### CostInfo state

```typescript
interface CostInfo {
  inputTokens: number
  outputTokens: number
  costUsd: number
}

const [costInfo, setCostInfo] = useState<CostInfo | null>(null)
```

### updateMsg 函数

```typescript
const updateMsg = useCallback((id: string, updater: (prev: DisplayMsg) => DisplayMsg) => {
  setMsgs(prev => prev.map(m => m.id === id ? updater(m) : m))
}, [])
```

### StatusBar 组件（内联）

StatusBar 渲染在 `App` 底部，显示：
- `{displayProvider}  {modelRef.current}` — provider 和 model 名称
- `输入 {inputTokens} / 输出 {outputTokens} tokens  累计 ¥{costUsd}` — 仅当 costInfo 非 null 时显示
- `Ctrl+C 中断` 或 `Ctrl+C 退出` — 根据 loading 状态切换

全部以 `dimColor` 渲染。

---

## 数据模型

### ToolBlock 生命周期

```
tool_start 事件
  → push({ id: ev.id, role: 'tool', text: `⚙ ${ev.name}  ${ev.description}` })
  → currentToolLogsRef.current = []

tool_log 事件（多次）
  → bufferToolLog(line)  // 写入 toolLogBufRef，定时 flush 到 toolProgress

tool_end 事件（成功）
  → flushToolLog()
  → setToolProgress('')
  → updateMsg(ev.id, prev => ({
      ...prev,
      text: prev.text
        + (logs.length > 0 ? '\n' + kept.join('\n') : '')
        + `\n✓ ${ev.name}${preview ? '\n' + preview : ''}`
    }))

tool_end 事件（失败）
  → updateMsg(ev.id, prev => ({
      ...prev,
      text: prev.text + `\n✗ ${ev.name}: ${ev.result.message}`,
      color: 'red'   // 错误时整块变红（或仅末行变红，见渲染策略）
    }))
```

### msgs 数组中的消息类型映射

| StreamEvent | 写入 msgs | 角色 | 颜色 | 前缀 |
|---|---|---|---|---|
| text_delta | 否（写 streamBuf） | — | — | — |
| done（有 assistantText） | 是 | `assistant` | white | `✦ ` |
| tool_start | 是（新建 ToolBlock） | `tool` | cyan | 无（内嵌） |
| tool_log | 否（写 toolProgress） | — | — | — |
| tool_end | 否（updateMsg 更新） | — | — | — |
| usage | 否（写 costInfo） | — | — | — |
| permission_denied | 是 | `system` | yellow | `⚠ ` |
| compact_start | 是 | `system` | gray | `• ` |
| compact_done | 是 | `system` | gray | `• ` |
| budget_exceeded | 是 | `error` | red | `✗ ` |
| error | 是 | `error` | red | `✗ ` |
| cron 触发（displayAs） | 是 | `system` | yellow | `⏰ ` |

### ROLE_COLOR 映射（更新后）

```typescript
const ROLE_COLOR: Record<MsgRole, string> = {
  user:      'green',
  assistant: 'white',
  tool:      'cyan',
  system:    'gray',
  error:     'red',
  // 'cost' 已移除
}
```

黄色 system 消息通过 `DisplayMsg.color` 字段覆盖默认灰色：

```typescript
// permission_denied
push({ role: 'system', text: `⚠ 已拒绝: ${ev.description}`, color: 'yellow' })

// cron 触发
push({ role: 'system', text: `⏰ 定时任务触发: ${desc}`, color: 'yellow' })
```

### 渲染逻辑（消息列表）

```tsx
{msgs.map((m, i) => (
  <Box key={m.id ?? i} marginBottom={0}>
    <Text color={m.color ?? ROLE_COLOR[m.role]}>
      {ROLE_PREFIX[m.role]}{m.text}
    </Text>
  </Box>
))}
```

### ROLE_PREFIX 映射（更新后）

```typescript
const ROLE_PREFIX: Record<MsgRole, string> = {
  user:      '你 › ',
  assistant: '✦ ',    // 新增前缀
  tool:      '',       // 前缀内嵌在 text 中（⚙ / ✓ / ✗）
  system:    '• ',
  error:     '✗ ',
}
```

### StreamBuf 渲染（流式输出）

```tsx
{loading && streamBuf && (
  <Box marginBottom={1}>
    <Text color="white">✦ {streamBuf}</Text>
  </Box>
)}
```

### StatusBar 渲染

```tsx
<Box marginTop={0}>
  <Text dimColor>
    {displayProvider}  {modelRef.current}
    {costInfo && `  输入 ${costInfo.inputTokens} / 输出 ${costInfo.outputTokens} tokens  累计 $${costInfo.costUsd.toFixed(4)}`}
    {loading ? '  Ctrl+C 中断' : '  Ctrl+C 退出'}
  </Text>
</Box>
```

---

## 正确性属性

*属性（Property）是在系统所有有效执行中都应成立的特征或行为——本质上是对系统应该做什么的形式化陈述。属性是人类可读规范与机器可验证正确性保证之间的桥梁。*

### 属性 1：ToolBlock 合并唯一性

*对于任意一次工具调用*（任意工具名称、任意日志行数、任意结果类型），其 `tool_start` → `tool_log × N` → `tool_end` 事件序列处理完毕后，`msgs` 数组中与该工具调用 `id` 对应的条目有且仅有一条，且该条目文本包含工具名称、日志内容（若有）以及结果状态行（`✓` 或 `✗`）。

**验证：需求 1.1、1.3、1.4、1.5、1.6、2.3**

### 属性 2：tool_log 不重复渲染

*对于任意一条 `tool_log` 行*，在 `tool_end` 事件触发后，该行内容在 `toolProgress`（临时区域）和 `msgs`（历史区域）中不同时存在——`toolProgress` 已清空，日志已迁移到 ToolBlock。

**验证：需求 2.1、2.2、2.3**

### 属性 3：stderr 行被过滤

*对于任意以 `[stderr]` 开头的 `tool_log` 行*，处理后该行内容既不出现在 `toolProgress` 中，也不出现在 `msgs` 的任何 ToolBlock 中。

**验证：需求 2.4**

### 属性 4：tool_log 截断保留最后 N 行

*对于任意超过 30 行的工具日志序列*，`tool_end` 后 ToolBlock 中保留的日志行数不超过 30，且 ToolBlock 文本包含 `…（省略前 K 行）` 提示，其中 K 为被省略的行数。

**验证：需求 3.1、3.2**

### 属性 5：tool_end output 截断

*对于任意长度超过 500 字符的 `tool_end` output*，ToolBlock 中显示的 output 内容不超过 500 字符，且追加了 `…（共 N 字符）` 提示，其中 N 为原始总字符数。

**验证：需求 3.3、3.4**

### 属性 6：assistant 消息前缀一致性

*对于任意 assistant 消息文本*（持久化消息或流式缓冲），其在界面上的渲染结果均以 `✦ ` 开头，且 `✦ ` 前缀与 user（`你 › `）、system（`• `）、error（`✗ `）前缀互不相同。

**验证：需求 4.1、4.3、4.4**

### 属性 7：usage 事件不写入 msgs，costInfo 反映最新值

*对于任意序列的 `usage` 事件*，处理完毕后 `msgs` 数组的长度不因 `usage` 事件而增加；`costInfo` 中的 `inputTokens`、`outputTokens`、`costUsd` 反映最后一次 `usage` 事件的值，且 `costUsd` 单调不减。

**验证：需求 5.1、5.2**

### 属性 8：黄色 system 消息颜色一致性

*对于任意 `permission_denied` 事件（任意 description）和任意定时任务触发事件（任意 description）*，对应写入 `msgs` 的消息 `color` 字段均为 `'yellow'`，而普通 system 消息（compact_start、compact_done 等）的 `color` 字段为默认灰色（`undefined` 或 `'gray'`）。

**验证：需求 7.2、9.2**

### 属性 9：permission_denied 和 cron 消息文本完整性

*对于任意 `permission_denied` 事件的 `description` 字段*，写入 `msgs` 的消息文本完整包含该 description，不截断；*对于任意定时任务触发的 `description`*，写入 `msgs` 的消息文本完整包含该 description。

**验证：需求 7.1、7.3、9.1**

---

## 错误处理

| 场景 | 处理方式 |
|---|---|
| `tool_end` 时找不到对应 id 的 ToolBlock | 降级为 `push`，追加新消息（防御性处理） |
| `tool_end` result 为 error | `updateMsg` 追加 `✗ {name}: {message}`，整块颜色变红 |
| `budget_exceeded` | 写入 `error` 级别消息到 `msgs`，同时更新 `costInfo` |
| `error` 事件 | 写入 `error` 级别消息到 `msgs` |
| `tool_log` 行以 `[stderr]` 开头 | 过滤，不写入 `toolProgress` 也不写入 ToolBlock |
| tool_end output 超过 500 字符 | 截取前 500 字符 + `\n…（共 N 字符）` 提示 |
| tool_log 超过 30 行 | 保留最后 30 行 + 首行插入 `…（省略前 N 行）` |

---

## 测试策略

本功能是纯 UI 状态管理逻辑，核心是 `StreamEvent → DisplayMsg[]` 的转换函数和 `costInfo` state 的更新逻辑。

**单元测试（example-based）**：

- `updateMsg` 函数：验证按 id 定位并更新，不影响其他消息
- ToolBlock 合并流程：模拟 `tool_start → tool_log × N → tool_end`，验证 msgs 中只有一条 tool 消息且内容正确
- `usage` 事件处理：验证 msgs 不增加，costInfo 正确更新
- `permission_denied` 渲染：验证颜色为 yellow，前缀为 `⚠ `
- 定时任务触发渲染：验证颜色为 yellow，前缀为 `⏰ `
- assistant 前缀：验证持久化消息和 streamBuf 均含 `✦ `
- tool_log 截断：验证超过 30 行时保留最后 30 行并插入省略提示
- tool_end output 截断：验证超过 500 字符时截断并追加字符数提示

**属性测试（property-based，使用 fast-check）**：

使用 `fast-check` 库，每个属性测试运行最少 100 次迭代。

- **属性 1**：生成随机工具名称、日志行序列、结果类型，验证 msgs 中每个 tool id 只有一条消息且内容完整
  - 标签：`Feature: cli-display-format, Property 1: ToolBlock 合并唯一性`
- **属性 2**：生成随机 tool_log 行序列，验证 tool_end 后 toolProgress 清空，日志迁移到 ToolBlock
  - 标签：`Feature: cli-display-format, Property 2: tool_log 不重复渲染`
- **属性 3**：生成随机 `[stderr]` 前缀行，验证不出现在 toolProgress 或 msgs 中
  - 标签：`Feature: cli-display-format, Property 3: stderr 行被过滤`
- **属性 4**：生成超过 30 行的随机日志序列，验证截断行数和省略提示
  - 标签：`Feature: cli-display-format, Property 4: tool_log 截断保留最后 N 行`
- **属性 5**：生成长度超过 500 字符的随机 output，验证截断和字符数提示
  - 标签：`Feature: cli-display-format, Property 5: tool_end output 截断`
- **属性 6**：生成随机 assistant 文本，验证渲染结果以 `✦ ` 开头，且各角色前缀互不相同
  - 标签：`Feature: cli-display-format, Property 6: assistant 消息前缀一致性`
- **属性 7**：生成随机 usage 事件序列，验证 msgs 不增加，costInfo 反映最新值且 costUsd 单调不减
  - 标签：`Feature: cli-display-format, Property 7: usage 事件不写入 msgs，costInfo 反映最新值`
- **属性 8**：生成随机 permission_denied 和 cron 触发事件，验证 color 为 yellow；生成 compact 事件，验证 color 为默认灰色
  - 标签：`Feature: cli-display-format, Property 8: 黄色 system 消息颜色一致性`
- **属性 9**：生成任意长度的随机 description，验证 permission_denied 和 cron 消息文本完整包含该 description
  - 标签：`Feature: cli-display-format, Property 9: permission_denied 和 cron 消息文本完整性`
