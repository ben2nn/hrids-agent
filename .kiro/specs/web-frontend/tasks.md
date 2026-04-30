# 实现计划：web-frontend

## 概述

为 hrids-agent 开发独立的 Web 前端，位于 `web/` 子目录，连接 Gateway 服务（HTTP REST + WebSocket）。
提供三栏布局：左侧导航栏（新建/专家/技能/自动化 + 会话列表）、中间对话区、右侧面板（任务产物 Tab | 工作目录 Tab）。
同时对后端进行最小化改造：TodoWriteTool 会话级隔离、新增 REST 接口、WebSocket 推送 todos_updated 事件。

## 任务

- [x] 1. 初始化前端项目脚手架
  - 创建 `web/` 目录，初始化 `package.json`，依赖包括 `react@^18`、`react-dom`、`typescript`、`vite`、`@vitejs/plugin-react`、`tailwindcss`、`postcss`、`autoprefixer`、`zustand`、`react-markdown`、`remark-gfm`、`react-syntax-highlighter`、`@tanstack/react-virtual` 及对应 `@types/*`
  - 创建 `vite.config.ts`，配置 dev proxy：`/sessions`（含 ws: true）、`/todos`、`/crons`、`/skills`、`/health` 均代理到 `http://localhost:3282`
  - 创建 `tailwind.config.ts`，配置深色主题 CSS 变量（`--bg-primary: #0f0f0f` 等）
  - 创建 `tsconfig.json`、`index.html`、`src/main.tsx` 入口
  - _需求：US-1 至 US-11，非功能需求_

- [x] 2. 类型定义与 API 客户端基础
  - 创建 `src/lib/types.ts`：复用 Gateway 的 `ServerMessage`（含新增 `todos_updated`）、`ClientMessage`、`SessionInfo`、`CreateSessionRequest`；新增 `FileEntry`、`FileListResponse`、`FileNode`、`Todo`、`CronJob`、`Skill` 类型
  - 创建 `src/lib/gateway.ts`：封装所有 REST 调用——`checkHealth`、`listSessions`、`createSession`、`deleteSession`、`getSessionTodos(sessionId)`、`listFiles(sessionId, path?)`、`getGlobalTodos()`、`getCronJobs()`、`toggleCron(id, enabled)`、`deleteCron(id)`、`getSkills()`
  - 创建 `src/lib/wsClient.ts`：WebSocket 客户端，支持指数退避自动重连（1s→2s→4s→8s→16s，最多 5 次）、断线消息队列、`onMessage(msg: ServerMessage)` 回调
  - 创建 `src/lib/markdown.ts`：配置 react-markdown + remark-gfm + react-syntax-highlighter
  - _需求：US-1、US-2、US-8、US-9、US-10、US-11_

- [x] 3. connectionStore — Gateway 连接配置
  - 创建 `src/store/connectionStore.ts`（Zustand）
  - 状态：`gatewayUrl`（默认 `http://localhost:3282`）、`authToken`、`isConnected`、`isChecking`
  - Actions：`setConfig(url, token)` 保存到 localStorage；`checkConnection()` 调用 `/health` 更新 `isConnected`；`loadFromStorage()` 从 localStorage 恢复
  - _需求：US-8_

- [x] 4. sessionStore — 会话列表与 WebSocket 连接管理
  - 创建 `src/store/sessionStore.ts`（Zustand）
  - 状态：`sessions: SessionInfo[]`、`activeSessionId: string | null`、`wsClients: Map<id, WsClient>`
  - Actions：`fetchSessions`、`createSession(req)`（创建后建立 WS 连接）、`deleteSession(id)`（关闭 WS）、`setActive(id)`、`sendMessage`、`sendAbort`、`sendPermissionReply`、`sendUserReply`
  - WS 收到消息时调用 `messageStore.handleServerMessage`、`todoStore.handleTodosUpdated`、`fileTreeStore` 的 `refresh`
  - _需求：US-4、US-5、US-7_

