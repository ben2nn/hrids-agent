# Claude Code 源码分析报告

> 分析目标：`D:\myproject\hrids-agent\refercode\claude-code-main`
> 分析日期：2026-05-13
> 项目代号：Tengu

---

## 项目简介

Claude Code 是 Anthropic 官方的 AI 编程代理 CLI 工具，内部代号 "Tengu"。采用 TypeScript 编写，基于 Bun 运行时，构建于 Anthropic SDK 之上。核心引擎由七大模块构成：查询引擎 (QueryEngine)、查询循环 (query)、任务系统 (Task/tasks)、上下文管理 (context)、会话历史 (history)、会话远程历史 (sessionHistory) 和初始化 (setup)。

**核心特点**：
- **AsyncGenerator 驱动** — 整个消息管道基于 AsyncGenerator 实现，支持背压和流式处理
- **多层上下文压缩** — Snip → Microcompact → Context Collapse → Autocompact 四级压缩管线
- **分层权限系统** — 工具级 → 规则级 → 模式级 → 分类器级，逐层检查
- **Bridge 远程架构** — 支持本地 CLI 与远程环境的解耦

## 文档结构

| 文档 | 内容 |
|------|------|
| [architecture.md](architecture.md) | 核心架构（QueryEngine、查询循环、状态管理） |
| [tool-system.md](tool-system.md) | 工具系统（接口定义、注册机制、核心工具实现） |
| [command-permission.md](command-permission.md) | 命令与权限系统（命令调度、权限决策流程） |
| [cost-session.md](cost-session.md) | 成本追踪与会话管理（OTel 集成、Bridge 架构） |
| [reference-value.md](reference-value.md) | 参考价值评估与借鉴建议 |

## 技术栈

| 维度 | 详情 |
|------|------|
| **语言** | TypeScript |
| **运行时** | Bun |
| **UI 框架** | Ink (React) |
| **SDK** | Anthropic SDK |
| **可观测性** | OpenTelemetry |

## 核心发现

### 高参考价值设计

1. **AsyncGenerator 消息管道** — 支持背压和流式处理的优雅架构
2. **四层上下文压缩管线** — Snip/Microcompact/Context Collapse/Autocompact
3. **分层权限系统** — 工具级 → 规则级 → 模式级 → 分类器级
4. **错误扣留机制** — 可恢复错误先扣留，恢复成功后丢弃
5. **依赖注入** — QueryDeps 接口使测试可注入 mock
6. **Feature Gate + Dead Code Elimination** — 编译时代码消除

### 架构亮点

```
+---------------------------+
|     QueryEngine           |  <-- 会话级生命周期管理
|  (submitMessage loop)     |
+---------------------------+
            |
            v
+---------------------------+
|     query() / queryLoop() |  <-- 查询级循环（模型调用+工具执行）
|  (while(true) agentic     |
|   loop with recovery)     |
+---------------------------+
            |
            v
+---------------------------+
|  deps.callModel()         |  <-- API 调用层
|  deps.autocompact()       |
|  runTools() / Streaming   |
|  ToolExecutor             |
+---------------------------+
```
