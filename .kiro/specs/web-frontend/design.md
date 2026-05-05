# Web 前端 UI — 产品设计文档

## 技术架构

### 目录结构

```
web/                          # 独立的前端项目根目录
├── index.html
├── package.json
├── vite.config.ts
├── tailwind.config.ts
├── tsconfig.json
└── src/
    ├── main.tsx              # 入口
    ├── App.tsx               # 根组件（路由：配置页 / 主界面）
    ├── store/
    │   ├── connectionStore.ts   # Gateway 连接配置
    │   ├── sessionStore.ts      # 会话列表和当前会话
    │   ├── messageStore.ts      # 消息历史（按 sessionId 分组）
    │   ├── fileTreeStore.ts     # 文件树状态（按 sessionId 分组）
    │   ├── todoStore.ts         # 会话任务产物（按 sessionId 分组）
    │   └── automationStore.ts   # 全局任务 + 定时任务（跨会话）
    ├── hooks/
    │   ├── useWebSocket.ts      # WebSocket 连接管理（重连、心跳）
    │   ├── useSession.ts        # 会话 CRUD 操作
    │   ├── useGateway.ts        # REST API 封装
    │   ├── useFileTree.ts       # 文件树加载和展开状态
    │   └── useTodos.ts          # 会话任务产物加载和实时更新
    ├── components/
    │   ├── layout/
    │   │   ├── NavBar.tsx        # 左侧导航栏（图标 + 会话列表）
    │   │   ├── ChatArea.tsx      # 中间对话区域
    │   │   ├── RightPanel.tsx    # 右侧面板（Tab 容器，可折叠）
    │   │   └── StatusBar.tsx     # 底部状态栏
    │   ├── chat/
    │   │   ├── MessageList.tsx   # 消息列表（虚拟滚动）
    │   │   ├── MessageItem.tsx   # 单条消息（user/assistant/tool/system）
    │   │   ├── ToolCard.tsx      # 工具执行卡片（可折叠）
    │   │   ├── InputBar.tsx      # 输入框 + 发送/中止按钮
    │   │   └── StreamingText.tsx # 流式文本渲染
    │   ├── panel/
    │   │   ├── TodoArtifacts.tsx # 任务产物 Tab（会话级）
    │   │   ├── TodoItem.tsx      # 单条任务（状态图标 + 优先级 + 内容）
    │   │   ├── FileTreeView.tsx  # 工作目录 Tab（含刷新按钮）
    │   │   └── FileTreeNode.tsx  # 文件树节点（目录/文件，递归）
    │   ├── modals/
    │   │   ├── PermissionModal.tsx  # 权限确认弹窗
    │   │   ├── NewSessionModal.tsx  # 新建会话配置
    │   │   └── ConfirmModal.tsx     # 通用确认弹窗
    │   └── pages/
    │       ├── ConnectPage.tsx      # 连接配置页
    │       ├── ChatPage.tsx         # 主对话页（含右侧面板）
    │       ├── AutomationPage.tsx   # 自动化页（全局任务 + 定时任务）
    │       └── SkillsPage.tsx       # 技能页
    └── lib/
        ├── gateway.ts           # Gateway REST API 客户端
        ├── wsClient.ts          # WebSocket 客户端封装
        ├── markdown.ts          # Markdown 渲染配置
        └── types.ts             # 前端类型定义
```

### 状态管理设计