- [x] 5. messageStore — 消息历史与实时状态
  - 创建 `src/store/messageStore.ts`（Zustand）
  - 状态：`messages: Map<sessionId, DisplayMessage[]>`、`streamingText: Map<sessionId, string>`、`toolCards: Map<sessionId, Map<toolId, ToolCardState>>`、`pendingAskUser: Map<sessionId, string>`、`pendingPermission: Map<sessionId, PermissionRequest>`、`costInfo: Map<sessionId, CostInfo>`
  - `handleServerMessage(sessionId, msg)` 处理全部 ServerMessage 类型：`text_delta` 追加流式缓冲、`tool_start` 创建 ToolCard、`tool_log` 追加日志、`tool_end` 更新状态、`done` 固化消息、`usage` 更新 costInfo、`permission_request` 设置 pendingPermission、`ask_user` 设置 pendingAskUser、`todos_updated` 转发给 todoStore、`cwd_changed` 转发给 fileTreeStore、`error`/`budget_exceeded` 追加错误消息
  - Actions：`appendUserMessage`、`clearSession`
  - _需求：US-1、US-2、US-3、US-5、US-6、US-7、US-9_

- [x] 6. fileTreeStore — 会话文件树（懒加载）
  - 创建 `src/store/fileTreeStore.ts`（Zustand）
  - 状态：`trees: Map<sessionId, FileNode>`、`expanded: Map<sessionId, Set<string>>`、`loading: Map<sessionId, Set<string>>`
  - `loadDir(sessionId, path)` 调用 `GET /sessions/:id/files?path=`，更新对应节点的 `children` 和 `loaded`
  - `toggleExpand(sessionId, path)` 展开时若 `loaded=false` 则触发 `loadDir`
  - `refresh(sessionId)` 清空已加载状态，重新请求根目录
  - `initSession(sessionId)` 会话激活时加载根目录
  - _需求：US-9_

- [x] 7. todoStore — 会话任务产物（仅会话级，不含全局任务）
  - 创建 `src/store/todoStore.ts`（Zustand）
  - 状态：`todos: Map<sessionId, Todo[]>`、`loading: Map<sessionId, boolean>`
  - `fetchTodos(sessionId)` 调用 `GET /sessions/:id/todos`
  - `handleTodosUpdated(sessionId, todos)` 处理 WS `todos_updated` 事件，直接替换列表
  - `clearSession(sessionId)` 会话销毁时清理
  - **注意：此 store 不包含全局任务，全局任务由 automationStore 管理**
  - _需求：US-9_

- [x] 8. automationStore — 全局任务与定时任务（跨会话）
  - 创建 `src/store/automationStore.ts`（Zustand）
  - 状态：`globalTodos: Todo[]`、`cronJobs: CronJob[]`、`loading: { todos: boolean; crons: boolean }`
  - `fetchGlobalTodos()` 调用 `GET /todos`
  - `fetchCronJobs()` 调用 `GET /crons`
  - `toggleCron(id, enabled)` 调用 `PUT /crons/:id/toggle`，乐观更新本地状态
  - `deleteCron(id)` 调用 `DELETE /crons/:id`，成功后从列表移除
  - _需求：US-10_

- [x] 9. ConnectPage — 连接配置页
  - 创建 `src/components/pages/ConnectPage.tsx`
  - UI：hrids-agent Logo/标题、Gateway URL 输入框（默认 `http://localhost:3282`）、Auth Token 输入框（密码类型，可选）、连接按钮（调用 `checkConnection()`）、连接中 loading 状态、连接失败错误提示
  - _需求：US-8_

- [x] 10. NavBar — 左侧导航栏
  - 创建 `src/components/layout/NavBar.tsx`（宽度 64px）
  - 从上到下：`[+] 新建`（打开 NewSessionModal）、`[🧠] 专家`（暂显示"即将推出"）、`[⚡] 技能`（切换 SkillsPage）、`[🤖] 自动`（切换 AutomationPage）、分割线、会话列表（可滚动）
  - 会话列表每项：状态图标（● ready 绿 / ⟳ busy 黄旋转 / ○ stopped 灰）+ 会话 ID 前8位，活跃会话高亮（左侧蓝色竖条），悬停显示删除按钮（需 ConfirmModal 二次确认）
  - 当前激活的导航项显示蓝色竖条高亮
  - _需求：US-4、US-10、US-11_

