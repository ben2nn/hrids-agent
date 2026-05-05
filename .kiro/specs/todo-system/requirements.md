# 需求文档：任务管理系统（todo-system）

## 简介

本文档定义 hrids-agent 任务管理系统的功能需求。该系统通过接口设计（而非 prompt 约束）物理阻止 LLM 在执行复杂任务时的五个核心失控点：**计划被覆盖**、**执行停滞**、**过早完成**、**压缩后漂移**、**范围失控**。

系统核心思路：工具返回值驱动执行循环，用状态机替代规则列表，让 LLM 在任何时刻只需知道"现在该调用哪个工具、传什么参数"。

## 词汇表

- **TodoTool**：实现全部 5 个任务管理工具的核心模块（`src/tools/TodoTool.ts`）
- **QueryEngine**：每次 LLM 请求前动态注入任务状态到 system prompt 的模块（`src/core/QueryEngine.ts`）
- **SessionManager**：管理 WebSocket 连接并推送任务状态更新的模块（`src/gateway/SessionManager.ts`）
- **Todo**：单条任务数据结构，包含 id、content、status、priority、createdAt 等字段
- **Task_List**：存储在 `{cwd}/.hrids/tasks/todos.json` 的任务列表
- **Dependency_Graph**：由任务 `dependsOn` 字段构成的有向图
- **Acceptance_Criteria**：任务的验收标准列表（`acceptance` 字段），完成前需逐条确认
- **Confirmations**：LLM 调用 `todo_update(completed)` 时提供的逐条确认布尔数组
- **Live_Context**：`buildLiveTodoContext()` 生成的任务状态快照字符串，动态注入到 system prompt
- **Atomic_Write**：先写临时文件再 `rename` 替换的原子写入操作，防止并发写入损坏

---

## 需求

### 需求 1：建立任务计划（todo_write）

**用户故事：** 作为 LLM 协调器，我希望在任务列表为空时建立完整的任务计划，以便系统能够跟踪和驱动复杂任务的执行。

#### 验收标准

1. WHEN `todo_write` 被调用且 Task_List 为空，THE TodoTool SHALL 接受调用，为每个任务分配系统自增 id，并将计划写入 `{cwd}/.hrids/tasks/todos.json`
2. WHEN `todo_write` 被调用且 Task_List 非空，THE TodoTool SHALL 拒绝调用，返回错误信息和当前计划快照，并提示使用 `todo_append` 或 `todo_update`
3. WHEN `todo_write` 写入成功，THE TodoTool SHALL 自动将第一个任务标记为 `in_progress`，无需 LLM 额外调用 `todo_update`
4. WHEN `todo_write` 写入成功，THE TodoTool SHALL 返回包含完整任务列表和下一步操作指令的响应
5. WHEN `todo_write` 的输入包含循环依赖（`dependsOn` 形成有向环），THE TodoTool SHALL 拒绝写入并返回具体的循环链路描述
6. THE TodoTool SHALL 使用 Atomic_Write 写入 Task_List，防止并发写入时文件半写损坏

---

### 需求 2：系统自增 id 分配

**用户故事：** 作为系统设计者，我希望任务 id 由系统自动分配而非 LLM 指定，以便从根本上消灭 LLM 用相同 id 覆盖已有任务的可能性。

#### 验收标准

1. THE TodoTool SHALL 为每个新任务分配单调递增的正整数字符串 id（格式为 `"1"`、`"2"`、`"3"`……）
2. WHEN `todo_write` 被调用，THE TodoTool SHALL 从 `"1"` 开始分配 id，按输入数组顺序连续递增
3. WHEN `todo_append` 被调用，THE TodoTool SHALL 从当前 Task_List 中最大 id 加 1 开始分配新任务的 id
4. IF LLM 在输入参数中传入 `id` 字段，THEN THE TodoTool SHALL 忽略该字段并使用系统分配的 id

---

### 需求 3：单条任务状态更新（todo_update）

**用户故事：** 作为 LLM 协调器，我希望能够更新单条任务的状态，以便系统能够追踪执行进度并自动推进到下一个任务。

#### 验收标准

