# 阶段 5：补充交互系统

## Context

阶段 1-4 已完成（状态管理、消息渲染、布局、输入增强）。阶段 5 原计划包含 29 个文件，按优先级拆分为 3 个批次实施。

## 批次拆分

### 批次 A：核心交互（高优先级，8 个文件）

#### A1. 错误与中断处理
- **新建** `src/cli/ui/InterruptedByUser.tsx` — 中断提示
- **新建** `src/cli/ui/ToolErrorMessage.tsx` — 工具错误展示
- **新建** `src/cli/ui/ToolCanceledMessage.tsx` — 工具取消消息

#### A2. 工具特定权限 UI
- **新建** `src/cli/ui/permissions/BashPermissionRequest.tsx` — 命令权限
- **新建** `src/cli/ui/permissions/FileEditPermissionRequest.tsx` — 编辑权限
- **新建** `src/cli/ui/permissions/FilesystemPermissionRequest.tsx` — 文件系统权限
- **新建** `src/cli/ui/permissions/FallbackPermissionRequest.tsx` — 通用权限
- **新建** `src/cli/ui/permissions/PermissionDialog.tsx` — 权限分发器

### 批次 B：会话与模型（中优先级，5 个文件）✅ 已完成

#### B1. 会话管理
- **新建** `src/cli/ui/ResumeSession.tsx` — 会话恢复列表 ✅
- **新建** `src/cli/ui/HistorySearch.tsx` — 历史搜索 ✅
- **新建** `src/cli/ui/SessionPreview.tsx` — 会话预览 ✅

#### B2. 模型切换
- **新建** `src/cli/ui/ModelPicker.tsx` — 模型选择器 ✅
- **新建** `src/cli/ui/EffortPicker.tsx` — Effort 级别选择 ✅

### 批次 C：增强功能（低优先级，18 个文件）✅ 已完成

#### C1. Design System（5 个文件）
- `src/cli/ui/design-system/Dialog.tsx` ✅
- `src/cli/ui/design-system/Select.tsx` ✅
- `src/cli/ui/design-system/Tabs.tsx` ✅
- `src/cli/ui/design-system/ProgressBar.tsx` ✅
- `src/cli/ui/design-system/LoadingState.tsx` ✅

#### C2. 文件引用与搜索（3 个文件）
- `src/cli/ui/QuickOpenDialog.tsx` ✅
- `src/cli/ui/GlobalSearchDialog.tsx` ✅
- `src/cli/ui/FuzzyPicker.tsx` ✅

#### C3. 任务系统（3 个文件）
- `src/cli/ui/tasks/BackgroundTasksDialog.tsx` ✅
- `src/cli/ui/tasks/TaskProgress.tsx` ✅
- `src/cli/ui/tasks/TaskStatusIcon.tsx` ✅

#### C4. 成本与上下文（3 个文件）
- `src/cli/ui/CostThresholdDialog.tsx` ✅
- `src/cli/ui/ContextVisualization.tsx` ✅
- `src/cli/ui/ContextSuggestions.tsx` ✅

#### C5. Agent 管理（4 个文件）
- `src/cli/ui/agents/AgentsMenu.tsx` ✅
- `src/cli/ui/agents/AgentDetail.tsx` ✅
- `src/cli/ui/agents/AgentEditor.tsx` ✅
- `src/cli/ui/agents/CreateAgentWizard.tsx` ✅

## 实施顺序

1. **批次 A** ✅ — 核心交互，影响用户体验（8 个文件）
2. **批次 B** ✅ — 会话与模型，提升工作流（5 个文件）
3. **批次 C** ✅ — 增强功能，按需实施（18 个文件）

## 验证方式

每个批次完成后：
1. `npm run build` 编译通过
2. `npm run chat` 启动交互模式验证 UI
3. 测试关键场景