- [x] 11. ToolCard — 工具执行卡片
  - 创建 `src/components/chat/ToolCard.tsx`
  - Props：`toolName`、`input: unknown`、`status: 'pending'|'success'|'error'|'denied'`、`logs: string[]`、`result?: unknown`、`isExpanded?: boolean`、`onToggle?: () => void`
  - 标题行：状态图标（⟳ 黄旋转 / ✓ 绿 / ✗ 红 / ⊘ 橙）+ 工具名 + 折叠按钮 + 状态标签
  - 折叠内容：输入参数（JSON 代码块）、执行日志（等宽字体，最多 30 行，超出可滚动）、执行结果（截断超 500 字符）
  - _需求：US-2_

- [x] 12. MessageList + MessageItem — 消息列表
  - 创建 `src/components/chat/MessageList.tsx` 和 `MessageItem.tsx`
  - `user`：右对齐气泡（`bg-blue-600`）；`assistant`：左对齐 Markdown 渲染（含代码高亮）+ 底部 token 用量；`tool`：嵌入 ToolCard；`system`：居中灰色小字；`error`：`bg-red-900/30`
  - 流式输出：从 `streamingText` 读取缓冲，末尾追加光标动画 `▋`，`done` 后固化
  - 使用 `@tanstack/react-virtual` 虚拟滚动，新消息自动滚底，用户手动上滚时暂停自动滚动
  - _需求：US-1、US-2、US-6_

- [x] 13. InputBar — 输入栏
  - 创建 `src/components/chat/InputBar.tsx`
  - 普通模式：`textarea` 自动扩展高度（最多 6 行），Enter 发送，Shift+Enter 换行，发送中禁用输入并显示"中止"按钮，空消息不允许发送
  - ask_user 模式：显示问题文本（灰色背景），预设选项显示为可点击按钮组，placeholder 变为"输入回答..."
  - 暴露 `insertText(text: string)` 方法，在光标位置插入文本（供 FileTreeNode 点击文件时调用 `@<path>`）
  - _需求：US-1、US-5、US-7、US-9_

- [x] 14. PermissionModal — 权限确认弹窗
  - 创建 `src/components/modals/PermissionModal.tsx`
  - 模态遮罩（点击外部不关闭）、工具名称（大字体）、操作描述（完整显示）、只读/写操作标签、5 分钟倒计时进度条、"拒绝"（灰色）和"允许执行"（蓝色）按钮
  - 点击后发送 `permission_reply`；倒计时归零自动拒绝并提示用户
  - _需求：US-3_

- [x] 15. StatusBar — 底部状态栏
  - 创建 `src/components/layout/StatusBar.tsx`
  - 显示：当前模型名称、累计 token（输入 + 输出）、累计费用（USD，保留 4 位小数）、WS 连接状态（已连接 / 重连中 / 断开）
  - 每次 `usage` 事件后数字更新
  - _需求：US-6_

- [x] 16. RightPanel — 右侧面板（Tab 容器）
  - 创建 `src/components/layout/RightPanel.tsx`
  - Tab 栏：`任务产物` | `工作目录`，下划线高亮当前 Tab
  - 右上角 `[›]`/`[‹]` 折叠/展开按钮，`transition-all duration-200`，展开宽度 280px，折叠收缩为 0
  - 无活跃会话时整体隐藏；会话切换时保持 Tab 选中状态，内容自动切换
  - _需求：US-9_