1. WHEN `todo_update(id, 'in_progress')` 被调用，THE TodoTool SHALL 将指定任务标记为 `in_progress`，并自动将其他所有 `in_progress` 任务降为 `pending`
2. WHILE Task_List 中存在 `in_progress` 状态的任务，THE TodoTool SHALL 保证同一时刻有且仅有一个任务处于 `in_progress` 状态
3. WHEN `todo_update(id, 'completed')` 被调用且目标任务无 Acceptance_Criteria，THE TodoTool SHALL 标记任务为 `completed`，并自动将下一个满足依赖条件的 `pending` 任务（按 high→medium→low 优先级，同优先级按 id 升序）标记为 `in_progress`
4. WHEN `todo_update(id, 'completed')` 被调用且目标任务有 Acceptance_Criteria，且 Confirmations 长度与 Acceptance_Criteria 一致且全部为 `true`，THE TodoTool SHALL 标记任务为 `completed` 并自动推进下一个任务
5. WHEN `todo_update(id, 'completed')` 被调用且目标任务有 Acceptance_Criteria，但未提供 Confirmations 或 Confirmations 未全部为 `true`，THE TodoTool SHALL 拒绝标记完成，并返回带索引的验收清单
6. IF `todo_update` 传入的 id 不存在于 Task_List，THEN THE TodoTool SHALL 返回错误信息，并提示调用 `todo_read` 确认当前列表
7. WHEN 所有任务均标记为 `completed`，THE TodoTool SHALL 返回全部完成的提示，并指示 LLM 输出最终结果而非继续调用任务工具

---

### 需求 4：依赖约束

**用户故事：** 作为任务规划者，我希望能够定义任务间的依赖关系，以便系统强制按正确顺序执行任务。

#### 验收标准

1. WHEN `todo_update(id, 'in_progress')` 被调用，且目标任务的 `dependsOn` 中存在未完成（非 `completed`）的任务，THE TodoTool SHALL 拒绝操作并返回具体的依赖任务信息和当前状态
2. WHEN 目标任务的所有 `dependsOn` 任务均为 `completed`，THE TodoTool SHALL 允许将该任务标记为 `in_progress`
3. WHEN `todo_append` 被调用，且新任务的 `dependsOn` 引用了不存在于 Task_List 的 id，THE TodoTool SHALL 拒绝操作并返回错误信息

---

### 需求 5：验收标准强制确认

**用户故事：** 作为质量保障机制，我希望有 Acceptance_Criteria 的任务在标记完成前必须逐条确认，以便防止 LLM 在未真正完成工作时过早标记完成。

#### 验收标准

1. WHEN `todo_update(id, 'completed')` 被调用且任务有 Acceptance_Criteria，但未提供 Confirmations 参数，THE TodoTool SHALL 返回带索引的验收清单，不标记任务为完成
2. WHEN `todo_update(id, 'completed')` 被调用且任务有 Acceptance_Criteria，但 Confirmations 长度与 Acceptance_Criteria 长度不一致，THE TodoTool SHALL 拒绝操作并返回验收清单
3. WHEN `todo_update(id, 'completed')` 被调用且任务有 Acceptance_Criteria，且 Confirmations 中存在 `false` 值，THE TodoTool SHALL 拒绝操作并返回验收清单
4. WHEN `todo_update(id, 'completed')` 被调用且任务有 Acceptance_Criteria，且 Confirmations 长度与 Acceptance_Criteria 一致且全部为 `true`，THE TodoTool SHALL 接受操作并标记任务为完成

---

### 需求 6：无循环依赖保证

**用户故事：** 作为系统设计者，我希望系统在写入任务时检测并拒绝循环依赖，以便保证任务执行图始终是有向无环图（DAG）。

#### 验收标准

1. WHEN `todo_write` 或 `todo_append` 被调用，THE TodoTool SHALL 在写入前对 Dependency_Graph 执行有向图环检测
2. IF `todo_write` 或 `todo_append` 的输入导致 Dependency_Graph 中存在有向环，THEN THE TodoTool SHALL 拒绝写入并返回具体的循环链路（如 "任务 1 → 3 → 1 形成循环"）
3. WHEN `todo_write` 或 `todo_append` 写入成功，THE TodoTool SHALL 保证 Task_List 中的 Dependency_Graph 不包含任何有向环

