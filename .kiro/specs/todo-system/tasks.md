# 实现计划：任务管理系统（todo-system）

## 概述

基于设计文档，将任务管理系统拆解为一系列增量式编码步骤。每个步骤在前一步骤的基础上构建，最终将所有组件串联成完整系统。实现语言：TypeScript。

## 任务列表

- [~] 1. 创建 TodoTool.ts 核心基础设施
  - 新建 `src/tools/TodoTool.ts` 文件
  - 实现 `getTodoFile()`：使用 `resolve(getGlobalCwd(), '.hrids', 'tasks', 'todos.json')` 解析路径
  - 实现 `loadTodos()`：读取并解析 `todos.json`，文件不存在时返回空数组
  - 实现 `saveTodos(todos, filePath)`：先写 `todos.json.tmp`，再 `renameSync` 原子替换，写入前确保目录存在（`mkdirSync` + `recursive: true`）
  - 实现 `assignIds(newTodos, existingTodos)`：从 `existingTodos` 最大 id + 1 开始连续分配，忽略输入中的 `id` 字段
  - 实现 `setTodosUpdatedCallback(cb)` 和内部触发逻辑
  - 导出 `loadTodos` 和 `setTodosUpdatedCallback`
  - _需求：2.1、2.2、2.3、2.4、12.1、12.2、12.3_

  - [ ]* 1.1 为 `assignIds()` 编写属性测试
    - **属性 2：id 单调递增且系统分配**
    - 对任意 `existingTodos` 和 `newTodos` 组合，新分配的 id 均大于 `existingTodos` 中所有 id，且序列连续无间隔
    - LLM 在输入中传入 `id` 字段时，该字段被忽略
    - **验证：需求 2.1、2.2、2.3、2.4**

  - [ ]* 1.2 为 `saveTodos()` / `loadTodos()` 编写单元测试
    - 测试正常读写往返（round-trip）
    - 测试文件不存在时 `loadTodos()` 返回空数组
    - 测试目录不存在时 `saveTodos()` 自动创建目录
    - _需求：12.1、12.2、12.3_

- [~] 2. 实现有向图环检测
  - 在 `src/tools/TodoTool.ts` 中实现 `detectCycle(allTodos)`
  - 构建邻接表，使用 DFS + `inStack` 集合检测有向环
  - 返回 `{ hasCycle: boolean, cyclePath: string | null }`，`cyclePath` 格式为 `"任务 1 → 3 → 1 形成循环"`
  - _需求：6.1、6.2、6.3_

  - [ ]* 2.1 为 `detectCycle()` 编写属性测试
    - **属性 6：无循环依赖**
    - 对任意无环的 DAG，`detectCycle()` 返回 `hasCycle = false`
    - 对任意包含有向环的图，`detectCycle()` 返回 `hasCycle = true` 且 `cyclePath` 非空
    - 写入成功的任务列表经 `detectCycle()` 检测后始终返回 `hasCycle = false`
    - **验证：需求 6.1、6.2、6.3**

- [~] 3. 实现 `todo_write` 工具
  - 在 `src/tools/TodoTool.ts` 中实现并导出 `TodoWriteTool`
  - `inputSchema` 使用 `z.strictObject()`，`todos` 数组加 `.min(1)` 约束，子项使用 `z.strictObject()`，包含 `content`、`priority`（枚举）、`acceptance?`、`dependsOn?`、`context?`，不含 `id` 字段
  - 执行逻辑：列表非空时拒绝并返回当前计划快照；调用 `detectCycle()` 检测环；调用 `assignIds()` 分配 id；自动将第一个任务标记为 `in_progress`；原子写入；触发推送回调
  - 返回值包含完整任务列表和下一步操作指令（"现在执行：「X」，完成后调用 todo_update(id='1', status='completed')"）
  - _需求：1.1、1.2、1.3、1.4、1.5、1.6、13.1、13.2、13.3、13.4、13.5_

  - [ ]* 3.1 为 `todo_write` 编写属性测试
    - **属性 1：计划不可被 LLM 自行覆盖**
    - 对任意非空的 `todos` 列表，调用 `todo_write` 后原有任务列表不变，返回错误信息
    - **验证：需求 1.2**

  - [ ]* 3.2 为 `todo_write` 自动推进编写属性测试
    - **属性 7：自动推进，最短工具调用路径（write 侧）**
    - 对任意合法的 `todo_write` 调用，写入成功后第一个任务的 `status` 为 `in_progress`，无需额外调用 `todo_update`
    - **验证：需求 1.3**

