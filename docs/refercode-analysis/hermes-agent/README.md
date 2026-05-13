# Hermes Agent 源码分析

> **项目地址**：Nous Research Hermes Agent
> **语言**：Python 3.10+
> **定位**：插件驱动的多平台 AI 代理框架，支持 28+ LLM 提供商、20+ 消息平台

---

## 项目概览

Hermes Agent 是 Nous Research 开发的通用 AI 代理框架，核心特点是**插件驱动架构**和**极致的可扩展性**。通过三个独立的插件发现系统（Provider、Gateway、Tool），实现了一个代码库适配几乎所有 LLM 提供商和消息平台的愿景。

### 核心特点

| 维度 | 特点 |
|------|------|
| 架构模式 | 插件驱动 + 策略模式 + 单例注册表 |
| 提供商支持 | 28+ LLM 提供商，通过 ProviderProfile 声明式配置 |
| 平台支持 | 20+ 消息平台（Telegram、Discord、Slack、飞书等） |
| 工具系统 | AST 自动发现 + 可组合 Toolset + 渐进式 Skills |
| 状态管理 | SQLite + FTS5 全文搜索（支持 CJK 三元组） |
| 代码编辑器集成 | ACP 适配器 + MCP 服务器 |

### 文件结构（核心）

```
hermes-agent/
├── run_agent.py          # ~15K 行，AIAgent 核心类
├── cli.py                # ~11K 行，CLI 入口
├── hermes_state.py       # ~3K 行，全局状态管理
├── providers/
│   ├── base.py           # ProviderProfile dataclass
│   └── __init__.py       # 三层发现机制
├── gateway/
│   ├── config.py         # Platform 枚举（动态成员）
│   └── platforms/
│       ├── base.py       # BasePlatformAdapter ABC
│       └── ...           # 20+ 平台适配器
├── tools/
│   ├── registry.py       # 单例 Registry，AST 自动发现
│   ├── model_tools.py    # 编排层
│   ├── toolsets.py       # 可组合 Toolset
│   ├── skills_tool.py    # 渐进式 Skills
│   ├── skills_guard.py   # 安全扫描（100+ 威胁模式）
│   └── skills_hub.py     # 远程安装
├── acp_adapter/
│   ├── server.py         # HermesACPAgent
│   └── tools.py          # TOOL_KIND_MAP
└── mcp_serve.py          # 10 个 MCP 工具
```

---

## 分析报告索引

| 报告 | 内容 |
|------|------|
| [架构设计](architecture.md) | AIAgent 核心、对话循环、状态管理、系统提示词缓存 |
| [工具系统](tool-system.md) | Registry 自动发现、Toolset 组合、Skills 渐进式披露、安全扫描 |
| [提供商与网关](provider-gateway.md) | ProviderProfile 声明式配置、平台适配器、ACP/MCP 集成 |
| [参考价值评估](reference-value.md) | 可借鉴的设计模式、与其他项目对比、优先级建议 |