```
connectionStore
  ├── gatewayUrl: string        # http://localhost:3282
  ├── authToken: string         # Bearer token
  ├── connected: boolean        # 健康检查状态
  └── actions: setConfig, checkConnection, loadFromStorage

sessionStore
  ├── sessions: SessionInfo[]   # 从 GET /sessions 获取
  ├── activeSessionId: string | null
  ├── wsMap: Map<id, WsClient>  # 每个会话一个 WS 连接
  └── actions: create, destroy, setActive, refresh, sendMessage, sendAbort

messageStore
  ├── messages: Map<sessionId, DisplayMessage[]>
  ├── streamingText: Map<sessionId, string>
  ├── toolCards: Map<sessionId, Map<toolId, ToolCardState>>
  ├── pendingAskUser: Map<sessionId, string>
  ├── pendingPermission: Map<sessionId, PermissionRequest>
  ├── costInfo: Map<sessionId, CostInfo>
  └── actions: handleServerMessage, appendUserMessage, clearSession

fileTreeStore
  ├── trees: Map<sessionId, FileNode>        # 每个会话的文件树根节点
  ├── expanded: Map<sessionId, Set<string>>  # 已展开的目录路径集合
  ├── loading: Map<sessionId, Set<string>>   # 正在加载的路径集合
  └── actions: loadDir, toggleExpand, refresh, initSession

todoStore  ← 仅会话任务产物，不含全局任务
  ├── todos: Map<sessionId, Todo[]>
  ├── loading: Map<sessionId, boolean>
  └── actions: fetchTodos, handleTodosUpdated, clearSession

automationStore  ← 全局数据，不随会话切换
  ├── globalTodos: Todo[]
  ├── cronJobs: CronJob[]
  ├── loading: { todos: boolean; crons: boolean }
  └── actions: fetchGlobalTodos, fetchCronJobs, toggleCron, deleteCron
```

**类型定义：**
```typescript
// 文件树节点
interface FileNode {
  name: string
  path: string          // 相对于 cwd 的路径
  type: 'file' | 'dir'
  children?: FileNode[] // 懒加载，展开时才填充
  loaded: boolean
}

// 任务（与后端 TodoWriteTool 一致）
interface Todo {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  priority: 'high' | 'medium' | 'low'
}

// 定时任务（与后端 ScheduleCronTool 一致）
interface CronJob {
  id: string
  expression: string
  description: string
  task: string
  createdAt: number
  lastRunAt?: number
  nextRunAt?: number
  enabled: boolean
  once?: boolean
}
```

**数据归属规则：**
| 数据 | Store | 后端路径 | 接口 | 更新方式 |
|------|-------|---------|------|---------|
| 会话任务产物 | `todoStore` | `sessions/<id>/todos.json` | `GET /sessions/:id/todos` | WS `todos_updated` |
| 全局任务 | `automationStore` | `todos.json` | `GET /todos` | 手动刷新 |
| 定时任务 | `automationStore` | `crons.json` | `GET /crons` | 手动刷新 |

### WebSocket 事件处理流

```
WS 收到消息
  ├── ready              → 会话就绪，更新 session status
  ├── text_delta         → 追加到 streamingText buffer
  ├── tool_start         → 创建 ToolCard（pending 状态）
  ├── tool_log           → 追加到对应 ToolCard 的 logs
  ├── tool_end           → 更新 ToolCard 状态（success/error）
  ├── todos_updated      → 刷新 todoStore 中当前会话的任务产物
  ├── permission_request → 显示 PermissionModal
  ├── ask_user           → 切换输入框为回答模式
  ├── usage              → 更新 token/cost 显示
  ├── cwd_changed        → 刷新 fileTreeStore 根目录
  ├── done               → 固化 streamingText 为消息，恢复输入
  ├── error              → 显示错误消息
  └── budget_exceeded    → 显示预算警告 toast
```

---

## UI 设计规范

### 整体布局（桌面端）

```
┌────────────────────────────────────────────────────────────────────────┐
│ ┌──────┐  ┌──────────────────────────────────┐  ┌──────────────────┐  │
│ │  +   │  │  会话标题 / 模型名称      [中止]  │  │ 任务产物│工作目录 │  │
│ │ 新建 │  ├──────────────────────────────────┤  ├──────────────────┤  │
│ │──────│  │                                  │  │ ▸ 高 实现登录功能 │  │
│ │  🧠  │  │         消息列表区域              │  │ ○ 中 编写单元测试 │  │
│ │ 专家 │  │   （流式输出 + 工具卡片）          │  │ ✓ 低 更新文档     │  │
│ │──────│  │                                  │  │                  │  │
│ │  ⚡  │  ├──────────────────────────────────┤  │                  │  │
│ │ 技能 │  │  [输入框.................] [发送] │  ├──────────────────┤  │
│ │──────│  ├──────────────────────────────────┤  │ 3项·1进行·1完成  │  │
│ │  🤖  │  │  qwen3.5  1.2k tokens  $0.002    │  └──────────────────┘  │
│ │ 自动 │  └──────────────────────────────────┘   280px，可折叠 [›]    │
│ │──────│                                                               │
│ │ 会话 │                                                               │
│ │  ●s1 │                                                               │
│ │  ○s2 │                                                               │
│ └──────┘                                                               │
│  64px   弹性宽度（flex-1）                                              │
└────────────────────────────────────────────────────────────────────────┘
```

