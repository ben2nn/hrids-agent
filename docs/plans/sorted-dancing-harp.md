# Claude Code 交互界面完整复刻方案

## Context

将 `refercode/claude-code-main` 的终端交互界面与逻辑完整复刻到 `hrids-agent` 项目。采用标准 Ink 渲染引擎，从消息渲染层开始，渐进式完成全部 5 个阶段（流式工具执行已拆分为独立计划）。

## 架构对比

| 层级 | Claude Code | hrids-agent 现状 | 目标 |
|------|------------|-----------------|------|
| 渲染引擎 | 自定义 Ink + Yoga | 标准 Ink | 保持标准 Ink |
| 状态管理 | createStore + Context | useState 散布在 App.tsx | 引入轻量 Store |
| 消息列表 | VirtualMessageList (虚拟滚动) | ✅ 已实现：scroll-store.ts + CardStream.tsx | 保持现有实现 |
| 输入组件 | Vim 模式 + 粘贴折叠 + 命令补全 | 基础历史记录 | 增强输入体验 |
| 工具执行 | StreamingToolExecutor (流式并行) | ToolScheduler (批量调度) | 独立计划 |
| 布局 | FullscreenLayout (scrollable + pinned + overlay) | 简单 Box 布局 | 分层布局 |

## 分阶段实施计划

### 阶段 1：消息渲染层（从这里开始）

#### 1.1 MessageRow.tsx — 富消息组件
- **新建** `src/cli/ui/MessageRow.tsx`
- 支持消息类型：user、assistant、tool_use、tool_result、system、error
- 替代现有 MessageCard.tsx（保留兼容）
- 参考：`refercode/.../components/MessageRow.tsx`

#### 1.2 ToolUseCard.tsx — 工具调用卡片
- **新建** `src/cli/ui/ToolUseCard.tsx`
- 显示：工具名、输入摘要、执行状态、耗时、可折叠输出
- 使用现有 TONE 和 TOOL_STATUS_GLYPH 主题
- 参考：`refercode/.../components/AssistantToolUseMessage.tsx`

#### 1.3 DiffView.tsx — Diff 渲染
- **新建** `src/cli/ui/DiffView.tsx`
- 文件编辑 diff 语法高亮
- 大 diff 截断 + 展开选项
- 参考：`refercode/.../components/FileEditToolDiff.tsx`

#### 1.4 StreamingMarkdown.tsx — 终端 Markdown
- **新建** `src/cli/ui/StreamingMarkdown.tsx`
- 渲染：标题、代码块、列表、粗体/斜体、链接
- 使用 `marked` + 自定义终端渲染器

#### 1.5 命令选项交互系统

**命令类型定义** — **新建** `src/cli/commands/types.ts`：
- 三种命令类型：`local`（返回文本）、`local-jsx`（返回 React 节点）、`prompt`（注入 prompt 给模型）
- CommandBase 字段：name, description, aliases, isHidden, isEnabled, argumentHint, availability, kind
- 参考：`refercode/.../types/command.ts`

**命令注册与发现** — **修改** `src/cli/commands/index.ts`：
- `getCommands()` 聚合来源：内置命令 + 技能命令 + 插件命令 + 工作流命令
- `memoize` 缓存，`isCommandEnabled()` / `meetsAvailabilityRequirement()` 过滤
- 参考：`refercode/.../commands.ts`

**命令补全与建议** — **新建** `src/cli/ui/CommandSuggestions.tsx`：
- 输入 `/` 触发 `generateCommandSuggestions()`
- 空 `/` 显示全部命令，按分类排序：最近使用 > 内置 > 用户 > 项目 > 插件
- 输入 `/com` 使用 Fuse.js 模糊搜索，权重：commandName(3) > aliasKey(2) > descriptionKey(0.5)
- 排序：精确名称 > 精确别名 > 前缀名称 > 前缀别名 > Fuse 分数
- SuggestionItem 结构：id, displayText, tag, description, color
- 渲染：命令名（左对齐 40% 列宽）+ [tag] 标签 + 描述文本
- 参考：`refercode/.../utils/suggestions/commandSuggestions.ts`
- 参考：`refercode/.../components/PromptInput/PromptInputFooterSuggestions.tsx`

