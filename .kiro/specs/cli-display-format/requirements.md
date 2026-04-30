# 需求文档

## 简介

hrids-agent 是一个基于 React + Ink 的 CLI 终端 agent 工具。当前对话界面的显示格式存在多处混乱：工具执行产生的三条独立消息堆积在历史中、tool_log 内容被重复渲染、cost 消息频繁打断对话节奏、assistant 消息缺乏前缀导致难以区分、tool_end 输出截断方式粗暴。本功能旨在制定并实现一套统一的 CLI 对话显示格式规范，覆盖所有消息类型，使界面层次清晰、信息密度合理、视觉噪音最小。

---

## 词汇表

- **Display_System**：负责将 StreamEvent 转换为终端可视内容的 UI 渲染层（即 `App.tsx` 及其子组件）
- **ToolBlock**：将同一次工具调用的 tool_start、tool_log、tool_end 三个事件合并展示的单一视觉单元
- **StreamBuf**：LLM 流式输出期间的实时文本缓冲区，完成后转为持久化 assistant 消息
- **ToolProgress**：工具执行期间的临时进度日志，任务结束后不保留在历史中
- **CostBar**：底部状态栏中显示 token 用量与累计费用的区域
- **PermissionPrompt**：需要用户确认的权限询问交互区域
- **CompactNotice**：上下文压缩事件的通知消息
- **StatusBar**：界面底部固定显示 provider、model、快捷键提示的状态栏

---

## 需求

### 需求 1：工具执行合并为单一 ToolBlock

**用户故事：** 作为 CLI 用户，我希望同一次工具调用的启动、日志、结果合并为一个视觉块，以便快速扫描工具执行情况而不被三条独立消息淹没。

#### 验收标准

1. WHEN tool_start 事件触发，THE Display_System SHALL 在消息历史中创建一个 ToolBlock 条目，显示工具名称和描述，格式为 `⚙ {name}  {description}`
2. WHILE 工具执行中，THE Display_System SHALL 将 tool_log 行追加到 ToolProgress 临时区域，不写入消息历史
3. WHEN tool_end 事件触发，THE Display_System SHALL 将 ToolProgress 内容清空，并将本次工具日志（最多 30 行）合并追加到同一 ToolBlock 条目中
4. WHEN tool_end 事件触发且结果为成功，THE Display_System SHALL 在 ToolBlock 末尾追加 `✓ {name}` 状态行
5. WHEN tool_end 事件触发且结果为错误，THE Display_System SHALL 在 ToolBlock 末尾追加 `✗ {name}: {message}` 错误行，颜色为红色
6. THE Display_System SHALL 保证同一次工具调用的所有内容在历史中占据连续的行，不被其他消息类型插入

---

### 需求 2：tool_log 去重，消除重复渲染

**用户故事：** 作为 CLI 用户，我希望工具日志只出现一次，以便避免相同内容在临时进度区和历史区各显示一遍造成混乱。

#### 验收标准

1. WHILE 工具执行中，THE Display_System SHALL 仅在 ToolProgress 临时区域显示 tool_log 内容
2. WHEN tool_end 事件触发，THE Display_System SHALL 将本次工具日志从 ToolProgress 迁移到 ToolBlock 历史条目，迁移后 ToolProgress 区域清空
3. THE Display_System SHALL 保证同一条 tool_log 内容在任意时刻最多在界面上出现一次
4. IF tool_log 行以 `[stderr]` 开头，THEN THE Display_System SHALL 过滤该行，不在任何区域显示

---

### 需求 3：tool_log 超长截断规范

**用户故事：** 作为 CLI 用户，我希望工具日志超出限制时有明确的省略提示，以便了解被截断的信息量而不是被大量文本撑满屏幕。

#### 验收标准

1. THE Display_System SHALL 为每次工具执行的日志设定最大保留行数上限，默认值为 30 行
2. WHEN 工具日志行数超过 30 行，THE Display_System SHALL 保留最后 30 行，并在首行插入 `…（省略前 N 行）` 提示，其中 N 为被省略的行数
3. THE Display_System SHALL 为 tool_end 的 output 字段设定最大字符数上限，默认值为 500 字符
4. WHEN tool_end output 字符数超过 500，THE Display_System SHALL 截取前 500 字符并追加 `\n…（共 N 字符）` 提示，其中 N 为原始总字符数
5. THE Display_System SHALL 以 `dimColor` 样式渲染所有省略提示文本，与正文内容形成视觉区分

---

### 需求 4：assistant 消息添加前缀，与工具日志明确区分

**用户故事：** 作为 CLI 用户，我希望 LLM 的回复消息有明确的视觉前缀，以便在工具日志和系统消息之间快速定位 AI 的实际回答。

#### 验收标准