左侧导航栏为图标+文字的窄栏（64px），下方是会话列表。点击导航图标切换中间区域的页面视图。

### 左侧导航栏结构

```
┌──────┐
│  +   │  ← 新建会话按钮（始终可见）
│ 新建 │
├──────┤
│  🧠  │  ← 专家（后续迭代，暂显示"即将推出"）
│ 专家 │
├──────┤
│  ⚡  │  ← 技能页面
│ 技能 │
├──────┤
│  🤖  │  ← 自动化页面（全局任务 + 定时任务）
│ 自动 │
├──────┤
│      │  ← 分割线
│ 会话 │  ← 会话列表（可滚动）
│  ●   │    ● ready（绿）
│  ⟳   │    ⟳ busy（黄，旋转）
│  ○   │    ○ stopped（灰）
└──────┘
```

### 右侧面板 Tab 设计

**任务产物 Tab（仅显示当前会话的 todo，无全局任务）：**
```
┌──────────────────────────────────┐
│ 任务产物 │ 工作目录          [›] │
├──────────────────────────────────┤
│ ▸ ██ 高  实现用户登录功能         │  ← in_progress，橙色
│ ○ ██ 中  编写单元测试             │  ← pending，灰色
│ ✓ ██ 低  更新 README 文档         │  ← completed，绿色+删除线
├──────────────────────────────────┤
│ 共 3 项 · 1 进行中 · 1 已完成    │
└──────────────────────────────────┘
```

**工作目录 Tab：**
```
┌──────────────────────────────────┐
│ 任务产物 │ 工作目录     [↻]  [›] │
├──────────────────────────────────┤
│ ~/.hrids-agent/work/session-xxx  │  ← cwd（截断，hover 显示完整）
├──────────────────────────────────┤
│ ▼ 📁 src                         │
│   ▶ 📁 core                      │
│   📄 main.ts                     │
│ 📄 package.json                  │
└──────────────────────────────────┘
```

### 自动化页面设计

```
┌──────────────────────────────────────────────────────┐
│  🤖 自动化                                            │
├──────────────────────────────────────────────────────┤
│  全局任务                                       [↻]  │
│  ─────────────────────────────────────────────────   │
│  ▸ 高  完善记忆系统架构                               │
│  ○ 中  补充核心模块单元测试                           │
│                                                      │
│  定时任务                                            │
│  ─────────────────────────────────────────────────   │
│  ● 每天早9点汇报进展    0 9 * * *   下次: 明天 09:00  [删除] │
│  ○ 每周一代码审查       0 9 * * 1   已禁用            [删除] │
└──────────────────────────────────────────────────────┘
```

定时任务每行左侧有启用/禁用开关（`●` 启用 / `○` 禁用），点击切换。

### 消息类型样式

| 类型 | 对齐 | 背景色 | 说明 |
|------|------|--------|------|
| user | 右对齐 | `bg-blue-600` | 用户消息气泡 |
| assistant | 左对齐 | `bg-gray-800` | Markdown 渲染 |
| tool | 左对齐 | `bg-gray-900` | ToolCard 组件 |
| system | 居中 | 无背景，灰色文字 | 系统提示 |
| error | 左对齐 | `bg-red-900/30` | 错误消息 |

### ToolCard 组件设计