**命令选项 UI** — **新建** `src/cli/ui/CommandOptionSelect.tsx`：
- Select 组件：单选列表，支持方向键导航 + Enter 确认
- SelectMulti 组件：多选列表，Space 切换 + Enter 确认
- 选项支持 description 描述文本
- 参考：Cla Code 的 Select/SelectMulti 实现

**具体命令 UI**：
- **新建** `src/cli/commands/config/ConfigView.tsx` — Tab 面板（Config/Status/Usage），键盘导航 + ESC 关闭
- **新建** `src/cli/commands/help/HelpView.tsx` — Tab 切换（general/commands/custom-commands），可滚动命令列表
- **修改** `src/cli/commands/commit.ts` — prompt 类型，getPromptForCommand() 动态构建上下文
- 参考：`refercode/.../commands/config/`、`refercode/.../commands/help/`

### 阶段 2：状态管理层

#### 2.1 store.ts — 轻量 Store
- **新建** `src/cli/ui/store.ts`
- 直接移植 Claude Code 的 createStore（35 行）
- `getState()`, `setState()`, `subscribe()`
- 参考：`refercode/.../state/store.ts`

#### 2.2 AppState.ts — 应用状态
- **新建** `src/cli/ui/AppState.ts`
- 定义 AppState 类型：messages, loading, streamBuf, toolProgress, costInfo, scrollState
- 提供 useAppState / useSetAppState hooks
- 渐进迁移 App.tsx 中的 useState

### ~~阶段 3：虚拟滚动~~ ✅ 已实现

已有完整实现：`scroll-store.ts` + `ScrollProvider.tsx` + `CardStream.tsx`
- 外部 store 模式（pub-sub）+ useSyncExternalStore 桥接
- 双高度策略：估算 + measureElement 实测回写
- OVERSCAN_CARDS=2 缓冲 + 16ms 事件节流
- pinned 自动跟踪 + 键盘滚动（PageUp/Down, Arrow keys）

### 阶段 3：输入增强

#### 3.1 增强 PromptInput.tsx
- **修改** `src/cli/ui/PromptInput.tsx`
- 新增功能：
  - Vim 模式：Normal/Insert/Visual 模式 + 状态指示
  - 粘贴折叠：>10000 字符截断为 `[Pasted text #N]`
  - 命令补全：`/commands` 和 `@files` 自动补全
  - 历史搜索：Ctrl+R 反向搜索
  - 多行编辑：Shift+Enter 换行
- 参考：`refercode/.../components/PromptInput/PromptInput.tsx`

#### 3.2 PromptInputFooter.tsx
- **新建** `src/cli/ui/PromptInputFooter.tsx`
- 快捷键提示、当前模式、队列命令数

#### 3.3 增强 CommandHint.tsx
- **修改** `src/cli/ui/CommandHint.tsx`
- 模糊匹配、描述内联、方向键导航

### ~~阶段 4：流式工具执行~~ → 独立计划

已拆分为独立计划：`docs/plans/streaming-tool-executor.md`

### 阶段 4：布局与权限 UI

#### 4.1 FullscreenLayout.tsx
- **新建** `src/cli/ui/FullscreenLayout.tsx`
- 分层：scrollable（消息）+ pinned（spinner+prompt）+ overlay（权限对话框）+ modal（斜杠命令）
- 参考：`refercode/.../components/FullscreenLayout.tsx`

#### 4.2 重构 App.tsx
- **修改** `src/cli/ui/App.tsx`
- 拆分为：App → MainScreen + StatusBar + PermissionDialog
- 使用 FullscreenLayout + AppState Store

#### 4.3 StatusNotices.tsx
- **新建** `src/cli/ui/StatusNotices.tsx`
- 模型信息、成本追踪、会话信息、连接状态