- [x] 17. TodoArtifacts + TodoItem — 任务产物 Tab
  - 创建 `src/components/panel/TodoArtifacts.tsx` 和 `TodoItem.tsx`
  - 从 `todoStore` 读取当前会话任务，**不显示全局任务**
  - `TodoItem` 显示：状态图标（`▸` 橙色进行中 / `○` 灰色待处理 / `✓` 绿色已完成+删除线）、优先级标签（高红/中黄/低灰）、任务内容
  - 底部统计栏：`共 N 项 · M 进行中 · K 已完成`
  - 空列表显示"暂无任务产物"（灰色居中）；加载中显示骨架屏
  - _需求：US-9_

- [x] 18. FileTreeView + FileTreeNode — 工作目录 Tab
  - 创建 `src/components/panel/FileTreeView.tsx` 和 `FileTreeNode.tsx`
  - `FileTreeView`：顶部显示 cwd 路径（截断，hover tooltip 完整路径）+ `[↻]` 刷新按钮；从 `fileTreeStore` 读取当前会话文件树
  - `FileTreeNode`（递归）：目录显示 `▶`/`▼` + `📁` + 名称，点击展开/折叠（懒加载，展开中显示旋转动画）；文件显示 `📄` + 名称，点击调用 `InputBar.insertText('@<path>')`；隐藏文件（`.` 开头）灰色显示；每层缩进 `depth * 12px`
  - _需求：US-9_

- [x] 19. AutomationPage — 自动化页面
  - 创建 `src/components/pages/AutomationPage.tsx`
  - **全局任务区块**：标题"全局任务" + `[↻]` 刷新按钮；从 `automationStore.globalTodos` 读取，使用 `TodoItem` 渲染；空列表显示"暂无全局任务"
  - **定时任务区块**：标题"定时任务"；每条 `CronJob` 显示启用/禁用开关（`●`/`○`，点击调用 `toggleCron`）、描述文字、cron 表达式（等宽字体灰色）、下次执行时间、`[删除]` 按钮（需 ConfirmModal 二次确认）；空列表显示"暂无定时任务"
  - _需求：US-10_

- [x] 20. SkillsPage — 技能页面
  - 创建 `src/components/pages/SkillsPage.tsx`
  - 技能卡片列表，每张卡片显示：名称、来源标签（内置/用户/项目）、描述摘要
  - 点击卡片展开查看完整 prompt 内容（Markdown 渲染）
  - _需求：US-11_

- [x] 21. ChatPage + App.tsx — 页面组装与路由
  - 创建 `src/components/pages/ChatPage.tsx`：三栏布局（NavBar 64px + ChatArea flex-1 + RightPanel 280px 可折叠）；ChatArea 内部为顶部标题栏 + MessageList + InputBar + StatusBar；无活跃会话时中间显示欢迎文字 + "新建会话"按钮
  - 创建 `src/components/modals/NewSessionModal.tsx`：模型输入框、工作目录输入框（可选）、自动模式 checkbox
  - 创建 `src/components/modals/ConfirmModal.tsx`：通用二次确认弹窗
  - 创建 `src/App.tsx`：启动时 `loadFromStorage()` → `checkConnection()`；失败显示 ConnectPage；成功后 `fetchSessions()` 进入主界面；主界面根据 NavBar 选中项渲染 ChatPage / SkillsPage / AutomationPage
  - _需求：US-1 至 US-11_

- [x] 22. 后端：TodoWriteTool 会话级隔离
  - 修改 `src/tools/TodoWriteTool.ts`
  - 新增模块级变量 `currentSessionId: string | null = null`，导出 `setTodoSessionId(id)` / `getTodoSessionId()`
  - 新增 `getTodoFile()` 函数：有 sessionId 时返回 `~/.hrids-agent/sessions/<id>/todos.json`，无则返回全局 `~/.hrids-agent/todos.json`
  - `loadTodos()` 和 `saveTodos()` 改用 `getTodoFile()` 替代硬编码路径
  - 修改 `src/gateway/SessionManager.ts`：`createSession()` 调用 `setTodoSessionId(sessionId)`，`destroySession()` 调用 `setTodoSessionId(null)`
  - _需求：US-9，约束与边界_

