# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

hrids-agent 是一个原创智能体 CLI 工具，采用事件溯源架构和流式 Agent 循环。使用 Ink (React for Terminal) 构建终端 UI，同时提供独立的 Web 前端。

## Common Commands

```bash
# Development
npm run dev              # tsx 启动 CLI (src/cli/index.ts)
npm run dev:craft        # craft 模式启动
npm run gateway          # 构建 web 前端 + 启动 gateway 服务

# Build
npm run build            # 构建 web 前端 + tsc 编译
npm run build:web        # 仅构建 web 前端
npm run build:core       # 仅 tsc 编译
npm run start            # 运行编译产物 (dist/cli/index.js)

# Test
npm test                 # vitest --run (单次运行)
npm run test:watch       # vitest watch 模式
npm run test:coverage    # 带覆盖率报告
# 运行单个测试文件:
npx vitest --run tests/unit/Config.test.ts
# 运行匹配名称的测试:
npx vitest --run -t "test name pattern"

# Lint
npm run lint             # eslint .
```

## Architecture

### Entry Points

- **src/cli/index.ts** — CLI 入口 (Commander + 懒加载子命令)，`npm run dev` / `npm run start` / `bin/hrids-agent.mjs` 均使用此入口
- **bin/hrids-agent.mjs** — npm 二进制入口，指向 `dist/cli/index.js`

### Core: Event-Sourced Agentic Loop

核心引擎在 `src/core/QueryEngine.ts`，实现流式 Agent 循环：

1. 接收用户消息 → 媒体预处理 (@-引用)
2. 动态构建系统提示 (任务分类 + 工具注入)
3. 流式调用 LLM (`streamOneTurn`)
4. 解析工具调用 → `ToolScheduler` 并行/串行分批执行
5. 工具结果回传 LLM，循环直到：无工具调用 / DONE 标记 / 轮次上限 / 预算耗尽 / 中止

关键机制：
- **事件溯源**：`ConversationStore` 双存储 — `messages.jsonl` (LLM 视图) + `events.jsonl` (完整生命周期)，通过 `projections.ts` 派生不同视图
- **FallbackProvider**：多 Provider 故障转移 + 指数退避重试，同平台优先，跨平台兜底
- **StormBreaker**：防止重复工具调用风暴的去抖机制
- **Auto-compact**：Token 超阈值 (默认 100k) 时 LLM 生成结构化摘要替换历史

### Four Runtime Modes (src/modes/)

| 模式 | 说明 |
|------|------|
| interactiveMode | Ink React TUI (默认) |
| printMode | `-p` 单次执行，输出到 stdout |
| serverMode | NDJSON over stdin，程序化集成 |
| gatewayMode | HTTP + WebSocket 服务器，含嵌入式 Web UI |

### Provider Layer (src/core/providers/)

YAML 驱动的 Provider 注册表 (`builtin/` 目录下 13 个 Provider YAML 文件)。支持别名、自定义 Provider 解析、多 Provider 故障转移链。

传输实现：`OpenAIProvider` (OpenAI 兼容) 和 `AnthropicProvider` (Anthropic Messages)。

### Tool System (src/tools/)

所有工具实现 `ToolDef<T>` 接口：Zod 输入 Schema + 权限检查 + execute 函数。工具通过 `ToolRegistry` 注册，支持 plan-mode 拦截和审计。

主要类别：文件系统 (FileRead/Write/Edit/Glob/Grep)、Shell (BashTool)、Web (Fetch/Search)、任务管理 (Todo/Plan)、Agent 协调 (Agent/Team)、Memory、Skills、MCP。

### Memory System (src/memory/)

4 层架构：L0 Identity (固定身份) → L1 Summary (重要性排序) → L2 On-demand (按需分类) → L3 Search (sqlite-vec 向量搜索 / TF-IDF 兜底)。

### Ink TUI Components (src/cli/ui/)

按领域组织：`app/` (壳)、`input/` (输入)、`messages/` (消息流)、`permissions/` (权限请求)、`sessions/` (会话管理)、`agents/` (Agent 管理)、`dialogs/` (弹窗)、`design-system/` (基础组件)。

### Web Frontend (web/)

独立 npm 包，React 18 + Vite 6 + Tailwind CSS 3 + Zustand 5。通过 `npm run build --prefix web` 从根目录构建。Gateway 模式下由 Express 提供静态文件服务。

### Multi-Agent Coordination (src/core/coordinator/)

`AgentPool` 管理子 Agent 生命周期，`MessageBus` 处理 Agent 间通信，`TeamManager` 管理团队创建。Agent 配置从 `~/.hrids/agents/` 和 `~/.hrids/roles/` 加载（内置专家在代码中定义，用户自定义专家放 `~/.hrids/roles/`）。

## Configuration

- **主配置**：`~/.hrids/config.yaml` (YAML，参考 `config.example.yaml`)
- **MCP 配置**：`~/.hrids/mcp.json` (兼容 Claude Desktop 格式)
- **权限规则**：`~/.hrids/permission-rules.json`
- **会话数据**：`~/.hrids/sessions/`
- **记忆存储**：`~/.hrids/memory/` (SQLite)
- **项目级配置**：`{cwd}/AGENT.md` 或 `{cwd}/.hrids/AGENT.md`

## Tech Stack

- ESM (`"type": "module"`)，Node.js >= 18
- TypeScript 5.7+ (strict, ES2022 target, bundler resolution)
- 测试：Vitest 2.x + fast-check (属性测试)
- Lint：ESLint 9.x + typescript-eslint
- CI：GitHub Actions (lint → build → test + coverage)