- [~] 4. 实现 `todo_update` 工具
  - 在 `src/tools/TodoTool.ts` 中实现并导出 `TodoUpdateTool`
  - `inputSchema` 使用 `z.strictObject()`，包含 `id: z.string()`、`status: z.enum(['in_progress', 'completed'])`、`confirmations?: z.array(z.boolean())`
  - 标记 `in_progress` 逻辑：检查 `dependsOn` 依赖是否全部 `completed`；将其他 `in_progress` 任务降为 `pending`
  - 标记 `completed` 逻辑（无 `acceptance`）：标记完成，调用 `findNextPending()` 自动推进下一个任务
  - 标记 `completed` 逻辑（有 `acceptance`）：检查 `confirmations` 是否提供、长度是否匹配、是否全部为 `true`；不满足时返回带索引的验收清单；满足时标记完成并自动推进
  - 实现 `findNextPending(todos)`：按 `high→medium→low` 优先级，同优先级按 id 升序，过滤依赖已满足的 `pending` 任务
  - id 不存在时返回错误，提示调用 `todo_read`
  - 所有任务完成时返回全部完成提示，指示 LLM 输出最终结果
  - 原子写入；触发推送回调
  - _需求：3.1、3.2、3.3、3.4、3.5、3.6、3.7、4.1、4.2、5.1、5.2、5.3、5.4_

  - [ ]* 4.1 为 `todo_update` 编写属性测试（同一时刻最多一个 in_progress）
    - **属性 3：同一时刻最多一个 in_progress**
    - 对任意 `todo_update(id, 'in_progress')` 调用，执行后列表中 `status` 为 `in_progress` 的任务有且仅有一个
    - **验证：需求 3.1、3.2**

  - [ ]* 4.2 为 `todo_update` 编写属性测试（依赖约束）
    - **属性 4：依赖约束**
    - 对任意有 `dependsOn` 字段的任务，在其依赖的所有任务均为 `completed` 之前，调用 `todo_update(id, 'in_progress')` 返回错误，不修改任务状态
    - **验证：需求 4.1、4.2**

  - [ ]* 4.3 为 `todo_update` 编写属性测试（验收标准强制确认）
    - **属性 5：验收标准强制确认**
    - 对任意有 `acceptance` 字段的任务，`confirmations` 未提供、长度不匹配或存在 `false` 值时，系统拒绝标记完成
    - 只有 `confirmations` 长度与 `acceptance` 一致且全部为 `true` 时才真正标记完成
    - **验证：需求 5.1、5.2、5.3、5.4**

  - [ ]* 4.4 为 `todo_update` 自动推进编写属性测试
    - **属性 7：自动推进，最短工具调用路径（update 侧）**
    - 对任意 `todo_update(id, 'completed')` 成功调用（无验收标准或验收全部通过），若存在满足依赖条件的 `pending` 任务，则下一个任务自动标记为 `in_progress`，无需 LLM 额外调用 `todo_update`
    - **验证：需求 3.3、3.4**

- [~] 5. 检查点 — 确保所有测试通过
  - 确保所有测试通过，如有问题请向用户说明。