- [x] 23. 后端：新增 REST 接口
  - 修改 `src/gateway/server.ts`，新增以下路由（在鉴权中间件之后）：
  - `GET /todos`：读取全局 `todos.json`，返回 `Todo[]`，文件不存在返回 `[]`
  - `GET /sessions/:id/todos`：读取 `sessions/<id>/todos.json`，返回 `Todo[]`，会话不存在返回 404
  - `GET /sessions/:id/files?path=`：读取目录内容，安全检查禁止 `..` 跳出 cwd（返回 403），目录优先排序
  - `GET /crons`：读取 `crons.json`，返回 `CronJob[]`
  - `PUT /crons/:id/toggle`：读取 body `{ enabled: boolean }`，更新 `crons.json` 中对应条目
  - `DELETE /crons/:id`：从 `crons.json` 删除对应条目
  - `GET /skills`：调用 `buildSkillRegistry()` 返回已安装技能列表
  - 补充顶部 import：`readFileSync`、`writeFileSync`、`existsSync`、`readdirSync`、`statSync`、`resolve`、`join`、`homedir`
  - _需求：US-9、US-10、US-11，约束与边界_

- [x] 24. 后端：WebSocket 推送 todos_updated 事件
  - 修改 `src/tools/TodoWriteTool.ts`：新增 `setTodosUpdatedCallback(cb: (sessionId: string, todos: Todo[]) => void)`；`execute()` 保存成功后，若 `currentSessionId` 非空则调用回调
  - 修改 `src/gateway/SessionManager.ts`：`createSession()` 中调用 `setTodosUpdatedCallback`，回调内 `this.broadcast(session, { type: 'todos_updated', todos })`
  - 修改 `src/gateway/types.ts`：`ServerMessage` 联合类型添加 `| { type: 'todos_updated'; todos: Todo[] }`
  - _需求：US-9，约束与边界_

- [x] 25. 后端：静态文件托管 + CORS
  - 修改 `src/gateway/server.ts`：在所有 API 路由之前添加 CORS 中间件（`corsOrigin` 可配置，默认 `*`，处理 OPTIONS 预检）；在 `GatewayConfig` 添加 `corsOrigin?: string` 字段
  - 在 API 路由之后添加静态文件中间件：检测 `web/dist/` 是否存在，存在则 `express.static` + SPA fallback（`GET *` 返回 `index.html`）
  - 根目录 `package.json` 添加 `"build:web": "npm run build --prefix web"` 脚本
  - _需求：非功能需求（构建产物），约束与边界_

- [x] 26. WS 断线重连与错误处理
  - `src/lib/wsClient.ts` 实现指数退避重连逻辑（1s→2s→4s→8s→16s，最多 5 次）
  - 重连中 StatusBar 显示"重连中..."状态（橙色）
  - 5 次重连失败后显示 toast 提示 + 手动重连按钮
  - _需求：非功能需求_

- [ ] 27. 键盘快捷键与响应式适配
  - [ ]* 27.1 键盘快捷键：`Ctrl+N` 新建会话、`Ctrl+W` 关闭当前会话、`Ctrl+K` 清空消息（仅前端）、`Escape` 关闭弹窗/中止任务、`↑` 恢复上一条消息
  - [ ]* 27.2 响应式：移动端（<768px）NavBar 默认隐藏（汉堡菜单展开）、右侧面板默认折叠、输入框占满宽度
  - _需求：非功能需求（响应式）_

## 备注

- 标有 `*` 的子任务为可选项，可跳过以加快 MVP 进度
- 任务 1–21 为前端，任务 22–25 为后端改造，任务 26–27 为打磨优化
- 执行顺序建议：1 → 2 → 3–8（可并行）→ 9–20（可并行）→ 21 → 22 → 23 → 24 → 25 → 26 → 27
- 任务 16、17、18 依赖任务 6、7；任务 19 依赖任务 8；任务 20 依赖任务 2
- 后端任务 22 → 23 → 24 需顺序执行；任务 25 可与 22–24 并行