#### 4.4 PermissionRequest.tsx
- **新建** `src/cli/ui/PermissionRequest.tsx`
- 工具权限请求对话框：工具名、输入摘要、Allow/Deny/Always Allow

#### 4.5 BypassModeDialog.tsx
- **新建** `src/cli/ui/BypassModeDialog.tsx`
- 跳过权限模式对话框 + 安全警告

#### 4.6 AskUserQuestion — 用户提问交互系统（增强现有实现）

**现状**：已有 `src/tools/AskUserTool.ts`，支持单问题 + 文本选项，UI 仅在输入框显示提示文字。

**工具定义层** — **修改** `src/tools/AskUserTool.ts`：
- 扩展输入 schema 支持多问题：`questions`（1-4 题，含 question/header/options/multiSelect）
- 保持向后兼容：单问题格式自动转换为 `questions: [{ question, options }]`
- 新增 `answers`、`annotations` 输出字段
- 保持现有全局回调机制（CLI/Server/Gateway 三模式）
- 参考：`refercode/.../tools/AskUserQuestionTool/AskUserQuestionTool.tsx`

**UI 组件层**（6 个新文件）：
- **新建** `src/cli/ui/ask-user/AskUserQuestionView.tsx` — 主入口，解析输入，创建 useMultipleChoiceState，分发到 QuestionView / SubmitView
- **新建** `src/cli/ui/ask-user/QuestionView.tsx` — 单题展示：导航栏 + 题目 + Select/SelectMulti + "Other" 文本输入 + "Chat about this"
- **新建** `src/cli/ui/ask-user/SubmitQuestionsView.tsx` — 提交确认页：答案摘要 + 未完成警告 + Submit/Cancel
- **新建** `src/cli/ui/ask-user/QuestionNavigationBar.tsx` — Tab 导航：← Q1 ☑ Q2 ☐ Q3 Submit →，响应式截断
- **新建** `src/cli/ui/ask-user/PreviewQuestionView.tsx` — Preview 并排布局（代码片段等预览内容）
- **新建** `src/cli/ui/ask-user/useMultipleChoiceState.ts` — useReducer 状态机：next/prev-question, set-answer, update-question-state, set-text-input-mode
- 参考：`refercode/.../components/permissions/AskUserQuestionPermissionRequest/` 目录

**App.tsx 集成** — **修改** `src/cli/ui/App.tsx`：
- 替换当前 `askUserPrompt` 文本提示为 `<AskUserQuestionView />` 组件
- `tool_start` 事件中解析完整 questions 数据传入组件
- 组件内部处理用户交互，完成后调用 `resolveAskUser(answers)`
- 保持现有 `getPendingAskUser()` / `resolveAskUser()` 接口

**UI 布局**：
```
┌─ QuestionNavigationBar ──────────────────────┐
│  ☑ Q1-Auth  ☐ Q2-Library  ☐ Q3-Approach     │
├──────────────────────────────────────────────┤
│  Which library should we use?                │
│                                              │
│  ○ React (Recommended)                       │
│    Most popular, large ecosystem             │
│  ○ Vue                                       │
│    Simpler API, good DX                      │
│  ○ Svelte                                    │
│    Compile-time, smallest bundle             │
│  ○ Other  [________________]                 │
├──────────────────────────────────────────────┤
│  Enter to select / ↑↓ navigate / Esc cancel  │
│  1. Chat about this                          │
└──────────────────────────────────────────────┘
```

**关键交互**：
- 单题单选 → 自动提交；多题或多选 → 手动确认
- "Other" 始终追加，支持 `ctrl+g` 打开外部编辑器
- "Chat about this" → 向 Claude 发送反馈而非选择
- Tab 键在多题间切换，箭头键在选项间导航

## 文件清单