---

### 需求 7：追加新任务（todo_append）

**用户故事：** 作为 LLM 协调器，我希望在执行过程中发现遗漏步骤时能够追加新任务，以便在不中断当前任务的情况下扩展计划。

#### 验收标准

1. WHEN `todo_append` 被调用，THE TodoTool SHALL 将新任务追加到 Task_List 末尾，不修改任何已有任务的状态
2. WHEN `todo_append` 写入成功，THE TodoTool SHALL 返回提示继续执行当前任务的响应，不建议切换到新追加的任务
3. WHEN `todo_append` 被调用且新任务的 `dependsOn` 与现有任务形成有向环，THE TodoTool SHALL 拒绝写入并返回循环链路描述
4. THE TodoTool SHALL 使用 Atomic_Write 写入追加后的 Task_List

---

### 需求 8：请求重置计划（todo_reset）

**用户故事：** 作为系统安全机制，我希望 LLM 无法直接清空任务列表，必须通过用户确认才能重置，以便防止 LLM 在遇到障碍时绕过进度保护自行重新规划。

#### 验收标准

1. WHEN `todo_reset` 被调用且 Task_List 非空，THE TodoTool SHALL 在请求用户确认前自动备份当前列表到 `{cwd}/.hrids/tasks/todos.bak.{timestamp}.json`
2. WHEN `todo_reset` 被调用，THE TodoTool SHALL 向用户展示当前计划状态、重置原因和新方案描述，等待用户决策
3. WHEN 用户批准重置请求，THE TodoTool SHALL 清空 Task_List 并返回提示调用 `todo_write` 建立新计划的响应
4. WHEN 用户拒绝重置请求，THE TodoTool SHALL 保留原有 Task_List 并返回当前执行中任务的信息
5. WHEN `todo_reset` 等待用户决策超过 5 分钟，THE TodoTool SHALL 自动视为用户拒绝，保留原有 Task_List 并继续执行
6. WHEN `todo_reset` 被调用且 Task_List 为空，THE TodoTool SHALL 返回错误："当前没有任务计划，无需重置"

---

### 需求 9：读取任务状态（todo_read）

**用户故事：** 作为 LLM 协调器，我希望能够随时读取当前任务状态，以便在需要时了解整体进度和下一步操作。

#### 验收标准

1. WHEN `todo_read` 被调用且 Task_List 非空，THE TodoTool SHALL 返回按优先级排序（high→medium→low，同优先级按 id 升序）的未完成任务列表，以及最近 3 条已完成任务
2. WHEN `todo_read` 被调用且 Task_List 非空，THE TodoTool SHALL 在响应中包含当前 `in_progress` 任务的下一步操作指令
3. WHEN `todo_read` 被调用且 Task_List 为空，THE TodoTool SHALL 返回提示调用 `todo_write` 的消息
4. THE TodoTool SHALL 保证 `todo_read` 为只读操作，不修改任何任务状态

---

### 需求 10：压缩恢复——动态注入任务状态

**用户故事：** 作为系统可靠性保障，我希望每次 LLM 请求都能看到最新的任务状态，以便在上下文压缩后 LLM 仍能知道自己在做什么、下一步该做什么。

#### 验收标准

1. WHEN QueryEngine 构建 LLM 请求且 Task_List 中存在活跃任务（`pending` 或 `in_progress`），THE QueryEngine SHALL 将 Live_Context 追加到本次请求的 system prompt 末尾
2. WHEN QueryEngine 构建 LLM 请求且 Task_List 中不存在活跃任务，THE QueryEngine SHALL 不向 system prompt 追加任何任务状态内容
3. WHEN Live_Context 被构建且存在 `in_progress` 任务，THE QueryEngine SHALL 在 Live_Context 中包含该任务的完整 Acceptance_Criteria、`context` 背景和 `dependsOn` 信息
4. THE QueryEngine SHALL 每次请求实时读取 `todos.json` 文件构建 Live_Context，不使用缓存，保证上下文压缩后仍能获取最新状态
5. THE QueryEngine SHALL 构建临时的 `systemPromptForThisTurn` 数组追加 Live_Context，不修改 `this.config.systemPrompt` 共享引用
6. IF `todos.json` 文件不存在或读取失败，THEN THE QueryEngine SHALL 静默跳过任务状态注入，不影响 LLM 请求的正常发送

