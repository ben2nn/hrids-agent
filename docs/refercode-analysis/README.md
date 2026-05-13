# 参考代码分析

> 本目录存放对各参考项目的源码分析报告，用于提炼可借鉴到 hrids-agent 的设计模式和架构思想。

---

## 架构分析

**[过度设计审计报告](overengineering-audit.md)** — 对项目全部代码的逐模块审计，识别出 ~48,000 行可删除/提取的代码。核心发现：项目试图同时做 5 个产品（终端助手、Web 应用、IM 机器人、多代理编排、技能市场），核心编程助手只需 ~13,000 行。

**[架构优化设计](architecture-optimization.md)** — 基于审计结果，仅保留 3 项务实优化（ProviderProfile、错误扣留、外部内容隔离），1 周可完成，避免过度工程化。

---

## 项目索引

| 项目 | 语言 | 说明 | 分析报告 |
|------|------|------|---------|
| [DeepSeek-TUI](deepseek-tui/) | Rust | 终端 AI 编程助手，类似 Claude Code 的 Rust 实现 | [查看](deepseek-tui/README.md) |
| [DeepSeek-Reasonix](deepseek-reasonix/) | TypeScript | DeepSeek 原生编码代理，Cache-First Loop + Tool-Call Repair | [查看](deepseek-reasonix/README.md) |
| [Claude Code](claude-code/) | TypeScript | Anthropic 官方 AI 编程代理，AsyncGenerator 管道 + 四层压缩 | [查看](claude-code/README.md) |
| [Hermes Agent](hermes-agent/) | Python | Nous Research 多平台 AI 代理框架，插件驱动 + 28+ 提供商 + 20+ 网关 | [查看](hermes-agent/README.md) |
| [OpenClaw](openclaw/) | TypeScript | 本地优先 AI 助手平台，Gateway 架构 + 60+ 插件 + 22+ 渠道 + 多层沙箱 | [查看](openclaw/README.md) |

---

## 分析维度

每个参考项目的分析报告通常包含以下维度：

1. **架构设计** — 整体架构模式、核心组件关系、数据流
2. **核心系统** — 关键子系统的详细分析
3. **参考价值** — 可借鉴的设计模式、实现技巧、改进建议

---

## 待分析项目

| 项目 | 优先级 | 状态 |
|------|--------|------|
| Cursor (参考架构) | 中 | 待分析 |
| Continue.dev | 中 | 待分析 |
| Aider | 低 | 待分析 |

## 已完成分析

| 项目 | 完成日期 | 核心发现 |
|------|---------|---------|
| DeepSeek-TUI | 2026-05-13 | 延迟加载工具目录、BM25 搜索、连接健康三态模型、检查点-重启周期 |
| DeepSeek-Reasonix | 2026-05-13 | 三层内存分区、Tool-Call Repair 管道、Flash-First + Auto-Escalation |
| Claude Code | 2026-05-13 | AsyncGenerator 消息管道、四层上下文压缩、分层权限系统、错误扣留机制 |
| Hermes Agent | 2026-05-13 | ProviderProfile 声明式配置、AST 自动发现工具注册、可组合 Toolset、渐进式 Skills、安全扫描 |
| OpenClaw | 2026-05-13 | AgentHarness 双执行路径、可插拔 ContextEngine、声明式可用性 DSL、多层沙箱、Config 观察-恢复 |