### 新建文件（约 52 个）
```
# 阶段 1-4：核心 UI（23 个）
src/cli/ui/store.ts
src/cli/ui/AppState.ts
src/cli/ui/MessageRow.tsx
src/cli/ui/ToolUseCard.tsx
src/cli/ui/DiffView.tsx
src/cli/ui/StreamingMarkdown.tsx
src/cli/ui/PromptInputFooter.tsx
src/cli/ui/FullscreenLayout.tsx
src/cli/ui/StatusNotices.tsx
src/cli/ui/PermissionRequest.tsx
src/cli/ui/BypassModeDialog.tsx
src/cli/ui/ask-user/AskUserQuestionView.tsx
src/cli/ui/ask-user/QuestionView.tsx
src/cli/ui/ask-user/SubmitQuestionsView.tsx
src/cli/ui/ask-user/QuestionNavigationBar.tsx
src/cli/ui/ask-user/PreviewQuestionView.tsx
src/cli/ui/ask-user/useMultipleChoiceState.ts
src/cli/commands/types.ts
src/cli/ui/CommandSuggestions.tsx
src/cli/ui/CommandOptionSelect.tsx
src/cli/commands/config/ConfigView.tsx
src/cli/commands/help/HelpView.tsx

# 阶段 5：补充交互（约 29 个）
src/cli/ui/permissions/BashPermissionRequest.tsx
src/cli/ui/permissions/FileEditPermissionRequest.tsx
src/cli/ui/permissions/FilesystemPermissionRequest.tsx
src/cli/ui/permissions/FallbackPermissionRequest.tsx
src/cli/ui/InterruptedByUser.tsx
src/cli/ui/ToolErrorMessage.tsx
src/cli/ui/ToolCanceledMessage.tsx
src/cli/ui/QuickOpenDialog.tsx
src/cli/ui/GlobalSearchDialog.tsx
src/cli/ui/FuzzyPicker.tsx
src/cli/ui/ModelPicker.tsx
src/cli/ui/ResumeSession.tsx
src/cli/ui/HistorySearch.tsx
src/cli/ui/SessionPreview.tsx
src/cli/ui/design-system/Dialog.tsx
src/cli/ui/design-system/Select.tsx
src/cli/ui/design-system/Tabs.tsx
src/cli/ui/design-system/ProgressBar.tsx
src/cli/ui/design-system/LoadingState.tsx
src/cli/ui/tasks/BackgroundTasksDialog.tsx
src/cli/ui/tasks/TaskProgress.tsx
src/cli/ui/tasks/TaskStatusIcon.tsx
src/cli/ui/CostThresholdDialog.tsx
src/cli/ui/ContextVisualization.tsx
src/cli/ui/ContextSuggestions.tsx
src/cli/ui/agents/AgentsMenu.tsx
src/cli/ui/agents/AgentDetail.tsx
src/cli/ui/agents/AgentEditor.tsx
src/cli/ui/agents/CreateAgentWizard.tsx
```

### 修改文件（6 个）
```
src/cli/ui/App.tsx              — 主要重构：引入 store、FullscreenLayout、AskUserQuestionView
src/cli/ui/PromptInput.tsx      — 添加 Vim 模式、粘贴折叠、命令补全
src/cli/ui/CommandHint.tsx      — 添加模糊匹配、导航
src/cli/ui/MessageCard.tsx      — 逐步废弃，兼容保留
src/core/PermissionManager.ts   — 添加 shouldDefer 工具识别 + interactiveHandler
src/tools/AskUserTool.ts        — 扩展多问题 schema + 向后兼容
src/modes/interactiveMode.ts    — 更新 App 结构
```