- [ ] 6. 实现 `todo_append` 工具
  - 在 `src/tools/TodoTool.ts` 中实现并导出 `TodoAppendTool`
  - `inputSchema` 与 `todo_write` 相同（`z.strictObject()`，`todos.min(1)`，子项不含 `id`）
  - 执行逻辑：验证 `dependsOn` 引用的 id 均存在于当前列表；调用 `detectCycle()` 检测环（含新任务）；调用 `assignIds()` 从当前最大 id + 1 开始分配；追加到列表末尾，不修改已有任务；原子写入；触发推送回调
  - 返回值提示继续执行当前任务，不建议切换到新追加的任务
  - _需求：4.3、6.1、6.2、6.3、7.1、7.2、7.3、7.4_

  - [ ]* 6.1 为 `todo_append` 编写属性测试（追加不影响已有任务）
    - **属性 8：追加不影响已有任务**
    - 对任意 `todo_append` 调用，执行后已有任务的所有字段（id、content、status、priority、acceptance、dependsOn、context、createdAt）保持不变
    - **验证：需求 7.1**

- [ ] 7. 实现 `todo_reset` 工具
  - 在 `src/tools/TodoTool.ts` 中实现并导出 `TodoResetTool`
  - `inputSchema`：`z.strictObject({ reason: z.string(), newPlan: z.string().optional() })`
  - 执行逻辑：列表为空时返回错误；先备份当前列表到 `todos.bak.{timestamp}.json`（原子写入）；复用 `resolveDecision` 机制触发用户决策；使用 `Promise.race` + `setTimeout(5 * 60 * 1000)` 实现 5 分钟超时自动拒绝；用户允许后清空列表并触发推送回调；用户拒绝或超时后保留列表并返回当前执行中任务信息
  - _需求：8.1、8.2、8.3、8.4、8.5、8.6、12.4_

  - [ ]* 7.1 为 `todo_reset` 编写单元测试
    - 测试列表为空时返回错误
    - 测试备份文件在用户决策前已创建
    - 测试超时（mock 5 分钟）后自动视为拒绝，列表保持不变
    - _需求：8.1、8.5、8.6_

- [ ] 8. 实现 `todo_read` 工具
  - 在 `src/tools/TodoTool.ts` 中实现并导出 `TodoReadTool`
  - `inputSchema`：`z.strictObject({})`，`readonly: true`
  - 列表为空时返回提示调用 `todo_write` 的消息
  - 列表非空时：展示最近 3 条已完成任务 + 未完成任务（按 `high→medium→low` 优先级，同优先级按 id 升序）；对 `in_progress` 任务展示完整 `acceptance` 列表（带索引）；包含当前执行中任务的下一步操作指令
  - 不修改任何任务状态
  - _需求：9.1、9.2、9.3、9.4_

  - [ ]* 8.1 为 `todo_read` 编写单元测试
    - 测试空列表返回提示
    - 测试排序：high 优先级任务排在 medium/low 之前
    - 测试只读：调用前后任务列表完全一致
    - _需求：9.1、9.2、9.3、9.4_

- [ ] 9. 更新 `src/tools/index.ts`
  - 移除旧 `TodoWriteTool`、`TodoReadTool` 的导入和注册（来自 `TodoWriteTool.ts`）
  - 从新 `TodoTool.ts` 导入并注册 `TodoWriteTool`、`TodoUpdateTool`、`TodoAppendTool`、`TodoResetTool`、`TodoReadTool`
  - 确认 `ALL_TOOLS` 数组中旧工具已移除、新工具已添加
  - _需求：1.1（工具注册）_

- [ ] 10. 检查点 — 确保所有测试通过
  - 确保所有测试通过，如有问题请向用户说明。

