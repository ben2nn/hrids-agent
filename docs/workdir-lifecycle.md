# 工作目录生命周期管理设计方案

> 状态：待实施
> 日期：2026-05-09

## 背景

当前 `getSessionWorkDir()` 在会话创建时立即执行 `mkdirSync` + `git init`，但很多会话只是纯对话，不需要写文件，导致产生大量空的 git 仓库目录和不必要的 I/O 开销。

## 设计目标

1. 会话启动时**不创建工作目录**，只计算路径
2. 由智能体根据执行需要**自主决定**何时创建工作目录
3. 工作目录的创建、交付、清理过程在聊天记录中**可见**
4. 现阶段采用**永久保留、人为管理**策略

## 核心概念

### 生命周期状态

```
[未创建] → workdir_init → [活跃] → 任务完成 → [已交付] → 永久保留 / 人工清理
```

### 调用流程

```
用户："帮我完成 XXX 任务"
  ↓
智能体规划步骤
  ↓
发现需要写文件 / 执行代码 / 存储中间结果
  ↓
调用 workdir_init → 创建目录 + git init，聊天记录可见
  ↓
执行任务，读写文件
  ↓
任务完成 → 调用 workdir_deliver → 输出交付摘要
  ↓
用户确认 → 目录永久保留，用户自行管理
```

## 智能体自主决策（方案 v3）

工作目录的创建**不依赖用户明确表达"写文件"的意图**，而是由智能体在执行任务过程中，根据自身需要自主判断是否创建工作空间。

### 决策逻辑

智能体接收到用户任务后，内部规划执行步骤。当发现某个步骤需要写文件、执行代码、或存储中间结果时，主动调用 `workdir_init` 创建工作目录。

### 调用场景

| 用户输入 | 智能体行为 |
|---------|-----------|
| "今天天气怎么样" | 纯对话，不创建工作目录 |
| "帮我写个贪吃蛇游戏" | 识别需要写代码 → 调用 `workdir_init` → 写文件 |
| "分析一下这个数据" | 可能需要临时文件 → 调用 `workdir_init` → 处理 |
| "帮我重构这段代码" | 需要读写文件 → 调用 `workdir_init` → 操作 |
| "帮我完成 XXX 任务" | 智能体判断任务执行需要工作空间 → 自主创建 |

### 关键设计点

- **用户无感知**：用户只需描述任务，无需关心是否需要工作目录
- **智能体自主**：由大模型根据任务复杂度和执行步骤自行判断
- **过程可见**：创建、交付、清理操作均在聊天记录中可追踪
- **幂等安全**：重复调用 `workdir_init` 不会重复创建，返回已有路径

## 文件上传与引用体系

### 存储路径

用户上传的文件属于**会话级输入数据**，存放在 session 目录下：

```
~/.hrids/sessions/<sessionId>/uploads/<filename>
```

废弃原有的 `<workDir>/.cache/` 路径，不再使用。

### `@` 引用解析

用户和 LLM 通过 `@filename` 语法引用文件，MediaProcessor 按以下顺序查找：

```
@photo.jpg
  → 1. cwd（工作目录）              如存在则使用
  → 2. sessions/<id>/uploads/（上传目录） 如存在则使用
  → 3. 未找到 → 报错
```

- LLM 发送 `@filename` → MediaProcessor 自动搜索两个位置
- 用户在消息中输入 `@filename` → 同样走上述解析逻辑
- 系统提示中只展示**文件名**（不含 `.cache/` 前缀），简洁明了

### 前端显示

- 系统提示中的文件列表：`可引用文件：photo.jpg, data.pdf`
- 上传 API 返回：`{ name: "photo.jpg", ... }`（不含路径前缀）
- 用户消息中的引用：`@photo.jpg`（不含 `.cache/`）
- IM 消息中的引用：`@photo.jpg`

### 设计要点

- 上传文件与会话元数据放在一起，生命周期天然绑定会话
- 不依赖 workDir 是否已创建，上传随时可用
- `@` 引用统一为 `@filename`，用户无需关心文件实际存储位置
- 会话删除时，uploads 目录随 session 目录一并清理

### 与 workDir 的关系