### 参考文件（只读）
```
# 核心 UI
refercode/.../state/store.ts
refercode/.../components/PromptInput/PromptInput.tsx
refercode/.../components/PromptInput/inputPaste.ts
refercode/.../components/FullscreenLayout.tsx
refercode/.../components/MessageRow.tsx
refercode/.../components/Messages.tsx
refercode/.../components/FileEditToolDiff.tsx
refercode/.../screens/REPL.tsx

# AskUserQuestion
refercode/.../tools/AskUserQuestionTool/AskUserQuestionTool.tsx
refercode/.../components/permissions/AskUserQuestionPermissionRequest/

# 命令系统
refercode/.../types/command.ts
refercode/.../commands.ts
refercode/.../utils/suggestions/commandSuggestions.ts
refercode/.../components/PromptInput/PromptInputFooterSuggestions.tsx
refercode/.../commands/config/
refercode/.../commands/help/
refercode/.../commands/commit.ts

# 权限 UI
refercode/.../components/permissions/PermissionRequest.tsx
refercode/.../components/permissions/BashPermissionRequest/
refercode/.../components/permissions/FileEditPermissionRequest/
refercode/.../components/permissions/FilesystemPermissionRequest/
refercode/.../components/permissions/FallbackPermissionRequest.tsx
refercode/.../hooks/toolPermission/handlers/interactiveHandler.ts

# 错误与中断
refercode/.../components/InterruptedByUser.tsx
refercode/.../components/FallbackToolUseErrorMessage.tsx
refercode/.../components/UserToolResultMessage/

# 文件引用与搜索
refercode/.../components/QuickOpenDialog.tsx
refercode/.../components/GlobalSearchDialog.tsx
refercode/.../components/design-system/FuzzyPicker.tsx

# 模型切换
refercode/.../components/ModelPicker.tsx

# 会话管理
refercode/.../components/ResumeTask.tsx
refercode/.../components/HistorySearchDialog.tsx
refercode/.../components/SessionPreview.tsx

# Design System
refercode/.../components/design-system/Dialog.tsx
refercode/.../components/design-system/Select/
refercode/.../components/design-system/Tabs.tsx
refercode/.../components/design-system/ProgressBar.tsx
refercode/.../components/design-system/LoadingState.tsx

# 任务系统
refercode/.../components/tasks/
refercode/.../tasks/types.ts

# 成本与上下文
refercode/.../components/CostThresholdDialog.tsx
refercode/.../components/ContextVisualization.tsx
refercode/.../components/ContextSuggestions.tsx

# Agent 管理
refercode/.../components/agents/
```

## 关键技术决策

**虚拟滚动**：✅ 已实现（scroll-store.ts + CardStream.tsx）

**流式工具执行**：→ 独立计划 `docs/plans/streaming-tool-executor.md`

**状态管理迁移**：
- 渐进式：先新建 Store，再逐步迁移 useState
- 保留简单场景的 useState
- Store + React Context 双重注入

### 阶段 5：补充交互系统

#### 5.1 工具特定权限 UI（按需实现）
- **新建** `src/cli/ui/permissions/BashPermissionRequest.tsx` — 命令展示 + 破坏性警告
- **新建** `src/cli/ui/permissions/FileEditPermissionRequest.tsx` — Diff 预览
- **新建** `src/cli/ui/permissions/FilesystemPermissionRequest.tsx` — 只读工具权限
- **新建** `src/cli/ui/permissions/FallbackPermissionRequest.tsx` — 通用权限 UI
- 其他工具权限 UI 按需扩展
- 参考：`refercode/.../components/permissions/` 目录

#### 5.2 错误与中断处理
- **新建** `src/cli/ui/InterruptedByUser.tsx` — 中断提示："What should Claude do instead?"
- **新建** `src/cli/ui/ToolErrorMessage.tsx` — 工具错误展示（截断 + 详细模式切换）
- **新建** `src/cli/ui/ToolCanceledMessage.tsx` — 工具取消消息
- **修改** `src/cli/ui/App.tsx` — 集成 Ctrl+C 双击退出逻辑
- 参考：`refercode/.../components/InterruptedByUser.tsx`、`FallbackToolUseErrorMessage.tsx`