1. THE Display_System SHALL 为所有持久化的 assistant 消息添加前缀 `✦ `
2. THE Display_System SHALL 以白色（`white`）渲染 assistant 消息文本
3. WHILE LLM 流式输出中，THE Display_System SHALL 在 StreamBuf 实时文本前同样显示 `✦ ` 前缀
4. THE Display_System SHALL 保证 assistant 前缀与 user 前缀（`你 › `）、system 前缀（`• `）、error 前缀（`✗ `）在视觉上可区分

---

### 需求 5：cost 消息移出对话流，显示在状态栏

**用户故事：** 作为 CLI 用户，我希望 token 用量和费用信息显示在底部状态栏而非对话历史中，以便不打断对话节奏，同时随时可查看费用。

#### 验收标准

1. WHEN usage 事件触发，THE Display_System SHALL 更新 CostBar 区域的显示内容，不向消息历史追加任何条目
2. THE Display_System SHALL 在 StatusBar 中持续显示最新的 token 用量和累计费用，格式为 `输入 {inputTokens} / 输出 {outputTokens} tokens  累计 ${costUsd}`
3. THE Display_System SHALL 将 CostBar 渲染为 StatusBar 的一部分，位于 provider 和 model 信息之后
4. WHEN budget_exceeded 事件触发，THE Display_System SHALL 向消息历史追加一条 error 级别的预算超限提示，同时更新 CostBar

---

### 需求 6：用户消息和系统消息格式规范

**用户故事：** 作为 CLI 用户，我希望用户消息和系统消息有一致的格式规范，以便在对话历史中快速识别消息来源。

#### 验收标准

1. THE Display_System SHALL 为 user 消息添加前缀 `你 › `，颜色为绿色（`green`）
2. THE Display_System SHALL 为 system 消息添加前缀 `• `，颜色为灰色（`gray`）
3. THE Display_System SHALL 为 error 消息添加前缀 `✗ `，颜色为红色（`red`）
4. THE Display_System SHALL 为 tool 消息使用青色（`cyan`）渲染，无前缀符号（前缀已内嵌在消息文本中）
5. THE Display_System SHALL 保证所有消息类型的颜色和前缀在整个会话生命周期内保持一致

---

### 需求 7：权限询问（permission_denied）显示规范

**用户故事：** 作为 CLI 用户，我希望权限拒绝事件有明确的视觉提示，以便了解哪些操作被阻止。

#### 验收标准

1. WHEN permission_denied 事件触发，THE Display_System SHALL 向消息历史追加一条 system 级别消息，格式为 `⚠ 已拒绝: {description}`
2. THE Display_System SHALL 以黄色（`yellow`）渲染权限拒绝消息，与普通 system 消息（灰色）形成区分
3. THE Display_System SHALL 在权限拒绝消息中完整显示被拒绝操作的描述，不截断

---

### 需求 8：上下文压缩（compact）通知规范

**用户故事：** 作为 CLI 用户，我希望上下文压缩事件有清晰的开始和完成通知，以便了解系统正在进行的后台操作。

#### 验收标准

1. WHEN compact_start 事件触发，THE Display_System SHALL 向消息历史追加 system 消息 `⟳ 上下文过长，正在自动压缩历史...`
2. WHEN compact_done 事件触发，THE Display_System SHALL 向消息历史追加 system 消息 `✓ 历史已压缩（约 {tokens} tokens）`，其中 tokens 为压缩后的估算 token 数
3. THE Display_System SHALL 以灰色（`gray`）渲染 compact 通知消息，与普通对话内容形成视觉区分

---

### 需求 9：定时任务（cron）触发显示规范

**用户故事：** 作为 CLI 用户，我希望定时任务触发时有明确的视觉标识，以便区分用户主动发起的对话和系统自动触发的任务。

#### 验收标准

1. WHEN 定时任务触发，THE Display_System SHALL 在消息历史中插入 system 消息 `⏰ 定时任务触发: {description}`
2. THE Display_System SHALL 以黄色（`yellow`）渲染定时任务触发通知，与普通 system 消息（灰色）形成区分
3. WHEN 定时任务在 loading 状态下触发，THE Display_System SHALL 将任务加入队列，并在当前任务完成后按顺序执行，不丢失任何触发事件

---

### 需求 10：状态栏（StatusBar）信息完整性规范

**用户故事：** 作为 CLI 用户，我希望底部状态栏始终显示完整的上下文信息，以便随时了解当前会话状态。

#### 验收标准

1. THE Display_System SHALL 在 StatusBar 中持续显示当前 provider 名称和 model 名称
2. WHILE loading 状态为 true，THE Display_System SHALL 在 StatusBar 中显示 `Ctrl+C 中断` 提示
3. WHILE loading 状态为 false，THE Display_System SHALL 在 StatusBar 中显示 `Ctrl+C 退出` 提示
4. THE Display_System SHALL 以 `dimColor` 样式渲染 StatusBar 全部内容，使其与对话内容形成视觉层次区分
5. WHEN provider 或 model 发生 fallback 切换，THE Display_System SHALL 在下一次 done 事件后立即更新 StatusBar 中的对应显示值
