# OpenClaw 源码分析

> **项目地址**：OpenClaw (openclaw/openclaw)
> **语言**：TypeScript (ESM, Node 22+/24)
> **定位**：本地优先的个人 AI 助手平台，Gateway 架构 + 60+ 插件生态 + 22+ 消息渠道

---

## 项目概览

OpenClaw 是一个运行在用户本地设备上的个人 AI 助手平台。核心是一个长期运行的 **Gateway 守护进程**，连接多个消息渠道（WhatsApp、Telegram、Slack、Discord、Signal、iMessage 等），将对话路由到可配置的 AI 代理。项目采用 pnpm monorepo 结构，包含核心 TypeScript 代码、Vite Web 前端、以及 macOS/iOS/Android 原生伴侣应用。

### 核心特点

| 维度 | 特点 |
|------|------|
| 架构模式 | Gateway 中心化守护进程 + 插件驱动 + 双执行路径（内置 PI / 外部 ACP） |
| 渠道支持 | 22+ 消息渠道（WhatsApp、Telegram、Slack、Discord、Signal、iMessage、微信、QQ 等） |
| 提供商支持 | 20+ LLM 提供商（通过 60+ 扩展插件） |
| 工具系统 | 声明式描述符 + 可用性 DSL + Owner/Executor 分离 |
| 上下文管理 | 可插拔 ContextEngine 接口 + 自动压缩 + 转录轮转 |
| 安全体系 | 多层沙箱（Docker/SSH/OpenShell）+ 外部内容隔离 + 20+ CodeQL 查询 |
| 配置系统 | Zod Schema 验证 + 环境变量替换 + 配置观察-恢复 + 备份轮转 |
| 伴侣应用 | macOS 菜单栏、iOS、Android 原生应用（语音唤醒、画布、摄像头） |

### 文件结构（核心）

```
openclaw/
├── src/
│   ├── gateway/          # Gateway 守护进程（~300+ 文件）
│   ├── agents/           # AI 代理运行时（~500+ 文件）
│   │   ├── sandbox/      # 多层沙箱系统
│   │   ├── harness/      # 代理 Harness 接口
│   │   ├── auth-profiles/# 认证与使用量追踪
│   │   └── tools/        # 运行时工具实现
│   ├── cli/              # CLI 命令系统（~200+ 文件）
│   ├── channels/         # 渠道抽象层
│   ├── sessions/         # 会话管理
│   ├── tools/            # 工具描述符与规划器
│   ├── plugins/          # 插件加载与运行时
│   ├── plugin-sdk/       # 插件 SDK
│   ├── context-engine/   # 可插拔上下文引擎
│   ├── config/           # 配置系统
│   ├── security/         # 安全审计与内容隔离
│   ├── acp/              # ACP 协议实现
│   ├── mcp/              # MCP 协议实现
│   ├── tui/              # 终端 UI
│   └── trajectory/       # 轨迹记录
├── extensions/           # 60+ 扩展插件
│   ├── providers/        # LLM 提供商插件
│   ├── channels/         # 消息渠道插件
│   ├── tools/            # 工具扩展
│   ├── memory/           # 记忆系统
│   └── media/            # 媒体处理
├── packages/             # 共享内部包
├── ui/                   # Vite Web 前端
├── apps/                 # 原生伴侣应用
├── skills/               # 内置技能
└── security/             # CodeQL 安全查询
```

---

## 分析报告索引

| 报告 | 内容 |
|------|------|
| [架构设计](architecture.md) | Gateway 架构、AgentHarness 双执行路径、ContextEngine、会话管理、Plugin 系统 |
| [工具系统](tool-system.md) | ToolDescriptor 声明式定义、可用性 DSL、Owner/Executor 分离、插件工具注册 |
| [安全与配置](security-config.md) | 多层沙箱、外部内容隔离、Config 观察-恢复、Auth Profile 使用量追踪 |
| [参考价值评估](reference-value.md) | 可借鉴的设计模式、与其他项目对比、优先级建议 |