#### 5.3 文件引用与快速打开
- **新建** `src/cli/ui/QuickOpenDialog.tsx` — Ctrl+Shift+P 模糊文件查找 + 语法高亮预览
- **新建** `src/cli/ui/GlobalSearchDialog.tsx` — Ctrl+Shift+F ripgrep 搜索 + 上下文预览
- **新建** `src/cli/ui/FuzzyPicker.tsx` — 通用模糊搜索组件（被 QuickOpen/GlobalSearch/HistorySearch 复用）
- **修改** `src/cli/ui/PromptInput.tsx` — 支持 @file 引用解析
- 参考：`refercode/.../components/QuickOpenDialog.tsx`、`GlobalSearchDialog.tsx`

#### 5.4 模型切换
- **新建** `src/cli/ui/ModelPicker.tsx` — 模型选择列表 + Effort 级别切换 + Fast 模式
- **修改** `src/cli/ui/App.tsx` — /model 命令触发 ModelPicker
- 参考：`refercode/.../components/ModelPicker.tsx`

#### 5.5 会话管理
- **新建** `src/cli/ui/ResumeSession.tsx` — 会话恢复列表（按仓库过滤 + 相对时间）
- **新建** `src/cli/ui/HistorySearch.tsx` — Ctrl+R 历史搜索 + FuzzyPicker
- **新建** `src/cli/ui/SessionPreview.tsx` — 会话日志预览
- 参考：`refercode/.../components/ResumeTask.tsx`、`HistorySearchDialog.tsx`

#### 5.6 对话框基础组件（Design System）
- **新建** `src/cli/ui/design-system/Dialog.tsx` — 基础对话框（Ctrl+CD 退出 + overlay 注册）
- **新建** `src/cli/ui/design-system/Select.tsx` — 选择列表（键盘导航）
- **新建** `src/cli/ui/design-system/Tabs.tsx` — Tab 导航
- **新建** `src/cli/ui/design-system/ProgressBar.tsx` — 进度条
- **新建** `src/cli/ui/design-system/LoadingState.tsx` — 加载指示器
- 参考：`refercode/.../components/design-system/`

#### 5.7 任务系统（后台任务）
- **新建** `src/cli/ui/tasks/BackgroundTasksDialog.tsx` — 后台任务列表（列表/详情视图）
- **新建** `src/cli/ui/tasks/TaskProgress.tsx` — 任务进度展示（Shell/Agent 不同样式）
- **新建** `src/cli/ui/tasks/TaskStatusIcon.tsx` — 状态图标（play/tick/cross/warning）
- 参考：`refercode/.../components/tasks/`

#### 5.8 成本与上下文
- **新建** `src/cli/ui/CostThresholdDialog.tsx` — 成本警告（$5 阈值通知）
- **新建** `src/cli/ui/ContextVisualization.tsx` — 上下文使用率可视化
- **新建** `src/cli/ui/ContextSuggestions.tsx` — 上下文优化建议
- 参考：`refercode/.../components/CostThresholdDialog.tsx`、`ContextVisualization.tsx`

#### 5.9 Agent 管理
- **新建** `src/cli/ui/agents/AgentsMenu.tsx` — Agent 管理主菜单
- **新建** `src/cli/ui/agents/AgentDetail.tsx` — Agent 详情
- **新建** `src/cli/ui/agents/AgentEditor.tsx` — Agent 配置编辑器
- **新建** `src/cli/ui/agents/CreateAgentWizard.tsx` — 创建 Agent 向导
- 参考：`refercode/.../components/agents/`

## 关键架构模式

1. **Overlay 系统** — 所有对话框通过 `useRegisterOverlay()` 注册，防止背景输入
2. **Ctrl+CD 双击退出** — 所有交互组件的通用退出模式
3. **工具特定权限 UI** — `permissionComponentForTool()` 分发到专用 UI
4. **AppState 驱动** — 所有状态流经 `AppState` + `useAppState()` hooks
5. **Feature gating** — 编译时特性检查（如 VOICE_MODE、BASH_CLASSIFIER）

## 验证方式

每个阶段完成后：
1. `npm run build` 编译通过
2. `npm run chat` 启动交互模式验证 UI
3. 测试关键场景：消息滚动、工具调用显示、输入补全、权限请求
4. 对比 Claude Code 的同场景表现