- [ ] 11. 更新 `src/core/QueryEngine.ts`（动态任务状态注入）
  - 从 `TodoTool.ts` 导入 `loadTodos`
  - 实现 `buildLiveTodoContext()` 函数：
    - 调用 `loadTodos()` 实时读取文件（不缓存）
    - 过滤出活跃任务（`pending` 或 `in_progress`）
    - 无活跃任务时返回 `null`
    - 有活跃任务时构建状态快照字符串，包含进度、任务列表、`in_progress` 任务的完整 `acceptance`/`context`/`dependsOn` 信息及下一步调用指令
    - 文件不存在或读取失败时 `catch` 静默返回 `null`
  - 在 `streamOneTurn()` 内部构建临时 `systemPromptForThisTurn` 数组：`liveTodo ? [...this.config.systemPrompt, liveTodo] : this.config.systemPrompt`，不修改 `this.config.systemPrompt` 共享引用
  - 将 `systemPromptForThisTurn` 传入 `provider.stream()` 调用
  - _需求：10.1、10.2、10.3、10.4、10.5、10.6_

  - [ ]* 11.1 为 `buildLiveTodoContext()` 编写属性测试
    - **属性 9：任务状态在每次 LLM 请求中可见**
    - 对任意存在活跃任务（`pending` 或 `in_progress`）的状态，`buildLiveTodoContext()` 返回非 null 字符串，且包含所有 `in_progress` 任务的 id、content 及完整的 `acceptance`、`context` 信息
    - 对任意无活跃任务的状态，`buildLiveTodoContext()` 返回 `null`
    - 文件不存在时返回 `null`，不抛出异常
    - **验证：需求 10.1、10.2、10.3、10.4**

- [ ] 12. 更新 `src/gateway/SessionManager.ts`
  - 将 `setTodosUpdatedCallback` 的 import 来源从旧 `TodoWriteTool.ts` 更新为新 `TodoTool.ts`
  - 确认推送回调注册逻辑不变（仅更新 import 路径）
  - 确认 `todo_reset` 的决策推送复用 `gatewayDecisionCallbacks` / `sessionDecisionResolves` 机制，`setGatewayDecisionCallback` 已注册
  - _需求：11.1、11.2、11.3_

- [ ] 13. 更新 `src/core/coordinator/coordinatorPrompt.ts`
  - 将 `SECTION_TODO` 替换为状态机描述（参考设计文档"System Prompt 状态机"章节）
  - 加入规划确认的判断标准（高/低不确定性两条路径）
  - 更新工具速查表：新增 `todo_update`、`todo_append`、`todo_reset`，更新 `todo_write` 的语义说明
  - _需求：14.1、14.2、14.3_

- [ ] 14. 更新前端类型定义 `src/web/src/lib/types.ts`
  - 在 `Todo` 接口中新增字段：`acceptance?: string[]`、`dependsOn?: string[]`、`context?: string`、`createdAt: number`
  - 确认 `todos_updated` WebSocket 消息类型自动生效（无需单独修改消息类型）
  - _需求：15.1_

- [ ] 15. 删除旧文件 `src/tools/TodoWriteTool.ts`
  - 确认没有其他文件仍在 import 旧 `TodoWriteTool.ts`（使用 grep 搜索）
  - 确认旧文件中的 `setTodosUpdatedCallback`、`getTodoFile` 等逻辑已全部迁移到新 `TodoTool.ts`
  - 删除 `src/tools/TodoWriteTool.ts`
  - _需求：（清理旧实现）_

- [ ] 16. 最终检查点 — 确保所有测试通过
  - 确保所有测试通过，如有问题请向用户说明。

- [ ] 17. 更新前端 TodoItem 组件（可选）
  - 若 `Todo` 有 `acceptance` 字段，在 TodoItem 组件中展示验收标准列表
  - _需求：15.2_

## 备注

- 标有 `*` 的子任务为可选测试任务，可跳过以加快 MVP 进度
- 每个任务均引用了具体的需求条款，确保可追溯性
- 属性测试使用 `fast-check` 库（设计文档指定）
- 任务 1–8 均在同一文件 `src/tools/TodoTool.ts` 中完成，按依赖顺序递增实现
- 任务 9–17 为集成串联步骤，将新工具接入现有系统
- 检查点（任务 5、10、16）确保每个阶段的增量验证