```
用户上传文件 → sessions/<id>/uploads/
用户消息 @photo.jpg → MediaProcessor 搜索 uploads/ → 找到文件
                 ↓
智能体调用 workdir_init → work/<dir>/ 创建
智能体产出文件 → work/<dir>/photo.py
                 ↓
后续 @photo.py → MediaProcessor 搜索 cwd → 找到文件
后续 @photo.jpg → MediaProcessor 搜索 cwd 未找到 → 搜索 uploads/ → 找到文件
```

两个位置的文件通过 `@filename` 统一引用，互不干扰。

## 工具设计

### 1. workdir_init

创建工作目录。

```
工具名：workdir_init
描述：为当前会话创建专用工作目录。
     当你执行任务需要存储文件、运行代码、或进行任何文件操作时，
     先调用此工具创建工作空间。
     如果目录已存在则直接返回路径，不会重复创建。

参数：无

返回：目录路径 + 创建状态（新建 / 已存在）
```

### 2. workdir_deliver

任务完成时整理交付摘要。

```
工具名：workdir_deliver
描述：整理当前工作目录中的产出物，生成交付摘要。
     在任务完成时调用，将结果汇总呈现给用户。

参数：
  summary: string    - 任务完成摘要
  outputs: string[]  - 产出文件路径列表（相对于工作目录）

返回：格式化的交付报告，包含产出物列表和目录路径
```

### 3. workdir_cleanup

清理工作目录（现阶段由用户主动触发）。

```
工具名：workdir_cleanup
描述：清理当前会话的工作目录。
     仅在用户明确要求时调用。会先确认目录中的重要文件已交付。

参数：无

返回：清理结果
```

### 4. workdir_list

列出所有工作目录。

```
工具名：workdir_list
描述：列出所有工作目录及其信息，方便用户管理和查找历史工作空间。

参数：无

返回：工作目录列表，包含路径、创建时间、关联会话等信息
```

## 涉及文件

| 文件 | 改动 |
|------|------|
| `src/core/ContextBuilder.ts` | 拆分为 `getSessionWorkDirPath()` + `ensureWorkDir()`；移除 `.cache` 文件列表注入 |
| `src/core/cwd.ts` | 新增 `ensureWorkDirForCurrentCwd()` |
| `src/core/MediaProcessor.ts` | `extractMediaFromText` 增加 uploads 目录搜索路径 |
| `src/tools/WorkdirInitTool.ts` | **新增** - workdir_init 工具 |
| `src/tools/WorkdirDeliverTool.ts` | **新增** - workdir_deliver 工具 |
| `src/tools/WorkdirCleanupTool.ts` | **新增** - workdir_cleanup 工具 |
| `src/tools/WorkdirListTool.ts` | **新增** - workdir_list 工具 |
| `src/tools/index.ts` | 注册新工具 |
| `src/bootstrap/setupSession.ts` | 改用 `getSessionWorkDirPath()` |
| `src/gateway/SessionManager.ts` | 改用 `getSessionWorkDirPath()`；`extractRecentImagesFromHistory` 搜索 uploads 目录 |
| `src/tui/App.tsx` | 改用 `getSessionWorkDirPath()` |
| `src/modes/serverMode.ts` | 同上 |
| `src/gateway/server.ts` | 上传路径改为 `<sessionDir>/uploads/`；返回 `name` 去掉 `.cache/` 前缀 |

## Prompt 引导

在智能体系统 prompt 中加入：

```
当你执行任务需要工作空间（存储文件、运行代码、保存中间结果等）时，
先调用 workdir_init 工具创建工作目录。
任务完成后，调用 workdir_deliver 工具整理交付摘要。
纯对话类任务无需创建工作目录。
```

## 用户体验示例

```
用户：帮我写一个贪吃蛇游戏

智能体：好的，我来为你创建。
  → [调用 workdir_init]
  → [系统：工作目录已创建: ~/.hrids/work/20260509-xxx]

智能体：（编写代码...）

智能体：完成了！
  → [调用 workdir_deliver]
  → [系统：交付摘要]
     - snake.py：贪吃蛇游戏主程序
     - README.md：使用说明
     - 工作目录：~/.hrids/work/20260509-xxx

用户：不错，清理掉吧

智能体：好的
  → [调用 workdir_cleanup]
  → [系统：工作目录已清理]
```

## 保留策略

现阶段：**永久保留，人为管理**。

后续可扩展：
- 按时间自动清理（如 7 天过期）
- 用户标记"保留"防止清理
- 定期扫描提示用户清理过期目录