---

### 需求 11：WebSocket 实时推送

**用户故事：** 作为前端用户界面，我希望在任务状态发生变化时实时收到推送，以便前端能够即时刷新任务列表展示。

#### 验收标准

1. WHEN `todo_write`、`todo_update`、`todo_append` 或 `todo_reset`（用户允许后）执行成功，THE TodoTool SHALL 触发 `todos_updated` WebSocket 推送回调
2. THE SessionManager SHALL 注册 `todos_updated` 回调，并在收到回调时向前端广播最新的 Task_List
3. THE TodoTool SHALL 通过 `setTodosUpdatedCallback` 接口接受外部注册的推送回调，与 SessionManager 解耦

---

### 需求 12：数据持久化与原子写入

**用户故事：** 作为数据可靠性保障，我希望任务列表的写入操作是原子的，以便在并发或异常情况下不会出现文件半写损坏。

#### 验收标准

1. THE TodoTool SHALL 将 Task_List 存储在 `{cwd}/.hrids/tasks/todos.json`，路径使用 `resolve(getGlobalCwd(), '.hrids', 'tasks', 'todos.json')` 解析
2. THE TodoTool SHALL 使用 Atomic_Write 执行所有写操作：先写临时文件 `todos.json.tmp`，再通过 `renameSync` 原子替换目标文件
3. THE TodoTool SHALL 在写入前确保 `{cwd}/.hrids/tasks/` 目录存在，不存在时自动创建
4. WHEN `todo_reset` 创建备份文件，THE TodoTool SHALL 使用 Atomic_Write 写入备份文件

---

### 需求 13：输入验证与 Schema 约束

**用户故事：** 作为系统安全机制，我希望所有工具的输入参数在 schema 层严格验证，以便在 LLM 传入非法格式时直接拒绝，不进入执行逻辑。

#### 验收标准

1. THE TodoTool SHALL 对所有工具使用 `z.strictObject()` 定义 inputSchema，拒绝 schema 中未声明的额外字段
2. THE TodoTool SHALL 对 `status` 字段使用枚举约束，只接受 `'pending'`、`'in_progress'`、`'completed'` 三个值
3. THE TodoTool SHALL 对 `priority` 字段使用枚举约束，只接受 `'high'`、`'medium'`、`'low'` 三个值
4. THE TodoTool SHALL 对 `todo_write` 和 `todo_append` 的 `todos` 数组使用 `.min(1)` 约束，拒绝空数组输入
5. IF LLM 传入非法格式的参数，THEN THE TodoTool SHALL 在 schema 验证层直接返回错误，不执行任何业务逻辑

---

### 需求 14：规划确认机制

**用户故事：** 作为用户，我希望对于意图模糊或影响范围广的任务，LLM 先输出规划方案等我确认，而不是直接开始执行，以便我能在执行前审查和调整方案。

#### 验收标准

1. WHEN LLM 收到意图明确、范围清晰的任务（单文件修改、局部变更），THE QueryEngine SHALL 驱动 LLM 直接调用 `todo_write` 建立计划并开始执行
2. WHEN LLM 收到涉及架构决策、影响范围超出单个模块、包含不可逆操作或意图模糊的任务，THE QueryEngine SHALL 驱动 LLM 先输出规划方案，等待用户确认后再调用 `todo_write`
3. WHEN LLM 输出规划方案，THE QueryEngine SHALL 要求规划方案包含：目标描述、步骤列表、影响范围、预计任务数量

---

### 需求 15：前端类型定义更新

**用户故事：** 作为前端开发者，我希望前端的 `Todo` 类型定义与后端数据结构保持一致，以便前端能够正确展示新增的 `acceptance`、`dependsOn`、`context` 等字段。

#### 验收标准

1. THE Frontend SHALL 在 `src/web/src/lib/types.ts` 中的 `Todo` 接口新增 `acceptance?: string[]`、`dependsOn?: string[]`、`context?: string`、`createdAt: number` 字段
2. WHERE `acceptance` 字段存在，THE Frontend SHALL 在 TodoItem 组件中展示验收标准列表