```
┌─────────────────────────────────────────────────────┐
│ ⚙ bash_execute  [展开 ▼]                    ✓ 完成 │
│ ─────────────────────────────────────────────────── │
│ 命令: npm run build                                  │
│ > Building...  > Done in 2.3s                        │
└─────────────────────────────────────────────────────┘
```

状态图标：执行中 `⟳`（黄）/ 成功 `✓`（绿）/ 失败 `✗`（红）/ 权限拒绝 `⊘`（橙）

### 颜色主题（深色）

```css
--bg-primary:    #0f0f0f   /* 主背景 */
--bg-secondary:  #1a1a1a   /* 侧边栏、卡片 */
--bg-tertiary:   #242424   /* 输入框、悬停 */
--border:        #2e2e2e   /* 分割线 */
--text-primary:  #e8e8e8   /* 主文字 */
--text-secondary:#9a9a9a   /* 次要文字 */
--accent:        #3b82f6   /* 蓝色强调 */
--success:       #22c55e   /* 工具成功 */
--warning:       #f59e0b   /* 执行中 */
--error:         #ef4444   /* 错误 */
```

---

## API 接口对接

### REST API（`lib/gateway.ts`）

```typescript
// ── 连接 ──
// GET /health → 检查连接

// ── 会话 ──
// GET /sessions → 获取会话列表
// POST /sessions → 创建会话
// DELETE /sessions/:id → 删除会话

// ── 会话任务产物（新增）──
// GET /sessions/:id/todos → 读取会话任务列表（返回 Todo[]）

// ── 会话文件树（新增）──
// GET /sessions/:id/files?path=<relPath> → 读取目录内容

// ── 全局自动化（新增）──
// GET /todos → 读取全局任务列表（返回 Todo[]）
// GET /crons → 读取定时任务列表（返回 CronJob[]）
// PUT /crons/:id/toggle → 启用/禁用定时任务（body: { enabled: boolean }）
// DELETE /crons/:id → 删除定时任务

// ── 技能（新增）──
// GET /skills → 读取已安装技能列表
```

**`GET /sessions/:id/files` 接口规范：**

请求参数：`path`（query，可选，默认 `.`）

响应体：
```typescript
interface FileListResponse {
  cwd: string
  path: string
  entries: Array<{ name: string; type: 'file' | 'dir'; size?: number; mtime?: number }>
}
```

排序：目录优先，同类型按名称字母序。安全限制：`..` 跳出 `cwd` 返回 403。

### WebSocket 协议（`lib/wsClient.ts`）

连接地址：`ws://<host>:<port>/sessions/<id>/stream?token=<authToken>`

**客户端 → 服务端：**
```typescript
{ type: 'message', content: string }
{ type: 'abort' }
{ type: 'user_reply', answer: string }
{ type: 'permission_reply', key: string, granted: boolean }
{ type: 'set_cwd', cwd: string }
```

**服务端新增推送事件：**
```typescript
{ type: 'todos_updated', todos: Todo[] }  // todo_write 执行后推送
```

---

## 与 Gateway 的集成方式

### 开发阶段
```typescript
// vite.config.ts
proxy: {
  '/sessions': { target: 'http://localhost:3282', ws: true },
  '/todos': { target: 'http://localhost:3282' },
  '/crons': { target: 'http://localhost:3282' },
  '/skills': { target: 'http://localhost:3282' },
  '/health': { target: 'http://localhost:3282' },
}
```

### 生产部署
构建后的 `web/dist/` 由 Gateway Express 托管，访问 `http://localhost:3282` 直接打开前端。

---

## 关键技术决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 构建工具 | Vite | 快速 HMR，零配置 TypeScript |
| 样式 | Tailwind CSS | 无需维护 CSS 文件，与组件共存 |
| 状态管理 | Zustand | 轻量，无 Provider 包裹 |
| Markdown | react-markdown + remark-gfm | 生态最成熟，支持 GFM 和代码高亮 |
| 虚拟滚动 | @tanstack/react-virtual | 长对话性能保障 |
| 代码高亮 | react-syntax-highlighter | 支持 200+ 语言 |
| WebSocket | 原生 API | 无需额外依赖，封装重连逻辑即可 |
